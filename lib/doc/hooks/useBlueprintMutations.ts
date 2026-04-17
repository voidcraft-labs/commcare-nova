/**
 * User-facing mutation API for the BlueprintDoc store — domain-native.
 *
 * Every consumer that edits a module, form, or field calls this hook
 * and dispatches via the returned action object. All signatures take
 * uuid-first parameters and domain types (`Field`, `Form`, `Module`,
 * `FieldPatch`). No legacy `Question` / `BlueprintForm` / `AppBlueprint`
 * shape crosses this boundary — tool handlers that speak to the LLM
 * translate at their own wire boundary before calling here.
 *
 * Internally, each method:
 *   1. Reads the CURRENT doc snapshot via `store.getState()` (not the
 *      snapshot at hook construction) so uuid validation always targets
 *      the freshest state, even after intervening mutations.
 *   2. Validates the uuid exists in the current doc (form, field, or
 *      module entity map).
 *   3. Dispatches a `Mutation` through `store.getState().applyMany([...])`
 *      — the ONE public write path — which the reducer in
 *      `lib/doc/mutations/index.ts` translates into draft edits on the
 *      Immer-backed store. The two mutations that produce metadata
 *      (`renameField`, `moveField`) destructure position `[0]` of the
 *      returned `MutationResult[]`.
 *
 * Missing references (unknown uuid) are silently swallowed with a
 * dev-mode `console.warn`. The engine behaved the same way: no-op rather
 * than throw, so the UI never crashes on a stale selection held over a
 * reload or undo.
 */

import { useContext, useMemo } from "react";
import { BlueprintDocContext } from "@/lib/doc/provider";
import type {
	BlueprintDoc,
	FieldRenameMeta,
	MoveFieldResult,
	Mutation,
	MutationResult,
	Uuid,
} from "@/lib/doc/types";
import {
	asUuid,
	type CaseProperty,
	type CaseType,
	type ConnectType,
	type Field,
	type FieldKind,
	type FieldPatch,
	type Form,
	type Module,
} from "@/lib/domain";
import type { QuestionPath } from "@/lib/services/questionPath";

/**
 * Result of a `renameField` dispatch.
 *
 * `conflict: true` short-circuits the dispatch — the hook checks sibling
 * ids BEFORE calling the reducer so the UI can surface a "name already
 * taken" message without unwinding a half-applied mutation.
 * `xpathFieldsRewritten` reflects the number of XPath expression fields
 * that were rewritten by the reducer to reference the new field ID.
 */
export interface FieldRenameResult {
	newPath: QuestionPath;
	xpathFieldsRewritten: number;
	conflict?: boolean;
}

/**
 * Result of a `duplicateField` dispatch.
 *
 * Returns the clone's new path and UUID so callers can focus the new
 * field in the UI immediately. Computed by diffing parent order
 * arrays before and after the dispatch (the reducer itself doesn't
 * return the new uuid). `undefined` if the dispatch was a no-op.
 */
