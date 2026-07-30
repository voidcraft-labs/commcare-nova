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
