/**
 * User-facing mutation API for the BlueprintDoc store.
 *
 * Every consumer that edits a module, form, or field calls this hook
 * and dispatches via the returned action object. All signatures take
 * uuid-first parameters — callers read uuids from `useLocation()` or
 * direct doc store subscriptions. No legacy (mIdx, fIdx, path) resolution.
 *
 * Internally, each method:
 *   1. Reads the CURRENT doc snapshot via `store.getState()` (not the
 *      snapshot at hook construction) so uuid validation always targets
 *      the freshest state, even after intervening mutations.
 *   2. Validates the uuid exists in the current doc (form, field, or
 *      module entity map).
 *   3. Dispatches a `Mutation` through `store.getState().apply(...)`,
 *      which the Phase 1a reducer in `lib/doc/mutations/index.ts`
 *      translates into draft edits on the Immer-backed store.
 *
 * Missing references (unknown uuid) are silently swallowed with a
 * dev-mode `console.warn`. The legacy engine behaved the same way:
 * no-op rather than throw, so the UI never crashes on a stale selection
 * held over a reload or undo.
 *
 * NOTE: Public method names (addQuestion, moveQuestion, etc.) are kept
 * for Phase 1 compat — components/ still calls these names. Task 21
 * renames both the methods and their call sites together.
 */

import { useContext, useMemo } from "react";
import { flattenQuestions } from "@/lib/doc/converter";
import type { MoveFieldResult } from "@/lib/doc/mutations/fields";
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
import type { FieldPatch } from "@/lib/domain";
import type {
	BlueprintForm,
	BlueprintModule,
	CaseProperty,
	CaseType,
	ConnectType,
	Question,
} from "@/lib/schemas/blueprint";
import { decomposeFormEntity } from "@/lib/services/normalizedState";
import type { QuestionPath } from "@/lib/services/questionPath";

/**
 * Result of a `renameQuestion` dispatch.
 *
 * `conflict: true` short-circuits the dispatch — the hook checks sibling
 * ids BEFORE calling the reducer so the UI can surface a "name already
 * taken" message without unwinding a half-applied mutation.
 * `xpathFieldsRewritten` reflects the number of XPath expression fields
 * that were rewritten by the reducer to reference the new field ID.
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
 * field in the UI immediately. Computed by diffing parent order
 * arrays before and after the dispatch (the reducer itself doesn't
 * return the new uuid). `undefined` if the dispatch was a no-op.
 */
export interface DuplicateQuestionResult {
	newPath: QuestionPath;
	newUuid: string;
}

/** @deprecated Use MoveFieldResult — kept for Task 21 consumers */
export type MoveQuestionResult = MoveFieldResult;

/**
 * The full mutation surface returned by `useBlueprintMutations()`.
 *
 * All signatures take uuids directly — no legacy (mIdx, fIdx, path)
 * resolution. Callers read uuids from `useLocation()` or direct doc
 * store subscriptions, then pass them here.
 *
 * NOTE: Method names are the legacy question-named surface. Task 21
 * renames them to field-named equivalents.
 */
export interface BlueprintMutations {
	// ── Field mutations (exposed as question-named for Phase 1 compat) ───
	/**
	 * Insert a new field into a parent container (form or group/repeat).
	 *
	 * Returns the new field's uuid so callers can drive selection or
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
	 * Update fields on an existing field entity. Callers pass `undefined` for
	 * any field value to clear it — no `null` coercion needed.
	 *
	 * The patch type is `FieldPatch` — a union-wide partial that permits
	 * any known property across Field variants. Because `Field` is a
	 * discriminated union, `Partial<Omit<Field, "uuid">>` would reject
	 * literals like `{ label: "..." }` (some variants have no `label`).
	 * `FieldPatch` is the union of every variant's partial, which captures
	 * what the reducer actually allows: merge any recognized scalar property
	 * without changing the kind.
	 */
	updateQuestion: (uuid: Uuid, patch: FieldPatch) => void;
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
	) => MoveFieldResult;
	duplicateQuestion: (uuid: Uuid) => DuplicateQuestionResult | undefined;

	// ── Form mutations ────────────────────────────────────────────────────
	/** Insert a new form into a module. Returns the new form's uuid.
	 *  Accepts a form without a uuid — the hook mints one for the new entity. */
	addForm: (
		moduleUuid: Uuid,
		form: Omit<BlueprintForm, "uuid"> & { uuid?: string },
	) => Uuid;
	/**
	 * Update fields on an existing form. Patches use camelCase field names
	 * matching `FormEntity` (e.g. `closeCondition`, `postSubmit`).
	 */
	updateForm: (uuid: Uuid, patch: Partial<Omit<FormEntity, "uuid">>) => void;
	removeForm: (uuid: Uuid) => void;
	/** Replace a form's metadata + field subtree. The `form` argument's
	 *  `uuid` field (if present) is ignored — the destination uuid is the
	 *  first argument; nested fields keep their own uuids. */
	replaceForm: (
		uuid: Uuid,
		form: Omit<BlueprintForm, "uuid"> & { uuid?: string },
	) => void;

	// ── Module mutations ──────────────────────────────────────────────────
	/** Insert a new module. Returns the new module's uuid.
	 *  Accepts a module without a uuid — the hook mints one for the new entity. */
	addModule: (
		module: Omit<BlueprintModule, "uuid"> & { uuid?: string },
	) => Uuid;
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
	/**
	 * Update a single property on a case type's property list.
	 *
	 * Reads the current `caseTypes` from the doc, finds the matching case
	 * type by name and property by name, merges the updates, and dispatches
	 * a `setCaseTypes` mutation with the new array. Silently no-ops if the
	 * case type or property doesn't exist (fail-open, consistent with other
	 * mutation methods).
	 */
	updateCaseProperty: (
		caseTypeName: string,
		propertyName: string,
		updates: Partial<Omit<CaseProperty, "name">>,
	) => void;

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
 * Build a reverse `childUuid → parentUuid` index in a single pass over
 * `doc.fieldOrder`. O(N) over total fields. Callers that need to
 * walk up the parent chain multiple times (rename, duplicate, or
 * bulk-path operations) should build this once and pass it to
 * `computePathForUuid` / `findParentUuid` instead of re-scanning for
 * every walk — the naive version was O(N × D) per walk and O(N² × D)
 * when called multiple times in the same dispatch.
 */
