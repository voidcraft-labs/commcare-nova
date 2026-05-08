/**
 * blueprintHelpers — SA-only pure helpers over `BlueprintDoc`.
 *
 * Two surfaces:
 *
 *   - Positional lookups the SA's tool handlers use to resolve a
 *     `(moduleIndex, formIndex, bareId)` triple to a `{ field, path, formUuid }`
 *     record: `findFieldByBareId`, `resolveFieldByIndex`.
 *   - Mutation builders that return `Mutation[]` for the caller to apply
 *     via `docStore.applyMany(mutations)`. Helpers cover every level of
 *     the tree (app / module / form / field) plus the scaffolding +
 *     case-type bulk operations used during initial generation.
 *
 * Nothing here mutates state directly; the mutation-first convention
 * keeps agent-side call sites and the store-side reducer decoupled.
 *
 * Kept in `lib/agent/` because every consumer lives here. The shared
 * `searchBlueprint` query lives at `lib/doc/searchBlueprint.ts` so the
 * client `useSearchBlueprint` hook stays on its side of the
 * server/client boundary.
 */

import { normalizeConnectConfig } from "@/lib/doc/connectConfig";
import { buildFieldTree, type FieldWithChildren } from "@/lib/doc/fieldWalk";
import type { Mutation } from "@/lib/doc/types";
import type {
	BlueprintDoc,
	CaseType,
	Column,
	ConnectConfig,
	Field,
	FieldKind,
	Form,
	FormType,
	Module,
	PostSubmitDestination,
	SearchInputDef,
	Uuid,
} from "@/lib/domain";
import { asUuid, fieldKinds, isContainer } from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import type { Scaffold } from "./scaffoldSchemas";

// ── Positional lookup helpers ───────────────────────────────────────────

/** Resolve a field by bare id within a form (first match, depth-first).
 *  Used by SA tools that receive "patient_name" without a path. */
export function findFieldByBareId(
	doc: BlueprintDoc,
	formUuid: Uuid,
	bareId: string,
): { field: Field; path: string } | undefined {
	// Stack-based DFS across the form's field subtree. We record the current
	// path prefix alongside each uuid so the returned `path` matches the
	// order of traversal (visual order of the form).
	const stack: Array<{ uuid: Uuid; prefix: string }> = [];
	const topOrder = doc.fieldOrder[formUuid] ?? [];
	// Push in reverse so iteration order matches visual form order.
	for (let i = topOrder.length - 1; i >= 0; i--) {
		stack.push({ uuid: topOrder[i], prefix: "" });
	}
	while (stack.length > 0) {
		const next = stack.pop();
		if (!next) break;
		const { uuid, prefix } = next;
		const field = doc.fields[uuid];
		if (!field) continue;
		const path = prefix ? `${prefix}/${field.id}` : field.id;
		if (field.id === bareId) return { field, path };
		// Only container kinds have children in the order map.
		if (isContainer(field)) {
			const children = doc.fieldOrder[uuid] ?? [];
			for (let i = children.length - 1; i >= 0; i--) {
				stack.push({ uuid: children[i], prefix: path });
			}
		}
	}
	return undefined;
}

/**
 * Given a (module index, form index, bareId) triple — the SA's
 * positional lookup shape — resolve the field's uuid + path in the
 * normalized doc. Internal tool handlers can then dispatch mutations
 * uuid-first without tracking indices themselves.
 */
export function resolveFieldByIndex(
	doc: BlueprintDoc,
	moduleIndex: number,
	formIndex: number,
	bareId: string,
): { field: Field; path: string; formUuid: Uuid } | undefined {
	const moduleUuid = doc.moduleOrder[moduleIndex];
	if (!moduleUuid) return undefined;
	const formUuids = doc.formOrder[moduleUuid] ?? [];
	const formUuid = formUuids[formIndex];
	if (!formUuid) return undefined;
	const resolved = findFieldByBareId(doc, formUuid, bareId);
	if (!resolved) return undefined;
	return { ...resolved, formUuid };
}

