// lib/commcare/expression/__tests__/csqlEmitter.test.ts
//
// Acceptance tests for the CSQL value-expression emitter. The CSQL
// dialect has a closed value-function whitelist
// (`commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`):
// `date`, `date-add`, `datetime`, `datetime-add`, `double`, `now`,
// `today`, `unwrap-list`. The eight whitelist arms — when surfaced to
// the AST: `today`, `now`, `date-coerce` (→ `date`),
// `datetime-coerce` (→ `datetime`), `double`, `date-add`,
// `unwrap-list`, `term` — emit cleanly into the segment-list IR. The
// other seven arms (`arith`, `concat`, `coalesce`, `if`, `switch`,
// `count`, `format-date`) lift in the predicate emitter's hoist
// pass before reaching this emitter. The emitter throws a defensive
// error on any of those arms rather than emit broken CSQL — the
// throw guards the bypass path where a non-hoisted AST reaches this
// surface.
//
// Each test pins the exact `CsqlSegment[]` the emitter produces. The
// segment list — not a stringified concat-wrap — is the contract here
// because the wire-emission consumer composes the segments with its
// own surrounding constants (the predicate emitter joins comparison
// operators, the concat-wrap layer lifts each segment to a separate
// `concat(...)` argument).

import { describe, expect, it } from "vitest";
import {
	arith,
	coalesce,
	concat,
	count,
	dateAdd,
	dateCoerce,
	dateLiteral,
	datetimeCoerce,
	datetimeLiteral,
	double,
	formatDate,
	ifExpr,
	input,
	literal,
	matchAll,
	now,
	prop,
	sessionContext,
	sessionUser,
	subcasePath,
	switchCase,
	switchExpr,
	term,
	today,
	unwrapList,
} from "@/lib/domain/predicate/builders";
import type { TypeContext } from "@/lib/domain/predicate/typeChecker";
import type { CsqlSegment } from "../../predicate/csqlSegment";
import { quoteRuntimeCsqlValue } from "../../predicate/termEmitter";
import { parser } from "../../xpath/parser";
import { emitCsqlExpressionSegments } from "../csqlEmitter";

const TEMPORAL_CONTEXT: TypeContext = {
	caseTypes: [
		{
			name: "p",
			properties: [
				{ name: "birth_date", label: "Birth date", data_type: "date" },
				{
					name: "seen_at",
					label: "Seen at",
					data_type: "datetime",
				},
			],
		},
	],
	knownInputs: [
		{ name: "base_date", data_type: "date" },
		{ name: "base_datetime", data_type: "datetime" },
	],
};

function materializeSegments(
	segments: readonly CsqlSegment[],
	runtimeValues: ReadonlyMap<string, string>,
): string {
	return segments
		.map((segment) =>
			segment.kind === "constant"
				? segment.text
				: (runtimeValues.get(segment.xpath) ?? segment.xpath),
		)
		.join("");
}

function expectCleanCsqlParse(source: string): void {
	let hasError = false;
	parser.parse(source).iterate({
		enter(node) {
			if (node.type.isError) hasError = true;
		},
	});
	expect(hasError, source).toBe(false);
}

// ============================================================
// SHELL 1 — whitelist arms emit cleanly
// ============================================================

describe("emitCsqlExpressionSegments — discriminator-only constants", () => {
	it("emits today() as a single constant segment", () => {
		expect(emitCsqlExpressionSegments(today())).toEqual([
			{ kind: "constant", text: "today()" },
		]);
	});

	it("emits now() as a single constant segment", () => {
		expect(emitCsqlExpressionSegments(now())).toEqual([
			{ kind: "constant", text: "now()" },
		]);
	});
});

