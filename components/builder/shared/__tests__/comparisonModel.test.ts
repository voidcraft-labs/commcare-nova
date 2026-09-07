import { describe, expect, it } from "vitest";
import {
	arith,
	checkPredicate,
	dateLiteral,
	eq,
	gt,
	literal,
	prop,
	term,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { replaceComparisonSubject } from "../comparisonModel";
import type { PredicateEditContext } from "../editorSchemas";
import { buildEditorTypeContext } from "../editorTypeContext";

const context: PredicateEditContext = {
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
	caseDataScope: "per-case",
};
describe("comparison subject atomic edits", () => {
	it("changes an incompatible object in the same candidate as the subject", () => {
		const source = eq(prop("patient", "name"), literal("Alice"));
		const next = replaceComparisonSubject(
			source,
			term(prop("patient", "age")),
			context,
		);
		expect(next).toEqual(eq(prop("patient", "age"), literal(0)));
		expect(checkPredicate(next, buildEditorTypeContext(context))).toEqual({
			ok: true,
		});
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
		expect(checkPredicate(next, buildEditorTypeContext(context))).toEqual({
			ok: true,
		});
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
});
