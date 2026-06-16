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
	type Field,
	type Form,
	type FormType,
	type Module,
	plainColumn,
	type Uuid,
	uniqueSlug,
} from "@/lib/domain";
import type { Mutation } from "./types";

/** The first case-list column every new case-managing module is born with.
 *  `case_name` is in CommCare's standard property set, so the column resolves
 *  even before any form writes a custom property (`columnReferences`). */
const NAME_COLUMN_HEADER = "Name";

/** Friendly default form names per type — the user renames inline on the form
 *  screen after creation. */
const FORM_TYPE_NAME: Record<FormType, string> = {
	registration: "Registration",
	followup: "Follow-up",
	close: "Close case",
	survey: "Survey",
};

/** Title-case a case-type slug for a default display name: `home_visit` →
 *  "Home visit". Just enough humanizing for a starting label; the user renames. */
function humanizeCaseType(caseType: string): string {
	const words = caseType.replace(/[_-]+/g, " ").trim();
	return words.length > 0
		? words.charAt(0).toUpperCase() + words.slice(1)
		: caseType;
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

/** A `case_name` text field that writes the case name to `caseType` — the
 *  field a registration form needs to satisfy `NO_CASE_NAME_FIELD`. */
function caseNameField(caseType: string | undefined): Field {
	return {
		kind: "text",
		uuid: asUuid(crypto.randomUUID()),
		id: "case_name",
		label: "Name",
		...(caseType !== undefined && { case_property_on: caseType }),
	} as Field;
}

/** A starter data field that writes a real case property. `deriveCaseConfig`
 *  promotes the `case_name` field OUT of the case-property set (it's the name,
 *  not a property), so a registration form needs at least one more
 *  case-writing field to satisfy `REGISTRATION_NO_CASE_PROPS`. */
function caseDataField(caseType: string | undefined): Field {
	return {
		kind: "text",
		uuid: asUuid(crypto.randomUUID()),
		id: "notes",
		label: "Notes",
		...(caseType !== undefined && { case_property_on: caseType }),
	} as Field;
}

/** The fields a registration form is born with: the case name plus one data
 *  property (both required for a valid registration form). */
function registrationFields(caseType: string | undefined): Field[] {
	return [caseNameField(caseType), caseDataField(caseType)];
}

/** A plain text question — the default first field for a non-registration
 *  form, so the form isn't born empty (`EMPTY_FORM`). */
function defaultQuestion(): Field {
	return {
		kind: "text",
		uuid: asUuid(crypto.randomUUID()),
		id: "question_1",
		label: "Question 1",
	} as Field;
}

export interface CaseListModuleScaffold {
	/** The case type the module manages (existing or freshly-named). */
	caseType: string;
	/** Display name; defaults to the humanized case type. */
	name?: string;
	/** Insertion index in `moduleOrder`; appends when omitted. */
	index?: number;
}

/**
 * A fully functional case-management module, born complete:
 *   - the module, with one `case_name`/"Name" case-list column
 *   - a starter `registration` form
 *   - a `case_name` text field writing to `caseType`
 *
 * The `case_name` field auto-registers `caseType` (and the `case_name`
 * property) in `doc.caseTypes` via the reducer's `ensureCatalogProperty`, so a
 * brand-new case type needs no separate `setCaseTypes`.
 */
export function caseListModuleMutations(
	doc: BlueprintDoc,
	{ caseType, name, index }: CaseListModuleScaffold,
): { mutations: Mutation[]; moduleUuid: Uuid; formUuid: Uuid } {
	const moduleUuid = asUuid(crypto.randomUUID());
	const formUuid = asUuid(crypto.randomUUID());

	const moduleName = name ?? humanizeCaseType(caseType);
	const module: Module = {
		uuid: moduleUuid,
		id: uniqueSlug(moduleName, "module", existingModuleIds(doc)),
		name: moduleName,
		caseType,
		caseListConfig: {
			columns: [
				plainColumn(
					asUuid(crypto.randomUUID()),
					"case_name",
					NAME_COLUMN_HEADER,
				),
			],
			searchInputs: [],
		},
	};

	const formName = `Register ${humanizeCaseType(caseType).toLowerCase()}`;
	const form: Form = {
		uuid: formUuid,
		id: uniqueSlug(formName, "form", existingFormIds(doc)),
		name: formName,
		type: "registration",
	};

	const mutations: Mutation[] = [
		{ kind: "addModule", module, ...(index !== undefined && { index }) },
		{ kind: "addForm", moduleUuid, form },
		...registrationFields(caseType).map(
			(field, i): Mutation => ({
				kind: "addField",
				parentUuid: formUuid,
				field,
				index: i,
			}),
		),
	];
	return { mutations, moduleUuid, formUuid };
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
	const formName = FORM_TYPE_NAME[type];
	const form: Form = {
		uuid: formUuid,
		id: uniqueSlug(formName, "form", existingFormIds(doc)),
		name: formName,
		type,
	};
	// A registration form needs the case name plus one data property; every
	// other type just needs one field so it isn't empty.
	const fields =
		type === "registration"
			? registrationFields(mod.caseType)
			: [defaultQuestion()];

	const mutations: Mutation[] = [];
	if (mod.caseListOnly) {
		const patch: Partial<Omit<Module, "uuid">> = { caseListOnly: false };
		if ((mod.caseListConfig?.columns.length ?? 0) === 0) {
			patch.caseListConfig = {
				columns: [
					plainColumn(
						asUuid(crypto.randomUUID()),
						"case_name",
						NAME_COLUMN_HEADER,
					),
				],
				searchInputs: mod.caseListConfig?.searchInputs ?? [],
				...(mod.caseListConfig?.filter && {
					filter: mod.caseListConfig.filter,
				}),
			};
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
 * The form types that can be added to `mod` without introducing a finding.
 * Case-managing types (`registration`/`followup`/`close`) require a case type
 * (`NO_CASE_TYPE` / `CLOSE_FORM_NO_CASE_TYPE`); `survey` always applies. The
 * form menu offers every type but disables the ones not in this set, with a
 * reason — valid-by-construction "disabled, never hidden".
 */
export function allowedFormTypes(mod: Module): ReadonlySet<FormType> {
	return mod.caseType
		? new Set<FormType>(["registration", "followup", "close", "survey"])
		: new Set<FormType>(["survey"]);
}
