import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const id = "targeted-form-behavior-pragmas";
const uuid = (name: string) => targetedUuid(id, name);

export function formBehaviorPragmas() {
	const validationForm = (name: string, title: string) => ({
		uuid: uuid(name),
		name: title,
		type: "survey" as const,
		fields: [
			f({
				uuid: uuid(`${name}-note`),
				id: "note",
				kind: "text",
				label: "First note",
				validate: ". != 'accepted' or #form/decision != 'deny'",
				validate_msg: "The first note needs to change.",
			}),
			f({
				uuid: uuid(`${name}-decision`),
				id: "decision",
				kind: "text",
				label: "Later decision",
			}),
		],
	});
	const rowForm = (hiddenNote: boolean) => {
		const rowUuid = (name: string) => uuid(hiddenNote ? `fixed-${name}` : name);
		return {
			uuid: rowUuid("repeat"),
			name: hiddenNote ? "Record fixed notes" : "Record rows",
			type: "survey" as const,
			fields: [
				f({
					uuid: rowUuid("rows"),
					id: "rows",
					kind: "repeat",
					label: "Visit",
					repeat_mode: "user_controlled",
					children: [
						f({
							uuid: rowUuid("row-note"),
							id: "note",
							...(hiddenNote
								? { kind: "hidden" as const }
								: { kind: "text" as const, label: "Row note" }),
							default_value: "'a'",
						}),
						f({
							uuid: rowUuid("row-calculated"),
							id: "value",
							kind: "hidden",
							default_value: "'D'",
							calculate: "concat(../note, '!')",
						}),
						f({
							uuid: rowUuid("row-seen"),
							id: "seen",
							kind: "text",
							label: "Value at insertion",
							default_value: "../value",
						}),
					],
				}),
				f({
					uuid: rowUuid("unrelated"),
					id: "unrelated",
					kind: "text",
					label: "Other note",
				}),
			],
		};
	};
	const doc = buildDoc({
		appId: id,
		appName: "Form behavior visits",
		modules: [
			{
				uuid: uuid("menu"),
				name: "Visits",
				forms: [
					{
						uuid: uuid("automatic"),
						name: "Automatic visit",
						type: "survey",
						fields: [
							f({
								uuid: uuid("automatic-note"),
								id: "note",
								kind: "text",
								label: "Visit note",
								default_value: "'Automatic report'",
							}),
						],
					},
					{
						uuid: uuid("manual"),
						name: "Manual visit",
						type: "survey",
						fields: [
							f({
								uuid: uuid("manual-note"),
								id: "note",
								kind: "text",
								label: "Visit note",
								default_value: "'Manual report'",
							}),
							f({
								uuid: uuid("manual-control"),
								id: "sync_text",
								kind: "label",
								label: "Visit sync control",
							}),
						],
					},
					validationForm("changed", "Check changed answers"),
					validationForm("complete", "Check all answers"),
					rowForm(false),
					{
						uuid: uuid("sync-suppressed"),
						name: "Manual visit without sync",
						type: "survey",
						fields: [
							f({
								uuid: uuid("sync-suppressed-note"),
								id: "note",
								kind: "text",
								label: "Visit note",
								default_value: "'Manual report'",
							}),
							f({
								uuid: uuid("no-sync"),
								id: "sync_text",
								kind: "label",
								label: "Visit sync setting",
							}),
						],
					},
					rowForm(true),
				],
			},
		],
	});
	doc.forms[uuid("automatic")].automaticSubmissionText = {
		carrier: { field: uuid("automatic-note"), role: "field-label" },
	};
	doc.forms[uuid("sync-suppressed")].skipAutomaticSyncText = {
		carrier: { field: uuid("no-sync"), role: "field-label" },
	};
	doc.forms[uuid("changed")].validateChangedAnswersText = {
		carrier: { field: uuid("changed-note"), role: "field-label" },
	};
	return targetedDocument({
		id,
		doc,
		rows: [
			"Three Web Apps form pragmas retain their separate effects on the real forms",
			"Each repeat row receives its starting value before the calculation settles",
		],
		expected: {
			intent: [
				answerHeld(
					"automatic-visit-note",
					uuid("automatic"),
					"/data/note",
					"Automatic report",
				),
			],
		},
	});
}
