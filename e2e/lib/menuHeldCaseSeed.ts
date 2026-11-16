/**
 * A menu screen that holds a case, and a submenu that goes on with it. The
 * Patients menu chooses its case first and has a submenu, so choosing a
 * patient lands on its menu screen holding the patient (Web Apps' trail reads
 * App / Patients / the patient). Visits keeps its own screen under it and
 * lists its forms first (a survey beside a follow-up), going on with the
 * patient Patients chose: its follow-up opens for that patient, and a route
 * back to a list from it reaches Patients' list, which chose the case
 * (`menuProjection.ts::previewCaseListReturn`). The follow-up's date question
 * preloads `due_date`, and one patient's imported value is no date, so the
 * form refuses to open for that patient and offers Choose another record.
 * Patients' list keeps its tile on screen, so every screen holding the
 * patient pins it (`lib/preview/pinnedCaseTile.ts`). Pregnancies is a second
 * submenu, of a child case type, that chooses its pregnancy first among the
 * chosen patient's and goes on into its own form menu, so a form chosen there
 * leaves a case target from a list's own form menu behind as the worker steps
 * back to the Patients menu; the patient's crumb on Visits' screen must still
 * reach the Patients menu holding the patient. Clinic patients is a menu of
 * its own whose list keeps its tile on screen and shows each patient's
 * details, so Android's details draw the patient they show, where no case is
 * held yet, and Web Apps' draw none (`lib/preview/pinnedCaseTile.ts`).
 * Clinic search is the same list with a Search action whose forms do not
 * read the search: a result is chosen for the search's own datum, which names
 * no persistent detail, so Android's details of a result draw no tile
 * until the chosen patient is held.
 * Pregnancy visits is a menu of its own whose pregnancies are chosen under a
 * patient Patients' list chooses, a list off its trail, so Web Apps' trail
 * names that patient after the menu, before the pregnancy, one crumb per
 * selection (`MenuSession.handleInput`), and the patient's crumb reaches
 * the list of the patient's pregnancies (`previewBreadcrumbs.ts`). Its list
 * keeps its tile on screen as Patients' does, so its form pins the
 * patient's tile, the earliest held case whose list keeps one, and not the
 * pregnancy's, the form's own module's (`pinnedCaseTile.ts`).
 * Pregnancy follow-ups is a menu of its own that lists its forms first, a
 * survey beside a follow-up, whose pregnancies are chosen under a patient
 * Clinic patients' list chooses: the running app lists its forms, asks for
 * the patient after the follow-up's command, and goes on at the patient's
 * row though Clinic patients' own list opens each patient's details, as the
 * parent's datum names no details screen
 * (`lib/preview/engine/parentCaseSelection.ts`).
 */
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	plainColumn,
	simpleSearchInputDef,
	tileCell,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { buildUrl } from "@/lib/routing/location";

