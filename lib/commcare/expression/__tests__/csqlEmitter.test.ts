// lib/commcare/expression/__tests__/csqlEmitter.test.ts
//
// Acceptance tests for the CSQL value-expression emitter. The CSQL
// dialect has a closed value-function whitelist
// (`commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:27-36`):
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
	datetimeCoerce,
	double,
	formatDate,
	ifExpr,
	input,
	literal,
	matchAll,
	now,
	prop,
	subcasePath,
	switchCase,
	switchExpr,
	term,
	today,
	unwrapList,
} from "@/lib/domain/predicate/builders";
import { emitCsqlExpressionSegments } from "../csqlEmitter";

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
	// The expression emitter emits in function-call-argument position
	// — the wire form inside a CSQL value function (`date(<value>)`,
	// `double(<value>)`, etc.) accepts the runtime XPath result as a
	// raw value, NOT wrapped in CSQL double-quote brackets. Per-arm
	// emitters return raw segment lists; the wrap layer collapses
	// adjacent constants downstream.
	it("emits date(<value>) for date-coerce, splicing in a runtime ref segment", () => {
		const expr = dateCoerce(term(input("dob_text")));
		expect(emitCsqlExpressionSegments(expr)).toEqual([
			{ kind: "constant", text: "date(" },
			{
				kind: "runtime",
				xpath: `instance('search-input:results')/input/field[@name='dob_text']`,
			},
			{ kind: "constant", text: ")" },
		]);
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
	// three separate arguments. Source: `value_functions.py:115`.
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

	it("splices a runtime-ref date segment unwrapped (function-call argument position)", () => {
		// In function-call argument position, CCHQ's CSQL grammar accepts
		// the runtime XPath result as a value directly — the surrounding
		// `date-add(`/`)` parens scope the argument, no double-quote wrap
		// needed. The comparison-operand wrap rule applies only to the
		// outermost runtime ref in `<prop> = "<value>"` shape.
		const expr = dateAdd(term(input("base_date")), "days", term(literal(7)));
		expect(emitCsqlExpressionSegments(expr)).toEqual([
			{ kind: "constant", text: "date-add(" },
			{
				kind: "runtime",
				xpath: `instance('search-input:results')/input/field[@name='base_date']`,
			},
			{ kind: "constant", text: ", 'days', " },
			{ kind: "constant", text: "7" },
			{ kind: "constant", text: ")" },
		]);
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
});

describe("emitCsqlExpressionSegments — term arm structural lifter", () => {
	it("emits a property reference as a constant segment", () => {
		expect(emitCsqlExpressionSegments(term(prop("p", "name")))).toEqual([
			{ kind: "constant", text: "name" },
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

	it("emits a runtime-resolved input ref unwrapped (function-call argument position)", () => {
		// In function-call argument position, the runtime XPath result
		// is the value — no surrounding double-quote wrap. The
		// comparison-operand wrap rule applies only at the predicate-
		// emitter level when a term-arm operand sits in `<prop> =
		// "<value>"` position.
		expect(emitCsqlExpressionSegments(term(input("phone_query")))).toEqual([
			{
				kind: "runtime",
				xpath: `instance('search-input:results')/input/field[@name='phone_query']`,
			},
		]);
	});
});

// ============================================================
// SHELL 2 — non-whitelist arms throw defensively
// ============================================================
//
// The hoist pass in `lib/commcare/predicate/csqlHoist.ts` lifts every
// non-whitelist value-expression arm into an on-device wrapper before
// the emitter runs. If the bypass path ever surfaced one of these
// arms, the emitter throws with a "should have been hoisted" message
// rather than emit broken CSQL — the local `_exhaustive: never`
// default catches new ValueExpression kinds at compile time.

describe("emitCsqlExpressionSegments — non-whitelist arms throw", () => {
	it("throws on arith", () => {
		const expr = arith("+", term(prop("p", "age")), term(literal(1)));
		expect(() => emitCsqlExpressionSegments(expr)).toThrow(/hoisted/i);
	});

	it("throws on concat", () => {
		const expr = concat(term(literal("a")), term(literal("b")));
		expect(() => emitCsqlExpressionSegments(expr)).toThrow(/hoisted/i);
	});

	it("throws on coalesce", () => {
		const expr = coalesce(term(prop("p", "x")), term(literal("fallback")));
		expect(() => emitCsqlExpressionSegments(expr)).toThrow(/hoisted/i);
	});

	it("throws on if", () => {
		const expr = ifExpr(matchAll(), term(literal("a")), term(literal("b")));
		expect(() => emitCsqlExpressionSegments(expr)).toThrow(/hoisted/i);
	});

	it("throws on switch", () => {
		const expr = switchExpr(
			term(prop("p", "x")),
			[switchCase(literal("y"), term(literal(1)))],
			term(literal(0)),
		);
		expect(() => emitCsqlExpressionSegments(expr)).toThrow(/hoisted/i);
	});

	it("throws on count", () => {
		const expr = count(subcasePath("parent"));
		expect(() => emitCsqlExpressionSegments(expr)).toThrow(/hoisted/i);
	});

	it("throws on format-date", () => {
		const expr = formatDate(term(prop("p", "dob")), "iso");
		expect(() => emitCsqlExpressionSegments(expr)).toThrow(/hoisted/i);
	});
});
