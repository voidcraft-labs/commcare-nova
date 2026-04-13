/**
 * User-facing mutation API for the BlueprintDoc store.
 *
 * Every consumer that edits a module, form, or question calls this hook
 * and dispatches via the returned action object. Function signatures
 * intentionally mirror the legacy `builderStore` action shapes so Phase
 * 1b call-site migration is a drop-in rename — the only thing a caller
 * needs to change is the import path and the hook name.
 *
 * Internally, each method:
 *   1. Reads the CURRENT doc snapshot via `store.getState()` (not the
 *      snapshot at hook construction) so uuid resolution always targets
 *      the freshest state, even after intervening mutations.
 *   2. Resolves the legacy (mIdx, fIdx, path) coordinates through the
 *      Task 2 adapters in `pathToUuid.ts`.
 *   3. Dispatches a `Mutation` through `store.getState().apply(...)`,
 *      which the Phase 1a reducer in `lib/doc/mutations/index.ts`
 *      translates into draft edits on the Immer-backed store.
 *
 * Missing references (unknown module, form, or path) are silently
 * swallowed — resolve-returns-undefined short-circuits the dispatch with
 * a dev-mode `console.warn`. The legacy engine behaved the same way:
 * no-op rather than throw, so the UI never crashes on a stale selection
 * held over a reload or undo.
 *
 * Phase 2 will add uuid-first overloads and Phase 3 will delete the
 * legacy (mIdx, fIdx, path) argument shape entirely as callers move to
 * URL-derived uuids.
 */

import { useContext, useMemo } from "react";
import {
	resolveFormUuid,
	resolveModuleUuid,
	resolveQuestionUuid,
} from "@/lib/doc/adapters/pathToUuid";
import { toDoc } from "@/lib/doc/converter";
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
 * Partial with `null` allowed for each value.
 *
 * Legacy callers (ContextualEditorData, useSaveQuestion) pass `null` to clear
 * optional fields like `case_property_on`. The normalized `QuestionEntity` and
 * `FormEntity` types use `undefined` for absent fields. This utility type
 * accepts either so migration call sites compile without rewriting every
 * patch literal. The dispatch coerces `null` → `undefined` before passing
 * through to the reducer.
 */
type NullablePartial<T> = {
	[K in keyof T]?: T[K] | null;
};

/**
 * Result of a `moveQuestion` dispatch.
 *
 * Mirrors the legacy `MoveQuestionResult` in `lib/services/builderStore.ts`.
 * `renamed` is populated when a cross-parent move triggered sibling-id
 * deduplication (CommCare requires unique IDs per level). Phase 1b's
 * reducer already performs the dedup — surfacing the resulting new id
 * back to the caller is a later phase (the dedup happens silently today
 * because the Mutation union's payload doesn't carry the before/after
 * ids). For now the hook returns an empty object whenever the move
 * dispatches successfully.
 */
export interface MoveQuestionResult {
	renamed?: {
		oldId: string;
		newId: string;
		newPath: string;
		xpathFieldsRewritten: number;
	};
}

/**
 * Result of a `renameQuestion` dispatch.
 *
 * Mirrors the legacy `QuestionRenameResult`. `conflict: true` short-circuits
 * the dispatch — the hook checks sibling ids BEFORE calling the reducer so
 * the UI can surface a "name already taken" message without unwinding a
 * half-applied mutation. `xpathFieldsRewritten` is currently always 0: the
 * doc reducer rewrites references in-place but doesn't return a count
 * (adding one would require changes to `lib/doc/mutations/questions.ts`
 * which are out of scope for this fix).
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
 * Signatures MUST stay drop-in compatible with the corresponding actions
 * on `lib/services/builderStore.ts` so Phase 1b's Task 6 can mechanically
 * rename call sites without rewriting argument shapes. New parameters go
 * through `applyMany` or dedicated methods, not ad-hoc variants of these.
 */