/**
 * Map a `(moduleIndex, formIndex)` pair to the doc's form uuid. Returns
 * `undefined` when either index is out of range — tool bodies surface
 * that as an error string to the SA.
 *
 * The lighter cousin of `resolveFieldByIndex`: callers that don't need a
 * field lookup (per-form reads, structural edits) use this to skip the
 * DFS walk over the form's field subtree.
 */
export function resolveFormUuid(
	doc: BlueprintDoc,
	moduleIndex: number,
	formIndex: number,
): Uuid | undefined {
	const moduleUuid = doc.moduleOrder[moduleIndex];
	if (!moduleUuid) return undefined;
	const formUuids = doc.formOrder[moduleUuid] ?? [];
	return formUuids[formIndex];
}

/**
 * The four handles shared tool modules need when resolving a positional
 * `(moduleIndex, formIndex)` triple: the `moduleUuid` / `formUuid` for
 * mutation emission and index → uuid resolution, plus the `mod` / `form`
 * entities for the `form.type` + `mod.caseType` signals downstream
 * helpers (e.g. `applyDefaults`) consume.
 */
export interface FormContext {
	moduleUuid: Uuid;
	mod: Module;
	formUuid: Uuid;
	form: Form;
}

/**
 * Resolve the module + form entities for a positional
 * `(moduleIndex, formIndex)` triple. Returns `undefined` when either
 * index is out of range — callers map that to a tool-specific error
 * string, so the message wording stays at the call site and the SA
 * keeps its existing voice.
 *
 * Use this instead of `resolveFormUuid` when the tool body also needs
 * the resolved `mod` / `form` entities (e.g. `form.type` for preload
 * auto-defaults, `mod.caseType` for case-type lookup). The shared add-
 * path pipeline in `contentProcessing.applyDefaults` consumes both.
 */
export function resolveFormContext(
	doc: BlueprintDoc,
	moduleIndex: number,
	formIndex: number,
): FormContext | undefined {
	const moduleUuid = doc.moduleOrder[moduleIndex];
	if (!moduleUuid) return undefined;
	const mod = doc.modules[moduleUuid];
	if (!mod) return undefined;
	const formUuid = doc.formOrder[moduleUuid]?.[formIndex];
	if (!formUuid) return undefined;
	const form = doc.forms[formUuid];
	if (!form) return undefined;
	return { moduleUuid, mod, formUuid, form };
}

// ── Form-tree snapshot ──────────────────────────────────────────────────

/**
 * Shape returned by `formSnapshot` — the form entity augmented with its
 * ordered, nested field tree. Uses the domain `Form` type verbatim so
 * downstream consumers (SA `getForm` tool, MCP adapter) read domain
 * names (`closeCondition`, `postSubmit`, `formLinks`) and don't carry
 * any CommCare wire-format translation.
 *
 * Lives alongside the positional lookup helpers because it's a
 * `BlueprintDoc`-read derived shape — the same category of surface.
 */
export type FormSnapshot = Form & { fields: FieldWithChildren[] };

/**
 * Build a `FormSnapshot` for the given form uuid. Returns `undefined`
 * when the form doesn't exist in the doc — callers surface that as a
 * "form not found" error to the SA.
 */
export function formSnapshot(
	doc: BlueprintDoc,
	formUuid: Uuid,
): FormSnapshot | undefined {
	const form = doc.forms[formUuid];
	if (!form) return undefined;
	return { ...form, fields: buildFieldTree(doc, formUuid) };
}

// ── Mutation builders — app level ───────────────────────────────────────

/** Replace the app's case-type catalog wholesale. */
export function setCaseTypesMutations(
	caseTypes: CaseType[] | null,
): Mutation[] {
	return [{ kind: "setCaseTypes", caseTypes }];
}

// ── Mutation builders — modules ─────────────────────────────────────────

