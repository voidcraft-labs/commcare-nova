/**
 * User-facing mutation API for the BlueprintDoc store.
 *
 * Every consumer that edits a module, form, or question calls this hook
 * and dispatches via the returned action object. All signatures take
 * uuid-first parameters — callers read uuids from `useLocation()` or
 * direct doc store subscriptions. No legacy (mIdx, fIdx, path) resolution.
 *
 * Internally, each method:
 *   1. Reads the CURRENT doc snapshot via `store.getState()` (not the
 *      snapshot at hook construction) so uuid validation always targets
 *      the freshest state, even after intervening mutations.
 *   2. Validates the uuid exists in the current doc (form, question, or
 *      module entity map).
 *   3. Dispatches a `Mutation` through `store.getState().apply(...)`,
 *      which the Phase 1a reducer in `lib/doc/mutations/index.ts`
 *      translates into draft edits on the Immer-backed store.
 *
 * Missing references (unknown uuid) are silently swallowed with a
 * dev-mode `console.warn`. The legacy engine behaved the same way:
 * no-op rather than throw, so the UI never crashes on a stale selection
 * held over a reload or undo.
 */

import { useContext, useMemo } from "react";
import { toDoc } from "@/lib/doc/converter";
import type { MoveQuestionResult } from "@/lib/doc/mutations/questions";
import { BlueprintDocContext } from "@/lib/doc/provider";
import {
	asUuid,
	type BlueprintDoc,
	type FormEntity,
	type ModuleEntity,
	type Mutation,
	type QuestionEntity,
	type Uuid,
} from "@/lib/doc/types";
import type {
	AppBlueprint,
	BlueprintForm,
	BlueprintModule,
	CaseType,
	ConnectType,
	Question,
} from "@/lib/schemas/blueprint";
import type { QuestionPath } from "@/lib/services/questionPath";

/**
 * Result of a `renameQuestion` dispatch.
 *
 * `conflict: true` short-circuits the dispatch — the hook checks sibling
 * ids BEFORE calling the reducer so the UI can surface a "name already
 * taken" message without unwinding a half-applied mutation.
 * `xpathFieldsRewritten` reflects the number of XPath expression fields
 * that were rewritten by the reducer to reference the new question ID.
 */
export interface QuestionRenameResult {
	newPath: QuestionPath;
	xpathFieldsRewritten: number;
	conflict?: boolean;
}

/**
 * Result of a `duplicateQuestion` dispatch.
 *
 * Returns the clone's new path and UUID so callers can focus the new
 * question in the UI immediately. Computed by diffing parent order
 * arrays before and after the dispatch (the reducer itself doesn't
 * return the new uuid). `undefined` if the dispatch was a no-op.
 */
export interface DuplicateQuestionResult {
	newPath: QuestionPath;
	newUuid: string;
}

/**
 * The full mutation surface returned by `useBlueprintMutations()`.
 *
 * All signatures take uuids directly — no legacy (mIdx, fIdx, path)
 * resolution. Callers read uuids from `useLocation()` or direct doc
 * store subscriptions, then pass them here.
 */