describe("emitCsqlExpressionSegments — coercion functions", () => {
	// Runtime XPath reads resolve before CCHQ parses the generated CSQL.
	// They therefore need CSQL string-literal brackets even inside a
	// native function call; raw interpolation turns an ISO date into an
	// arithmetic AST (`date(2024-01-02)`) and a session id into a Step.
	it("emits date(<value>) for date-coerce, splicing in a runtime ref segment", () => {
		const expr = dateCoerce(term(input("dob_text")));
		const xpath = `instance('search-input:results')/input/field[@name='dob_text']`;
		expect(emitCsqlExpressionSegments(expr)).toEqual([
			{ kind: "constant", text: "date(" },
			...quoteRuntimeCsqlValue(xpath, "double", ["dob_text"]),
			{ kind: "constant", text: ")" },
		]);
	});

	it("quotes a session-context scalar nested in datetime()", () => {
		const expr = datetimeCoerce(term(sessionContext("appversion")));
		const xpath = "instance('commcaresession')/session/context/appversion";
		expect(emitCsqlExpressionSegments(expr)).toEqual([
			{ kind: "constant", text: "datetime(" },
			...quoteRuntimeCsqlValue(xpath),
			{ kind: "constant", text: ")" },
		]);
	});

	it("quotes a session-user scalar nested in double()", () => {
		const expr = double(term(sessionUser("score")));
		const xpath = "instance('commcaresession')/session/user/data/score";
		expect(emitCsqlExpressionSegments(expr)).toEqual([
			{ kind: "constant", text: "double(" },
			...quoteRuntimeCsqlValue(xpath),
			{ kind: "constant", text: ")" },
		]);
	});

	it("inlines non-native wrappers as one safely quoted runtime function argument", () => {
		const dateExpr = dateCoerce(
			concat(term(input("year")), term(literal("-01-01"))),
		);
		const doubleExpr = double(
			ifExpr(matchAll(), term(input("score")), term(literal(0))),
		);
		const dateSegments = emitCsqlExpressionSegments(dateExpr);
		const doubleSegments = emitCsqlExpressionSegments(doubleExpr);
		expect(dateSegments[0]).toEqual({ kind: "constant", text: "date(" });
		expect(dateSegments[1]?.kind).toBe("runtime");
		expect(dateSegments.at(-1)).toEqual({ kind: "constant", text: ")" });
		expect(doubleSegments[0]).toEqual({ kind: "constant", text: "double(" });
		expect(doubleSegments[1]?.kind).toBe("runtime");
		expect(doubleSegments.at(-1)).toEqual({ kind: "constant", text: ")" });
		expectCleanCsqlParse(`date("2024-01-01")`);
		expectCleanCsqlParse(`double("19")`);
	});

	it("emits date(<literal>) for a literal value, leaving merging to the wrap layer", () => {
		const expr = dateCoerce(term(literal("2024-01-01")));
		expect(emitCsqlExpressionSegments(expr)).toEqual([
			{ kind: "constant", text: "date(" },
			{ kind: "constant", text: "'2024-01-01'" },
			{ kind: "constant", text: ")" },
		]);
	});

	it("emits datetime(<value>) for datetime-coerce", () => {
		const expr = datetimeCoerce(term(literal("2024-01-01T12:00:00")));
		expect(emitCsqlExpressionSegments(expr)).toEqual([
			{ kind: "constant", text: "datetime(" },
			{ kind: "constant", text: "'2024-01-01T12:00:00'" },
			{ kind: "constant", text: ")" },
		]);
	});

	it("emits double(<prop>) as constant segments awaiting merge", () => {
		const expr = double(term(prop("p", "age")));
		expect(emitCsqlExpressionSegments(expr)).toEqual([
			{ kind: "constant", text: "double(" },
			{ kind: "constant", text: "age" },
			{ kind: "constant", text: ")" },
		]);
	});
});

