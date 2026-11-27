import { describe, expect, it } from "vitest";
import { expressionEditorFixture } from "@/__tests__/helpers/expressionEditorFixture";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { simpleSearchInputDef } from "@/lib/domain";
import {
	arith,
	checkExpression,
	dateLiteral,
	eq,
	gt,
	ifExpr,
	literal,
	prop,
	sessionContext,
	slotContext,
	term,
} from "@/lib/domain/expression";
import { expressionContextAtPath } from "@/lib/domain/expression/typeChecker";
import { proseText } from "@/lib/domain/prose";
import { VERB_ENTRIES, verbEntryAdmitted } from "../cards/PredicateVerbMenu";
import { replaceComparisonSubject } from "../comparisonModel";
import type { PredicateEditContext } from "../editorSchemas";
import { editorExpressionContext } from "../editorTypeContext";

const context: PredicateEditContext = expressionEditorFixture("case-filter", {
	caseTypes: [
		{
			name: "patient",
			properties: [
				{ name: "name", label: proseText("Name"), data_type: "text" },
				{ name: "age", label: proseText("Age"), data_type: "int" },
				{ name: "date", label: proseText("Date"), data_type: "date" },
			],
		},
	],
	currentCaseType: "patient",
	knownInputs: [],
}).context;
describe("comparison subject atomic edits", () => {
	it("changes an incompatible object in the same candidate as the subject", () => {
		const source = eq(prop("patient", "name"), literal("Alice"));
		const next = replaceComparisonSubject(
			source,
			term(prop("patient", "age")),
			context,
		);
		expect(next).toEqual(eq(prop("patient", "age"), literal(0)));
		expect(
			checkExpression(next, editorExpressionContext(context)),
		).toMatchObject({ errors: [] });
		expect(source.right).toEqual(term(literal("Alice")));
	});
	it("retains an authored compatible expression by identity", () => {
		const right = arith("+", term(literal(5)), term(literal(2)));
		const next = replaceComparisonSubject(
			gt(prop("patient", "age"), right),
			arith("+", term(prop("patient", "age")), term(literal(1))),
			context,
		);
		if (next.kind !== "gt") throw new Error("Expected greater-than");
		expect(next.right).toBe(right);
		expect(
			checkExpression(next, editorExpressionContext(context)),
		).toMatchObject({ errors: [] });
	});
	it("does not strip a temporal qualifier when a replacement remains compatible", () => {
		const source = gt(prop("patient", "date"), dateLiteral("2026-01-01"));
		const next = replaceComparisonSubject(
			source,
			term(prop("patient", "date")),
			context,
		);
		if (next.kind !== "gt") throw new Error("Expected greater-than");
		expect(next.right).toBe(source.right);
	});

	it("offers numeric worker-name ordering with the written text on a Search default", () => {
		const module = testUuid("worker-name-default-menu");
		const input = testUuid("worker-name-default-input");
		const doc = buildDoc({
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					uuid: module,
					name: "Patients",
					caseType: "patient",
					caseSearchConfig: {},
					caseListConfig: {
						...caseListConfig([]),
						searchInputs: [
							simpleSearchInputDef(
								input,
								"village",
								"Village",
								"text",
								"village",
							),
						],
					},
				},
			],
		});
		const review = slotContext(
			doc,
			{
				entity: "module",
				uuid: module,
				slot: "search_input_default",
				member: { searchInputUuid: input },
			},
			new Map(),
		);
		if (review === undefined)
			throw new Error("Expected the simple Search starting value");
		const subject = sessionContext("username");
		const comparison = eq(subject, literal("20"));
		const defaultValue = ifExpr(
			comparison,
			term(literal("north")),
			term(literal("south")),
		);
		const editContext = {
			...context,
			expressionContext: expressionContextAtPath(defaultValue, review, [
				"if",
				"cond",
			]),
		};
		const order = VERB_ENTRIES.find((entry) => entry.id === "gt");
		if (order === undefined)
			throw new Error("Expected the greater-than operation");
		expect(verbEntryAdmitted(order, comparison, "text", editContext)).toBe(
			true,
		);
		const next = order.build(comparison, editContext);
		expect(next).toEqual(gt(subject, literal("20")));
		expect(verbEntryAdmitted(order, comparison, "text", context)).toBe(false);
		expect(
			verbEntryAdmitted(
				order,
				eq(subject, dateLiteral("2026-01-01")),
				"text",
				editContext,
			),
		).toBe(false);
	});
});
