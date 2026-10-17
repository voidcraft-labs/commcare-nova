/**
 * Where a close form's condition is written: on HQ's close action when HQ's
 * Case Management tab can state it, otherwise as a Save to Case close. Each
 * of the tab's five clauses fails beside its nearest passing neighbour.
 */
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, type FieldSpec, f } from "@/lib/__tests__/docHelpers";
import { closeConditionPlacement, proseText } from "@/lib/domain";

function placement(
	field: FieldSpec,
	answer: string,
	options: { inRepeat?: boolean; type?: "close" | "followup" } = {},
) {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Close",
						type: options.type ?? "close",
						fields: options.inRepeat
							? [
									f({
										kind: "repeat",
										id: "rows",
										repeat_mode: "user_controlled",
										children: [field],
									}),
								]
							: [field],
						closeCondition: { field: field.id, answer },
					},
				],
			},
		],
	});
	return closeConditionPlacement(doc, doc.formOrder[doc.moduleOrder[0]][0]);
}

const inline = (kind: "single_select" | "multi_select") =>
	f({
		kind,
		id: "outcome",
		optionsSource: {
			kind: "inline",
			options: ["a", "b", "its", "it's", '"x', "x"].map((value, index) => ({
				value,
				label: proseText(value),
				uuid: testUuid(`close-option-${kind}-${index}`),
			})),
		},
	});

it("places a condition on a select, a Hidden Value or a label on the close action, and on a text question in the source", () => {
	expect(placement(inline("single_select"), "a")).toBe("form-action");
	expect(placement(inline("multi_select"), "a")).toBe("form-action");
	expect(
		placement(f({ kind: "hidden", id: "outcome", calculate: "'a'" }), "a"),
	).toBe("form-action");
	expect(placement(f({ kind: "label", id: "outcome" }), "a")).toBe(
		"form-action",
	);
	expect(placement(f({ kind: "text", id: "outcome" }), "a")).toBe(
		"save-to-case",
	);
});

it("places a condition on a question inside a repeat in the source", () => {
	expect(placement(inline("single_select"), "a", { inRepeat: true })).toBe(
		"save-to-case",
	);
});

it("places an answer holding a single quote in the source", () => {
	expect(placement(inline("single_select"), "its")).toBe("form-action");
	expect(placement(inline("single_select"), "it's")).toBe("save-to-case");
});

it("places an answer that starts or ends with a double quote in the source", () => {
	expect(placement(inline("single_select"), "x")).toBe("form-action");
	expect(placement(inline("single_select"), '"x')).toBe("save-to-case");
	expect(
		placement(f({ kind: "hidden", id: "outcome", calculate: "'a'" }), 'x"'),
	).toBe("save-to-case");
	expect(
		placement(f({ kind: "hidden", id: "outcome", calculate: "'a'" }), 'x"y'),
	).toBe("form-action");
});

it("places an answer that is none of a select's own choices in the source, and any answer on a lookup or case select on the action", () => {
	expect(placement(inline("single_select"), "b")).toBe("form-action");
	expect(placement(inline("single_select"), "c")).toBe("save-to-case");
	for (const optionsSource of [
		{
			kind: "lookup",
			tableId: testUuid("close-table"),
			valueColumnId: testUuid("close-value"),
			labelColumnId: testUuid("close-label"),
		},
		{ kind: "cases", caseType: "patient", labelProperty: "case_name" },
	])
		expect(
			placement(
				f({ kind: "single_select", id: "outcome", optionsSource }),
				"c",
			),
		).toBe("form-action");
});

it("places an unconditional close and any other form's close on the close action", () => {
	expect(
		placement(f({ kind: "text", id: "outcome" }), "a", { type: "followup" }),
	).toBe("form-action");
	const doc = buildDoc({
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [{ name: "Close", type: "close", fields: [] }],
			},
		],
	});
	expect(
		closeConditionPlacement(doc, doc.formOrder[doc.moduleOrder[0]][0]),
	).toBe("form-action");
});

it("places a condition still missing its answer on the close action, where the emitter reads it as unconditional", () => {
	expect(placement(f({ kind: "text", id: "outcome" }), "")).toBe("form-action");
	expect(placement(inline("single_select"), "")).toBe("form-action");
});
