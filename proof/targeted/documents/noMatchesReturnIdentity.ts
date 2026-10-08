/** A fixed sibling-menu move changes positional return commands, not their target. */
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn, proseText, simpleSearchInputDef } from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";
import { answerHeld } from "./echo";

export function noMatchesReturnIdentity() {
	const id = "targeted-no-matches-return-identity";
	const uuid = (name: string) => targetedUuid(id, name);
	const doc = buildDoc({
		appId: id,
		appName: "Patient registry",
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
				caseSearchConfig: { searchFirst: true },
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
						entry: { kind: "search-no-matches" },
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
				caseListOnly: true,
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
		rows: [
			"proof 5, no-matches return guards retain menu identity after a sibling move",
		],
		doc,
		edit,
		expected: {
			intent: [answerHeld("note-held", uuid("visit"), "/data/note", "seen")],
		},
		files: { "restore.xml": restoreXml({ cases: [] }) },
	});
}
