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
 * reach the Patients menu holding the patient.
 */
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { type BlueprintDoc, plainColumn, tileCell } from "@/lib/domain";
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
		],
	});
	doc.modules[seed.visits.moduleUuid].parentModuleUuid =
		seed.patients.moduleUuid;
	doc.modules[seed.pregnancies.moduleUuid].parentModuleUuid =
		seed.patients.moduleUuid;
	return doc;
}

export function menuHeldCaseRoute(appId: string): string {
	return buildUrl(`/build/${appId}`, {
		kind: "module",
		moduleUuid: MENU_HELD_CASE_SEED.patients.moduleUuid,
	});
}