describe("emitCsqlExpressionSegments — date-add", () => {
	// CCHQ's wire signature: `date-add(date, interval, quantity)` —
	// three separate arguments. Source: `value_functions.py::date_add`.
	// Emitter returns raw segment lists; adjacent constants merge at
	// the wrap layer (`mergeAdjacentConstants` in csqlSegment.ts).
	it("emits date-add(<date>, '<interval>', <quantity>) for a literal date", () => {
		const expr = dateAdd(today(), "days", term(literal(-1)));
		expect(emitCsqlExpressionSegments(expr)).toEqual([
			{ kind: "constant", text: "date-add(" },
			{ kind: "constant", text: "today()" },
			{ kind: "constant", text: ", 'days', " },
			{ kind: "constant", text: "-1" },
			{ kind: "constant", text: ")" },
		]);
	});

	it("emits a months interval", () => {
		const expr = dateAdd(today(), "months", term(literal(3)));
		expect(emitCsqlExpressionSegments(expr)).toEqual([
			{ kind: "constant", text: "date-add(" },
			{ kind: "constant", text: "today()" },
			{ kind: "constant", text: ", 'months', " },
			{ kind: "constant", text: "3" },
			{ kind: "constant", text: ")" },
		]);
	});

	it("quotes a typed runtime date and keeps date-add", () => {
		const expr = dateAdd(term(input("base_date")), "days", term(literal(7)));
		const xpath = `instance('search-input:results')/input/field[@name='base_date']`;
		expect(emitCsqlExpressionSegments(expr, TEMPORAL_CONTEXT)).toEqual([
			{ kind: "constant", text: "date-add(" },
			...quoteRuntimeCsqlValue(xpath, "double", ["base_date"]),
			{ kind: "constant", text: ", 'days', " },
			{ kind: "constant", text: "7" },
			{ kind: "constant", text: ")" },
		]);
	});

	it("emits datetime-add for now() and preserves it through nested date-add wrappers", () => {
		const inner = dateAdd(now(), "hours", term(literal(2)));
		const expr = dateAdd(inner, "minutes", term(literal(30)));
		expect(emitCsqlExpressionSegments(expr)).toEqual([
			{ kind: "constant", text: "datetime-add(" },
			{ kind: "constant", text: "datetime-add(" },
			{ kind: "constant", text: "now()" },
			{ kind: "constant", text: ", 'hours', " },
			{ kind: "constant", text: "2" },
			{ kind: "constant", text: ")" },
			{ kind: "constant", text: ", 'minutes', " },
			{ kind: "constant", text: "30" },
			{ kind: "constant", text: ")" },
		]);
	});

	it("uses explicit coercion wrappers as a sound standalone discriminator", () => {
		const dateExpr = dateAdd(
			dateCoerce(term(input("base_date"))),
			"days",
			term(literal(1)),
		);
		const datetimeExpr = dateAdd(
			datetimeCoerce(term(input("base_datetime"))),
			"hours",
			term(literal(1)),
		);
		const dateInput = `instance('search-input:results')/input/field[@name='base_date']`;
		const datetimeInput = `instance('search-input:results')/input/field[@name='base_datetime']`;
		expect(emitCsqlExpressionSegments(dateExpr)).toEqual([
			{ kind: "constant", text: "date-add(" },
			{ kind: "constant", text: "date(" },
			...quoteRuntimeCsqlValue(dateInput, "double", ["base_date"]),
			{ kind: "constant", text: ")" },
			{ kind: "constant", text: ", 'days', " },
			{ kind: "constant", text: "1" },
			{ kind: "constant", text: ")" },
		]);
		expect(emitCsqlExpressionSegments(datetimeExpr)).toEqual([
			{ kind: "constant", text: "datetime-add(" },
			{ kind: "constant", text: "datetime(" },
			...quoteRuntimeCsqlValue(datetimeInput, "double", ["base_datetime"]),
			{ kind: "constant", text: ")" },
			{ kind: "constant", text: ", 'hours', " },
			{ kind: "constant", text: "1" },
			{ kind: "constant", text: ")" },
		]);
		expectCleanCsqlParse(`date-add(date("2024-05-01"), 'days', 1)`);
		expectCleanCsqlParse(
			`datetime-add(datetime("2024-05-01T10:30:00Z"), 'hours', 1)`,
		);
	});

	it("uses typed literals and null-neutral wrappers without a context", () => {
		const dateExpr = dateAdd(
			term(dateLiteral("2024-05-01")),
			"days",
			term(literal(1)),
		);
		const datetimeExpr = dateAdd(
			ifExpr(
				matchAll(),
				term(literal(null)),
				term(datetimeLiteral("2024-05-01T10:30:00Z")),
			),
			"hours",
			term(literal(1)),
		);
		expect(
			materializeSegments(emitCsqlExpressionSegments(dateExpr), new Map()),
		).toBe(`date-add('2024-05-01', 'days', 1)`);
		const datetimeSegments = emitCsqlExpressionSegments(datetimeExpr);
		expect(datetimeSegments[0]).toEqual({
			kind: "constant",
			text: "datetime-add(",
		});
		expect(datetimeSegments[1]?.kind).toBe("runtime");
		expectCleanCsqlParse(`datetime-add("2024-05-01T10:30:00Z", 'hours', 1)`);
	});

	it("rejects an ambiguous input or property when no canonical type context is supplied", () => {
		const inputExpr = dateAdd(
			term(input("base_date")),
			"days",
			term(literal(1)),
		);
		const propertyExpr = dateAdd(
			term(prop("p", "birth_date")),
			"days",
			term(literal(1)),
		);
		expect(() => emitCsqlExpressionSegments(inputExpr)).toThrow(
			/cannot choose between/i,
		);
		expect(() => emitCsqlExpressionSegments(propertyExpr)).toThrow(
			/cannot choose between/i,
		);
	});
});

