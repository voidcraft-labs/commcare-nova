import { describe, expect, it } from "vitest";
import { expressionEditorFixture } from "@/__tests__/helpers/expressionEditorFixture";
import type { CaseType } from "@/lib/domain";
import {
	ancestorPath,
	checkExpression,
	dateLiteral,
	isIn,
	literal,
	prop,
	relationStep,
	sessionContext,
} from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";
import { editorExpressionContext } from "../editorTypeContext";
import { membershipLiteralContext } from "../membershipLiteralContext";

const caseTypes: CaseType[] = [
	{
		name: "patient",
		parent_type: "household",
		properties: [
			{ name: "started", label: proseText("Started"), data_type: "int" },
		],
	},
	{
		name: "household",
		properties: [
			{ name: "started", label: proseText("Started"), data_type: "date" },
		],
	},
];
describe("membership literal property context", () => {
	it("uses related property type instead of a same-named origin property", () => {
		const value = isIn(
			prop(
				"patient",
				"started",
				ancestorPath(relationStep("parent", "household")),
			),
			dateLiteral("2026-01-01"),
		);
		expect(
			checkExpression(
				value,
				editorExpressionContext(
					expressionEditorFixture("case-filter", {
						caseTypes,
						currentCaseType: "patient",
						knownInputs: [],
					}).context,
				),
			),
		).toMatchObject({ errors: [] });
		expect(membershipLiteralContext(value, "patient", caseTypes)).toEqual({
			caseTypeName: "household",
			propertyName: "started",
		});
	});
	it("uses slot constraint for non-property expressions and keeps local properties local", () => {
		expect(
			membershipLiteralContext(
				isIn(sessionContext("username"), literal("a")),
				"patient",
				caseTypes,
			),
		).toEqual({ caseTypeName: "patient", propertyName: undefined });
		expect(
			membershipLiteralContext(
				isIn(prop("patient", "started"), literal(1)),
				"patient",
				caseTypes,
			),
		).toEqual({ caseTypeName: "patient", propertyName: "started" });
	});
});
