/**
 * The text a worker typed into a case list's search box, read in a form
 * (`targeted-case-list-search-text`), declared Android only, since Web Apps
 * keeps no case list search text.
 *
 * Module "Patients" has one case list. Its follow-up form "Visit" holds a
 * hidden value `searched` calculated by the case list search text (the value
 * arm itself, never a session datum), which writes `patient.searched`, and a
 * note, writing `patient.note`, shown while the search text is blank. Core
 * adds `session/data/stringquery` for a frame step carrying the last query
 * (`SessionInstanceBuilder.addUserQueryData`), and Nova prints the read under
 * the count guard, `if(count(P) > 0, P[1], '')`, so an absent node reads blank.
 *
 * Fixed values: the note answered "seen" is the note the form holds. A
 * device's walk taps cases without typing a search, so it reads the absent
 * case (`''`) and the note is shown; the present case, one node and two, is
 * the native `expression` family's (`SessionContextRuntimeTest`).
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { NEW_APP_SETTINGS, plainColumn, proseText } from "@/lib/domain";
import { caseListSearchText, eq, literal } from "@/lib/domain/expression";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const ID = "targeted-case-list-search-text";
const uuid = (name: string) => targetedUuid(ID, name);

export function caseListSearchTextDocument() {
	const visit = uuid("visit");
	const doc = buildDoc({
		appId: ID,
		appName: "Case list search text",
		// Web Apps keeps no case list search text.
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "android" },
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "note", label: proseText("Note"), data_type: "text" },
					{ name: "searched", label: proseText("Searched for") },
				],
			},
		],
		modules: [
			{
				uuid: uuid("module"),
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListOf([
					plainColumn(uuid("name-column"), "case_name", "Name"),
				]),
				forms: [
					{
						uuid: visit,
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "hidden",
								uuid: uuid("searched"),
								id: "searched",
								calculate: caseListSearchText(),
								caseWrite: { caseType: "patient", property: "searched" },
							}),
							f({
								kind: "text",
								uuid: uuid("note"),
								id: "note",
								label: proseText("Note"),
								relevant: eq(caseListSearchText(), literal("")),
								caseWrite: { caseType: "patient", property: "note" },
							}),
						],
					},
				],
			},
		],
	});
	return targetedDocument({
		id: ID,
		rows: [
			"the case list search text read in a form's calculate and relevance",
		],
		doc,
		expected: {
			intent: [
				answerHeld("note-held", visit, "/data/note", "seen", "local", {
					command: "m0-f0",
					caseId: "targeted-patient",
				}),
			],
		},
	});
}