export interface BlueprintMutations {
	// ── Question mutations ────────────────────────────────────────────────
	/**
	 * Insert a new question into a parent container (form or group/repeat).
	 *
	 * Returns the new question's uuid so callers can drive selection or
	 * navigation. Returns the empty string (branded as `Uuid`) on a no-op
	 * (e.g. unrecognized `parentUuid`).
	 *
	 * Accepts either a full `Question` (with uuid) or a partial shape
	 * without uuid — legacy callers (SA tools, QuestionTypePicker) omit
	 * the uuid and let the hook mint one via `crypto.randomUUID()`.
	 */
	addQuestion: (
		parentUuid: Uuid,
		question: Omit<Question, "uuid"> & { uuid?: string },
		opts?: {
			afterUuid?: Uuid;
			beforeUuid?: Uuid;
			atIndex?: number;
		},
	) => Uuid;
	/**
	 * Update fields on an existing question. Callers pass `undefined` for
	 * any field value to clear it — no `null` coercion needed.
	 */
	updateQuestion: (
		uuid: Uuid,
		patch: Partial<Omit<QuestionEntity, "uuid">>,
	) => void;
	removeQuestion: (uuid: Uuid) => void;
	renameQuestion: (uuid: Uuid, newId: string) => QuestionRenameResult;
	moveQuestion: (
		uuid: Uuid,
		opts: {
			toParentUuid?: Uuid;
			afterUuid?: Uuid;
			beforeUuid?: Uuid;
			toIndex?: number;
		},
	) => MoveQuestionResult;
	duplicateQuestion: (uuid: Uuid) => DuplicateQuestionResult | undefined;

	// ── Form mutations ────────────────────────────────────────────────────
	/** Insert a new form into a module. Returns the new form's uuid. */
	addForm: (moduleUuid: Uuid, form: BlueprintForm) => Uuid;
	/**
	 * Update fields on an existing form. Patches use camelCase field names
	 * matching `FormEntity` (e.g. `closeCondition`, `postSubmit`).
	 */
	updateForm: (uuid: Uuid, patch: Partial<Omit<FormEntity, "uuid">>) => void;
	removeForm: (uuid: Uuid) => void;
	replaceForm: (uuid: Uuid, form: BlueprintForm) => void;

	// ── Module mutations ──────────────────────────────────────────────────
	/** Insert a new module. Returns the new module's uuid. */
	addModule: (module: BlueprintModule) => Uuid;
	updateModule: (
		uuid: Uuid,
		patch: Partial<Omit<ModuleEntity, "uuid">>,
	) => void;
	removeModule: (uuid: Uuid) => void;

	// ── App-level ─────────────────────────────────────────────────────────
	/**
	 * Combined app-level patch. Routes `app_name` and `connect_type`
	 * through a single `applyMany` so the entire patch collapses to ONE
	 * undo entry (no two-undo bug).
	 */
	updateApp: (patch: {
		app_name?: string;
		connect_type?: ConnectType | null;
	}) => void;
	setCaseTypes: (caseTypes: CaseType[] | null) => void;

	// ── Batch ─────────────────────────────────────────────────────────────
	/**
	 * Dispatch multiple mutations in a single atomic undo snapshot. Used
	 * by compound edits (rename-case-property, switch-connect-mode, etc.)
	 * that need to coordinate several doc changes without fragmenting
	 * history.
	 */
	applyMany: (mutations: Mutation[]) => void;
}

/**
 * Dev-only warning for silent no-ops.
 *
 * Every mutation method bails out silently when a uuid can't be found
 * in the current doc — matching legacy behavior, which the UI relies
 * on so stale selections don't crash the tree. In development we still
 * want visibility into which lookups are failing so bugs don't hide
 * behind the fail-open contract. Stripped by the production build via
 * the `NODE_ENV` check.
 */
function warnUnresolved(
	method: string,
	context: Record<string, unknown>,
): void {
	if (process.env.NODE_ENV !== "production") {
		console.warn(`[useBlueprintMutations.${method}] unresolved uuid`, context);
	}
}

/**
 * Build the slash-delimited path to a question whose uuid is known.
 *
 * Walks up the `questionOrder` map from the question to its enclosing
 * form, collecting semantic ids. Used by `renameQuestion` (after dispatch,
 * to return the updated path) and `duplicateQuestion` (to synthesize the
 * clone's `newPath` return value).
 */
/**
 * Build a reverse `childUuid → parentUuid` index in a single pass over
 * `doc.questionOrder`. O(N) over total questions. Callers that need to
 * walk up the parent chain multiple times (rename, duplicate, or
 * bulk-path operations) should build this once and pass it to
 * `computePathForUuid` / `findParentUuid` instead of re-scanning for
 * every walk — the naive version was O(N × D) per walk and O(N² × D)
 * when called multiple times in the same dispatch.
 */
