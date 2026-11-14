/**
 * A record type is named in form text as `#<type>/<property>`, or as
 * `#record/<type>/<property>` where the type is one of reference text's fixed
 * words. Every case type a form reads, whatever it is called, prints as text
 * the parser reads back to the same stored tree, so a type named `case`,
 * `form` or `1st-visit` can be shown and typed back like any other.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	parseFormExpressionForSlot,
	projectFormExpression,
} from "@/lib/doc/expressionText";
import type { BlueprintDoc } from "@/lib/domain";
import type {
	Expression,
	ExpressionSlotRef,
} from "@/lib/domain/expression/types";
import { parseFormExpression } from "../expressionAst";

const TYPES = [
	"case",
	"form",
	"user",
	"search",
	"record",
	"row",
	"parent",
	"1st-visit",
	"-flagged",
] as const;

const read = (caseType: string): Expression => ({
	kind: "term",
	term: { kind: "form-case", caseType, property: "code" },
});

/** A follow-up of `own`, whose parent type is `ancestor`, calculating from both. */
function followup(own: string, ancestor: string) {
	const doc: BlueprintDoc = buildDoc({
		caseTypes: [
			{
				name: own,
				parent_type: ancestor,
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "code", label: "Code" },
				],
			},
			{
				name: ancestor,
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "code", label: "Code" },
				],
			},
		],
		modules: [
			{
				name: "Records",
				caseType: own,
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "hidden",
								id: "both",
								calculate: {
									kind: "concat",
									parts: [read(own), read(ancestor)],
								},
							}),
						],
					},
				],
			},
		],
	});
	const field = Object.values(doc.fields).find((each) => each.id === "both");
	if (field === undefined) throw new Error("no field");
	const slot: ExpressionSlotRef = {
		entity: "field",
		uuid: field.uuid,
		slot: "calculate",
	};
	const stored = (doc.fields[field.uuid] as { calculate: Expression })
		.calculate;
	return { doc, slot, stored };
}

const parse = (doc: BlueprintDoc, slot: ExpressionSlotRef, text: string) =>
	parseFormExpressionForSlot(doc, slot, text, "unavailable");

describe("reference text for a record type", () => {
	for (const [index, own] of TYPES.entries()) {
		const ancestor = TYPES[(index + 1) % TYPES.length];
		describe(`a ${own} record whose parent is a ${ancestor} record`, () => {
			it("prints text that parses back to the same tree", () => {
				const { doc, slot, stored } = followup(own, ancestor);
				const printed = projectFormExpression(doc, slot, stored, "unavailable");
				expect(printed.unresolved).toEqual([]);
				const parsed = parse(doc, slot, printed.text);
				expect(parsed.ok && parsed.expression).toEqual(stored);
			});

			it("reads #record/<type>/<property> for either type", () => {
				const { doc, slot } = followup(own, ancestor);
				for (const caseType of [own, ancestor]) {
					const parsed = parse(doc, slot, `#record/${caseType}/code`);
					expect(parsed.ok && parsed.expression).toEqual(read(caseType));
				}
			});

			it("refuses #case in the builder's text, naming the long form", () => {
				const { doc, slot } = followup(own, ancestor);
				const parsed = parse(doc, slot, "#case/code");
				expect(parsed.ok).toBe(false);
				if (!parsed.ok)
					expect(parsed.issues.map((issue) => issue.message)).toEqual([
						"This formula has no selected record for #case to read. You can name the record type, as in #<record-type>/<property>. A record type called case is #record/case/<property>.",
					]);
			});

			it("reads #case as the selected record in the authoring scope", () => {
				const { doc, slot } = followup(own, ancestor);
				const parsed = parseFormExpression("#case/code", {
					doc,
					slot,
					lookup: "unavailable",
					authoring: {
						resolveFormShortName: () => undefined,
						selectedCaseType: own,
					},
				});
				expect(parsed.ok && parsed.expression).toEqual(read(own));
			});
		});
	}

	it("refuses #row and a one-segment #record with their sentences", () => {
		const { doc, slot } = followup("visit", "household");
		const row = parse(doc, slot, "#row/code");
		expect(row.ok ? [] : row.issues.map((issue) => issue.message)).toEqual([
			"#row reads the record or the table row a filter is testing, so it has nothing to read in this formula. A record's value is #<record-type>/<property>, and a record type called row is #record/row/<property>.",
		]);
		const record = parse(doc, slot, "#record/code");
		expect(
			record.ok ? [] : record.issues.map((issue) => issue.message),
		).toEqual([
			"A record reference names one property: #<record-type>/<property>, or #record/<record-type>/<property>, which reads any record type. A worker's detail is #user/<property>.",
		]);
	});
});
