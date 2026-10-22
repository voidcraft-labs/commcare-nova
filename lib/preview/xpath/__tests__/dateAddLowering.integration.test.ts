import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { toWire } from "@/lib/commcare/xpath/wire/fromExpression";
import { serializeWire } from "@/lib/commcare/xpath/wire/serialize";
import { dateAdd, dateCoerce, literal, term } from "@/lib/domain/expression";
import { slotContext } from "@/lib/domain/expression/context";
import { xpathToString } from "../coerce";
import { evaluate } from "../evaluator";
import type { EvalContext } from "../types";

const context: EvalContext = {
	getValue: () => undefined,
	resolveHashtag: () => "",
	contextPath: "/data/current",
	position: 1,
};

function evaluateDateAdd(
	base: string,
	interval: "seconds" | "minutes" | "hours" | "days" | "weeks",
	quantity: number,
): { readonly xpath: string; readonly result: string } {
	const expression = dateAdd(
		dateCoerce(term(literal(base))),
		interval,
		term(literal(quantity)),
	);
	const doc = buildDoc({
		modules: [
			{
				name: "Dates",
				forms: [
					{
						name: "Date calculation",
						type: "survey",
						fields: [
							{ id: "date_result", kind: "hidden", calculate: expression },
						],
					},
				],
			},
		],
	});
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	const fieldUuid = doc.fieldOrder[formUuid][0];
	const types = slotContext(
		doc,
		{ entity: "field", uuid: fieldUuid, slot: "calculate" },
		new Map(),
	);
	if (types === undefined)
		throw new Error("The date calculation has no expression slot context.");
	const xpath = serializeWire(toWire(expression, { target: "xform", types }), {
		target: "xform",
		constraint: false,
	}).text;
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
		"evaluates emitted %s plus %s %s as the expected whole date",
		(base, interval, quantity, expected) => {
			const { result } = evaluateDateAdd(base, interval, quantity);
			expect(result).toBe(expected);
		},
	);
});
