import { describe, expect, it } from "vitest";
import { emitOnDeviceExpression } from "@/lib/commcare/expression";
import { dateAdd, dateCoerce, literal, term } from "@/lib/domain/predicate";
import { xpathToString } from "../coerce";
import { evaluate } from "../evaluator";
import type { EvalContext } from "../types";

const context: EvalContext = {
	getValue: () => undefined,
	resolveHashtag: () => "",
	contextPath: "/data/current",
	position: 1,
	size: 1,
};

function evaluateDateAdd(
	base: string,
	interval: "seconds" | "minutes" | "hours" | "days" | "weeks",
	quantity: number,
): { readonly xpath: string; readonly result: string } {
	const xpath = emitOnDeviceExpression(
		dateAdd(dateCoerce(term(literal(base))), interval, term(literal(quantity))),
	);
	return { xpath, result: xpathToString(evaluate(xpath, context)) };
}

describe("on-device date-add lowering in Preview XPath", () => {
	it.each([
		["1969-12-31", "days", -0.5, "1969-12-30"],
		["1969-12-31", "days", 0.5, "1969-12-31"],
		["2024-01-01", "seconds", -1, "2023-12-31"],
		["2024-01-01", "minutes", 720, "2024-01-01"],
		["2024-01-01", "hours", 24, "2024-01-02"],
		["2024-01-01", "weeks", 0.5, "2024-01-04"],
	] as const)(
		"evaluates %s plus %s %s as the same whole date CCHQ returns",
		(base, interval, quantity, expected) => {
			const { xpath, result } = evaluateDateAdd(base, interval, quantity);
			expect(xpath).toContain("date(floor(");
			expect(result).toBe(expected);
		},
	);
});