export const MENU_HELD_CASE_SEED = {
	appName: "Smoke — Menu holding a case",
	caseType: "patient",
	property: "due_date",
	propertyLabel: "Due date",
	patients: {
		moduleUuid: testUuid("menu-held-patients"),
		name: "Patients",
		columnUuid: testUuid("menu-held-patients-name"),
		formUuid: testUuid("menu-held-review"),
		formName: "Review patient",
	},
	visits: {
		moduleUuid: testUuid("menu-held-visits"),
		name: "Visits",
		columnUuid: testUuid("menu-held-visits-name"),
		surveyUuid: testUuid("menu-held-notes"),
		surveyName: "Visit notes",
		formUuid: testUuid("menu-held-due"),
		formName: "Check due date",
	},
	pregnancies: {
		moduleUuid: testUuid("menu-held-pregnancies"),
		name: "Pregnancies",
		caseType: "pregnancy",
		columnUuid: testUuid("menu-held-pregnancies-name"),
		formUuid: testUuid("menu-held-pregnancy-visit"),
		formName: "Record pregnancy visit",
		/** The imported patient's one pregnancy. */
		caseName: "First pregnancy",
	},
	pregnancyVisits: {
		moduleUuid: testUuid("menu-held-pregnancy-visits"),
		name: "Pregnancy visits",
		columnUuid: testUuid("menu-held-pregnancy-visits-name"),
		formUuid: testUuid("menu-held-pregnancy-check"),
		formName: "Pregnancy check",
	},
	/** A menu of its own whose pregnancies a patient chosen on Clinic
	 *  patients' list holds, listing its forms before the patient is chosen. */
	pregnancyFollowUps: {
		moduleUuid: testUuid("menu-held-pregnancy-follow-ups"),
		name: "Pregnancy follow-ups",
		columnUuid: testUuid("menu-held-pregnancy-follow-ups-name"),
		surveyUuid: testUuid("menu-held-pregnancy-notes"),
		surveyName: "Pregnancy notes",
		formUuid: testUuid("menu-held-pregnancy-follow-up"),
		formName: "Pregnancy follow-up",
	},
	clinic: {
		moduleUuid: testUuid("menu-held-clinic"),
		name: "Clinic patients",
		columnUuid: testUuid("menu-held-clinic-name"),
		formUuid: testUuid("menu-held-clinic-check"),
		formName: "Clinic check",
	},
	clinicSearch: {
		moduleUuid: testUuid("menu-held-clinic-search"),
		name: "Clinic search",
		columnUuid: testUuid("menu-held-clinic-search-name"),
		inputUuid: testUuid("menu-held-clinic-search-input"),
		formUuid: testUuid("menu-held-clinic-search-check"),
		formName: "Clinic search check",
	},
	/** The imported patient: their due date is text no date cast accepts. */
	refused: { caseName: "Ada Okafor", value: "next week" },
	/** The patient the follow-up opens for. */
	opens: { caseName: "Bea Lund", value: "2026-11-02" },
} as const;