/** Input shape for a new module. `uuid` may be supplied to pin identity
 *  (e.g. during scaffold), otherwise the helper mints one. */
export interface NewModuleInput {
	uuid?: string;
	id?: string;
	name: string;
	caseType?: string;
	caseListOnly?: boolean;
	purpose?: string;
	caseListConfig?: Module["caseListConfig"];
}

/** Build an `addModule` mutation. Mints a uuid when the caller doesn't
 *  supply one — mirrors the producer-side stamp pattern established by
 *  `addField` in the reducer. Accepts an optional `index` for ordered
 *  insertion; omit to append at the end. */
export function addModuleMutations(
	_doc: BlueprintDoc,
	input: NewModuleInput,
	opts?: { index?: number },
): Mutation[] {
	const uuid = asUuid(
		typeof input.uuid === "string" && input.uuid.length > 0
			? input.uuid
			: crypto.randomUUID(),
	);
	const module: Module = {
		uuid,
		// Modules carry a semantic `id` alongside their display `name`. SA
		// callers typically only know the name; derive a slug when id is
		// absent so round-tripping through the store stays consistent.
		id: input.id ?? slugifyModuleId(input.name),
		name: input.name,
		...(input.caseType !== undefined && { caseType: input.caseType }),
		...(input.caseListOnly !== undefined && {
			caseListOnly: input.caseListOnly,
		}),
		...(input.purpose !== undefined && { purpose: input.purpose }),
		...(input.caseListConfig !== undefined && {
			caseListConfig: input.caseListConfig,
		}),
	};
	return [
		{
			kind: "addModule",
			module,
			...(opts?.index !== undefined && { index: opts.index }),
		},
	];
}

/** Remove a module (cascades forms + fields via the reducer). No-op when
 *  the uuid isn't present in the current doc. */
export function removeModuleMutations(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): Mutation[] {
	if (doc.modules[moduleUuid] === undefined) return [];
	return [{ kind: "removeModule", uuid: moduleUuid }];
}

/** Patch module fields. Keys mirror the domain Module shape (camelCase). */
export function updateModuleMutations(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	patch: Partial<Omit<Module, "uuid">>,
): Mutation[] {
	if (doc.modules[moduleUuid] === undefined) return [];
	return [{ kind: "updateModule", uuid: moduleUuid, patch }];
}

// ── Mutation builders — case list config ────────────────────────────────
//
// One pair of helpers per case-list slot — `caseListConfig.columns`
// and `caseListConfig.searchInputs`. Each pair (`add`, `update`,
// `remove`, `reorder`) returns a tagged result the SA tool surface
// destructures: success → `Mutation[]` ready to record; failure →
// Elm-style error string the tool forwards verbatim. Failure returns
// expose the underlying predicate (uuid not found, length mismatch,
// duplicate, unknown, missing) so the SA can repair its call.
//
// Other (non-SA) consumers — UI mutations, future migration scripts —
// destructure the same shape and surface their own error UI.

/**
 * Tagged result of a case-list-config mutation builder. The success
 * arm carries the ready-to-record `Mutation[]`; the failure arm carries
 * a single human-readable error string.
 */
export type CaseListMutationResult =
	| { ok: true; mutations: Mutation[] }
	| { error: string };

/**
 * Snapshot a module's `caseListConfig` with empty arrays in the unset
 * slots. Read by every case-list mutation builder so the surrounding
 * slots carry through the patch even when the module had no config
 * yet. `filter` stays absent rather than `undefined` because the
 * schema treats absence as "no filter" and a literal `undefined` would
 * round-trip as an explicit clear at the reducer's `Object.assign`.
 */
function snapshotCaseListConfig(mod: Module): {
	columns: Column[];
	searchInputs: SearchInputDef[];
	filter?: Predicate;
} {
	const config = mod.caseListConfig;
	if (config === undefined) return { columns: [], searchInputs: [] };
	return {
		columns: [...config.columns],
		searchInputs: [...config.searchInputs],
		...(config.filter !== undefined && { filter: config.filter }),
	};
}

