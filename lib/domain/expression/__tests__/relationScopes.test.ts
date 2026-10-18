import { describe, expect, it } from "vitest";
import type { CaseType } from "../../blueprint";
import { lookupColumnIdSchema, lookupTableIdSchema } from "../../lookupIds";
import { asUuid } from "../../uuid";
import { arith, eq, literal, prop, subcasePath, term } from "../builders";
import { normalizeRelationEvaluationScopes } from "../normalizeRelationEvaluationScopes";
import { mapCasePropertiesInExpression } from "../rewrite";
import type { Expression } from "../types";

const caseTypes: CaseType[] = [
	{ name: "household", properties: [] },
	{ name: "patient", parent_type: "household", properties: [] },
	{ name: "visit", parent_type: "patient", properties: [] },
];
const context = { caseTypes, currentCaseType: "household" };
const patients = subcasePath("parent", "patient");
const related = () => prop("household", "age", patients);
const id = asUuid("00000000-0000-4000-8000-000000000001");
describe("relation scope normalization", () => {
	it("lifts the complete boolean leaf while retaining the scalar calculation", () => {
		const scalar = arith("+", term(related()), term(literal(1)));
		expect(normalizeRelationEvaluationScopes(scalar, context)).toBe(scalar);
		const normalized = normalizeRelationEvaluationScopes(
			eq(scalar, literal(5)),
			context,
		);
		expect(normalized).toEqual({
			kind: "exists",
			via: patients,
			where: eq(
				arith("+", term(prop("patient", "age")), term(literal(1))),
				literal(5),
			),
		});
		expect(normalizeRelationEvaluationScopes(normalized, context)).toBe(
			normalized,
		);
	});
	it("keeps numeric form predicates scalar and prevents their local reads from rebasing the outer test", () => {
		const numeric = arith("+", term(related()), term(literal(1)));
		const field: Expression = {
			kind: "term",
			term: {
				kind: "field",
				uuid: id,
				filters: [{ step: { kind: "field", uuid: id }, where: [numeric] }],
			},
		};
		const expression = eq(field, term(literal(2)));
		expect(normalizeRelationEvaluationScopes(expression, context)).toBe(
			expression,
		);
	});
	it("does not confuse a query-local property with an outer property", () => {
		const query: Expression = {
			kind: "project",
			of: {
				kind: "cases",
				source: "casedb",
				where: [eq(prop("patient", "age"), literal(3))],
			},
			value: prop("patient", "age"),
		};
		const expression = eq(related(), query);
		expect(
			normalizeRelationEvaluationScopes(expression, context),
		).toMatchObject({
			kind: "exists",
			where: {
				kind: "eq",
				left: { term: { caseType: "patient" } },
				right: query,
			},
		});
	});
	it("retains the explicitly captured case in a table lookup", () => {
		const lookup: Expression = {
			kind: "table-lookup",
			tableId: lookupTableIdSchema.parse(
				"00000000-0000-7000-8000-000000000001",
			),
			resultColumnId: lookupColumnIdSchema.parse(
				"00000000-0000-7000-8000-000000000002",
			),
			where: eq(prop("household", "external_id"), literal("a")),
		};
		expect(() =>
			normalizeRelationEvaluationScopes(eq(related(), lookup), context),
		).toThrow("more than one record scope");
		expect(normalizeRelationEvaluationScopes(lookup, context)).toBe(lookup);
	});
	it("refuses hidden current-row dependencies instead of moving them to the related row", () => {
		expect(() =>
			normalizeRelationEvaluationScopes(
				eq(
					related(),
					term({
						kind: "case-index",
						caseType: "household",
						identifier: "parent",
					}),
				),
				context,
			),
		).toThrow("more than one record scope");
		expect(() =>
			normalizeRelationEvaluationScopes(
				eq(related(), term({ kind: "case-row-type" })),
				context,
			),
		).toThrow("more than one record scope");
	});
	it("discovers unhinted rename targets and leaves invalid historical relations repairable", () => {
		const expression = eq(
			prop("patient", "name", {
				kind: "ancestor",
				via: [{ identifier: "parent" }],
			}),
			literal("a"),
		);
		expect(
			mapCasePropertiesInExpression(
				expression,
				(type, name) =>
					type === "household" && name === "name" ? "title" : undefined,
				caseTypes,
			),
		).toBe(1);
		expect(expression.left).toMatchObject({ term: { property: "title" } });
		const unresolved = eq(
			prop("household", "name", { kind: "subcase", identifier: "missing" }),
			literal("a"),
		);
		expect(
			mapCasePropertiesInExpression(unresolved, () => "title", caseTypes),
		).toBe(0);
		expect(() =>
			normalizeRelationEvaluationScopes(unresolved, context),
		).toThrow();
	});
});