export function buildMenuHeldCaseBlueprint(appId: string): BlueprintDoc {
	const seed = MENU_HELD_CASE_SEED;
	const name = (uuid: typeof seed.patients.columnUuid) =>
		plainColumn(uuid, "case_name", "Patient", {
			// No details: choosing a patient goes straight on.
			visibleInDetail: false,
			tile: tileCell(0, 0, 6, 1, { fontSize: "large" }),
		});
	const doc = buildDoc({
		appId,
		appName: seed.appName,
		caseTypes: [
			{
				name: seed.caseType,
				properties: [
					{
						name: seed.property,
						label: proseText(seed.propertyLabel),
						data_type: "date",
					},
				],
			},
			{
				name: seed.pregnancies.caseType,
				parent_type: seed.caseType,
				properties: [],
			},
		],
		modules: [
			{
				uuid: seed.patients.moduleUuid,
				name: seed.patients.name,
				caseType: seed.caseType,
				caseListConfig: {
					tile: { persistOnForms: true },
					columns: [name(seed.patients.columnUuid)],
					searchInputs: [],
				},
				forms: [
					{
						uuid: seed.patients.formUuid,
						name: seed.patients.formName,
						type: "followup",
						fields: [f({ kind: "text", id: "review_note" })],
					},
				],
			},
			{
				uuid: seed.visits.moduleUuid,
				name: seed.visits.name,
				caseType: seed.caseType,
				caseListConfig: {
					columns: [
						plainColumn(seed.visits.columnUuid, "case_name", "Patient", {
							visibleInDetail: false,
						}),
					],
					searchInputs: [],
				},
				forms: [
					{
						uuid: seed.visits.surveyUuid,
						name: seed.visits.surveyName,
						type: "survey",
						fields: [f({ kind: "text", id: "note" })],
					},
					{
						uuid: seed.visits.formUuid,
						name: seed.visits.formName,
						type: "followup",
						fields: [
							f({
								kind: "date",
								id: seed.property,
								label: proseText(seed.propertyLabel),
								caseWrite: {
									caseType: seed.caseType,
									property: seed.property,
								},
							}),
						],
					},
				],
			},
			{
				uuid: seed.pregnancies.moduleUuid,
				name: seed.pregnancies.name,
				caseType: seed.pregnancies.caseType,
				parentCaseModuleUuid: seed.patients.moduleUuid,
				caseListConfig: {
					columns: [
						plainColumn(seed.pregnancies.columnUuid, "case_name", "Pregnancy", {
							visibleInDetail: false,
						}),
					],
					searchInputs: [],
				},
				forms: [
					{
						uuid: seed.pregnancies.formUuid,
						name: seed.pregnancies.formName,
						type: "followup",
						fields: [f({ kind: "text", id: "visit_note" })],
					},
				],
			},
			{
				uuid: seed.clinic.moduleUuid,
				name: seed.clinic.name,
				caseType: seed.caseType,
				caseListConfig: {
					tile: { persistOnForms: true },
					columns: [
						plainColumn(seed.clinic.columnUuid, "case_name", "Patient", {
							// Shown on Details: choosing a patient opens their details.
							tile: tileCell(0, 0, 6, 1, { fontSize: "large" }),
						}),
					],
					searchInputs: [],
				},
				forms: [
					{
						uuid: seed.clinic.formUuid,
						name: seed.clinic.formName,
						type: "followup",
						fields: [f({ kind: "text", id: "clinic_note" })],
					},
				],
			},
			{
				uuid: seed.clinicSearch.moduleUuid,
				name: seed.clinicSearch.name,
				caseType: seed.caseType,
				caseListConfig: {
					tile: { persistOnForms: true },
					columns: [
						plainColumn(seed.clinicSearch.columnUuid, "case_name", "Patient", {
							tile: tileCell(0, 0, 6, 1, { fontSize: "large" }),
						}),
					],
					searchInputs: [
						simpleSearchInputDef(
							seed.clinicSearch.inputUuid,
							"patient_name",
							"Patient name",
							"text",
							"case_name",
						),
					],
				},
				forms: [
					{
						uuid: seed.clinicSearch.formUuid,
						name: seed.clinicSearch.formName,
						type: "followup",
						fields: [f({ kind: "text", id: "clinic_search_note" })],
					},
				],
			},
			{
				uuid: seed.pregnancyVisits.moduleUuid,
				name: seed.pregnancyVisits.name,
				caseType: seed.pregnancies.caseType,
				parentCaseModuleUuid: seed.patients.moduleUuid,
				caseListConfig: {
					/* Its own list keeps its tile too, so on its form the
					 * earliest held case whose list keeps one (the patient,
					 * Patients') differs from the form's own module's (the
					 * pregnancy). */
					tile: { persistOnForms: true },
					columns: [
						plainColumn(
							seed.pregnancyVisits.columnUuid,
							"case_name",
							"Pregnancy",
							{
								visibleInDetail: false,
								tile: tileCell(0, 0, 6, 1, { fontSize: "large" }),
							},
						),
					],
					searchInputs: [],
				},
				forms: [
					{
						uuid: seed.pregnancyVisits.formUuid,
						name: seed.pregnancyVisits.formName,
						type: "followup",
						fields: [f({ kind: "text", id: "check_note" })],
					},
				],
			},
			{
				uuid: seed.pregnancyFollowUps.moduleUuid,
				name: seed.pregnancyFollowUps.name,
				caseType: seed.pregnancies.caseType,
				parentCaseModuleUuid: seed.clinic.moduleUuid,
				caseListConfig: {
					columns: [
						plainColumn(
							seed.pregnancyFollowUps.columnUuid,
							"case_name",
							"Pregnancy",
							{ visibleInDetail: false },
						),
					],
					searchInputs: [],
				},
				forms: [
					{
						uuid: seed.pregnancyFollowUps.surveyUuid,
						name: seed.pregnancyFollowUps.surveyName,
						type: "survey",
						fields: [f({ kind: "text", id: "pregnancy_note" })],
					},
					{
						uuid: seed.pregnancyFollowUps.formUuid,
						name: seed.pregnancyFollowUps.formName,
						type: "followup",
						fields: [f({ kind: "text", id: "follow_up_note" })],
					},
				],
			},
		],
	});
	doc.modules[seed.visits.moduleUuid].parentModuleUuid =
		seed.patients.moduleUuid;
	doc.modules[seed.pregnancies.moduleUuid].parentModuleUuid =
		seed.patients.moduleUuid;
	return doc;
}

/** The Clinic patients menu, whose list opens each patient's details. */
export function menuHeldCaseClinicRoute(appId: string): string {
	return buildUrl(`/build/${appId}`, {
		kind: "module",
		moduleUuid: MENU_HELD_CASE_SEED.clinic.moduleUuid,
	});
}

export function menuHeldCaseRoute(appId: string): string {
	return buildUrl(`/build/${appId}`, {
		kind: "module",
		moduleUuid: MENU_HELD_CASE_SEED.patients.moduleUuid,
	});
}
