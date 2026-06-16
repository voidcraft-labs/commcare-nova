// lib/doc/scaffolds.ts
//
// Pure `Mutation[]` builders for the builder's in-tree "add module / add form"
// affordances. They are the UI twin of the SA's `lib/agent/blueprintHelpers.ts`
// + `createModule` / `createForm` tools: every creation lands the entity TOGETHER
// with the minimal contents that make it valid, so the whole batch passes the
// commit gate (`mutationCommitVerdict`) as one candidate. Valid-by-construction
// forbids an empty shell — a lone case-managing `addModule` introduces
// `NO_FORMS_OR_CASE_LIST` + `MISSING_CASE_LIST_COLUMNS`, and a lone `addForm`
// introduces `EMPTY_FORM` — so the defaults below aren't cosmetic, they're what
// keeps creation alive under the gate.
//
// The reducer applies a batch sequentially, so an `addForm` that names the
// module the same batch just added resolves against the live draft — the same
// shape the SA emits. uuids are minted here so the caller can navigate to the
// new entity after the gated commit.

import {
	asUuid,
	type BlueprintDoc,
	type CaseListConfig,
	type Form,
	type FormType,
	formTypeLabels,
	humanizeId,
	type Module,
	plainColumn,
	type TextField,
	type Uuid,
	uniqueSlug,
} from "@/lib/domain";
import type { Mutation } from "./types";

/** Header for the `Name` column a new case module is born with. `case_name` is
 *  a CommCare standard property, so the column resolves (`columnReferences` →
 *  `augmentCaseType`) once the case type is in the catalog — which is why the
 *  viewer declares its type even when no form writes `case_name` yet. */
const NAME_COLUMN_HEADER = "Name";

/** The canonical starter case-list column — a plain `case_name`/"Name" column. */
function nameColumn() {
	return plainColumn(
		asUuid(crypto.randomUUID()),
		"case_name",
		NAME_COLUMN_HEADER,
	);
}

/** A case-list config carrying a `Name` column, preserving an existing
 *  config's search inputs + filter. The single home of the "born with a Name
 *  column" shape every creation/case-type path seeds. */
function caseListConfigWithName(existing?: CaseListConfig): CaseListConfig {
	return {
		columns: [nameColumn()],
		searchInputs: existing?.searchInputs ?? [],
		...(existing?.filter && { filter: existing.filter }),
	};
}

function existingModuleIds(doc: BlueprintDoc): Set<string> {
	const ids = new Set<string>();
	for (const uuid of doc.moduleOrder) {
		const mod = doc.modules[uuid];
		if (mod) ids.add(mod.id);
	}
	return ids;
}

function existingFormIds(doc: BlueprintDoc): Set<string> {
	const ids = new Set<string>();
	for (const list of Object.values(doc.formOrder)) {
		for (const uuid of list ?? []) {
			const form = doc.forms[uuid];
			if (form) ids.add(form.id);
		}
	}
	return ids;
}

/** A text field. Typed as `TextField` (not cast to `Field`) so the per-kind
 *  schema check still applies — a property the kind doesn't have won't compile,
 *  the guarantee `newFieldDefaults.ts` was created to keep. */
function textField(id: string, label: string, caseType?: string): TextField {
	return {
		kind: "text",
		uuid: asUuid(crypto.randomUUID()),
		id,
		label,
		...(caseType !== undefined && { case_property_on: caseType }),
	};
}

/** The field a registration form is born with: just the `case_name` writer
 *  (`NO_CASE_NAME_FIELD`). A name-only case create is valid across the whole
 *  wire (verified against commcare-hq / commcare-core / formplayer), so no
 *  extra "saved property" field is forced. */
function registrationFields(caseType: string | undefined): TextField[] {
	return [textField("case_name", "Name", caseType)];
}

/** A plain text question — the default first field for a non-registration
 *  form, so the form isn't born empty (`EMPTY_FORM`). */
function defaultQuestion(): TextField {
	return textField("question_1", "Question 1");
}

export interface CaseListModuleScaffold {
	/** The case type the module manages (existing or freshly-named). */
	caseType: string;
	/** Display name; defaults to the humanized case type. */
	name?: string;
	/** Insertion index in `moduleOrder`; appends when omitted. */
	index?: number;
}

/** Declare `caseType` in the catalog (empty properties) when it's new — a no-op
 *  for a type already present. The viewer below has no form to write
 *  `case_name`, so the type must be in the catalog for the `Name` column's
 *  standard-property to resolve (`augmentCaseType`). */
function declareCaseTypeMutations(
	doc: BlueprintDoc,
	caseType: string,
): Mutation[] {
	const existing = doc.caseTypes ?? [];
	if (existing.some((ct) => ct.name === caseType)) return [];
	return [
		{
			kind: "setCaseTypes",
			caseTypes: [...existing, { name: caseType, properties: [] }],
		},
	];
}

/**
 * A case-list module, born as a VIEWER (`caseListOnly`): the module + its case
 * type + a `Name` case-list column, and NO forms. A formless case module must
 * be `caseListOnly` (otherwise `NO_FORMS_OR_CASE_LIST`); the user adds a
 * registration form afterward via the form affordance, which flips the flag off
 * (`formScaffoldMutations`). The case type is declared in the catalog so the
 * Name column resolves before any form writes `case_name`.
 */