/**
 * Replace the entry whose `uuid` matches `targetUuid` with `replacement`.
 * Returns the post-mutation array as a fresh copy on success, or an
 * Elm-style error message naming the missing uuid.
 */
function replaceByUuid<T extends { uuid: Uuid }>(
	items: readonly T[],
	targetUuid: Uuid,
	replacement: T,
	entityLabel: string,
): { ok: true; items: T[] } | { error: string } {
	const index = items.findIndex((item) => item.uuid === targetUuid);
	if (index < 0) {
		return {
			error: `Tried to update ${entityLabel} ${targetUuid}. Found no entry with that uuid in the module's case list. Look at getModule's projection or run searchBlueprint to surface the current uuids.`,
		};
	}
	const next = items.slice();
	next[index] = replacement;
	return { ok: true, items: next };
}

/**
 * Drop the entry whose `uuid` matches `targetUuid`. Returns the post-
 * mutation array on success, or an Elm-style error naming the missing
 * uuid.
 */
function removeByUuid<T extends { uuid: Uuid }>(
	items: readonly T[],
	targetUuid: Uuid,
	entityLabel: string,
): { ok: true; items: T[] } | { error: string } {
	const index = items.findIndex((item) => item.uuid === targetUuid);
	if (index < 0) {
		return {
			error: `Tried to remove ${entityLabel} ${targetUuid}. Found no entry with that uuid in the module's case list. Look at getModule's projection or run searchBlueprint to surface the current uuids.`,
		};
	}
	const next = items.slice();
	next.splice(index, 1);
	return { ok: true, items: next };
}

/**
 * Reorder the array to match `requestedOrder`. The sequence must be a
 * permutation of the current uuids — every existing uuid present, no
 * duplicates, no unknowns. Four failure arms surface predictably so
 * the caller can repair its request.
 */
function reorderByUuid<T extends { uuid: Uuid }>(
	items: readonly T[],
	requestedOrder: readonly Uuid[],
	entityLabel: string,
): { ok: true; items: T[] } | { error: string } {
	if (requestedOrder.length !== items.length) {
		return {
			error: `Tried to reorder ${entityLabel}s. Found ${items.length} entries on the module but the request supplied ${requestedOrder.length} uuids. Try a uuid array that contains every existing uuid exactly once.`,
		};
	}
	const seen = new Set<Uuid>();
	for (const uuid of requestedOrder) {
		if (seen.has(uuid)) {
			return {
				error: `Tried to reorder ${entityLabel}s. Found duplicate uuid ${uuid} in the requested order. Try a uuid array with each existing uuid listed exactly once.`,
			};
		}
		seen.add(uuid);
	}
	const byUuid = new Map<Uuid, T>();
	for (const item of items) {
		byUuid.set(item.uuid, item);
	}
	const next: T[] = [];
	for (const uuid of requestedOrder) {
		const item = byUuid.get(uuid);
		if (item === undefined) {
			return {
				error: `Tried to reorder ${entityLabel}s. Found unknown uuid ${uuid} in the requested order — that uuid is not present on the module. Look at getModule's projection for the current uuids.`,
			};
		}
		next.push(item);
	}
	return { ok: true, items: next };
}

/**
 * Append one column to a module's case-list `columns` array.
 *
 * Failure arm: module not in the doc.
 */
export function addColumnMutation(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	column: Column,
): CaseListMutationResult {
	const mod = doc.modules[moduleUuid];
	if (mod === undefined) {
		return {
			error: `Tried to add a case list column on module ${moduleUuid}. Found no module with that uuid in the doc.`,
		};
	}
	const base = snapshotCaseListConfig(mod);
	return {
		ok: true,
		mutations: [
			{
				kind: "updateModule",
				uuid: moduleUuid,
				patch: {
					caseListConfig: { ...base, columns: [...base.columns, column] },
				},
			},
		],
	};
}

