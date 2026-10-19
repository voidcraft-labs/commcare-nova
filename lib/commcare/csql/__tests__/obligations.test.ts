import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { simpleSearchInputDef } from "@/lib/domain";
import {
	arith,
	dateCoerce,
	datetimeCoerce,
	double,
	eq,
	gte,
	ifExpr,
	input,
	literal,
	prop,
	term,
	whenInput,
	within,
} from "@/lib/domain/expression/builders";
import type { Expression } from "@/lib/domain/expression/types";
import { searchInputXPathInstance } from "@/lib/preview/engine/xpathInstances";
import { toBoolean, xpathToString } from "@/lib/preview/xpath/coerce";
import { evaluate } from "@/lib/preview/xpath/evaluator";
import { invokeGeneratedJavaRosaFunction } from "@/lib/preview/xpath/generatedJavaRosaFunctions";
import { csqlInputContext } from "../../__tests__/csqlFunctionFixture";
import { serializeWire } from "../../xpath/wire/serialize";
import type { WireExpr } from "../../xpath/wire/tree";
import { emitCsql } from "../emitter";

// The obligations the emitter reports, evaluated by Preview's XPath evaluator
// over fixed search answers: each must hold exactly where the wrapper sends
// `match-none()`, so prompt validation and Preview reject the state the
// exported search fails closed on, and no other.
const names = ["mode", "value", "radius", "unit", "days"] as const;
const ref = (name: (typeof names)[number]) =>
	input(testUuid(`obligation-${name}`));
const context = csqlInputContext(
	names.map((name) =>
		simpleSearchInputDef(
			testUuid(`obligation-${name}`),
			name,
			name,
			"text",
			"case_name",
		),
	),
);

function run(wire: WireExpr, answers: Readonly<Record<string, string>>) {
	const instance = searchInputXPathInstance(
		new Map(Object.entries(answers)),
		"search-input:results",
	);
	return evaluate(serializeWire(wire, { target: "suite" }).text, {
		contextPath: "",
		position: 1,
		getValue: () => undefined,
		resolveXPathInstance: (id) =>
			id === "search-input:results" ? instance : undefined,
		invokeGeneratedFunction: invokeGeneratedJavaRosaFunction,
	});
}

/** The kinds of the obligations that hold, and what the wrapper sends. */
function outcome(
	predicate: Expression,
	answers: Readonly<Record<string, string>>,
) {
	const emission = emitCsql(predicate, context);
	return {
		rejected: (emission.runtimeRejections ?? [])
			.filter((rejection) => toBoolean(run(rejection.condition, answers)))
			.map((rejection) => rejection.kind)
			.sort(),
		sent: xpathToString(run(emission.wrapper, answers)),
	};
}

const both = `it's "quoted"`;

describe("CSQL obligations against Preview's evaluator", () => {
	const choice = ifExpr(
		eq(term(ref("mode")), term(literal("by-name"))),
		eq(prop("patient", "case_name"), term(ref("value"))),
		gte(prop("patient", "age"), term(literal(18))),
	);

	it("rejects a value of the branch the device chose", () => {
		expect(outcome(choice, { mode: "by-name", value: both })).toEqual({
			rejected: ["quote"],
			sent: "match-none()",
		});
	});

	it("does not reject a search for a value in the branch it did not choose", () => {
		expect(outcome(choice, { mode: "by-age", value: both })).toEqual({
			rejected: [],
			sent: "age >= 18",
		});
	});

	it("does not reject an unanswered input's clause", () => {
		const gated = whenInput(
			ref("value"),
			eq(prop("patient", "case_name"), term(ref("value"))),
		);
		expect(outcome(gated, {})).toEqual({ rejected: [], sent: "match-all()" });
	});

	it.each([
		["5", [], "within-distance(gps, '0 0', \"5\", 'miles')"],
		["0", ["positive-number"], "match-none()"],
		["far", ["positive-number"], "match-none()"],
	] as const)(
		"holds a runtime radius %j to a positive number",
		(radius, rejected, sent) => {
			const predicate = whenInput(
				ref("radius"),
				within(
					prop("patient", "gps"),
					term(literal("0 0")),
					term(ref("radius")),
					"miles",
				),
			);
			expect(outcome(predicate, { radius })).toEqual({ rejected, sent });
		},
	);

	it.each([
		["meters", []],
		["nauticalmiles", []],
		["parsecs", ["distance-unit"]],
	] as const)(
		"holds a runtime unit %j to one of HQ's nine",
		(unit, rejected) => {
			const predicate = whenInput(
				ref("unit"),
				within(
					prop("patient", "gps"),
					term(literal("0 0")),
					5,
					term(ref("unit")),
				),
			);
			expect(outcome(predicate, { unit }).rejected).toEqual(rejected);
		},
	);

	it.each([
		["19000", [], "dob = date(19000)"],
		["1.5", ["whole-number"], "match-none()"],
		["soon", ["whole-number"], "match-none()"],
	] as const)(
		"holds a runtime day count %j to a whole number, sent unquoted",
		(days, rejected, sent) => {
			const predicate = whenInput(
				ref("days"),
				eq(
					prop("patient", "dob"),
					dateCoerce(arith("+", double(term(ref("days"))), term(literal(0)))),
				),
			);
			expect(outcome(predicate, { days })).toEqual({ rejected, sent });
		},
	);

	it.each([
		["19000.5", []],
		["soon", ["decimal-number"]],
	] as const)(
		"holds a runtime day count %j under datetime() to a number",
		(days, rejected) => {
			const predicate = whenInput(
				ref("days"),
				gte(
					prop("patient", "visit_date"),
					datetimeCoerce(
						arith("+", double(term(ref("days"))), term(literal(0))),
					),
				),
			);
			expect(outcome(predicate, { days }).rejected).toEqual(rejected);
		},
	);
});
