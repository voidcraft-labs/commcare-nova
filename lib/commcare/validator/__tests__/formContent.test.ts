/**
 * What a form must hold, and what one form may hold.
 *
 * A form needs one field a person authored that is not a container: HQ's
 * build refuses a form whose questions are all groups as a blank form
 * (`helpers/validators.py::FormBaseValidator.validate_for_build`). And a
 * deliver form holds a deliver unit or a task, never both: CommCare Connect
 * checks the delivery before it completes the task, so it turns away the
 * visit in the form that completes the worker's assigned task
 * (commcare-connect `form_receiver/processor.py::process_deliver_form`).
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, type FieldSpec, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import type { BlueprintDoc, ConnectConfig } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import type { ValidationError } from "../errors";
import { runValidation } from "../runner";

const QUESTION = testUuid("form-content-question");

function surveyDoc(fields: FieldSpec[]): BlueprintDoc {
	return buildDoc({
		appName: "Form content",
		modules: [
			{ name: "Survey", forms: [{ name: "Intake", type: "survey", fields }] },
		],
	});
}

function findings(doc: BlueprintDoc): ValidationError[] {
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
}

const emptyGroup = (id = "household"): FieldSpec =>
	f({ kind: "group", id, label: proseText("Household"), children: [] });

describe("EMPTY_FORM", () => {
	it("refuses a form of empty groups and repeats, in the third wording", () => {
		const refused = findings(
			surveyDoc([
				emptyGroup(),
				f({
					kind: "repeat",
					id: "rows",
					label: proseText("Rows"),
					children: [emptyGroup("inner")],
				}),
			]),
		);
		expect(refused.map((error) => error.code)).toEqual(["EMPTY_FORM"]);
		expect(refused[0]?.details).toEqual({ problem: "no_question" });
		expect(userFacingError(refused[0] as ValidationError)).toBe(
			`"Intake" has sections or groups and no question in them yet. Add a question, a label or a hidden value.`,
		);
	});

	it("refuses a sectioned form whose pages hold only an empty group", () => {
		const refused = findings(
			surveyDoc([
				f({
					kind: "section",
					id: "first",
					label: proseText("First"),
					children: [emptyGroup()],
				}),
			]),
		);
		expect(refused.map((error) => error.code)).toEqual(["EMPTY_FORM"]);
		expect(refused[0]?.details).toEqual({ problem: "no_question" });
	});

	it("keeps its first two wordings for a form with no fields and one of empty sections", () => {
		expect(findings(surveyDoc([]))[0]?.details).toEqual({
			problem: "no_fields",
		});
		expect(
			findings(
				surveyDoc([
					f({
						kind: "section",
						id: "first",
						label: proseText("First"),
						children: [],
					}),
				]),
			)[0]?.details,
		).toEqual({ problem: "empty_sections" });
	});

	it.each<[string, FieldSpec[]]>([
		[
			"an empty group beside a label at the root",
			[
				emptyGroup(),
				f({ kind: "label", id: "note", label: proseText("Note") }),
			],
		],
		[
			"a group holding only a hidden value",
			[
				f({
					kind: "group",
					id: "household",
					label: proseText("Household"),
					children: [f({ kind: "hidden", id: "total", calculate: "1" })],
				}),
			],
		],
		[
			"a repeat holding only a label",
			[
				f({
					kind: "repeat",
					id: "rows",
					label: proseText("Rows"),
					children: [
						f({ kind: "label", id: "note", label: proseText("Note") }),
					],
				}),
			],
		],
		[
			"a sectioned form whose first page holds a label and whose second an empty group",
			[
				f({
					kind: "section",
					id: "first",
					label: proseText("First"),
					children: [
						f({ kind: "label", id: "note", label: proseText("Note") }),
					],
				}),
				f({
					kind: "section",
					id: "second",
					label: proseText("Second"),
					children: [emptyGroup()],
				}),
			],
		],
	])("accepts %s", (_name, fields) => {
		expect(findings(surveyDoc(fields))).toEqual([]);
	});

	it("refuses removing a form's last question beside an empty group, and admits moving it into the group", () => {
		const doc = surveyDoc([
			emptyGroup(),
			f({
				uuid: QUESTION,
				kind: "text",
				id: "name",
				label: proseText("Name"),
			}),
		]);
		const group = Object.values(doc.fields).find(
			(field) => field.kind === "group",
		);
		if (group === undefined) throw new Error("The fixture has no group");

		const removed = mutationCommitVerdict(
			doc,
			[{ kind: "removeField", uuid: QUESTION }],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(removed.ok).toBe(false);
		if (!removed.ok) {
			expect(removed.findings.map((error) => error.code)).toEqual([
				"EMPTY_FORM",
			]);
			expect(removed.findings[0]?.details?.problem).toBe("no_question");
		}

		const moved = mutationCommitVerdict(
			doc,
			[
				{
					kind: "moveField",
					uuid: QUESTION,
					toParentUuid: group.uuid,
					after: null,
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(moved.ok).toBe(true);
	});
});

function deliverDoc(connect: ConnectConfig): BlueprintDoc {
	return buildDoc({
		appName: "Deliveries",
		connectType: "deliver",
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Home visit",
						type: "survey",
						fields: [f({ kind: "text", id: "name", label: proseText("Name") })],
						connect,
					},
				],
			},
		],
	});
}

const DELIVER_UNIT = { id: "home_visit", name: "Home visit" };
const TASK = {
	id: "follow_up",
	name: "Follow up",
	description: "Visit again",
};

describe("CONNECT_DELIVER_FORM_HOLDS_TASK", () => {
	it("refuses a deliver form that holds both a deliver unit and a task", () => {
		const refused = findings(
			deliverDoc({ deliver_unit: DELIVER_UNIT, task: TASK }),
		);
		expect(refused.map((error) => error.code)).toEqual([
			"CONNECT_DELIVER_FORM_HOLDS_TASK",
		]);
		expect(refused[0]?.message).toBe(
			`"Home visit" holds both a deliver unit and a task. CommCare Connect checks the delivery before it completes the task, so it turns away the visit in this form while the task is assigned. A task goes in a form of its own.`,
		);
		expect(userFacingError(refused[0] as ValidationError)).toBe(
			refused[0]?.message,
		);
	});

	it.each<[string, ConnectConfig]>([
		["a deliver unit alone", { deliver_unit: DELIVER_UNIT }],
		["a task alone", { task: TASK }],
	])("accepts %s", (_name, connect) => {
		expect(findings(deliverDoc(connect))).toEqual([]);
	});
});