/**
 * Replace one column on a module's case-list, keyed by `columnUuid`.
 *
 * Failure arms: module not in the doc, columnUuid not in the module's
 * columns array.
 */
export function updateColumnMutation(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	columnUuid: Uuid,
	replacement: Column,
): CaseListMutationResult {
	const mod = doc.modules[moduleUuid];
	if (mod === undefined) {
		return {
			error: `Tried to update case list column ${columnUuid} on module ${moduleUuid}. Found no module with that uuid in the doc.`,
		};
	}
	const base = snapshotCaseListConfig(mod);
	const op = replaceByUuid(
		base.columns,
		columnUuid,
		replacement,
		"case list column",
	);
	if ("error" in op) return { error: op.error };
	return {
		ok: true,
		mutations: [
			{
				kind: "updateModule",
				uuid: moduleUuid,
				patch: { caseListConfig: { ...base, columns: op.items } },
			},
		],
	};
}

/**
 * Drop one column from a module's case-list, keyed by `columnUuid`.
 *
 * Failure arms: module not in the doc, columnUuid not in the module's
 * columns array.
 */
export function removeColumnMutation(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	columnUuid: Uuid,
): CaseListMutationResult {
	const mod = doc.modules[moduleUuid];
	if (mod === undefined) {
		return {
			error: `Tried to remove case list column ${columnUuid} on module ${moduleUuid}. Found no module with that uuid in the doc.`,
		};
	}
	const base = snapshotCaseListConfig(mod);
	const op = removeByUuid(base.columns, columnUuid, "case list column");
	if ("error" in op) return { error: op.error };
	return {
		ok: true,
		mutations: [
			{
				kind: "updateModule",
				uuid: moduleUuid,
				patch: { caseListConfig: { ...base, columns: op.items } },
			},
		],
	};
}

/**
 * Reorder a module's case-list columns to match the supplied uuid
 * sequence.
 *
 * Failure arms: module not in the doc, length mismatch, duplicate
 * uuid, unknown uuid in the request.
 */
export function reorderColumnsMutation(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	order: readonly Uuid[],
): CaseListMutationResult {
	const mod = doc.modules[moduleUuid];
	if (mod === undefined) {
		return {
			error: `Tried to reorder case list columns on module ${moduleUuid}. Found no module with that uuid in the doc.`,
		};
	}
	const base = snapshotCaseListConfig(mod);
	const op = reorderByUuid(base.columns, order, "case list column");
	if ("error" in op) return { error: op.error };
	return {
		ok: true,
		mutations: [
			{
				kind: "updateModule",
				uuid: moduleUuid,
				patch: { caseListConfig: { ...base, columns: op.items } },
			},
		],
	};
}

/** Search-input parallel of `addColumnMutation`. */
export function addSearchInputMutation(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	searchInput: SearchInputDef,
): CaseListMutationResult {
	const mod = doc.modules[moduleUuid];
	if (mod === undefined) {
		return {
			error: `Tried to add a search input on module ${moduleUuid}. Found no module with that uuid in the doc.`,
		};
	}
	const base = snapshotCaseListConfig(mod);
	return {
		ok: true,
		mutations: [
			{
				kind: "updateModule",
				uuid: moduleUuid,
				patch: {
					caseListConfig: {
						...base,
						searchInputs: [...base.searchInputs, searchInput],
					},
				},
			},
		],
	};
}

/** Search-input parallel of `updateColumnMutation`. */
export function updateSearchInputMutation(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	searchInputUuid: Uuid,
	replacement: SearchInputDef,
): CaseListMutationResult {
	const mod = doc.modules[moduleUuid];
	if (mod === undefined) {
		return {
			error: `Tried to update search input ${searchInputUuid} on module ${moduleUuid}. Found no module with that uuid in the doc.`,
		};
	}
	const base = snapshotCaseListConfig(mod);
	const op = replaceByUuid(
		base.searchInputs,
		searchInputUuid,
		replacement,
		"search input",
	);
	if ("error" in op) return { error: op.error };
	return {
		ok: true,
		mutations: [
			{
				kind: "updateModule",
				uuid: moduleUuid,
				patch: { caseListConfig: { ...base, searchInputs: op.items } },
			},
		],
	};
}

