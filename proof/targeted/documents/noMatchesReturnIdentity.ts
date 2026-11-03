/**
 * A fixed sibling-menu move beside a menu whose forms read the search and
 * whose case list offers its registration form after a search finds nothing,
 * a form that returns to the case list. Forms read the search in Web Apps
 * alone, so the app declares Web Apps only, proof 5 compares the app JSON of
 * the move, and HQ builds the return guard.
 */
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	NEW_APP_SETTINGS,
	plainColumn,
	proseText,
	simpleSearchInputDef,
} from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";
import { answerHeld } from "./echo";

export function noMatchesReturnIdentity() {
	const id = "targeted-no-matches-return-identity";
	const uuid = (name: string) => targetedUuid(id, name);
	const doc = buildDoc({
		appId: id,
		appName: "Patient registry",
		// Forms that read the search run in Web Apps alone (`forms-read-search`).
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "web-apps" },
		caseTypes: [
			{
				name: "patient",
				parent_type: "household",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
			{
				name: "household",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				uuid: uuid("patients"),
				name: "Patients",
				caseType: "patient",
				caseSearchConfig: { formsReadSearch: true },
				caseListRegistrationForm: { formUuid: uuid("register") },
				caseListConfig: caseListOf(
					[plainColumn(uuid("patient-name-column"), "case_name", "Name")],
					{
						searchInputs: [
							simpleSearchInputDef(
								uuid("name-input"),
								"patient_name",
								"Name",
								"text",
								"case_name",
							),
						],
					},
				),
				forms: [
					{
						uuid: uuid("visit"),
						name: "Visit",
						type: "followup",
						fields: [
							f({
								uuid: uuid("note"),
								kind: "text",
								id: "note",
								label: "Note",
							}),
						],
					},
					{
						uuid: uuid("register"),
						name: "Register patient",
						type: "registration",
						fields: [
							f({
								uuid: uuid("name"),
								kind: "text",
								id: "case_name",
								label: "Name",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
				],
			},
			{
				uuid: uuid("households"),
				name: "Households",
				caseType: "household",
				caseListMenuItem: {},
				caseListConfig: caseListOf([
					plainColumn(uuid("household-name-column"), "case_name", "Name"),
				]),
				forms: [],
			},
		],
	});
	const edit = structuredClone(doc);
	edit.moduleOrder = [uuid("households"), uuid("patients")];
	return targetedDocument({
		id,
		rows: ["proof 5, a sibling menu move beside a no-matches form"],
		doc,
		edit,
		expected: {
			intent: [
				answerHeld("note-held", uuid("visit"), "/data/note", "seen", "A", {
					command: "m0-f0",
					caseId: "targeted-patient",
				}),
			],
		},
		files: { "restore.xml": restoreXml({ cases: [] }) },
	});
}