function buildParentIndex(doc: BlueprintDoc): Map<Uuid, Uuid> {
	const parentOfUuid = new Map<Uuid, Uuid>();
	for (const [parentUuid, order] of Object.entries(doc.fieldOrder)) {
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
 * field entity, or the walk never hits a form). The cycle guard is
 * defensive — `buildParentIndex` cannot produce a cycle from a
 * well-formed `fieldOrder`, but corruption shouldn't hang the UI.
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
		const field = doc.fields[cursor];
		if (!field) return undefined;
		segments.push(field.id);
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
				// field that can contain children.
				if (
					doc.forms[parentUuid] === undefined &&
					doc.fields[parentUuid] === undefined
				) {
					warnUnresolved("addQuestion", { parentUuid });
					return "" as Uuid;
				}

				// Resolve insertion index from afterUuid / beforeUuid / atIndex.
				// atIndex takes precedence (matches legacy semantics where
				// numeric index is documented as authoritative).
				const order = doc.fieldOrder[parentUuid] ?? [];
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
				// via `fieldOrder`, so we strip `children` before dispatching.
				// Callers inserting a whole subtree should use `applyMany` with one
				// `addField` per descendant instead.
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
					kind: "addField",
					parentUuid,
					field: entity,
					index,
				});
				return uuid;
			},

			updateQuestion(uuid, patch) {
				const doc = get();
				if (!doc.fields[uuid]) {
					warnUnresolved("updateQuestion", { uuid });
					return;
				}
				dispatch({
					kind: "updateField",
					uuid,
					patch,
				});
			},

			removeQuestion(uuid) {
				const doc = get();
				if (!doc.fields[uuid]) {
					warnUnresolved("removeQuestion", { uuid });
					return;
				}
				dispatch({ kind: "removeField", uuid });
			},

			renameQuestion(uuid, newId) {
				const doc = get();
				const field = doc.fields[uuid];
				if (!field) {
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
					const siblings = doc.fieldOrder[parentUuid] ?? [];
					for (const sibUuid of siblings) {
						if (sibUuid === uuid) continue;
						if (doc.fields[sibUuid]?.id === newId) {
							return {
								newPath: "" as QuestionPath,
								xpathFieldsRewritten: 0,
								conflict: true,
							};
						}
					}
				}

				// Dispatch via `applyWithResult` to capture the xpath rewrite count.
				// The reducer returns `undefined` if the target entity vanishes
				// between our pre-check and the Immer draft — defensive fallback
				// to zero rewrites so callers always see a valid number.
				const meta = store.getState().applyWithResult({
					kind: "renameField",
					uuid,
					newId,
				});

				/* Compute the new path AFTER dispatch — the semantic id has
				 * changed. Rebuild the parent index from the post-dispatch
				 * snapshot: `renameField` doesn't reparent, but the walk
				 * needs to read `doc.fields[...].id` from the fresh
				 * snapshot anyway, so reuse that same snapshot's index. */
				const after = get();
				const afterParentIndex = buildParentIndex(after);
				const newPath = (computePathForUuid(after, uuid, afterParentIndex) ??
					"") as QuestionPath;
				return {
					newPath,
					xpathFieldsRewritten: meta?.xpathFieldsRewritten ?? 0,
				};
			},

			moveQuestion(uuid, opts) {
				const doc = get();
				const field = doc.fields[uuid];
				if (!field) {
					warnUnresolved("moveQuestion", { uuid });
					return {};
				}

				// Default destination: the field's current parent (same-parent
				// reorder). Fall back to the field's own uuid as a guard — this
				// is unreachable in practice because every field has a parent
				// entry in `fieldOrder`. `buildParentIndex` gives O(1) lookup
				// instead of an `Object.entries(...).find(order.includes(...))`
				// linear+linear scan.
				const toParentUuid =
					opts.toParentUuid ?? buildParentIndex(doc).get(uuid) ?? uuid;

				// Virtual post-splice order when same-parent move. When the source
				// uuid appears in the destination parent, emulate the post-splice
				// state so the returned index aligns with where the reducer will
				// actually insert after it removes the source uuid.
				const base = doc.fieldOrder[toParentUuid] ?? [];
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
				// Returns `undefined` if the target entity vanishes between our
				// pre-check and the Immer draft — fallback to empty result so
				// callers always see a valid `MoveFieldResult`.
				return (
					store.getState().applyWithResult({
						kind: "moveField",
						uuid,
						toParentUuid,
						toIndex,
					}) ?? {}
				);
			},

			duplicateQuestion(uuid) {
				const doc = get();
				if (!doc.fields[uuid]) {
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
				const beforeOrder = [...(doc.fieldOrder[parentUuid] ?? [])];
				const beforeSet = new Set(beforeOrder);

				dispatch({ kind: "duplicateField", uuid });

				// Diff the post-dispatch order against the snapshot to find the
				// new clone. Only one uuid should be new.
				const afterDoc = get();
				const afterOrder = afterDoc.fieldOrder[parentUuid] ?? [];
				const newUuid = afterOrder.find((u) => !beforeSet.has(u));
				if (!newUuid) return undefined;

				// Rebuild the new path: parent path (if any) + new field id.
				// The post-dispatch parent index differs from the pre-dispatch
				// one (the clone is now a child of `parentUuid`) — rebuild from
				// the fresh snapshot so the walk sees the new entry.
				const cloneEntity = afterDoc.fields[newUuid];
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
				// scalars. Callers wanting to insert a form plus its fields in
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
				/* Wholesale form swap. The reducer's `replaceForm` variant
				 * expects a form entity + pre-flattened field entities + a
				 * `fieldOrder` map for the replacement subtree. We walk the
				 * incoming nested form directly via `flattenQuestions` (the same
				 * helper `toDoc` uses) and decompose the form's metadata fields
				 * via `decomposeFormEntity`. The destination uuid is stamped
				 * onto a copy of the incoming form so `decomposeFormEntity`'s
				 * required-uuid contract is satisfied without mutating the
				 * caller's reference. */
				const doc = get();
				if (!doc.forms[uuid]) {
					warnUnresolved("replaceForm", { uuid });
					return;
				}

				const formWithUuid: BlueprintForm = { ...form, uuid };
				const nForm = decomposeFormEntity(formWithUuid);
				const replacement = nForm as unknown as FormEntity;

				/* Flatten the nested field tree into doc shape. Top-level
				 * fields are keyed under the destination form uuid; nested
				 * group/repeat children are keyed under their parent field
				 * uuid (handled recursively by flattenQuestions). */
				const fieldsMap: Record<Uuid, QuestionEntity> = {};
				const fieldOrder: Record<Uuid, Uuid[]> = {};
				fieldOrder[uuid] = flattenQuestions(
					form.questions ?? [],
					fieldsMap,
					fieldOrder,
				);
				const fields = Object.values(fieldsMap);

				dispatch({
					kind: "replaceForm",
					uuid,
					form: replacement,
					fields,
					fieldOrder,
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

			updateCaseProperty(caseTypeName, propertyName, updates) {
				const doc = get();
				const currentCaseTypes = doc.caseTypes;
				if (!currentCaseTypes) {
					warnUnresolved("updateCaseProperty", { caseTypeName, propertyName });
					return;
				}
				const ctIndex = currentCaseTypes.findIndex(
					(ct) => ct.name === caseTypeName,
				);
				if (ctIndex === -1) {
					warnUnresolved("updateCaseProperty", {
						caseTypeName,
						reason: "case type not found",
					});
					return;
				}
				const ct = currentCaseTypes[ctIndex];
				const propIndex = ct.properties.findIndex(
					(p) => p.name === propertyName,
				);
				if (propIndex === -1) {
					warnUnresolved("updateCaseProperty", {
						caseTypeName,
						propertyName,
						reason: "property not found",
					});
					return;
				}
				// Build a new caseTypes array with the updated property. Immutable
				// construction avoids mutating the Immer-frozen snapshot.
				const nextCaseTypes = currentCaseTypes.map((caseType, i) => {
					if (i !== ctIndex) return caseType;
					return {
						...caseType,
						properties: caseType.properties.map((p, j) =>
							j === propIndex ? { ...p, ...updates } : p,
						),
					};
				});
				dispatch({ kind: "setCaseTypes", caseTypes: nextCaseTypes });
			},

			applyMany(mutations) {
				// Batch dispatch — the store's `applyMany` wraps the whole set
				// in one `set()` call so zundo records exactly one undo entry.
				store.getState().applyMany(mutations);
			},
		};
	}, [store]);
}