function buildParentIndex(doc: BlueprintDoc): Map<Uuid, Uuid> {
	const parentOfUuid = new Map<Uuid, Uuid>();
	for (const [parentUuid, order] of Object.entries(doc.questionOrder)) {
		for (const childUuid of order) {
			parentOfUuid.set(childUuid, parentUuid as Uuid);
		}
	}
	return parentOfUuid;
}

/**
 * Walk from a uuid up to its owning form, joining semantic ids into a
 * slash-delimited path. Consumes a pre-built parent index so each walk
 * is O(D) rather than O(N × D).
 *
 * Returns `undefined` when the uuid is unreachable (cycle, missing
 * question entity, or the walk never hits a form). The cycle guard is
 * defensive — `buildParentIndex` cannot produce a cycle from a
 * well-formed `questionOrder`, but corruption shouldn't hang the UI.
 */
function computePathForUuid(
	doc: BlueprintDoc,
	uuid: Uuid,
	parentOfUuid: Map<Uuid, Uuid>,
): string | undefined {
	const segments: string[] = [];
	let cursor: Uuid | undefined = uuid;
	const visited = new Set<Uuid>();
	while (cursor !== undefined) {
		if (visited.has(cursor)) return undefined;
		visited.add(cursor);
		if (doc.forms[cursor] !== undefined) {
			return segments.reverse().join("/");
		}
		const q = doc.questions[cursor];
		if (!q) return undefined;
		segments.push(q.id);
		cursor = parentOfUuid.get(cursor);
	}
	return undefined;
}

