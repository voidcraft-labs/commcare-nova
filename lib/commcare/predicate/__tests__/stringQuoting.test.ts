// lib/commcare/predicate/__tests__/stringQuoting.test.ts
//
// Acceptance tests for the lexical-emission helpers shared across the
// per-dialect predicate emitters. Each helper owns one concern:
//
//   - `quoteLiteral` — per-dialect string-literal escape. Three
//     dialects feed in: `case-list-filter` (on-device XPath 1.0 in the
//     casedb nodeset position; `concat()` available), `csql` (the
//     ElasticSearch-evaluated `_xpath_query` value where CCHQ's
//     value-function whitelist excludes `concat()`), and
//     `search-filter` (post-ES on-device dialect that runs after
//     server narrowing on the case-search results page; same XPath 1.0
//     environment as case-list-filter). The case-list-filter and
//     search-filter dialects share a single escape strategy
//     (`concat('part', "'", 'part')` for embedded single quotes); the
//     csql dialect switches between single- and double-quoted literals
//     and rejects values carrying both quote styles.
//   - `quoteIdentifier` — pass-through. Identifier validation happens
//     upstream at the schema layer; the helper exists as a boundary
//     marker so a future change to the identifier-emit rule lands in
//     one place.
//   - `formatNumeric` — non-scientific decimal-literal output. The
//     CommCare XPath grammar admits `digit+ ('.' digit*)? | '.' digit+`
//     only and rejects exponent syntax, so the helper expands
//     JavaScript's `String(n)` exponent form into a fully expanded
//     decimal by sliding the IEEE-754 mantissa's decimal point.
//
// CCHQ source citations for the wire-form rules are anchored in the
// helpers' JSDoc; tests pin exact wire output strings so any drift
// from CCHQ's accepted forms surfaces as a fixture mismatch.

import { describe, expect, it } from "vitest";
import {
	formatNumeric,
	quoteIdentifier,
	quoteLiteral,
	type WireDialect,
} from "../stringQuoting";

// `case-list-filter` and `search-filter` produce identical output for
// every input — both run in the on-device XPath 1.0 environment with
// `concat()` available. Listing them once here parameterizes the
// shared-behavior tests so adding a third concat-fallback dialect (if
// one ever lands) surfaces as a single edit site.
const CONCAT_FALLBACK_DIALECTS: readonly WireDialect[] = [
	"case-list-filter",
	"search-filter",
];

describe("quoteLiteral — quote-free values", () => {
	it.each([
		"case-list-filter",
		"csql",
		"search-filter",
	] as const)("wraps a quote-free value in single quotes (%s)", (dialect) => {
		expect(quoteLiteral("Alice", dialect)).toBe("'Alice'");
	});

	it.each([
		"case-list-filter",
		"csql",
		"search-filter",
	] as const)("wraps an empty string in single quotes (%s)", (dialect) => {
		// Empty literal is admitted across every dialect because the
		// underlying XPath 1.0 string-literal grammar permits it. The
		// AST surface emits an empty-string literal for the `null`
		// arm and for is-blank's RHS, so this test pins a wire-side
		// shape both surfaces depend on.
		expect(quoteLiteral("", dialect)).toBe("''");
	});

	it.each([
		"case-list-filter",
		"csql",
		"search-filter",
	] as const)("passes whitespace, tabs, newlines, and unicode through unchanged (%s)", (dialect) => {
		// XPath 1.0 string literals admit any character that isn't
		// the wrapping quote — no escape sequences in the grammar.
		// The helper threads the value through verbatim; only the
		// quote characters themselves drive the escape branches.
		expect(quoteLiteral("a b\tc\nd", dialect)).toBe("'a b\tc\nd'");
		expect(quoteLiteral("naïve café 日本語", dialect)).toBe(
			"'naïve café 日本語'",
		);
	});

	it.each([
		"case-list-filter",
		"csql",
		"search-filter",
	] as const)("single-quote-wraps a value containing only a double quote (%s)", (dialect) => {
		// A value with embedded double quotes but no single quotes
		// fits inside single-quoted wire syntax in every dialect; no
		// escape pass runs. Pinning this asymmetry against the
		// embedded-single-quote path locks the fact that csql's
		// quote-style swap fires only on single quotes.
		expect(quoteLiteral('say "hello"', dialect)).toBe(`'say "hello"'`);
	});
});