export function caseListModuleMutations(
	doc: BlueprintDoc,
	{ caseType, name, index }: CaseListModuleScaffold,
): { mutations: Mutation[]; moduleUuid: Uuid } {
	const moduleUuid = asUuid(crypto.randomUUID());
	const moduleName = name ?? humanizeId(caseType);
	const module: Module = {
		uuid: moduleUuid,
		id: uniqueSlug(moduleName, "module", existingModuleIds(doc)),
		name: moduleName,
		caseType,
		caseListOnly: true,
		caseListConfig: caseListConfigWithName(),
	};
	return {
		mutations: [
			...declareCaseTypeMutations(doc, caseType),
			{ kind: "addModule", module, ...(index !== undefined && { index }) },
		],
		moduleUuid,
	};
}

/**
 * A bare survey/menu module — no case type, no forms. This is valid (none of
 * the module rules fire on a typeless, formless module), so the user can add
 * survey forms to it afterward through the form insertion affordance.
 */
export function surveyModuleMutations(
	doc: BlueprintDoc,
	{ name, index }: { name?: string; index?: number } = {},
): { mutations: Mutation[]; moduleUuid: Uuid } {
	const moduleUuid = asUuid(crypto.randomUUID());
	const moduleName = name ?? "Survey";
	const module: Module = {
		uuid: moduleUuid,
		id: uniqueSlug(moduleName, "module", existingModuleIds(doc)),
		name: moduleName,
	};
	return {
		mutations: [
			{ kind: "addModule", module, ...(index !== undefined && { index }) },
		],
		moduleUuid,
	};
}

/**
 * A new form of `type` in `moduleUuid`, born with a default first field:
 *   - `registration` → a `case_name` writer (needs the module's case type)
 *   - everything else → a plain text question
 *
 * A `caseListOnly` module can't hold forms (`CASE_LIST_ONLY_HAS_FORMS`), so the
 * batch first flips the flag off and seeds a `Name` column if the module has
 * none (a case-managing module with forms obliges one — `MISSING_CASE_LIST_COLUMNS`).
 * Returns `null` when the module doesn't exist.
 */
export function formScaffoldMutations(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	type: FormType,
	index?: number,
): { mutations: Mutation[]; formUuid: Uuid } | null {
	const mod = doc.modules[moduleUuid];
	if (!mod) return null;

	const formUuid = asUuid(crypto.randomUUID());
	const formName = formTypeLabels[type];
	const form: Form = {
		uuid: formUuid,
		id: uniqueSlug(formName, "form", existingFormIds(doc)),
		name: formName,
		type,
	};
	// A registration form is born with just the `case_name` writer; every other
	// type gets one text question so it isn't born empty (`EMPTY_FORM`).
	const fields =
		type === "registration"
			? registrationFields(mod.caseType)
			: [defaultQuestion()];

	const mutations: Mutation[] = [];
	if (mod.caseListOnly) {
		const patch: Partial<Omit<Module, "uuid">> = { caseListOnly: false };
		if ((mod.caseListConfig?.columns.length ?? 0) === 0) {
			patch.caseListConfig = caseListConfigWithName(mod.caseListConfig);
		}
		mutations.push({ kind: "updateModule", uuid: moduleUuid, patch });
	}
	mutations.push({
		kind: "addForm",
		moduleUuid,
		form,
		...(index !== undefined && { index }),
	});
	for (let i = 0; i < fields.length; i++) {
		mutations.push({
			kind: "addField",
			parentUuid: formUuid,
			field: fields[i],
			index: i,
		});
	}
	return { mutations, formUuid };
}

/**
 * The module patch that SETS a case type on an existing module, born valid:
 *
 *   - No forms → a case-list-only VIEWER (`caseListOnly: true`). A formless
 *     case module is invalid (`NO_FORMS_OR_CASE_LIST`); the viewer is the only
 *     valid formless+typed shape, and adding a form later flips the flag off
 *     (`formScaffoldMutations`). (No seeded column: a `case_name` column needs
 *     a writer, and `caseListOnly` modules are exempt from the column rule.)
 *   - Has forms, no columns → seed a `Name` column (a form-bearing case module
 *     obliges one, `MISSING_CASE_LIST_COLUMNS`).
 *   - Has forms + columns → just the type.
 *
 * Centralizing the born-valid decision here keeps the settings UI from
 * re-encoding the rule; callers pass the module + whether it has forms (both in
 * hand from their entity hooks) rather than the whole doc.
 */
export function caseTypeSetPatch(
	mod: Module,
	hasForms: boolean,
	caseType: string,
): Partial<Omit<Module, "uuid">> {
	if (!hasForms) return { caseType, caseListOnly: true };
	const hasColumns = (mod.caseListConfig?.columns.length ?? 0) > 0;
	return hasColumns
		? { caseType }
		: { caseType, caseListConfig: caseListConfigWithName(mod.caseListConfig) };
}

/**
 * The module patch that CLEARS a module's case type, turning it into a survey.
 * Drops the now-meaningless case-list + case-search config in the same patch —
 * a typeless module keeping its `caseSearchConfig` would trip
 * `caseSearchConfigRequiresCaseType`, and orphaned columns would resurface on
 * re-typing. (Clears travel as `undefined` per the `updateModule` convention.)
 */
export function caseTypeClearPatch(): Partial<Omit<Module, "uuid">> {
	return {
		caseType: undefined,
		caseListConfig: undefined,
		caseSearchConfig: undefined,
	};
}