/** Search-input parallel of `removeColumnMutation`. */
export function removeSearchInputMutation(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	searchInputUuid: Uuid,
): CaseListMutationResult {
	const mod = doc.modules[moduleUuid];
	if (mod === undefined) {
		return {
			error: `Tried to remove search input ${searchInputUuid} on module ${moduleUuid}. Found no module with that uuid in the doc.`,
		};
	}
	const base = snapshotCaseListConfig(mod);
	const op = removeByUuid(base.searchInputs, searchInputUuid, "search input");
	if ("error" in op) return { error: op.error };
	return {
		ok: true,
		mutations: [
			{
				kind: "updateModule",
				uuid: moduleUuid,
				patch: { caseListConfig: { ...base, searchInputs: op.items } },
			},
		],
	};
}

/** Search-input parallel of `reorderColumnsMutation`. */
export function reorderSearchInputsMutation(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	order: readonly Uuid[],
): CaseListMutationResult {
	const mod = doc.modules[moduleUuid];
	if (mod === undefined) {
		return {
			error: `Tried to reorder search inputs on module ${moduleUuid}. Found no module with that uuid in the doc.`,
		};
	}
	const base = snapshotCaseListConfig(mod);
	const op = reorderByUuid(base.searchInputs, order, "search input");
	if ("error" in op) return { error: op.error };
	return {
		ok: true,
		mutations: [
			{
				kind: "updateModule",
				uuid: moduleUuid,
				patch: { caseListConfig: { ...base, searchInputs: op.items } },
			},
		],
	};
}

// ── Mutation builders — forms ───────────────────────────────────────────

/** Input shape for a new form. `uuid` may be supplied (e.g. during
 *  scaffold) to pin identity; otherwise the helper mints one. */
export interface NewFormInput {
	uuid?: string;
	id?: string;
	name: string;
	type: FormType;
	purpose?: string;
	closeCondition?: Form["closeCondition"];
	connect?: ConnectConfig | null;
	postSubmit?: PostSubmitDestination;
}

/** Build an `addForm` mutation. Mints a uuid when the caller doesn't
 *  supply one. Forms are keyed under their owning module via the
 *  `moduleUuid` argument — the reducer refuses to install a form whose
 *  module isn't registered. */
export function addFormMutations(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	input: NewFormInput,
	opts?: { index?: number },
): Mutation[] {
	if (doc.modules[moduleUuid] === undefined) return [];
	const uuid = asUuid(
		typeof input.uuid === "string" && input.uuid.length > 0
			? input.uuid
			: crypto.randomUUID(),
	);
	const form: Form = {
		uuid,
		// Forms carry a semantic id alongside name, mirroring modules.
		id: input.id ?? slugifyFormId(input.name),
		name: input.name,
		type: input.type,
		...(input.purpose !== undefined && { purpose: input.purpose }),
		...(input.closeCondition !== undefined && {
			closeCondition: input.closeCondition,
		}),
		...(input.connect != null && {
			// `normalizeConnectConfig` strips empty sub-configs. A returned
			// `undefined` means "every sub-config was empty" — which for
			// `addForm` means "don't stamp connect at all".
			connect: normalizeConnectConfig(input.connect),
		}),
		...(input.postSubmit !== undefined && { postSubmit: input.postSubmit }),
	};
	return [
		{
			kind: "addForm",
			moduleUuid,
			form,
			...(opts?.index !== undefined && { index: opts.index }),
		},
	];
}

/** Remove a form (cascades field subtree via the reducer). No-op when
 *  the uuid isn't present in the current doc. */
export function removeFormMutations(
	doc: BlueprintDoc,
	formUuid: Uuid,
): Mutation[] {
	if (doc.forms[formUuid] === undefined) return [];
	return [{ kind: "removeForm", uuid: formUuid }];
}

