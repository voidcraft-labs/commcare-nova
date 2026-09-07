import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	ancestorPath,
	checkPredicate,
	literal,
	multiSelectAll,
	multiSelectAny,
	prop,
	relationStep,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { buildEditorTypeContext } from "../editorTypeContext";
import {
	multiSelectProperty,
	replaceMultiSelectProperty,
	replaceMultiSelectValues,
} from "../multiSelectModel";

const caseTypes: CaseType[] = [
	{
		name: "patient",
		parent_type: "household",
		properties: [
			{
				name: "tags",
				label: proseText("Client tags"),
				data_type: "multi_select",
				options: [{ value: "client", label: proseText("Client") }],
			},
		],
	},
	{
		name: "household",
		properties: [
			{
				name: "tags",
				label: proseText("Household tags"),
				data_type: "multi_select",
				options: [
					{ value: "priority", label: proseText("Priority") },
					{ value: "follow_up", label: proseText("Follow up") },
				],
			},
		],
	},
];
const related = prop(
	"patient",
	"tags",
	ancestorPath(relationStep("parent", "household")),
);
describe("actual multiple-choice card edits", () => {
	it("reads option identities at the saved connection destination", () => {
		const value = multiSelectAny(related, literal("priority"));
		expect(
			checkPredicate(
				value,
				buildEditorTypeContext({
					caseTypes,
					currentCaseType: "patient",
					knownInputs: [],
				}),
			),
		).toEqual({ ok: true });
		expect(multiSelectProperty(related, caseTypes)?.label).toEqual(
			proseText("Household tags"),
		);
		expect(
			multiSelectProperty(related, caseTypes)?.options?.map(
				(option) => option.value,
			),
		).toEqual(["priority", "follow_up"]);
	});
	it("resets to the destination's first option while preserving the exact connection and quantifier", () => {
		const source = multiSelectAll(prop("patient", "tags"), literal("client"));
		const next = replaceMultiSelectProperty(source, related, caseTypes);
		expect(next).toEqual(multiSelectAll(related, literal("priority")));
		expect(next.property).toBe(related);
		expect(source.values).toEqual([literal("client")]);
	});
	it("refuses empty chip lists and permits repairing an invalid historical value by index", () => {
		const source = multiSelectAny(related, literal(7), literal("priority"));
		expect(replaceMultiSelectValues(source, [])).toBeUndefined();
		expect(replaceMultiSelectValues(source, source.values.slice(1))).toEqual(
			multiSelectAny(related, literal("priority")),
		);
	});
	it("does not silently borrow origin choices for an unresolved connection", () => {
		const missing = prop(
			"patient",
			"tags",
			ancestorPath(relationStep("custom", "missing")),
		);
		expect(multiSelectProperty(missing, caseTypes)).toBeUndefined();
	});
});
