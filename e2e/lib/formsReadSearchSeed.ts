/**
 * A menu whose forms read the search and whose case list registers what a
 * search could not find.
 *
 * Search before register is one journey with three screens that only a real
 * browser can string together: the Search screen the menu opens on (search
 * first, so no browse list, no Results heading, no register action yet),
 * the Results a completed search lands on (rows, or the "No cases match"
 * notice carrying the register action), and the case list registration
 * form that opens prefilled from the search's answers and returns to
 * Results showing the case it made. The fixture is the smallest shape that
 * exercises every hop: one required visible prompt on the case name, one
 * hidden prompt (the search time, `now()`), one case-loading menu form so
 * the module is case-first, and one registration form the menu's
 * `caseListRegistrationForm` names, whose name field defaults to
 * `#search/patient_name` and whose hidden field reads `#search/search_time`.
 * The fixture declares only Web Apps, the one platform that runs forms
 * that read the search.
 *
 * The journey registers a case, so every Playwright attempt gets its own
 * empty app through its native `forms-read-search` profile.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	asUuid,
	type BlueprintDoc,
	fuzzyMode,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import { input, now, term } from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";
import { buildUrl } from "@/lib/routing/location";

export const FORMS_READ_SEARCH_SEED = {
	appName: "Smoke — Forms read the search",
	moduleName: "Patients",
	caseType: "patient",
	moduleUuid: asUuid("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"),
	columns: {
		patientName: asUuid("a2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e"),
	},
	searchInputs: {
		patientName: asUuid("a3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e7f"),
		searchTime: asUuid("a4e5f6a7-b8c9-4d0e-9f2a-3b4c5d6e7f8a"),
	},
	/** The visible prompt: required, with its own message. */
	prompt: {
		name: "patient_name",
		label: "Patient name",
		requiredMessage: "Type at least part of a name to search.",
	},
	visit: {
		formUuid: asUuid("a5f6a7b8-c9d0-4e1f-8a3b-4c5d6e7f8a9b"),
		formName: "Visit",
		noteFieldUuid: asUuid("a6a7b8c9-d0e1-4f2a-9b4c-5d6e7f8a9b0c"),
	},
	register: {
		formUuid: asUuid("a7b8c9d0-e1f2-4a3b-8c5d-6e7f8a9b0c1d"),
		formName: "Register patient",
		/** What the Results action says; the form keeps its own name. */
		actionLabel: "Register a new patient",
		nameFieldUuid: asUuid("a8c9d0e1-f2a3-4b4c-9d6e-7f8a9b0c1d2e"),
		nameFieldLabel: "Name",
		searchTimeFieldUuid: asUuid("a9d0e1f2-a3b4-4c5d-8e7f-8a9b0c1d2e3f"),
		labelFieldUuid: asUuid("aad0e1f2-a3b4-4c5d-8e7f-8a9b0c1d2e40"),
	},
	/** The first patient registered through the worker journey. */
	unmatchedName: "Zzz",
} as const;

/** The blueprint installed into each forms-read-search fixture app. */
export function buildFormsReadSearchBlueprint(
	appId = "test-app",
): BlueprintDoc {
	const { moduleUuid, columns, searchInputs, prompt, visit, register } =
		FORMS_READ_SEARCH_SEED;
	return buildDoc({
		appId,
		appName: FORMS_READ_SEARCH_SEED.appName,
		caseTypes: [
			{
				name: FORMS_READ_SEARCH_SEED.caseType,
				properties: [
					{
						name: "last_note",
						label: proseText("Last note"),
						data_type: "text",
					},
				],
			},
		],
		modules: [
			{
				uuid: moduleUuid,
				name: FORMS_READ_SEARCH_SEED.moduleName,
				caseType: FORMS_READ_SEARCH_SEED.caseType,
				caseListConfig: {
					columns: [plainColumn(columns.patientName, "case_name", "Patient")],
					listColumnOrder: [columns.patientName],
					detailColumnOrder: [columns.patientName],
					searchInputs: [
						simpleSearchInputDef(
							searchInputs.patientName,
							prompt.name,
							prompt.label,
							"text",
							"case_name",
							{
								mode: fuzzyMode(),
								required: { message: prompt.requiredMessage },
							},
						),
						{
							kind: "hidden",
							uuid: searchInputs.searchTime,
							name: "search_time",
							label: "Search time",
							value: now(),
						},
					],
				},
				caseSearchConfig: { formsReadSearch: true },
				caseListRegistrationForm: {
					formUuid: register.formUuid,
					label: register.actionLabel,
				},
				forms: [
					{
						uuid: visit.formUuid,
						name: visit.formName,
						// Case-loading, so the module is case-first and its forms may
						// read the search; the registration form below is not on the
						// menu.
						type: "followup",
						fields: [
							f({
								uuid: visit.noteFieldUuid,
								kind: "text",
								id: "visit_note",
								label: proseText("Visit note"),
								caseWrite: {
									caseType: FORMS_READ_SEARCH_SEED.caseType,
									property: "last_note",
								},
							}),
						],
					},
					{
						uuid: register.formUuid,
						name: register.formName,
						type: "registration",
						fields: [
							f({
								uuid: register.nameFieldUuid,
								kind: "text",
								id: "case_name",
								label: proseText(register.nameFieldLabel),
								caseWrite: {
									caseType: FORMS_READ_SEARCH_SEED.caseType,
									property: "case_name",
								},
								default_value: term(input(searchInputs.patientName)),
							}),
							{
								kind: "hidden",
								uuid: register.searchTimeFieldUuid,
								id: "search_time",
								default_value: term(input(searchInputs.searchTime)),
							},
							// The record name the journey authors: a form the case list
							// offers after an empty search names its case from a question's answer
							// as it is, which CommCare HQ's Case Management holds.
							f({
								uuid: register.labelFieldUuid,
								kind: "hidden",
								id: "patient_label",
								calculate: "concat('Patient ', #form/case_name)",
							}),
						],
					},
				],
			},
		],
	});
}

export interface FormsReadSearchRoutes {
	/** The Search authoring canvas, which carries the registration setting. */
	readonly searchConfig: string;
	/** The module's Results, which Preview opens on Search. */
	readonly results: string;
	/** The case list registration form's own URL. */
	readonly registerForm: string;
}

/** The canonical relative paths the journey opens. */
export function formsReadSearchRoutes(appId: string): FormsReadSearchRoutes {
	const basePath = `/build/${appId}`;
	const moduleUuid = FORMS_READ_SEARCH_SEED.moduleUuid;
	return {
		searchConfig: buildUrl(basePath, { kind: "search-config", moduleUuid }),
		results: buildUrl(basePath, { kind: "cases", moduleUuid }),
		registerForm: buildUrl(basePath, {
			kind: "form",
			moduleUuid,
			formUuid: FORMS_READ_SEARCH_SEED.register.formUuid,
		}),
	};
}
