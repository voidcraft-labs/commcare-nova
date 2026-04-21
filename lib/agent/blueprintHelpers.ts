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
 * Kept in `lib/agent/` because every consumer lives here. The one shared
 * query (`searchBlueprint`) that used to live alongside these helpers was
 * moved to `lib/doc/searchBlueprint.ts` so the client `useSearchBlueprint`
 * hook doesn't have to reach across the server/client boundary.
 */

import { normalizeConnectConfig } from "@/lib/doc/connectConfig";
import type { Mutation } from "@/lib/doc/types";
import type {
	BlueprintDoc,
	CaseType,
	ConnectConfig,
	Field,
	FieldKind,
	Form,
	FormType,
	Module,
	PostSubmitDestination,
	Uuid,
} from "@/lib/domain";
import { asUuid, fieldKinds, isContainer } from "@/lib/domain";
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

// ── Mutation builders — app level ───────────────────────────────────────

/** Replace the app's case-type catalog wholesale. */
export function setCaseTypesMutations(
	_doc: BlueprintDoc,
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
	caseListColumns?: Module["caseListColumns"];
	caseDetailColumns?: Module["caseDetailColumns"];
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
		...(input.caseListColumns !== undefined && {
			caseListColumns: input.caseListColumns,
		}),
		...(input.caseDetailColumns !== undefined && {
			caseDetailColumns: input.caseDetailColumns,
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
export function setScaffoldMutations(
	doc: BlueprintDoc,
	scaffold: Scaffold,
): Mutation[] {
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
			const formEntity: Form = {
				uuid: formUuid,
				id: slugifyFormId(sf.name),
				name: sf.name,
				type: sf.type,
				...(sf.purpose !== undefined && { purpose: sf.purpose }),
			};
			muts.push({ kind: "addForm", moduleUuid, form: formEntity });
		}
	}
	// `doc` is read only for reference, not consulted — but keep the
	// parameter for signature symmetry with other mutation builders
	// (every helper takes the doc first).
	void doc;
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
