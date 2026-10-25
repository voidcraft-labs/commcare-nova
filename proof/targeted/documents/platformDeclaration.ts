/**
 * The platform declaration's witness: an app narrowed from both platforms to
 * Android only, with a date-and-time question the narrowing admits.
 *
 * D declares nothing, so it runs in Web Apps and on Android: a follow-up form
 * "Visit" on the patient case with a text question `note` that writes
 * `patient.note`. D′ is the same app declaring Android only, with a
 * date-and-time question `seen_at` after `note` that writes nothing, a
 * question Web Apps has no entry for (`entries.js::getEntry`), so the gate
 * judges the narrowing and the question it admits as one batch. Both are
 * built by one helper, so D and D′ share every identity.
 *
 * What reads it: at A, every reader, the client replaying it; at B-edit,
 * Formplayer's walk answers `seen_at` as Core's session does and submits, a
 * device walks it, and the client does not replay it.
 *
 * Fixed values: the note answered "seen" is the note the form holds.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { NEW_APP_SETTINGS, plainColumn, proseText } from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const ID = "targeted-platform-declaration";
const uuid = (name: string) => targetedUuid(ID, name);

/** The app before the narrowing, or (`narrowed`) after it. */
function visits(narrowed: boolean) {
	return buildDoc({
		appId: ID,
		appName: "Patient visits",
		appSettings: narrowed
			? { ...NEW_APP_SETTINGS, runsOnlyOn: "android" }
			: { ...NEW_APP_SETTINGS },
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "note", label: proseText("Note"), data_type: "text" },
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
						uuid: uuid("visit"),
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: uuid("note"),
								id: "note",
								label: proseText("Note"),
								caseWrite: { caseType: "patient", property: "note" },
							}),
							...(narrowed
								? [
										f({
											kind: "datetime",
											uuid: uuid("seen-at"),
											id: "seen_at",
											label: proseText("Seen at"),
										}),
									]
								: []),
						],
					},
				],
			},
		],
	});
}

export function platformDeclaration() {
	return targetedDocument({
		id: ID,
		rows: [
			"the platform declaration narrowed to Android only, with a date-and-time question the narrowing admits",
		],
		doc: visits(false),
		edit: visits(true),
		expected: {
			intent: [
				answerHeld("note-held", uuid("visit"), "/data/note", "seen", "local", {
					command: "m0-f0",
					caseId: "targeted-patient",
				}),
			],
		},
	});
}
