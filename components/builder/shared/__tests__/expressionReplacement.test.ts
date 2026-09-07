import { describe, expect, it } from "vitest";
import {
	dateCoerce,
	double,
	literal,
	term,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { planPreservedExpressionReplacement } from "../expressionReplacement";

const TYPE_CONTEXT = {
	caseTypes: [],
	knownInputs: [],
	currentCaseType: "patient",
};

function expectPreservedChild(
	current: ValueExpression,
	target: ValueExpression["kind"],
	expected: ValueExpression,
	child: ValueExpression,
) {
	const planned = planPreservedExpressionReplacement(
		current,
		target,
		TYPE_CONTEXT,
	);
	expect(planned).toEqual(expected);
	if (planned === null || !("value" in planned)) {
		throw new Error("Expected a unary replacement");
	}
	expect(planned.value).toBe(child);
}

describe("planPreservedExpressionReplacement", () => {
	it("keeps a text '4' when a date read becomes a numeric read", () => {
		const child = term(literal("4"));
		expectPreservedChild(dateCoerce(child), "double", double(child), child);
	});

	it("does not preserve a child that the target coercion rejects", () => {
		const child = term(literal(4));
		expect(
			planPreservedExpressionReplacement(
				double(child),
				"date-coerce",
				TYPE_CONTEXT,
			),
		).toBeNull();
	});
});

describe("authored child preservation across expression carriers", () => {
	it.each(["concat", "coalesce"] as const)(
		"wraps a term in %s without cloning its authored child",
		(target) => {
			const child = term(literal("kept"));
			const next = planPreservedExpressionReplacement(
				child,
				target,
				TYPE_CONTEXT,
			);
			expect(next).toEqual(
				target === "concat"
					? { kind: "concat", parts: [child] }
					: { kind: "coalesce", values: [child] },
			);
			if (next?.kind === "concat") expect(next.parts[0]).toBe(child);
			if (next?.kind === "coalesce") expect(next.values[0]).toBe(child);
		},
	);
	it("preserves every collection child in order across compatible carriers", () => {
		const first = term(literal("first"));
		const second = term(literal("second"));
		const current: ValueExpression = { kind: "concat", parts: [first, second] };
		const next = planPreservedExpressionReplacement(
			current,
			"coalesce",
			TYPE_CONTEXT,
		);
		expect(next).toEqual({ kind: "coalesce", values: [first, second] });
		if (next?.kind !== "coalesce")
			throw new Error("Expected preserved collection");
		expect(next.values[0]).toBe(first);
		expect(next.values[1]).toBe(second);
		expect(
			planPreservedExpressionReplacement(next, "concat", TYPE_CONTEXT),
		).toEqual(current);
	});
	it("refuses a collection whose target requires incompatible result types", () => {
		const current: ValueExpression = {
			kind: "concat",
			parts: [term(literal("first")), term(literal(2))],
		};
		expect(
			planPreservedExpressionReplacement(current, "coalesce", TYPE_CONTEXT),
		).toBeNull();
	});
	it("refuses resetting an authored arithmetic operand through a preservation shortcut", () => {
		expect(
			planPreservedExpressionReplacement(
				term(literal(42)),
				"arith",
				TYPE_CONTEXT,
			),
		).toBeNull();
	});
	it.each([
		["today", "now"],
		["now", "today"],
	] as const)("switches the childless clock %s to %s directly", (from, to) => {
		expect(
			planPreservedExpressionReplacement({ kind: from }, to, TYPE_CONTEXT),
		).toEqual({ kind: to });
	});
});
