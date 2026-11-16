/**
 * Three lists of patients under one menu: Patients, which opens on Results
 * first and whose forms read the search; Find a patient, which opens on
 * Results first through its Search action, its forms reading no search; and
 * All patients, a plain list.
 *
 * Opening Patients runs its default search, which finds both patients. A
 * worker who searches again for one of them, steps out to the menu, opens
 * All patients and comes back through the browser's history returns to the
 * search they ran. Web Apps keeps each step's query in the page's address
 * (`cloudcare/js/formplayer/utils/utils.js::setQueryData`, the answers in
 * session storage by query key) and restores it with the address
 * (`CloudcareUrl.fromJson`), and Formplayer answers the query prompts from
 * it before it runs the query again
 * (`MenuSessionRunnerService.java::handleQueryScreen`), so the menu's own
 * default search never replaces it. Opening the other list is what makes
 * Preview build the Patients screen afresh, where taking the standing
 * search back and launching the default search are two effects of one
 * mount (`caseListPhase.ts::caseListLaunchesDefaultSearch`); a list Preview
 * only hid keeps its state.
 *
 * The fixture declares only Web Apps, the one platform that runs forms that
 * read the search. The journey reads its own rows, so every Playwright
 * attempt gets its own app through its native `search-standing` profile.
 */

import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	fuzzyMode,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

export const SEARCH_STANDING_SEED = {
	appName: "Smoke — Standing search",
	caseType: "patient",
	clinic: {
		moduleUuid: testUuid("search-standing-clinic"),
		name: "Clinic",
		formName: "Clinic check",
	},
	searching: {
		moduleUuid: testUuid("search-standing-module"),
		name: "Patients",
		formName: "Visit",
		columnUuid: testUuid("search-standing-name-column"),
		searchInputUuid: testUuid("search-standing-name-input"),
	},
	/** A list that opens on Results first whose forms do not read the
	 *  search: its Search action runs the default search as it opens. */
	finding: {
		moduleUuid: testUuid("search-standing-finding"),
		name: "Find a patient",
		formName: "Check-in",
		columnUuid: testUuid("search-standing-finding-column"),
		searchInputUuid: testUuid("search-standing-finding-input"),
	},
	browsing: {
		moduleUuid: testUuid("search-standing-browse"),
		name: "All patients",
		formName: "Review",
		columnUuid: testUuid("search-standing-browse-column"),
	},
	prompt: { name: "patient_name", label: "Patient name" },
	noteLabel: "Visit note",
	/** The patient the worker searches for. */
	searched: { caseName: "Kofi Mensah", answer: "Kofi" },
	/** The patient only the menu's default search finds, and a second
	 *  search for her. */
	other: { caseName: "Ama Owusu", answer: "Ama" },
} as const;

export function buildSearchStandingBlueprint(appId: string): BlueprintDoc {
	const seed = SEARCH_STANDING_SEED;
	const note = f({
		kind: "text",
		id: "note",
		label: proseText(seed.noteLabel),
		caseWrite: { caseType: seed.caseType, property: "note" },
	});
	const doc = buildDoc({
		appId,
		appName: seed.appName,
		caseTypes: [
			{
				name: seed.caseType,
				properties: [
					{ name: "note", label: proseText(seed.noteLabel), data_type: "text" },
				],
			},
		],
		modules: [
			{
				uuid: seed.clinic.moduleUuid,
				name: seed.clinic.name,
				forms: [
					{
						name: seed.clinic.formName,
						type: "survey",
						fields: [f({ kind: "text", id: "remark", label: "Remark" })],
					},
				],
			},
			{
				uuid: seed.searching.moduleUuid,
				name: seed.searching.name,
				caseType: seed.caseType,
				caseListConfig: {
					columns: [
						plainColumn(seed.searching.columnUuid, "case_name", "Patient"),
					],
					searchInputs: [
						simpleSearchInputDef(
							seed.searching.searchInputUuid,
							seed.prompt.name,
							seed.prompt.label,
							"text",
							"case_name",
							{ mode: fuzzyMode() },
						),
					],
				},
				caseSearchConfig: { workflow: "skipToResults", formsReadSearch: true },
				forms: [
					{ name: seed.searching.formName, type: "followup", fields: [note] },
				],
			},
			{
				uuid: seed.finding.moduleUuid,
				name: seed.finding.name,
				caseType: seed.caseType,
				caseListConfig: {
					columns: [
						plainColumn(seed.finding.columnUuid, "case_name", "Patient"),
					],
					searchInputs: [
						simpleSearchInputDef(
							seed.finding.searchInputUuid,
							seed.prompt.name,
							seed.prompt.label,
							"text",
							"case_name",
							{ mode: fuzzyMode() },
						),
					],
				},
				caseSearchConfig: { workflow: "skipToResults" },
				forms: [
					{ name: seed.finding.formName, type: "followup", fields: [note] },
				],
			},
			{
				uuid: seed.browsing.moduleUuid,
				name: seed.browsing.name,
				caseType: seed.caseType,
				caseListConfig: {
					columns: [
						plainColumn(seed.browsing.columnUuid, "case_name", "Patient"),
					],
					searchInputs: [],
				},
				forms: [
					{ name: seed.browsing.formName, type: "followup", fields: [note] },
				],
			},
		],
	});
	for (const child of [
		seed.searching.moduleUuid,
		seed.finding.moduleUuid,
		seed.browsing.moduleUuid,
	])
		doc.modules[child] = {
			...doc.modules[child],
			parentModuleUuid: seed.clinic.moduleUuid,
		};
	return doc;
}
