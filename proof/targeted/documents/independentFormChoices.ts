import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type CaseOperation,
	type FormCaseSelection,
	plainColumn,
	proseText,
} from "@/lib/domain";
import { formField, literal, neq, prop, term } from "@/lib/domain/expression";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

/** Two workers' choices from one physical list, one automatic check against a
 * record of another type and a value that must change when the worker goes back. */
const id = "targeted-independent-form-choices";
const uuid = (part: string) => targetedUuid(id, part);

export function independentChoicesBlueprint(appId: string) {
	const menu = uuid("people");
	const entry = uuid("visit");
	const choices: FormCaseSelection[] = [
		{
			uuid: uuid("worker"),
			name: "My worker record",
			tag: "worker",
			caseType: "commcare-user",
			source: { kind: "worker-record" },
		},
		{
			uuid: uuid("first"),
			name: "First person",
			tag: "first",
			caseType: "person",
			source: { kind: "choose", module: menu },
		},
		{
			uuid: uuid("second"),
			name: "Second person",
			tag: "second",
			caseType: "person",
			source: { kind: "choose", module: menu },
		},
		{
			uuid: uuid("raw"),
			name: "Record from the worker",
			tag: "raw",
			caseType: "person",
			source: {
				kind: "expression",
				value: term({
					kind: "session-datum",
					datum: { kind: "form-selection", selection: uuid("worker") },
				}),
			},
		},
	];
	const operations: CaseOperation[] = [
		{
			action: "own",
			id: "person",
			uuid: uuid("update-second"),
			writes: [
				{ property: "second_note", value: term(formField(uuid("note"))) },
			],
		},
		{
			action: "update",
			id: "update_first",
			uuid: uuid("update-first"),
			caseType: "person",
			target: {
				kind: "expression",
				expr: term({
					kind: "session-datum",
					datum: { kind: "form-selection", selection: uuid("first") },
				}),
			},
			writes: [
				{ property: "first_note", value: term(formField(uuid("note"))) },
			],
		},
	];
	const doc = buildDoc({
		appId,
		appName: "Visit two people",
		caseTypes: [
			{
				name: "person",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "first_note", label: proseText("First visit note") },
					{ name: "second_note", label: proseText("Second visit note") },
				],
			},
		],
		modules: [
			{
				uuid: menu,
				name: "People",
				caseType: "person",
				caseListMenuItem: { label: "All people" },
				caseListConfig: caseListOf(
					[plainColumn(uuid("name"), "case_name", "Name")],
					{
						filter: neq(
							prop("person", "case_name"),
							literal("Standalone list only"),
						),
					},
				),
				forms: [
					{
						uuid: entry,
						name: "Visit two people",
						type: "followup",
						fields: [
							f({
								uuid: uuid("note"),
								kind: "text",
								id: "note",
								label: proseText("Visit note"),
							}),
						],
					},
				],
			},
			{
				uuid: uuid("notes"),
				name: "Notes",
				forms: [
					{
						uuid: uuid("note-form"),
						name: "Leave a note",
						type: "survey",
						fields: [
							f({
								uuid: uuid("note-text"),
								kind: "text",
								id: "text",
								label: proseText("Note"),
							}),
						],
					},
				],
			},
		],
	});
	doc.forms[entry].caseSelections = choices;
	doc.forms[entry].caseOperations = operations;
	doc.forms[entry].computedDatums = [
		{
			uuid: uuid("visit-key"),
			key: "visit_key",
			value: { kind: "call", fn: "uuid", args: [] },
		},
	];
	return doc;
}

export function independentFormChoices() {
	const doc = independentChoicesBlueprint(id);
	return targetedDocument({
		id,
		rows: [
			"two independent opening records chosen from one list and an automatic record of another stored type",
		],
		doc,
		expected: {
			intent: [answerHeld("answer", uuid("note-form"), "/data/text", "seen")],
		},
	});
}
