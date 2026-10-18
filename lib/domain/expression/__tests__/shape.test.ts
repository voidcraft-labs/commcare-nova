import { describe, expect, it } from "vitest";
import { asUuid } from "../../uuid";
import { type Expression, expressionSchema } from "../types";

const field = asUuid("00000000-0000-4000-8000-000000000001");
const other = asUuid("00000000-0000-4000-8000-000000000002");
const value: Expression = { kind: "term", term: { kind: "literal", value: 1 } };
const property = {
	kind: "prop",
	caseType: "patient",
	property: "age",
} as const;
describe("canonical persisted expression shape", () => {
	it("keeps existing bare properties and refuses their duplicate wrapped spelling", () => {
		const base = { kind: "match", property, value, mode: "starts-with" };
		expect(expressionSchema.parse(base)).toEqual(base);
		expect(
			expressionSchema.safeParse({
				...base,
				property: { kind: "term", term: property },
			}).success,
		).toBe(false);
		expect(
			expressionSchema.safeParse({
				...base,
				property: { kind: "call", fn: "string", args: [value] },
			}).success,
		).toBe(true);
	});
	it("keeps only one literal and choice spelling in a widened selection value", () => {
		const choice = { kind: "choice", field, options: [other] };
		const base = {
			kind: "multi-select-contains",
			property,
			quantifier: "any",
			values: [choice],
		};
		expect(expressionSchema.parse(base)).toEqual(base);
		expect(
			expressionSchema.safeParse({
				...base,
				values: [{ kind: "term", term: choice }],
			}).success,
		).toBe(false);
		expect(
			expressionSchema.safeParse({
				...base,
				values: [
					{
						kind: "term",
						term: { kind: "literal", value: "a", data_type: "text" },
					},
				],
			}).success,
		).toBe(false);
	});
	it("preserves annotated dynamic operands and the reserved exact date pattern exception", () => {
		const date = { kind: "today" };
		expect(
			expressionSchema.safeParse({
				kind: "format-date",
				date,
				pattern: { kind: "term", term: { kind: "literal", value: "iso" } },
			}).success,
		).toBe(true);
		expect(
			expressionSchema.safeParse({
				kind: "format-date",
				date,
				pattern: { kind: "term", term: { kind: "literal", value: "%Y" } },
			}).success,
		).toBe(false);
		expect(
			expressionSchema.safeParse({
				kind: "format-date",
				date,
				pattern: {
					kind: "term",
					term: { kind: "literal", value: "%Y", data_type: "text" },
				},
			}).success,
		).toBe(true);
		expect(
			expressionSchema.safeParse({
				kind: "matches-pattern",
				left: value,
				pattern: { kind: "term", term: { kind: "literal", value: true } },
			}).success,
		).toBe(true);
	});
	it("admits untyped standard properties while requiring custom-property identity", () => {
		expect(
			expressionSchema.safeParse({
				kind: "term",
				term: { kind: "prop", property: "case_id" },
			}).success,
		).toBe(true);
		expect(
			expressionSchema.safeParse({
				kind: "term",
				term: { kind: "prop", property: "age" },
			}).success,
		).toBe(false);
	});
	it("uses the full form-node identity for nonempty ordered filter groups", () => {
		const row = { kind: "field", uuid: field } as const;
		const wrapper = {
			kind: "field",
			uuid: field,
			role: "query-wrapper",
		} as const;
		const leaf = {
			kind: "field",
			uuid: other,
			spelling: "relative",
			filters: [
				{ step: wrapper, where: [value] },
				{ step: row, where: [value] },
			],
		};
		expect(
			expressionSchema.safeParse({ kind: "term", term: leaf }).success,
		).toBe(true);
		expect(
			expressionSchema.safeParse({
				kind: "term",
				term: { ...leaf, filters: [leaf.filters[0], leaf.filters[0]] },
			}).success,
		).toBe(false);
		expect(
			expressionSchema.safeParse({
				kind: "term",
				term: { ...leaf, filters: [] },
			}).success,
		).toBe(false);
		expect(
			expressionSchema.safeParse({
				kind: "term",
				term: { ...leaf, spelling: "absolute" },
			}).success,
		).toBe(false);
	});
	it("keeps ordinary repeat attributes absolute-capable and the form root filter-free", () => {
		expect(
			expressionSchema.safeParse({
				kind: "term",
				term: {
					kind: "repeat-row",
					repeat: field,
					attribute: "id",
					spelling: "absolute",
					filters: [
						{
							step: { kind: "repeat-row", repeat: field, attribute: "id" },
							where: [value],
						},
					],
				},
			}).success,
		).toBe(true);
		expect(
			expressionSchema.safeParse({
				kind: "term",
				term: {
					kind: "form-node",
					node: { kind: "form-root", form: field },
					spelling: "relative",
					filters: [{ step: { kind: "field", uuid: other }, where: [value] }],
				},
			}).success,
		).toBe(false);
	});
	it("places a counted query's predicate in the query and projects only row leaves", () => {
		const rows = { kind: "cases", source: "casedb", where: [value] };
		expect(
			expressionSchema.safeParse({ kind: "count", via: rows }).success,
		).toBe(true);
		expect(
			expressionSchema.safeParse({ kind: "count", via: rows, where: value })
				.success,
		).toBe(false);
		expect(
			expressionSchema.safeParse({ kind: "project", of: rows, value: property })
				.success,
		).toBe(true);
		expect(
			expressionSchema.safeParse({
				kind: "project",
				of: rows,
				value: { kind: "literal", value: 1 },
			}).success,
		).toBe(false);
	});
});