export function useBlueprintMutations(): BlueprintMutations {
	const store = useContext(BlueprintDocContext);
	if (!store) {
		throw new Error(
			"useBlueprintMutations requires a <BlueprintDocProvider> ancestor",
		);
	}

	// Memoize against the store instance so the returned action object is
	// reference-stable across re-renders. A consumer storing this in a
	// useEffect dependency array sees it as unchanging for the lifetime of
	// the provider.
	return useMemo<BlueprintMutations>(() => {
		// Lazy snapshot accessor — reads the freshest state at dispatch time,
		// never at hook construction. This is critical: without it, a mutation
		// made immediately after another would validate against stale state.
		const get = () => store.getState();
		const dispatch = (mut: Mutation) => store.getState().apply(mut);

		return {
			addQuestion(parentUuid, question, opts) {
				const doc = get();
				// Verify parent exists — must be either a form or a group/repeat
				// question that can contain children.
				if (
					doc.forms[parentUuid] === undefined &&
					doc.questions[parentUuid] === undefined
				) {
					warnUnresolved("addQuestion", { parentUuid });
					return "" as Uuid;
				}

				// Resolve insertion index from afterUuid / beforeUuid / atIndex.
				// atIndex takes precedence (matches legacy semantics where
				// numeric index is documented as authoritative).
				const order = doc.questionOrder[parentUuid] ?? [];
				let index: number | undefined;
				if (opts?.atIndex !== undefined) {
					index = opts.atIndex;
				} else if (opts?.beforeUuid) {
					const i = order.indexOf(opts.beforeUuid);
					if (i >= 0) index = i;
				} else if (opts?.afterUuid) {
					const i = order.indexOf(opts.afterUuid);
					if (i >= 0) index = i + 1;
				}

				// The blueprint `Question` shape carries a nested `children` array
				// for group/repeat subtrees; the normalized doc expresses nesting
				// via `questionOrder`, so we strip `children` before dispatching.
				// Callers inserting a whole subtree should use `applyMany` with one
				// `addQuestion` per descendant instead.
				const { children: _children, ...rest } = question as Question & {
					children?: Question[];
				};

				// Mint a uuid if the caller didn't supply one. SA tools and
				// QuestionTypePicker pass shapes without uuids and rely on the
				// store to generate identity.
				const maybeUuid = (rest as { uuid?: string }).uuid;
				const uuid = asUuid(
					typeof maybeUuid === "string" && maybeUuid.length > 0
						? maybeUuid
						: crypto.randomUUID(),
				);
				const entity: QuestionEntity = {
					...(rest as Omit<QuestionEntity, "uuid">),
					uuid,
				};

				dispatch({
					kind: "addQuestion",
					parentUuid,
					question: entity,
					index,
				});
				return uuid;
			},

			updateQuestion(uuid, patch) {
				const doc = get();
				if (!doc.questions[uuid]) {
					warnUnresolved("updateQuestion", { uuid });
					return;
				}
				dispatch({
					kind: "updateQuestion",
					uuid,
					patch,
				});
			},

			removeQuestion(uuid) {
				const doc = get();
				if (!doc.questions[uuid]) {
					warnUnresolved("removeQuestion", { uuid });
					return;
				}
				dispatch({ kind: "removeQuestion", uuid });
			},

			renameQuestion(uuid, newId) {
				const doc = get();
				const q = doc.questions[uuid];
				if (!q) {
					warnUnresolved("renameQuestion", { uuid });
					return {
						newPath: "" as QuestionPath,
						xpathFieldsRewritten: 0,
					};
				}

				// Find parent + siblings for conflict check. Reject the rename
				// before dispatching so the UI can surface a "name already taken"
				// message without unwinding a half-applied mutation.
				const parentIndex = buildParentIndex(doc);
				const parentUuid = parentIndex.get(uuid);
				if (parentUuid !== undefined) {
					const siblings = doc.questionOrder[parentUuid] ?? [];
					for (const sibUuid of siblings) {
						if (sibUuid === uuid) continue;
						if (doc.questions[sibUuid]?.id === newId) {
							return {
								newPath: "" as QuestionPath,
								xpathFieldsRewritten: 0,
								conflict: true,
							};
						}
					}
				}

				// Dispatch via `applyWithResult` to capture the xpath rewrite count.
				const meta = store.getState().applyWithResult({
					kind: "renameQuestion",
					uuid,
					newId,
				});

				/* Compute the new path AFTER dispatch — the semantic id has
				 * changed. Rebuild the parent index from the post-dispatch
				 * snapshot: `renameQuestion` doesn't reparent, but the walk
				 * needs to read `doc.questions[...].id` from the fresh
				 * snapshot anyway, so reuse that same snapshot's index. */
				const after = get();
				const afterParentIndex = buildParentIndex(after);
				const newPath = (computePathForUuid(after, uuid, afterParentIndex) ??
					"") as QuestionPath;
				return {
					newPath,
					xpathFieldsRewritten: meta.xpathFieldsRewritten,
				};
			},

			moveQuestion(uuid, opts) {
				const doc = get();
				const q = doc.questions[uuid];
				if (!q) {
					warnUnresolved("moveQuestion", { uuid });
					return {};
				}

				// Default destination: the question's current parent (same-parent
				// reorder). Fall back to the question's own uuid as a guard — this
				// is unreachable in practice because every question has a parent
				// entry in `questionOrder`. `buildParentIndex` gives O(1) lookup
				// instead of an `Object.entries(...).find(order.includes(...))`
				// linear+linear scan.
				const toParentUuid =
					opts.toParentUuid ?? buildParentIndex(doc).get(uuid) ?? uuid;

				// Virtual post-splice order when same-parent move. When the source
				// uuid appears in the destination parent, emulate the post-splice
				// state so the returned index aligns with where the reducer will
				// actually insert after it removes the source uuid.
				const base = doc.questionOrder[toParentUuid] ?? [];
				const virtual = base.includes(uuid)
					? base.filter((u) => u !== uuid)
					: base;

				// Default: append at the end of the destination parent.
				let toIndex = virtual.length;
				if (opts.toIndex !== undefined) {
					toIndex = opts.toIndex;
				} else if (opts.beforeUuid) {
					const i = virtual.indexOf(opts.beforeUuid);
					if (i >= 0) toIndex = i;
				} else if (opts.afterUuid) {
					const i = virtual.indexOf(opts.afterUuid);
					if (i >= 0) toIndex = i + 1;
				}

				// Dispatch via `applyWithResult` to capture the rename metadata
				// the reducer populates when cross-level dedup changes the id.
				return store.getState().applyWithResult({
					kind: "moveQuestion",
					uuid,
					toParentUuid,
					toIndex,
				});
			},

			duplicateQuestion(uuid) {
				const doc = get();
				if (!doc.questions[uuid]) {
					warnUnresolved("duplicateQuestion", { uuid });
					return undefined;
				}

				// Snapshot the parent's order BEFORE dispatch so we can diff and
				// recover the new clone's uuid. The reducer splices the clone
				// right after the source; the post-dispatch order will contain
				// exactly one uuid that wasn't present before.
				const parentIndex = buildParentIndex(doc);
				const parentUuid = parentIndex.get(uuid);
				if (parentUuid === undefined) {
					warnUnresolved("duplicateQuestion", {
						uuid,
						reason: "no parent",
					});
					return undefined;
				}
				const beforeOrder = [...(doc.questionOrder[parentUuid] ?? [])];
				const beforeSet = new Set(beforeOrder);

				dispatch({ kind: "duplicateQuestion", uuid });

				// Diff the post-dispatch order against the snapshot to find the
				// new clone. Only one uuid should be new.
				const afterDoc = get();
				const afterOrder = afterDoc.questionOrder[parentUuid] ?? [];
				const newUuid = afterOrder.find((u) => !beforeSet.has(u));
				if (!newUuid) return undefined;

				// Rebuild the new path: parent path (if any) + new question id.
				// The post-dispatch parent index differs from the pre-dispatch
				// one (the clone is now a child of `parentUuid`) — rebuild from
				// the fresh snapshot so the walk sees the new entry.
				const cloneEntity = afterDoc.questions[newUuid];
				if (!cloneEntity) return undefined;
				const afterParentIndex = buildParentIndex(afterDoc);
				const parentPath = afterDoc.forms[parentUuid]
					? "" // parent is the form root
					: (computePathForUuid(afterDoc, parentUuid, afterParentIndex) ?? "");
				const newPath = (
					parentPath ? `${parentPath}/${cloneEntity.id}` : cloneEntity.id
				) as QuestionPath;

				return { newPath, newUuid: newUuid as string };
			},

			addForm(moduleUuid, form) {
				const doc = get();
				if (!doc.modules[moduleUuid]) {
					warnUnresolved("addForm", { moduleUuid });
					return "" as Uuid;
				}
				// Strip nested `questions` — the entity map only carries form-level
				// scalars. Callers wanting to insert a form plus its questions in
				// one shot should dispatch an `applyMany` batch.
				const { questions: _qs, ...formRest } = form as BlueprintForm & {
					questions?: Question[];
				};
				const formUuid = asUuid(crypto.randomUUID());
				dispatch({
					kind: "addForm",
					moduleUuid,
					form: { ...formRest, uuid: formUuid } as FormEntity,
				});
				return formUuid;
			},

			updateForm(uuid, patch) {
				const doc = get();
				if (!doc.forms[uuid]) {
					warnUnresolved("updateForm", { uuid });
					return;
				}
				dispatch({
					kind: "updateForm",
					uuid,
					patch,
				});
			},

			removeForm(uuid) {
				const doc = get();
				if (!doc.forms[uuid]) {
					warnUnresolved("removeForm", { uuid });
					return;
				}
				dispatch({ kind: "removeForm", uuid });
			},

			replaceForm(uuid, form) {
				// Wholesale form swap. The reducer's `replaceForm` variant
				// expects a form entity + pre-flattened question entities + a
				// `questionOrder` map for the replacement subtree. Rather than
				// reimplement the nested-to-flat walk here, we reuse `toDoc` on
				// a minimal scratch blueprint wrapping the incoming form — the
				// converter handles children, nested groups, and uuid minting.
				const doc = get();
				if (!doc.forms[uuid]) {
					warnUnresolved("replaceForm", { uuid });
					return;
				}

				const bp: AppBlueprint = {
					app_name: "",
					connect_type: undefined,
					case_types: null,
					modules: [{ name: "__replace__", forms: [form] }],
				};
				const scratch = toDoc(bp, "");
				const scratchModuleUuid = scratch.moduleOrder[0];
				const scratchFormUuid = scratch.formOrder[scratchModuleUuid][0];
				const scratchForm = scratch.forms[scratchFormUuid];

				// Carry the scratch form's fields but stamp the destination uuid.
				const replacement: FormEntity = { ...scratchForm, uuid };
				const questions = Object.values(scratch.questions) as QuestionEntity[];

				// `questionOrder` is keyed by parent uuid. The scratch root slot
				// is keyed by `scratchFormUuid`; we remap that single key to the
				// destination `uuid`. Nested (group/repeat) slots are keyed by
				// question uuids, which are preserved verbatim — no remap needed.
				const questionOrder: Record<Uuid, Uuid[]> = {};
				for (const [key, order] of Object.entries(scratch.questionOrder)) {
					questionOrder[(key === scratchFormUuid ? uuid : key) as Uuid] = order;
				}

				dispatch({
					kind: "replaceForm",
					uuid,
					form: replacement,
					questions,
					questionOrder,
				});
			},

			addModule(module) {
				// Strip nested `forms` — the entity map carries only module-level
				// scalars; forms join via `addForm` batches.
				const { forms: _forms, ...moduleRest } = module as BlueprintModule & {
					forms?: BlueprintForm[];
				};
				const moduleUuid = asUuid(crypto.randomUUID());
				dispatch({
					kind: "addModule",
					module: { ...moduleRest, uuid: moduleUuid } as ModuleEntity,
				});
				return moduleUuid;
			},

			updateModule(uuid, patch) {
				const doc = get();
				if (!doc.modules[uuid]) {
					warnUnresolved("updateModule", { uuid });
					return;
				}
				dispatch({ kind: "updateModule", uuid, patch });
			},

			removeModule(uuid) {
				const doc = get();
				if (!doc.modules[uuid]) {
					warnUnresolved("removeModule", { uuid });
					return;
				}
				dispatch({ kind: "removeModule", uuid });
			},

			updateApp(patch) {
				// Collapse the combined patch into a single `applyMany` so zundo
				// records exactly one undo entry. Dispatching `setAppName` and
				// `setConnectType` individually would produce TWO undo entries per
				// call — the user would have to hit ctrl-z twice to roll back a
				// single "Rename + toggle" edit.
				const mutations: Mutation[] = [];
				if (patch.app_name !== undefined) {
					mutations.push({ kind: "setAppName", name: patch.app_name });
				}
				if (patch.connect_type !== undefined) {
					// ConnectType | null is the narrower type; null means "connect
					// disabled" (absent connect_type in the blueprint schema).
					mutations.push({
						kind: "setConnectType",
						connectType: patch.connect_type,
					});
				}
				if (mutations.length > 0) {
					store.getState().applyMany(mutations);
				}
			},

			setCaseTypes(caseTypes) {
				dispatch({ kind: "setCaseTypes", caseTypes });
			},

			applyMany(mutations) {
				// Batch dispatch — the store's `applyMany` wraps the whole set
				// in one `set()` call so zundo records exactly one undo entry.
				store.getState().applyMany(mutations);
			},
		};
	}, [store]);
}