describe("quoteLiteral — case-list-filter / search-filter concat fallback", () => {
	// XPath 1.0 has no string-escape syntax. Both the on-device
	// case-list nodeset position and the post-ES on-device search-filter
	// position run against the same XPath 1.0 environment, where
	// `concat()` is available — so the portable form for embedded
	// single quotes splits the value on `'`, single-quotes each segment,
	// and interleaves the literal-quote separator `"'"` between
	// segments. Both dialects share the same wire output for every
	// input.

	it.each(
		CONCAT_FALLBACK_DIALECTS,
	)("splits a single embedded quote into a 3-segment concat (%s)", (dialect) => {
		expect(quoteLiteral("O'Brien", dialect)).toBe(`concat('O', "'", 'Brien')`);
	});

	it.each(
		CONCAT_FALLBACK_DIALECTS,
	)("emits empty boundary segments for a quote-only value (%s)", (dialect) => {
		// A value of `'` produces two empty halves around a single
		// quote separator. Emitting the empty boundary segments
		// keeps the segment count at `n + 1` for `n` quotes,
		// matching the multi-quote case below — the alternative
		// (collapsing empty segments) would force a special branch
		// that fires only on quote-bookended values.
		expect(quoteLiteral("'", dialect)).toBe(`concat('', "'", '')`);
	});

	it.each(
		CONCAT_FALLBACK_DIALECTS,
	)("emits one segment per split for multiple consecutive embedded quotes (%s)", (dialect) => {
		// Two quotes in a row produce three string segments
		// separated by two literal-quote separators; the middle
		// segment is empty. Pinning the segment count locks the
		// `n + 1` segment / `n` separator invariant that the
		// concat-fallback path relies on.
		expect(quoteLiteral("a''b", dialect)).toBe(
			`concat('a', "'", '', "'", 'b')`,
		);
	});

	it.each(
		CONCAT_FALLBACK_DIALECTS,
	)("interleaves literal-quote separators for non-adjacent embedded quotes (%s)", (dialect) => {
		// Three non-adjacent quotes produce four segments and three
		// separators. This pins the same invariant against a
		// regression that miscounted the separator interleaving for
		// quotes scattered across the value rather than adjacent.
		expect(quoteLiteral("a'b'c'd", dialect)).toBe(
			`concat('a', "'", 'b', "'", 'c', "'", 'd')`,
		);
	});

	it.each(
		CONCAT_FALLBACK_DIALECTS,
	)("keeps embedded double quotes inside single-quoted segments unchanged (%s)", (dialect) => {
		// A value carrying both quote styles still emits a portable
		// `concat()` form because `concat()` is available: the
		// double quote sits inside its single-quoted segment with
		// no further escape, and the split-on-single-quote produces
		// the segment count.
		expect(quoteLiteral(`it's "quoted"`, dialect)).toBe(
			`concat('it', "'", 's "quoted"')`,
		);
	});
});

describe("quoteLiteral — case-list-filter and search-filter share output", () => {
	// Cross-dialect invariance: every input that emits via the
	// concat-fallback path produces the same wire string in both
	// dialects. The test below feeds a representative cross-section
	// (quote-free, single embedded quote, quote-only, both quote
	// styles) so a regression that diverges the two dialects' escape
	// strategy surfaces here.
	it.each([
		{ value: "Alice", expected: "'Alice'" },
		{ value: "O'Brien", expected: `concat('O', "'", 'Brien')` },
		{ value: "'", expected: `concat('', "'", '')` },
		{
			value: `it's "quoted"`,
			expected: `concat('it', "'", 's "quoted"')`,
		},
	])("emits identically across both dialects for $value", ({
		value,
		expected,
	}) => {
		expect(quoteLiteral(value, "case-list-filter")).toBe(expected);
		expect(quoteLiteral(value, "search-filter")).toBe(expected);
	});
});