export interface DuplicateFieldResult {
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
	// ── Field mutations ───────────────────────────────────────────────────
	/**
	 * Insert a new field into a parent container (form or group/repeat).
	 *
	 * Returns the new field's uuid so callers can drive selection or
	 * navigation. Returns the empty string (branded as `Uuid`) on a no-op
	 * (e.g. unrecognized `parentUuid`).
	 *
	 * Accepts a Field without uuid — the hook mints one via
	 * `crypto.randomUUID()`. Callers that already own a uuid (e.g. the
	 * replay stream) can pass it through the optional `uuid` field on the
	 * input object and it will be used verbatim.
	 */
	addField: <K extends FieldKind>(
		parentUuid: Uuid,
		field: { kind: K } & Omit<Extract<Field, { kind: K }>, "uuid" | "kind"> & {
				uuid?: string;
			},
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
	updateField: (uuid: Uuid, patch: FieldPatch) => void;
	removeField: (uuid: Uuid) => void;
	renameField: (uuid: Uuid, newId: string) => FieldRenameResult;
	moveField: (
		uuid: Uuid,
		opts: {
			toParentUuid?: Uuid;
			afterUuid?: Uuid;
			beforeUuid?: Uuid;
			toIndex?: number;
		},
	) => MoveFieldResult;
	duplicateField: (uuid: Uuid) => DuplicateFieldResult | undefined;
	/**
	 * Convert a field to a different kind atomically.
	 *
	 * Unlike the ad-hoc `saveField("kind", ...)` path it replaces, this
	 * dispatches a `convertField` mutation that runs the kind swap inside
	 * the reducer — one atomic undo entry, one clean event log entry, and
	 * the schema-driven key reconciliation handles options / validation /
	 * hint preservation per kind's Zod schema.
	 *
	 * Silently no-ops when the uuid is unknown or when the source kind
	 * equals the target kind.
	 */
	convertField: (uuid: Uuid, toKind: FieldKind) => void;

	// ── Form mutations ────────────────────────────────────────────────────
	/** Insert a new form into a module. Returns the new form's uuid.
	 *  Accepts a form without a uuid — the hook mints one for the new entity. */
	addForm: (
		moduleUuid: Uuid,
		form: Omit<Form, "uuid"> & { uuid?: string },
	) => Uuid;
	/**
	 * Update fields on an existing form. Patches use camelCase domain property
	 * names (e.g. `closeCondition`, `postSubmit`).
	 */
	updateForm: (uuid: Uuid, patch: Partial<Omit<Form, "uuid">>) => void;
	removeForm: (uuid: Uuid) => void;

	// ── Module mutations ──────────────────────────────────────────────────
	/** Insert a new module. Returns the new module's uuid.
	 *  Accepts a module without a uuid — the hook mints one for the new entity. */
	addModule: (module: Omit<Module, "uuid"> & { uuid?: string }) => Uuid;
	updateModule: (uuid: Uuid, patch: Partial<Omit<Module, "uuid">>) => void;
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
	 *
	 * Returns the reducer's per-mutation results in input order. Callers
	 * that need metadata from specific positions (`renameField`, `moveField`)
	 * destructure by index and narrow via `as FieldRenameMeta | undefined` /
	 * `as MoveFieldResult | undefined`.
	 */
	applyMany: (mutations: Mutation[]) => MutationResult[];
}

/**
 * Dev-only warning for silent no-ops.
 *
 * Every mutation method bails out silently when a uuid can't be found
 * in the current doc — matching the legacy engine's behavior, which the
 * UI relies on so stale selections don't crash the tree. In development
 * we still want visibility into which lookups are failing so bugs don't
 * hide behind the fail-open contract. Stripped by the production build
 * via the `NODE_ENV` check.
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
 * Walk from a uuid up to its owning form, joining semantic ids into a
 * slash-delimited path.
 *
 * Reads the store's already-maintained `doc.fieldParent` reverse index
 * directly — rebuilding a parallel Map here would be wasted work (the
 * index is rebuilt atomically by every mutation that touches ordering).
 *
 * Returns `undefined` when the uuid is unreachable (cycle, missing
 * field entity, or the walk never hits a form). The cycle guard is
 * defensive — a well-formed `fieldParent` cannot produce a cycle, but
 * corruption shouldn't hang the UI.
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
		const field = doc.fields[cursor];
		if (!field) return undefined;
		segments.push(field.id);
		// `fieldParent` returns `null` at the form boundary and `undefined` for
		// orphans — both terminate the walk without revisiting.
		const parent: Uuid | null | undefined = doc.fieldParent[cursor];
		cursor = parent ?? undefined;
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

		return {
			addField(parentUuid, field, opts) {
				const doc = get();
				// Verify parent exists — must be either a form or a group/repeat
				// field that can contain children.
				if (
					doc.forms[parentUuid] === undefined &&
					doc.fields[parentUuid] === undefined
				) {
					warnUnresolved("addField", { parentUuid });
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

				// Mint a uuid if the caller didn't supply one. FieldTypePicker
				// and the SA tool handlers pass shapes without uuids and rely on
				// the store to generate identity.
				const maybeUuid = field.uuid;
				const uuid = asUuid(
					typeof maybeUuid === "string" && maybeUuid.length > 0
						? maybeUuid
						: crypto.randomUUID(),
				);
				// Field is a discriminated union; the narrowed generic input is a
				// specific variant's Omit — we stamp the uuid and cast via
				// `unknown` because the distributive Omit shape doesn't round-trip
				// back to the full union narrowly (TS limitation around Omit +
				// discriminated unions).
				const entity = { ...field, uuid } as unknown as Field;

				store.getState().applyMany([
					{
						kind: "addField",
						parentUuid,
						field: entity,
						index,
					},
				]);
				return uuid;
			},

			updateField(uuid, patch) {
				const doc = get();
				if (!doc.fields[uuid]) {
					warnUnresolved("updateField", { uuid });
					return;
				}
				store.getState().applyMany([
					{
						kind: "updateField",
						uuid,
						patch,
					},
				]);
			},

			removeField(uuid) {
				const doc = get();
				if (!doc.fields[uuid]) {
					warnUnresolved("removeField", { uuid });
					return;
				}
				store.getState().applyMany([{ kind: "removeField", uuid }]);
			},

			renameField(uuid, newId) {
				const doc = get();
				const field = doc.fields[uuid];
				if (!field) {
					warnUnresolved("renameField", { uuid });
					return {
						newPath: "" as QuestionPath,
						xpathFieldsRewritten: 0,
					};
				}

				// Find parent + siblings for conflict check. Reject the rename
				// before dispatching so the UI can surface a "name already taken"
				// message without unwinding a half-applied mutation.
				const parentUuid = doc.fieldParent[uuid] ?? undefined;
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

				// Dispatch via the single write path. Position `[0]` of the
				// returned array carries the reducer's per-mutation result —
				// narrow it to `FieldRenameMeta` so we can read the xpath
				// rewrite count. The reducer returns `undefined` if the target
				// entity vanishes between our pre-check and the Immer draft —
				// defensive fallback to zero rewrites so callers always see a
				// valid number.
				const [result] = store
					.getState()
					.applyMany([{ kind: "renameField", uuid, newId }]);
				const meta = result as FieldRenameMeta | undefined;

				/* Compute the new path AFTER dispatch — the semantic id has
				 * changed. `renameField` doesn't reparent, so `fieldParent`
				 * is unchanged, but the walk needs the post-dispatch snapshot
				 * of `fields` to read the new id. */
				const after = get();
				const newPath = (computePathForUuid(after, uuid) ?? "") as QuestionPath;
				return {
					newPath,
					xpathFieldsRewritten: meta?.xpathFieldsRewritten ?? 0,
				};
			},

			moveField(uuid, opts) {
				const doc = get();
				const field = doc.fields[uuid];
				if (!field) {
					warnUnresolved("moveField", { uuid });
					return { droppedCrossDepthRefs: 0 };
				}

				// Default destination: the field's current parent (same-parent
				// reorder). Fall back to the field's own uuid as a guard — this
				// is unreachable in practice because every field has a parent
				// entry in `fieldOrder`. Read the parent directly from the
				// store-maintained `fieldParent` reverse index (O(1)).
				const toParentUuid = opts.toParentUuid ?? doc.fieldParent[uuid] ?? uuid;

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

				// Dispatch via the single write path. Position `[0]` of the
				// returned array carries the reducer's rename metadata (populated
				// when cross-level dedup changes the id). The reducer returns
				// `undefined` if the target entity vanishes between our pre-check
				// and the Immer draft — fallback to a zeroed result so callers
				// always see a valid `MoveFieldResult`.
				const [result] = store
					.getState()
					.applyMany([{ kind: "moveField", uuid, toParentUuid, toIndex }]);
				return (
					(result as MoveFieldResult | undefined) ?? {
						droppedCrossDepthRefs: 0,
					}
				);
			},

			duplicateField(uuid) {
				const doc = get();
				if (!doc.fields[uuid]) {
					warnUnresolved("duplicateField", { uuid });
					return undefined;
				}

				// Snapshot the parent's order BEFORE dispatch so we can diff and
				// recover the new clone's uuid. The reducer splices the clone
				// right after the source; the post-dispatch order will contain
				// exactly one uuid that wasn't present before.
				const parentUuid = doc.fieldParent[uuid] ?? undefined;
				if (parentUuid === undefined) {
					warnUnresolved("duplicateField", {
						uuid,
						reason: "no parent",
					});
					return undefined;
				}
				const beforeOrder = [...(doc.fieldOrder[parentUuid] ?? [])];
				const beforeSet = new Set(beforeOrder);

				store.getState().applyMany([{ kind: "duplicateField", uuid }]);

				// Diff the post-dispatch order against the snapshot to find the
				// new clone. Only one uuid should be new.
				const afterDoc = get();
				const afterOrder = afterDoc.fieldOrder[parentUuid] ?? [];
				const newUuid = afterOrder.find((u) => !beforeSet.has(u));
				if (!newUuid) return undefined;

				// Rebuild the new path: parent path (if any) + new field id.
				// `fieldParent` is already up to date on `afterDoc` — the
				// dispatcher rebuilds it after the reducer runs.
				const cloneEntity = afterDoc.fields[newUuid];
				if (!cloneEntity) return undefined;
				const parentPath = afterDoc.forms[parentUuid]
					? "" // parent is the form root
					: (computePathForUuid(afterDoc, parentUuid) ?? "");
				const newPath = (
					parentPath ? `${parentPath}/${cloneEntity.id}` : cloneEntity.id
				) as QuestionPath;

				return { newPath, newUuid: newUuid as string };
			},

			convertField(uuid, toKind) {
				const doc = get();
				if (!doc.fields[uuid]) {
					// Include `toKind` so the dev-mode warn disambiguates the caller's
					// intent — a stale UI closure and a drifted SA dispatch present
					// identically without it. Matches the debug payload shape the
					// other multi-arg mutations (updateCaseProperty, etc.) use.
					warnUnresolved("convertField", { uuid, toKind });
					return;
				}
				store.getState().applyMany([{ kind: "convertField", uuid, toKind }]);
			},

			addForm(moduleUuid, form) {
				const doc = get();
				if (!doc.modules[moduleUuid]) {
					warnUnresolved("addForm", { moduleUuid });
					return "" as Uuid;
				}
				const maybeUuid = form.uuid;
				const formUuid = asUuid(
					typeof maybeUuid === "string" && maybeUuid.length > 0
						? maybeUuid
						: crypto.randomUUID(),
				);
				store.getState().applyMany([
					{
						kind: "addForm",
						moduleUuid,
						form: { ...form, uuid: formUuid } as Form,
					},
				]);
				return formUuid;
			},

			updateForm(uuid, patch) {
				const doc = get();
				if (!doc.forms[uuid]) {
					warnUnresolved("updateForm", { uuid });
					return;
				}
				store.getState().applyMany([
					{
						kind: "updateForm",
						uuid,
						patch,
					},
				]);
			},

			removeForm(uuid) {
				const doc = get();
				if (!doc.forms[uuid]) {
					warnUnresolved("removeForm", { uuid });
					return;
				}
				store.getState().applyMany([{ kind: "removeForm", uuid }]);
			},

			addModule(module) {
				const maybeUuid = module.uuid;
				const moduleUuid = asUuid(
					typeof maybeUuid === "string" && maybeUuid.length > 0
						? maybeUuid
						: crypto.randomUUID(),
				);
				store.getState().applyMany([
					{
						kind: "addModule",
						module: { ...module, uuid: moduleUuid } as Module,
					},
				]);
				return moduleUuid;
			},

			updateModule(uuid, patch) {
				const doc = get();
				if (!doc.modules[uuid]) {
					warnUnresolved("updateModule", { uuid });
					return;
				}
				store.getState().applyMany([{ kind: "updateModule", uuid, patch }]);
			},

			removeModule(uuid) {
				const doc = get();
				if (!doc.modules[uuid]) {
					warnUnresolved("removeModule", { uuid });
					return;
				}
				store.getState().applyMany([{ kind: "removeModule", uuid }]);
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
				store.getState().applyMany([{ kind: "setCaseTypes", caseTypes }]);
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
				store
					.getState()
					.applyMany([{ kind: "setCaseTypes", caseTypes: nextCaseTypes }]);
			},

			applyMany(mutations) {
				// Batch dispatch — the store's `applyMany` wraps the whole set
				// in one `set()` call so zundo records exactly one undo entry.
				// Returns the reducer's per-mutation results in input order;
				// surfaced here so callers can narrow specific positions.
				return store.getState().applyMany(mutations);
			},
		};
	}, [store]);
}