/**
 * Patch form-level fields. Nullable fields (`closeCondition`, `connect`,
 * `postSubmit`) follow a convention: passing `null` clears the field
 * (the reducer stores `undefined`), passing an object replaces it, and
 * omitting the key leaves it untouched.
 *
 * `connect` additionally runs through `normalizeConnectConfig` so empty
 * sub-configs don't get written — matches legacy behavior where an
 * explicit `{ connect: {} }` patch was treated as "clear".
 */
export function updateFormMutations(
	doc: BlueprintDoc,
	formUuid: Uuid,
	patch: Partial<{
		name: string;
		type: FormType;
		closeCondition: Form["closeCondition"] | null;
		connect: ConnectConfig | null;
		postSubmit: PostSubmitDestination | null;
		purpose: string | null;
	}>,
): Mutation[] {
	if (doc.forms[formUuid] === undefined) return [];
	const reducerPatch: Partial<Omit<Form, "uuid">> = {};
	if (patch.name !== undefined) reducerPatch.name = patch.name;
	if (patch.type !== undefined) reducerPatch.type = patch.type;
	if (patch.closeCondition !== undefined) {
		// `null` → clear (reducer treats `undefined` as "remove" via
		// Object.assign — not perfect, but Immer's Object.assign with an
		// explicit `undefined` clears the key in strict mode).
		reducerPatch.closeCondition =
			patch.closeCondition === null ? undefined : patch.closeCondition;
	}
	if (patch.connect !== undefined) {
		reducerPatch.connect =
			patch.connect === null
				? undefined
				: (normalizeConnectConfig(patch.connect) ?? undefined);
	}
	if (patch.postSubmit !== undefined) {
		reducerPatch.postSubmit =
			patch.postSubmit === null ? undefined : patch.postSubmit;
	}
	if (patch.purpose !== undefined) {
		reducerPatch.purpose = patch.purpose === null ? undefined : patch.purpose;
	}
	return [{ kind: "updateForm", uuid: formUuid, patch: reducerPatch }];
}

// ── Mutation builders — fields ──────────────────────────────────────────

/** Build an `addField` mutation. The caller supplies a full `Field`
 *  entity (with uuid); helpers that mint fields from SA wire format live
 *  elsewhere — this helper stays type-tight against the domain shape. */
export function addFieldMutations(
	doc: BlueprintDoc,
	input: {
		parentUuid: Uuid;
		field: Field;
		index?: number;
	},
): Mutation[] {
	// Parent must be a form or an existing container field.
	const parentForm = doc.forms[input.parentUuid];
	const parentField = doc.fields[input.parentUuid];
	const parentExists =
		parentForm !== undefined ||
		(parentField !== undefined && isContainer(parentField));
	if (!parentExists) return [];
	return [
		{
			kind: "addField",
			parentUuid: input.parentUuid,
			field: input.field,
			...(input.index !== undefined && { index: input.index }),
		},
	];
}

/** Remove a field (cascades children via the reducer). */
export function removeFieldMutations(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
): Mutation[] {
	if (doc.fields[fieldUuid] === undefined) return [];
	return [{ kind: "removeField", uuid: fieldUuid }];
}

/** Rename a field's semantic id. The reducer rewrites XPath references
 *  to the old id across the entire doc atomically. */
export function renameFieldMutations(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
	newId: string,
): Mutation[] {
	if (doc.fields[fieldUuid] === undefined) return [];
	return [{ kind: "renameField", uuid: fieldUuid, newId }];
}

/** Patch arbitrary fields on a field entity. The `Field` union is
 *  discriminated by `kind`; the patch must match the specific kind's
 *  shape. Narrowing callers (SA `editField` tool, inspect panel) are
 *  responsible for constructing a valid patch — the reducer parses the
 *  merged shape against `fieldSchema` and rejects patches that don't
 *  satisfy the target kind. */
