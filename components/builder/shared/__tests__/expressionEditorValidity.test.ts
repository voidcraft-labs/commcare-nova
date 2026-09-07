import { describe, expect, it } from "vitest";
import {
	ANY_CONSTRAINT,
	arith,
	comparisonObjectConstraint,
	ifExpr,
	literal,
	matchAll,
	prop,
	term,
	today,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { expressionEditorErrors } from "../expressionEditorValidity";

const context = {
	caseTypes: [
		{
			name: "patient",
			properties: [
				{ name: "age", label: proseText("Age"), data_type: "int" as const },
			],
		},
	],
	knownInputs: [],
	currentCaseType: "patient",
};
describe("expression editor error projection", () => {
	it("keeps precise nested checker paths and adds no second operator finding", () => {
		const errors = expressionEditorErrors(
			arith("+", term(literal("text")), term(literal(1))),
			context,
			ANY_CONSTRAINT,
		);
		expect(errors.map(({ code, path }) => ({ code, path }))).toEqual([
			{ code: "number-value", path: ["left"] },
		]);
	});
	it("reports root slot mismatch and accepts the corresponding numeric value", () => {
		const constraint = comparisonObjectConstraint("eq", "int");
		expect(
			expressionEditorErrors(today(), context, constraint).map(
				({ code, path }) => ({ code, path }),
			),
		).toEqual([{ code: "constraint-value", path: [] }]);
		expect(
			expressionEditorErrors(term(prop("patient", "age")), context, constraint),
		).toEqual([]);
	});
	it("preserves branch diagnostics across expression/predicate family boundaries", () => {
		const errors = expressionEditorErrors(
			ifExpr(matchAll(), term(literal(1)), term(literal("text"))),
			context,
			ANY_CONSTRAINT,
		);
		expect(errors.map(({ code, path }) => ({ code, path }))).toContainEqual({
			code: "branch-values",
			path: ["if"],
		});
	});
	it("does not invent a root type diagnostic when the referenced type is unavailable", () => {
		const errors = expressionEditorErrors(
			term(prop("patient", "missing")),
			context,
			comparisonObjectConstraint("eq", "int"),
		);
		expect(errors.map(({ code }) => code)).toEqual(["unknown-property"]);
	});
});