describe("quoteLiteral — csql per-quote-style swap", () => {
	// CSQL's value-function whitelist excludes `concat()`, so the
	// emitter cannot fall back to an alternating-quote concat. CSQL
	// admits both single- and double-quoted string literals natively,
	// so the helper switches the wrapping quote style based on which
	// quote character the value carries.

	it("double-quote-wraps a value containing only single quotes", () => {
		expect(quoteLiteral("O'Brien", "csql")).toBe(`"O'Brien"`);
	});

	it("double-quote-wraps a quote-only value", () => {
		// Mirror of the case-list-filter quote-only test in the concat
		// describe block above. CSQL's wire form for the same input is
		// the single concise `"'"` rather than the empty-bookended
		// concat — pinning both forms locks the divergence.
		expect(quoteLiteral("'", "csql")).toBe(`"'"`);
	});

	it("single-quote-wraps a value containing only double quotes", () => {
		// Asymmetric counterpart to the embedded-single-quote case:
		// double quotes alone leave the wrapping quote style at single,
		// matching the case-list-filter and search-filter behavior for
		// the same input.
		expect(quoteLiteral('say "hello"', "csql")).toBe(`'say "hello"'`);
	});

	it("throws on a value containing both single and double quotes", () => {
		// CSQL has no portable inline escape that handles both quote
		// styles in the same literal. `concat()` is not in CSQL's
		// value-function whitelist (per
		// `corehq/apps/case_search/xpath_functions/__init__.py:27-36`,
		// where `XPATH_VALUE_FUNCTIONS` lists 8 functions and `concat`
		// is not among them) and XPath 1.0 string literals can carry
		// only one of the two quote styles at a time. The helper throws
		// rather than emit broken wire output; authors must split the
		// value into a different filter shape or strip one quote type
		// upstream. The throw message contains "no portable escape"
		// (case-insensitive) — backward-compatible with the shipped
		// `xpathEmitter` throw at the same surface.
		expect(() => quoteLiteral(`it's "quoted"`, "csql")).toThrow(
			/no portable escape/i,
		);
	});

	it("passes whitespace, tabs, newlines, and unicode through unchanged when only one quote style is present", () => {
		// XPath 1.0 string literals admit any non-wrapping-quote
		// character; the helper threads the value through verbatim
		// across the embedded-single-quote branch as well. Pinning
		// non-ASCII content here locks the value-passthrough property
		// against a regression that introduced an unnecessary escape
		// pass in the csql branch.
		expect(quoteLiteral("a\tb\nc 日本", "csql")).toBe("'a\tb\nc 日本'");
		expect(quoteLiteral("naïve\nO'Brien", "csql")).toBe(`"naïve\nO'Brien"`);
	});
});

describe("quoteIdentifier", () => {
	// `quoteIdentifier` is a pass-through. Property-name validation
	// happens upstream at the schema layer (XML element-name vocabulary
	// for property names; `RESERVED_CASE_ATTRIBUTES` membership for the
	// four `@`-prefixed system attributes is handled by the term
	// emitter, not here). The helper exists as a boundary marker so a
	// future change to the identifier-emit rule lands in one place;
	// every emitter funnels identifier emission through it.

	it("returns the identifier verbatim", () => {
		expect(quoteIdentifier("name")).toBe("name");
		expect(quoteIdentifier("date_opened")).toBe("date_opened");
		expect(quoteIdentifier("case_id")).toBe("case_id");
	});

	it("preserves underscores and digits", () => {
		// XML element-name vocabulary admits `[A-Za-z_][A-Za-z0-9_-]*`
		// (the schema layer is the source of truth for the regex). The
		// helper passes through every admissible identifier shape
		// unchanged.
		expect(quoteIdentifier("field_1")).toBe("field_1");
		expect(quoteIdentifier("_internal")).toBe("_internal");
	});
});