export function updateFieldMutations(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
	patch: Partial<Omit<Field, "uuid">>,
): Mutation[] {
	if (doc.fields[fieldUuid] === undefined) return [];
	return [{ kind: "updateField", uuid: fieldUuid, patch }];
}

// ── Mutation builders — scaffold ────────────────────────────────────────

/**
 * Build the mutation batch for applying a scaffold to an (effectively
 * empty) doc: set the app name + connect type, then create each module
 * and its forms in order. Mints uuids for every entity so the resulting
 * doc has stable identity immediately.
 *
 * Scaffolds are only applied to empty docs during the initial build —
 * callers must drop any existing modules separately if they want a
 * clean slate. This helper deliberately doesn't emit removeModule
 * mutations for existing modules to keep the intent explicit.
 */
export function setScaffoldMutations(scaffold: Scaffold): Mutation[] {
	const muts: Mutation[] = [];
	muts.push({ kind: "setAppName", name: scaffold.app_name });
	const connectType = scaffold.connect_type;
	if (connectType === "learn" || connectType === "deliver") {
		muts.push({ kind: "setConnectType", connectType });
	} else {
		muts.push({ kind: "setConnectType", connectType: null });
	}

	for (const sm of scaffold.modules) {
		const moduleUuid = asUuid(crypto.randomUUID());
		const moduleEntity: Module = {
			uuid: moduleUuid,
			id: slugifyModuleId(sm.name),
			name: sm.name,
			...(sm.case_type != null && { caseType: sm.case_type }),
			...(sm.case_list_only && { caseListOnly: sm.case_list_only }),
			...(sm.purpose !== undefined && { purpose: sm.purpose }),
		};
		muts.push({ kind: "addModule", module: moduleEntity });

		for (const sf of sm.forms) {
			const formUuid = asUuid(crypto.randomUUID());
			/* Build the Form entity field-by-field with explicit
			 * assignment for optional properties. Each `if` is a named
			 * decision the reader can audit top-to-bottom — vs. the
			 * conditional-spread idiom (`...(cond && {k: v})`), which
			 * obscures whether a key actually lands on the literal. The
			 * SA-facing scaffold schema (`scaffoldModulesSchema`) declares
			 * every property the SA can set; each one needs a matching
			 * read here. A missing read silently drops the field on the
			 * persisted doc — the kind of bug that's invisible until a
			 * downstream consumer notices the wrong default behavior. */
			const formEntity: Form = {
				uuid: formUuid,
				id: slugifyFormId(sf.name),
				name: sf.name,
				type: sf.type,
			};
			if (sf.purpose !== undefined) formEntity.purpose = sf.purpose;
			if (sf.post_submit !== undefined) formEntity.postSubmit = sf.post_submit;
			if (sf.connect !== undefined) {
				/* `normalizeConnectConfig` strips empty sub-configs so an
				 * SA-supplied `{}` (zero opt-ins) lands as absent rather
				 * than as an empty marker on the form. Same contract as
				 * `addFormMutations` and `updateFormMutations`. */
				const normalized = normalizeConnectConfig(sf.connect);
				if (normalized !== undefined) formEntity.connect = normalized;
			}
			muts.push({ kind: "addForm", moduleUuid, form: formEntity });
		}
	}
	return muts;
}

// ── Private helpers ─────────────────────────────────────────────────────

/** Derive a module's semantic id slug from its display name. Lowercased,
 *  non-alphanumerics collapsed to `_`. Keeps us from having to surface a
 *  separate slug input at every creation site. */
function slugifyModuleId(name: string): string {
	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return slug.length > 0 ? slug : "module";
}

/** Derive a form's semantic id slug from its display name. Same rules
 *  as the module slug — we default to "form" if sanitizing strips
 *  everything. */
function slugifyFormId(name: string): string {
	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return slug.length > 0 ? slug : "form";
}

// ── Re-exports for consumers that need type-level narrowing ─────────────

export type { FieldKind };
export { fieldKinds };
