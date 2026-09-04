/**
 * A module that opens on Search and registers what a search could not find.
 *
 * Search before register is one journey with three screens that only a real
 * browser can string together: the Search screen a search-first module
 * opens on (no browse list, no Results heading, no register action yet),
 * the Results a completed search lands on (rows, or the "No cases match"
 * notice carrying the register action), and the no-matches registration
 * form that opens prefilled from the search's answers and returns to
 * Results showing the case it made. The fixture is the smallest shape that
 * exercises every hop: one required visible prompt on the case name, one
 * hidden prompt (the search time, `now()`), one case-loading menu form so
 * the module is case-first, and one registration form born as the module's
 * no-matches form whose name field defaults to `#search/patient_name` and
 * whose hidden field reads `#search/search_time`.
 *
 * The journey registers a case, so every Playwright attempt gets its own
 * app and seeded row: `SEARCH_FIRST_FIXTURE_COUNT` in `e2e/lib/config.ts`,
 * selected by `seed.searchFirst[testInfo.retry]`.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	asUuid,
	type BlueprintDoc,
	fuzzyMode,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import { now } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { buildUrl } from "@/lib/routing/location";

export const SEARCH_FIRST_SEED = {
	appName: "Smoke — Search first",
	moduleName: "Patients",
	caseType: "patient",
	/** The one seeded case; searching its first name finds it. */
	caseName: "Ada Lovelace",
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
	},
	/** A name no seeded case carries, so the search finds nothing. */
	unmatchedName: "Zzz",
} as const;

/** The blueprint installed into each search-first fixture app. */
export function buildSearchFirstBlueprint(appId = "test-app"): BlueprintDoc {
	const { moduleUuid, columns, searchInputs, prompt, visit, register } =
		SEARCH_FIRST_SEED;
	return buildDoc({
		appId,
		appName: SEARCH_FIRST_SEED.appName,
		caseTypes: [
			{
				name: SEARCH_FIRST_SEED.caseType,
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
				name: SEARCH_FIRST_SEED.moduleName,
				caseType: SEARCH_FIRST_SEED.caseType,
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
				caseSearchConfig: { searchFirst: true },
				forms: [
					{
						uuid: visit.formUuid,
						name: visit.formName,
						// Case-loading, so the module is case-first and may open on
						// Search; the registration form below is not on the menu.
						type: "followup",
						fields: [
							f({
								uuid: visit.noteFieldUuid,
								kind: "text",
								id: "visit_note",
								label: proseText("Visit note"),
								caseWrite: {
									caseType: SEARCH_FIRST_SEED.caseType,
									property: "last_note",
								},
							}),
						],
					},
					{
						uuid: register.formUuid,
						name: register.formName,
						type: "registration",
						entry: { kind: "search-no-matches", label: register.actionLabel },
						fields: [
							f({
								uuid: register.nameFieldUuid,
								kind: "text",
								id: "case_name",
								label: proseText(register.nameFieldLabel),
								caseWrite: {
									caseType: SEARCH_FIRST_SEED.caseType,
									property: "case_name",
								},
								default_value: {
									parts: [
										{
											kind: "search-answer-ref",
											searchInputUuid: searchInputs.patientName,
										},
									],
								},
							}),
							{
								kind: "hidden",
								uuid: register.searchTimeFieldUuid,
								id: "search_time",
								default_value: {
									parts: [
										{
											kind: "search-answer-ref",
											searchInputUuid: searchInputs.searchTime,
										},
									],
								},
							},
						],
					},
				],
			},
		],
	});
}

export interface SearchFirstRoutes {
	/** The Search authoring canvas, which carries the no-matches setting. */
	readonly searchConfig: string;
	/** The module's Results, which Preview opens on Search. */
	readonly results: string;
	/** The no-matches registration form's own URL. */
	readonly registerForm: string;
}

/** The canonical relative paths the journey opens. */
export function searchFirstRoutes(appId: string): SearchFirstRoutes {
	const basePath = `/build/${appId}`;
	const moduleUuid = SEARCH_FIRST_SEED.moduleUuid;
	return {
		searchConfig: buildUrl(basePath, { kind: "search-config", moduleUuid }),
		results: buildUrl(basePath, { kind: "cases", moduleUuid }),
		registerForm: buildUrl(basePath, {
			kind: "form",
			moduleUuid,
			formUuid: SEARCH_FIRST_SEED.register.formUuid,
		}),
	};
}