describe("formatNumeric", () => {
	// CommCare's XPath grammar at
	// `lib/commcare/xpath/grammar.lezer.grammar:133-136` admits
	// `digit+ ('.' digit*)? | '.' digit+` only and rejects exponent
	// syntax. JavaScript's `String(n)` switches to exponent form for
	// very small magnitudes (below ~1e-6) and very large ones (at or
	// above 1e21); the helper expands those into a fully-expanded
	// decimal so the wire form parses on the CommCare side.

	it("emits integers as their canonical decimal form", () => {
		expect(formatNumeric(0)).toBe("0");
		expect(formatNumeric(1)).toBe("1");
		expect(formatNumeric(42)).toBe("42");
		expect(formatNumeric(-1)).toBe("-1");
		expect(formatNumeric(-42)).toBe("-42");
	});

	it("preserves a common fractional decimal verbatim", () => {
		// `String(3.14)` is already non-exponent and the shortest
		// round-trip form for the IEEE-754 double — pinning the exact
		// form guards against a regression that swapped in `toFixed(20)`
		// or any other lossy serialization producing visual artifacts
		// like `3.14000000000000012434`.
		expect(formatNumeric(3.14)).toBe("3.14");
		expect(formatNumeric(-3.14)).toBe("-3.14");
	});

	it("emits zero with no leading sign", () => {
		// IEEE-754 has both `+0` and `-0`. `String(0)` and `String(-0)`
		// both return `"0"` (per ECMAScript's `ToString` for Number),
		// so the helper inherits that behavior — pinning it here locks
		// the wire form against a regression that introduced a manual
		// sign-prepending pass.
		expect(formatNumeric(0)).toBe("0");
		expect(formatNumeric(-0)).toBe("0");
	});

	it("expands very small magnitudes that String(n) emits in exponent form", () => {
		// JavaScript's `String(n)` switches to exponent form below
		// roughly 1e-6. CommCare's XPath grammar admits decimals only,
		// so the helper slides the IEEE-754 mantissa's decimal point
		// to produce a fully-expanded decimal. The pinned outputs are
		// the exact decimal expansion of `String(<n>)`'s exponent form.
		expect(formatNumeric(1e-7)).toBe("0.0000001");
		expect(formatNumeric(5e-10)).toBe("0.0000000005");
		expect(formatNumeric(-1e-10)).toBe("-0.0000000001");
	});

	it("expands very large magnitudes that String(n) emits in exponent form", () => {
		// `String(n)` switches to exponent form at and above 1e21. The
		// reformatter slides the mantissa's decimal point past the
		// trailing zeros, producing a fully-expanded decimal whose
		// trailing zeros come from the IEEE-754 representation.
		expect(formatNumeric(1e21)).toBe("1000000000000000000000");
		expect(formatNumeric(1.5e21)).toBe("1500000000000000000000");
		expect(formatNumeric(-1e25)).toBe("-10000000000000000000000000");
	});

	it("preserves the leading minus sign through the exponent-form expansion path", () => {
		// The reformatter parses the optional leading `-` out of the
		// exponent-form string and prepends it to the rebuilt decimal.
		// Pinning the negative case here protects against a regression
		// that dropped the sign during reformatting (silent wrong-sign
		// numerics would surface only at runtime as wrong-result
		// comparisons).
		expect(formatNumeric(-1.5e-7)).toBe("-0.00000015");
		expect(formatNumeric(-2.5e25)).toBe("-25000000000000000000000000");
	});

	it("handles boundary values just outside and just inside the exponent-form cusp", () => {
		// `String(1e-6)` is `'0.000001'` (non-exponent) — pin the
		// boundary just inside the in-range path so a regression that
		// reformatted via the exponent path would surface as a wrong
		// output (e.g. extra trailing zeros from a wider expansion).
		expect(formatNumeric(1e-6)).toBe("0.000001");
		// `String(1e20)` is `'100000000000000000000'` (non-exponent) —
		// the matching upper-bound boundary just inside the in-range
		// path.
		expect(formatNumeric(1e20)).toBe("100000000000000000000");
	});

	it("expands exponent-form values whose mantissa carries a fractional part", () => {
		// `String(1.234e-7)` is `'1.234e-7'`; the reformatter splits
		// the mantissa across the decimal point and slides the digit
		// sequence so the integer + fractional digits combine into the
		// significand before the decimal-point shift.
		expect(formatNumeric(1.234e-7)).toBe("0.0000001234");
	});
});
