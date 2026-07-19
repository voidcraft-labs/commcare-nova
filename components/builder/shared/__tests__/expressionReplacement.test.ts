import { describe, expect, it } from "vitest";
import {
	dateCoerce,
	dateLiteral,
	double,
	literal,
	term,
	unwrapList,
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
	it("keeps a text '4' when a numeric read becomes a saved-list read", () => {
		const child = term(literal("4"));
		expectPreservedChild(
			double(child),
			"unwrap-list",
			unwrapList(child),
			child,
		);
	});

	it("keeps a text '4' when a date read becomes a numeric read", () => {
		const child = term(literal("4"));
		expectPreservedChild(dateCoerce(child), "double", double(child), child);
	});

	it("refuses to carry a date into a saved-list reader", () => {
		const child = term(dateLiteral("2025-06-15"));
		expect(
			planPreservedExpressionReplacement(
				double(child),
				"unwrap-list",
				TYPE_CONTEXT,
			),
		).toBeNull();
	});

	it("keeps the true date-coercion twins lossless for imported children", () => {
		const child = term(dateLiteral("2025-06-15"));
		expectPreservedChild(
			dateCoerce(child),
			"datetime-coerce",
			{ kind: "datetime-coerce", value: child },
			child,
		);
	});
});