describe("emitCsqlExpressionSegments — unwrap-list", () => {
	it("emits unwrap-list(<value>) for a property as constant segments", () => {
		const expr = unwrapList(term(prop("p", "tags")));
		expect(emitCsqlExpressionSegments(expr)).toEqual([
			{ kind: "constant", text: "unwrap-list(" },
			{ kind: "constant", text: "tags" },
			{ kind: "constant", text: ")" },
		]);
	});

	it("single-quotes runtime JSON so its required double quotes remain valid", () => {
		const expr = unwrapList(term(input("selected_values")));
		const segments = emitCsqlExpressionSegments(expr);
		const xpath = `instance('search-input:results')/input/field[@name='selected_values']`;
		const materialized = materializeSegments(
			// `quoteRuntimeCsqlValue` is asserted structurally below; this
			// representative server-side result pins the parser round trip.
			[{ kind: "constant", text: 'unwrap-list(\'["north","south"]\')' }],
			new Map(),
		);
		expect(materialized).toBe(`unwrap-list('["north","south"]')`);
		expect(segments).toEqual([
			{ kind: "constant", text: "unwrap-list(" },
			...quoteRuntimeCsqlValue(xpath, "single", ["selected_values"]),
			{ kind: "constant", text: ")" },
		]);
		expectCleanCsqlParse(materialized);
	});
});

describe("emitCsqlExpressionSegments — term arm structural lifter", () => {
	it("emits a property reference as a constant segment", () => {
		expect(emitCsqlExpressionSegments(term(prop("p", "full_name")))).toEqual([
			{ kind: "constant", text: "full_name" },
		]);
	});

	it("emits a string literal as a constant single-quoted segment", () => {
		expect(emitCsqlExpressionSegments(term(literal("Alice")))).toEqual([
			{ kind: "constant", text: `'Alice'` },
		]);
	});

	it("emits a numeric literal as an unquoted constant segment", () => {
		expect(emitCsqlExpressionSegments(term(literal(42)))).toEqual([
			{ kind: "constant", text: "42" },
		]);
	});

	it("emits a runtime-resolved input as a quoted CSQL scalar", () => {
		const xpath = `instance('search-input:results')/input/field[@name='phone_query']`;
		expect(emitCsqlExpressionSegments(term(input("phone_query")))).toEqual(
			quoteRuntimeCsqlValue(xpath, "double", ["phone_query"]),
		);
	});
});

// ============================================================
// SHELL 2 — non-whitelist arms throw defensively
// ============================================================
//
// The predicate-side emitter at `lib/commcare/predicate/csqlEmitter.ts`
// inlines every non-whitelist value-expression arm as an on-device
// XPath fragment before reaching this surface. If the bypass path
// ever surfaced one of these arms, the emitter throws a defensive
// error rather than emit broken CSQL — the local
// `_exhaustive: never` default catches new ValueExpression kinds
// at compile time. The error message points at the operand dispatch
// in `emitOperandSegments` because that is where the inline routing
// lives.

describe("emitCsqlExpressionSegments — non-whitelist arms throw", () => {
	it("throws on arith", () => {
		const expr = arith("+", term(prop("p", "age")), term(literal(1)));
		expect(() => emitCsqlExpressionSegments(expr)).toThrow(/whitelist/i);
	});

	it("throws on concat", () => {
		const expr = concat(term(literal("a")), term(literal("b")));
		expect(() => emitCsqlExpressionSegments(expr)).toThrow(/whitelist/i);
	});

	it("throws on coalesce", () => {
		const expr = coalesce(term(prop("p", "x")), term(literal("fallback")));
		expect(() => emitCsqlExpressionSegments(expr)).toThrow(/whitelist/i);
	});

	it("throws on if", () => {
		const expr = ifExpr(matchAll(), term(literal("a")), term(literal("b")));
		expect(() => emitCsqlExpressionSegments(expr)).toThrow(/whitelist/i);
	});

	it("throws on switch", () => {
		const expr = switchExpr(
			term(prop("p", "x")),
			[switchCase(literal("y"), term(literal(1)))],
			term(literal(0)),
		);
		expect(() => emitCsqlExpressionSegments(expr)).toThrow(/whitelist/i);
	});

	it("throws on count", () => {
		const expr = count(subcasePath("parent"));
		expect(() => emitCsqlExpressionSegments(expr)).toThrow(/whitelist/i);
	});

	it("throws on format-date", () => {
		const expr = formatDate(term(prop("p", "dob")), "iso");
		expect(() => emitCsqlExpressionSegments(expr)).toThrow(/whitelist/i);
	});
});