export interface BlueprintMutations {
	// ── Question mutations ────────────────────────────────────────────────
	/**
	 * Insert a new question. Returns the new question's uuid (not its
	 * semantic id) so callers can drive selection/navigation. Returns the
	 * empty string on a no-op (e.g. unresolvable `mIdx`/`fIdx`).
	 *
	 * Accepts either a full `Question` (with uuid) or a partial shape
	 * without uuid — legacy callers (SA tools, QuestionTypePicker) omit
	 * the uuid and let the hook mint one via `crypto.randomUUID()`.
	 */
	addQuestion: (
		mIdx: number,
		fIdx: number,
		question: Omit<Question, "uuid"> & { uuid?: string },
		opts?: {
			afterPath?: string;
			beforePath?: string;
			atIndex?: number;
			parentPath?: string;
		},
	) => string;
	/**
	 * Update fields on an existing question. Accepts `null` for any field
	 * value to clear it — the dispatch coerces `null` to `undefined` so
	 * the normalized entity stays clean.
	 */
	updateQuestion: (
		mIdx: number,
		fIdx: number,
		path: string,
		patch: NullablePartial<Omit<QuestionEntity, "uuid">>,
	) => void;
	removeQuestion: (mIdx: number, fIdx: number, path: string) => void;
	renameQuestion: (
		mIdx: number,
		fIdx: number,
		path: string,
		newId: string,
	) => QuestionRenameResult;
	moveQuestion: (
		mIdx: number,
		fIdx: number,
		path: string,
		opts: {
			afterPath?: string;
			beforePath?: string;
			targetParentPath?: string;
		},
	) => MoveQuestionResult;
	duplicateQuestion: (
		mIdx: number,
		fIdx: number,
		path: string,
	) => DuplicateQuestionResult | undefined;

	// ── Form mutations ────────────────────────────────────────────────────
	addForm: (mIdx: number, form: BlueprintForm) => void;
	/**
	 * Update fields on an existing form. Accepts `null` for any field
	 * value to clear it — the dispatch coerces `null` to `undefined` so
	 * the normalized entity stays clean. Patches use camelCase field names
	 * matching `FormEntity` (e.g. `closeCondition`, `postSubmit`).
	 */
	updateForm: (
		mIdx: number,
		fIdx: number,
		patch: NullablePartial<Omit<FormEntity, "uuid">>,
	) => void;
	removeForm: (mIdx: number, fIdx: number) => void;
	replaceForm: (mIdx: number, fIdx: number, form: BlueprintForm) => void;

	// ── Module mutations ──────────────────────────────────────────────────
	addModule: (module: BlueprintModule) => void;
	updateModule: (
		mIdx: number,
		patch: Partial<Omit<ModuleEntity, "uuid">>,
	) => void;
	removeModule: (mIdx: number) => void;

	// ── App-level ─────────────────────────────────────────────────────────
	/**
	 * Combined app-level patch. Legacy shape used `connect_type?: string`;
	 * we route both fields through a single `applyMany` so the entire patch
	 * collapses to ONE undo entry (no two-undo bug). Unlike the previous
	 * version that dispatched each field separately, this matches the
	 * legacy atomic-update contract callers expect.
	 */
	updateApp: (patch: { app_name?: string; connect_type?: string }) => void;
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
 * Replace `null` values with `undefined` in a shallow patch object.
 *
 * Legacy callers pass `null` to mean "remove this field" (e.g.
 * `{ case_property_on: null }`), but the normalized entity types use
 * `undefined` for absent optional fields. This conversion bridges
 * the gap without rewriting every call site.
 */
function coerceNulls<T extends Record<string, unknown>>(
	patch: T,
): { [K in keyof T]: Exclude<T[K], null> | undefined } {
	const result = { ...patch };
	for (const key of Object.keys(result)) {
		if (result[key] === null) {
			(result as Record<string, unknown>)[key] = undefined;
		}
	}
	return result as { [K in keyof T]: Exclude<T[K], null> | undefined };
}

/**
 * Dev-only warning for silent no-ops.
 *
 * Every mutation method bails out silently when the legacy (mIdx, fIdx,
 * path) tuple can't be resolved — matching legacy behavior, which the UI
 * relies on so stale selections don't crash the tree. In development we
 * still want visibility into which resolves are failing so bugs don't
 * hide behind the fail-open contract. Stripped by the production build
 * via the `NODE_ENV` check.
 */
function warnUnresolved(
	method: string,
	context: Record<string, unknown>,
): void {
	if (process.env.NODE_ENV !== "production") {
		console.warn(`[useBlueprintMutations.${method}] unresolved path`, context);
	}
}

/**
 * Resolve a legacy `afterPath`/`beforePath`/`atIndex`/`parentPath` insert
 * point to a concrete `(parentUuid, index)` pair inside the current doc.
 *
 * Extracted so `addQuestion` and `moveQuestion` share a single resolver
 * instead of duplicating the walk. Callers pass the form uuid as the
 * default parent so unresolvable `parentPath` values degrade to the form
 * root rather than no-op — matching the legacy engine's forgiving
 * behavior on stale drop targets.
 *
 * The `excludeUuid` argument is `moveQuestion`'s escape hatch: when the
 * source and destination parent are the same, removing the source from
 * the order array shifts every index after it left by one. Passing the
 * source uuid here computes the insert index against a virtual post-
 * splice order so the reducer's internal splice doesn't shift under us.
 */
function resolveInsertionPoint(
	doc: BlueprintDoc,
	mIdx: number,
	fIdx: number,
	formUuid: Uuid,
	opts:
		| {
				parentPath?: string;
				afterPath?: string;
				beforePath?: string;
				atIndex?: number;
		  }
		| undefined,
	excludeUuid?: Uuid,
): { parentUuid: Uuid; index: number | undefined } {
	const parentUuid: Uuid = opts?.parentPath
		? (resolveQuestionUuid(doc, mIdx, fIdx, opts.parentPath) ?? formUuid)
		: formUuid;

	// Baseline order inside the destination parent. When `excludeUuid` is
	// passed and appears in this parent (same-parent move), emulate the
	// post-splice state so the returned index aligns with where the
	// reducer will actually insert after it removes the source uuid.
	const baseOrder = doc.questionOrder[parentUuid] ?? [];
	const virtualOrder =
		excludeUuid !== undefined && baseOrder.includes(excludeUuid)
			? baseOrder.filter((u) => u !== excludeUuid)
			: baseOrder;

	// Explicit numeric index takes precedence over path-relative hints,
	// matching legacy semantics (`atIndex` is documented as authoritative).
	if (opts?.atIndex !== undefined) {
		return { parentUuid, index: opts.atIndex };
	}

	if (opts?.beforePath) {
		const beforeUuid = resolveQuestionUuid(doc, mIdx, fIdx, opts.beforePath);
		if (beforeUuid) {
			const idx = virtualOrder.indexOf(beforeUuid);
			if (idx >= 0) return { parentUuid, index: idx };
		}
	}

	if (opts?.afterPath) {
		const afterUuid = resolveQuestionUuid(doc, mIdx, fIdx, opts.afterPath);
		if (afterUuid) {
			const idx = virtualOrder.indexOf(afterUuid);
			if (idx >= 0) return { parentUuid, index: idx + 1 };
		}
	}

	// No positional hint — append (reducer clamps to end of order).
	return { parentUuid, index: undefined };
}

/**
 * Build the slash-delimited path to a question whose uuid is known.
 *
 * Walks up the `questionOrder` map from the question to its enclosing
 * form, collecting semantic ids. Used by `duplicateQuestion` to synthesize
 * the cloned question's `newPath` return value without re-running the
 * legacy path walker — we already know the parent path and the clone's
 * new id, so the result is `parentPath ? `${parentPath}/${newId}` : newId`.
 */
function computePathForUuid(doc: BlueprintDoc, uuid: Uuid): string | undefined {
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
		// Find this cursor's parent by scanning questionOrder.
		let nextParent: Uuid | undefined;
		for (const [parentUuid, order] of Object.entries(doc.questionOrder)) {
			if (order.includes(cursor)) {
				nextParent = parentUuid as Uuid;
				break;
			}
		}
		cursor = nextParent;
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
		// Lazy snapshot accessor — resolves uuids at dispatch time, never at
		// hook construction. This is critical: without it, a mutation made
		// immediately after another would resolve against stale indices.
		const get = () => store.getState();
		const dispatch = (mut: Mutation) => store.getState().apply(mut);

		return {
			addQuestion(mIdx, fIdx, question, opts) {
				const doc = get();
				const formUuid = resolveFormUuid(doc, mIdx, fIdx);
				if (!formUuid) {
					warnUnresolved("addQuestion", { mIdx, fIdx });
					return "";
				}
				// Resolve the insertion target. `afterPath`/`beforePath` become
				// concrete numeric indices here so the reducer doesn't need to
				// re-resolve paths during dispatch.
				const { parentUuid, index } = resolveInsertionPoint(
					doc,
					mIdx,
					fIdx,
					formUuid,
					opts,
				);

				// The blueprint `Question` shape carries a nested `children` array
				// for group/repeat subtrees; the normalized doc expresses nesting
				// via `questionOrder`, so we strip `children` before dispatching
				// the insert. Callers inserting a whole subtree should use
				// `applyMany` with one `addQuestion` per descendant instead.
				const { children: _children, ...rest } = question as Question & {
					children?: Question[];
				};

				// Mint a uuid if the caller didn't supply one. Legacy callers
				// pass a `NewQuestion` shape (no uuid) and rely on the store to
				// generate identity; preserving that contract keeps Task 6's
				// rename purely mechanical.
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

			updateQuestion(mIdx, fIdx, path, patch) {
				const doc = get();
				const uuid = resolveQuestionUuid(doc, mIdx, fIdx, path);
				if (!uuid) {
					warnUnresolved("updateQuestion", { mIdx, fIdx, path });
					return;
				}
				// Coerce null → undefined so the normalized entity stays clean.
				// Legacy callers pass null to clear optional fields.
				const cleanPatch = coerceNulls(patch);
				dispatch({
					kind: "updateQuestion",
					uuid,
					patch: cleanPatch as Partial<Omit<QuestionEntity, "uuid">>,
				});
			},

			removeQuestion(mIdx, fIdx, path) {
				const doc = get();
				const uuid = resolveQuestionUuid(doc, mIdx, fIdx, path);
				if (!uuid) {
					warnUnresolved("removeQuestion", { mIdx, fIdx, path });
					return;
				}
				dispatch({ kind: "removeQuestion", uuid });
			},

			renameQuestion(mIdx, fIdx, path, newId) {
				const doc = get();
				const uuid = resolveQuestionUuid(doc, mIdx, fIdx, path);
				if (!uuid) {
					warnUnresolved("renameQuestion", { mIdx, fIdx, path });
					return {
						newPath: path as QuestionPath,
						xpathFieldsRewritten: 0,
					};
				}

				// Look up the parent uuid + sibling list up front so we can:
				//   (1) detect id conflicts before dispatching (fail fast so the
				//       UI can surface a "name already taken" message instead of
				//       the silent dedup the reducer would apply).
				//   (2) reconstruct `newPath` by swapping the final segment.
				let parentUuid: Uuid | undefined;
				for (const [pUuid, order] of Object.entries(doc.questionOrder)) {
					if (order.includes(uuid)) {
						parentUuid = pUuid as Uuid;
						break;
					}
				}
				if (parentUuid !== undefined) {
					const siblings = doc.questionOrder[parentUuid] ?? [];
					for (const sibUuid of siblings) {
						if (sibUuid === uuid) continue;
						if (doc.questions[sibUuid]?.id === newId) {
							return {
								newPath: path as QuestionPath,
								xpathFieldsRewritten: 0,
								conflict: true,
							};
						}
					}
				}

				dispatch({ kind: "renameQuestion", uuid, newId });

				// Rebuild the path by swapping the last segment.
				const segments = path.split("/").filter((s) => s.length > 0);
				segments[segments.length - 1] = newId;
				// xpathFieldsRewritten count not exposed by the doc reducer yet;
				// surface zero until a later phase adds instrumentation.
				return {
					newPath: segments.join("/") as QuestionPath,
					xpathFieldsRewritten: 0,
				};
			},

			moveQuestion(mIdx, fIdx, path, opts) {
				const doc = get();
				const uuid = resolveQuestionUuid(doc, mIdx, fIdx, path);
				if (!uuid) {
					warnUnresolved("moveQuestion", { mIdx, fIdx, path });
					return {};
				}
				const formUuid = resolveFormUuid(doc, mIdx, fIdx);
				if (!formUuid) {
					warnUnresolved("moveQuestion", { mIdx, fIdx, path });
					return {};
				}
				// Reuse the addQuestion resolver but map `targetParentPath` into
				// the same `parentPath` slot it expects. `excludeUuid` is the
				// source uuid so same-parent moves compute an index against a
				// virtual post-splice order.
				const { parentUuid: toParentUuid, index } = resolveInsertionPoint(
					doc,
					mIdx,
					fIdx,
					formUuid,
					{
						parentPath: opts.targetParentPath,
						afterPath: opts.afterPath,
						beforePath: opts.beforePath,
					},
					uuid,
				);

				// Default to appending at the end of the destination parent when
				// no positional hint resolved. The reducer clamps to order length.
				const toIndex =
					index !== undefined
						? index
						: (doc.questionOrder[toParentUuid] ?? []).length;

				dispatch({
					kind: "moveQuestion",
					uuid,
					toParentUuid,
					toIndex,
				});

				// `renamed` tracking requires comparing pre/post-dispatch ids to
				// detect sibling-dedup renames triggered by cross-parent moves.
				// The doc reducer already runs the dedup; surfacing the result
				// back out is deferred — callers currently only check truthiness
				// of `result.renamed` which stays undefined for now.
				return {};
			},

			duplicateQuestion(mIdx, fIdx, path) {
				const doc = get();
				const uuid = resolveQuestionUuid(doc, mIdx, fIdx, path);
				if (!uuid) {
					warnUnresolved("duplicateQuestion", { mIdx, fIdx, path });
					return undefined;
				}

				// Snapshot the parent's order BEFORE dispatch so we can diff and
				// recover the new clone's uuid. The reducer splices the clone
				// right after the source; the post-dispatch order will contain
				// exactly one uuid that wasn't present before.
				let parentUuid: Uuid | undefined;
				for (const [pUuid, order] of Object.entries(doc.questionOrder)) {
					if (order.includes(uuid)) {
						parentUuid = pUuid as Uuid;
						break;
					}
				}
				if (parentUuid === undefined) {
					warnUnresolved("duplicateQuestion", {
						mIdx,
						fIdx,
						path,
						reason: "no parent",
					});
					return undefined;
				}
				const beforeOrder = [...(doc.questionOrder[parentUuid] ?? [])];
				const beforeSet = new Set(beforeOrder);

				dispatch({ kind: "duplicateQuestion", uuid });

				// Diff the post-dispatch order against the snapshot to find the
				// new clone. Only one uuid should be new; if we somehow see more
				// (concurrent dispatch? impossible under the single-threaded
				// model) we take the first.
				const afterDoc = get();
				const afterOrder = afterDoc.questionOrder[parentUuid] ?? [];
				const newUuid = afterOrder.find((u) => !beforeSet.has(u));
				if (!newUuid) return undefined;

				// Rebuild the new path: parent path (if any) + new question id.
				const cloneEntity = afterDoc.questions[newUuid];
				if (!cloneEntity) return undefined;
				const parentPath = afterDoc.forms[parentUuid]
					? "" // parent is the form root
					: (computePathForUuid(afterDoc, parentUuid) ?? "");
				const newPath = (
					parentPath ? `${parentPath}/${cloneEntity.id}` : cloneEntity.id
				) as QuestionPath;

				return { newPath, newUuid: newUuid as string };
			},

			addForm(mIdx, form) {
				const doc = get();
				const moduleUuid = resolveModuleUuid(doc, mIdx);
				if (!moduleUuid) {
					warnUnresolved("addForm", { mIdx });
					return;
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
			},

			updateForm(mIdx, fIdx, patch) {
				const doc = get();
				const uuid = resolveFormUuid(doc, mIdx, fIdx);
				if (!uuid) {
					warnUnresolved("updateForm", { mIdx, fIdx });
					return;
				}
				// Coerce null → undefined so the normalized entity stays clean.
				const cleanPatch = coerceNulls(patch);
				dispatch({
					kind: "updateForm",
					uuid,
					patch: cleanPatch as Partial<Omit<FormEntity, "uuid">>,
				});
			},

			removeForm(mIdx, fIdx) {
				const doc = get();
				const uuid = resolveFormUuid(doc, mIdx, fIdx);
				if (!uuid) {
					warnUnresolved("removeForm", { mIdx, fIdx });
					return;
				}
				dispatch({ kind: "removeForm", uuid });
			},

			replaceForm(mIdx, fIdx, form) {
				// Wholesale form swap. The reducer's `replaceForm` variant
				// expects a form entity + pre-flattened question entities + a
				// `questionOrder` map for the replacement subtree. Rather than
				// reimplement the nested-to-flat walk here, we reuse `toDoc` on
				// a minimal scratch blueprint wrapping the incoming form — the
				// converter handles children, nested groups, and uuid minting
				// for modules/forms.
				//
				// Scratch builds a throwaway app with one module containing only
				// the replacement form, converts to doc shape, then re-keys the
				// top-level `questionOrder` slot from the scratch form's uuid to
				// the destination form's uuid (preserving the existing form uuid
				// so stable references in `formOrder` don't move).
				const doc = get();
				const uuid = resolveFormUuid(doc, mIdx, fIdx);
				if (!uuid) {
					warnUnresolved("replaceForm", { mIdx, fIdx });
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
				// question uuids, which are preserved verbatim from the input
				// form — no remap needed.
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
				// Same strip-children trick as `addForm`: the entity map carries
				// only module-level scalars; forms join via `addForm` batches.
				const { forms: _forms, ...moduleRest } = module as BlueprintModule & {
					forms?: BlueprintForm[];
				};
				const moduleUuid = asUuid(crypto.randomUUID());
				dispatch({
					kind: "addModule",
					module: { ...moduleRest, uuid: moduleUuid } as ModuleEntity,
				});
			},

			updateModule(mIdx, patch) {
				const doc = get();
				const uuid = resolveModuleUuid(doc, mIdx);
				if (!uuid) {
					warnUnresolved("updateModule", { mIdx });
					return;
				}
				dispatch({ kind: "updateModule", uuid, patch });
			},

			removeModule(mIdx) {
				const doc = get();
				const uuid = resolveModuleUuid(doc, mIdx);
				if (!uuid) {
					warnUnresolved("removeModule", { mIdx });
					return;
				}
				dispatch({ kind: "removeModule", uuid });
			},

			updateApp(patch) {
				// Collapse the combined patch into a single `applyMany` so zundo
				// records exactly one undo entry. The previous implementation
				// dispatched `setAppName` and `setConnectType` individually,
				// which produced TWO undo entries per call — the user had to
				// hit ctrl-z twice to roll back a single "Rename + toggle" edit.
				const mutations: Mutation[] = [];
				if (patch.app_name !== undefined) {
					mutations.push({ kind: "setAppName", name: patch.app_name });
				}
				if (patch.connect_type !== undefined) {
					// Legacy accepted `string`; coerce to the narrower enum. Empty
					// string is normalized to `null` (= connect disabled) to match
					// the blueprint schema where absent connect_type means "not
					// a connect app".
					const narrowed: ConnectType | null =
						patch.connect_type === ""
							? null
							: (patch.connect_type as ConnectType);
					mutations.push({
						kind: "setConnectType",
						connectType: narrowed,
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
