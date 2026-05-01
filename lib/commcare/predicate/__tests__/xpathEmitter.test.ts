// lib/commcare/predicate/__tests__/xpathEmitter.test.ts
//
// Acceptance tests for the predicate-AST → CommCare XPath/CSQL emitter.
// Each `it` builds an AST via the typed builders and asserts the
// emitter's exact wire string. The strings are pinned to CommCare's
// shipped wire vocabulary, citation-anchored to commcare-hq source so
// any future change in the emitter that drifts from CommCare's accepted
// forms surfaces as a test failure.
//
// Coverage spans four concentric layers: (1) per-operator output for
// every comparison + logical kind landing in this emitter, (2) operand
// emission for each term variant (prop / input / user / literal,
// including the embedded-quote concat fallback and the
// reserved-attribute `@` prefix), (3) the precedence invariant that
// and-of-or wraps the inner or in parens, (4) cross-context
// invariance — comparison and logical operator emission produces
// identical strings under both `case-list-filter` and `csql` even
// after the reserved-attribute prefix logic, since the reserved set
// converges across both contexts in CCHQ.
//
// Operand-emission tests use the user-defined property `name` rather
// than `status` to keep the focus on operator behavior; the
// reserved-attribute prefix logic is exercised by its own dedicated
// describe block parameterized over both contexts.
//
// CCHQ citations for the emitted forms are in xpathEmitter.ts.

import { describe, expect, it } from "vitest";
import {
	and,
	eq,
	gt,
	gte,
	input,
	literal,
	lt,
	lte,
	neq,
	not,
	or,
	prop,
	userField,
} from "@/lib/domain/predicate/builders";
import { type EmissionContext, emitXPath } from "../xpathEmitter";

// Both contexts run through the same operator + quoting logic, so
// every cross-context invariant test parameterizes over this tuple.
// Listed once here so adding a third context (if one ever lands)
// surfaces as a single edit site.
const CONTEXTS: readonly EmissionContext[] = ["case-list-filter", "csql"];

describe("emitXPath — comparison operators", () => {
	it("emits eq with a string literal", () => {
		const p = eq(prop("patient", "name"), literal("Alice"));
		expect(emitXPath(p, "case-list-filter")).toBe("name = 'Alice'");
	});

	it("emits eq with a numeric literal", () => {
		const p = eq(prop("patient", "age"), literal(42));
		expect(emitXPath(p, "case-list-filter")).toBe("age = 42");
	});

	it("emits eq with a decimal literal preserving the fractional part", () => {
		// Numeric literals whose `String(n)` form is already
		// non-exponent emit verbatim, so `3.14` round-trips as
		// `3.14`. Pinning the exact form here guards against a
		// regression that swapped in `toFixed(20)` or any other
		// lossy serialization that would surface as visual artifacts
		// like `3.14000000000000012434`.
		const p = eq(prop("patient", "weight_kg"), literal(3.14));
		expect(emitXPath(p, "case-list-filter")).toBe("weight_kg = 3.14");
	});

	it("emits very small decimal literals without scientific notation", () => {
		// JavaScript's `String(n)` switches to exponent form below
		// roughly 1e-6, but CommCare's XPath grammar admits decimal
		// literals only — `digit+ ('.' digit*)? | '.' digit+` per
		// `lib/commcare/xpath/grammar.lezer.grammar:133-136` — so
		// emitting `1e-7` would parse-fail downstream. The emitter
		// reformats by sliding the IEEE-754 mantissa's decimal point
		// rather than rounding through `toFixed`, so the wire form
		// is the exact decimal expansion of `String(0.0000001)`.
		const p = eq(prop("patient", "ratio"), literal(0.0000001));
		expect(emitXPath(p, "case-list-filter")).toBe("ratio = 0.0000001");
	});

	it("emits very large numeric literals without scientific notation", () => {
		// Counterpart to the very-small case: `String(n)` switches
		// to exponent form at and above 1e21, so an integer-valued
		// `1.5e21` would emit as `1.5e+21` and parse-fail. The
		// reformatter slides the mantissa's decimal point past the
		// trailing zeros to produce a fully expanded decimal.
		const p = eq(prop("patient", "big"), literal(1.5e21));
		expect(emitXPath(p, "case-list-filter")).toBe(
			"big = 1500000000000000000000",
		);
	});

	it("emits negative numeric literals with the leading minus sign", () => {
		// The numeric reformatter preserves the sign through the
		// mantissa-shifting path. Pin the negative case so a
		// regression that dropped the sign during reformatting (for
		// either the in-range or exponent path) surfaces here rather
		// than as a wrong-sign comparison at runtime.
		expect(
			emitXPath(
				eq(prop("patient", "delta"), literal(-3.14)),
				"case-list-filter",
			),
		).toBe("delta = -3.14");
		expect(
			emitXPath(
				eq(prop("patient", "tiny"), literal(-1e-10)),
				"case-list-filter",
			),
		).toBe("tiny = -0.0000000001");
	});

	it("emits neq", () => {
		const p = neq(prop("patient", "name"), literal("Bob"));
		expect(emitXPath(p, "case-list-filter")).toBe("name != 'Bob'");
	});

	it("emits gt / gte / lt / lte", () => {
		expect(
			emitXPath(gt(prop("patient", "age"), literal(18)), "case-list-filter"),
		).toBe("age > 18");
		expect(
			emitXPath(gte(prop("patient", "age"), literal(18)), "case-list-filter"),
		).toBe("age >= 18");
		expect(
			emitXPath(lt(prop("patient", "age"), literal(18)), "case-list-filter"),
		).toBe("age < 18");
		expect(
			emitXPath(lte(prop("patient", "age"), literal(18)), "case-list-filter"),
		).toBe("age <= 18");
	});

	it("emits boolean literals as quoted 'true' / 'false' strings", () => {
		// Boolean wire form mirrors `String(boolean)` — the most common
		// upstream serialization. Authors with a form that wrote `1`/`0`
		// or `yes`/`no` coerce upstream by passing a string literal
		// explicitly, so this test pins what the boolean path produces
		// rather than asserting any single CCHQ-canonical encoding.
		expect(
			emitXPath(
				eq(prop("patient", "is_active"), literal(true)),
				"case-list-filter",
			),
		).toBe("is_active = 'true'");
		expect(
			emitXPath(
				eq(prop("patient", "is_active"), literal(false)),
				"case-list-filter",
			),
		).toBe("is_active = 'false'");
	});

	it("emits null literals as the empty string", () => {
		// XPath compares an absent attribute equal to `''`, so
		// `<prop> = ''` is the natural "is unset" wire form. The type
		// checker treats `literal(null)` as universally compatible —
		// the structural sentinel for is-unset filters across every
		// case-property data type — and this test is the wire-side
		// pin on what that AST shape becomes.
		const p = eq(prop("patient", "name"), literal(null));
		expect(emitXPath(p, "case-list-filter")).toBe("name = ''");
	});

	it("escapes single quotes in string literals via concat()", () => {
		// XPath 1.0 has no string-escape syntax: a literal embedding a
		// single quote inside a single-quoted string cannot be expressed
		// directly. The portable form switches to concat() with
		// alternating single- and double-quoted segments. Pinning the
		// exact concat shape here also locks the segment ordering so a
		// regression that rebuilt the string in some other order would
		// surface as a fixture mismatch rather than a silent encoding
		// drift.
		const p = eq(prop("patient", "name"), literal("O'Brien"));
		expect(emitXPath(p, "case-list-filter")).toBe(
			`name = concat('O', "'", 'Brien')`,
		);
	});

	it("emits concat with empty boundary segments for a quote-only literal", () => {
		// A literal containing nothing but a single quote splits into
		// two empty string halves around the quote. Emitting empty
		// boundary segments keeps the segment count predictable
		// (`n + 1` segments for `n` quotes) so reasoning about the
		// concat output stays uniform regardless of where the quotes
		// sit in the source string.
		const p = eq(prop("patient", "name"), literal("'"));
		expect(emitXPath(p, "case-list-filter")).toBe(`name = concat('', "'", '')`);
	});

	it("emits concat with multiple consecutive embedded quotes", () => {
		// Two quotes in a row produce three string segments separated
		// by two literal-quote separators. The middle segment is
		// empty; emitting it keeps the segment count consistent with
		// the single-quote case and avoids a special branch that would
		// only fire on adjacent quotes.
		const p = eq(prop("patient", "note"), literal("a''b"));
		expect(emitXPath(p, "case-list-filter")).toBe(
			`note = concat('a', "'", '', "'", 'b')`,
		);
	});

	it("emits user-context refs against session/user/data", () => {
		const p = eq(prop("patient", "region"), userField("commcare_location_id"));
		expect(emitXPath(p, "case-list-filter")).toBe(
			"region = instance('commcaresession')/session/user/data/commcare_location_id",
		);
	});

	it("emits search-input refs against the search-input results instance", () => {
		const p = eq(prop("patient", "name"), input("name_query"));
		expect(emitXPath(p, "case-list-filter")).toBe(
			"name = instance('search-input:results')/input/field[@name='name_query']",
		);
	});
});

describe("emitXPath — reserved case attributes", () => {
	// CommCare stores `case_id`, `case_type`, `owner_id`, and `status`
	// as XML attributes on `<case>` in the casedb restore output and
	// registers the same four with the `@` prefix in the case-search
	// system-metadata index. The emitter therefore prefixes uniformly
	// across both `case-list-filter` and `csql` contexts; a bare
	// `case_type` in CSQL would silently degrade to a user-property
	// lookup with no match (see CCHQ source citations in
	// xpathEmitter.ts on RESERVED_CASE_ATTRIBUTES).
	//
	// Each reserved attribute gets the same parameterized assertion
	// across both contexts; the single `it.each` here covers all
	// 4 × 2 cells without restating eight near-identical bodies.

	it.each(
		(["case_id", "case_type", "owner_id", "status"] as const).flatMap((attr) =>
			CONTEXTS.map((ctx) => ({ attr, ctx }) as const),
		),
	)("prefixes '$attr' with @ in $ctx context", ({ attr, ctx }) => {
		const p = eq(prop("patient", attr), literal("X"));
		expect(emitXPath(p, ctx)).toBe(`@${attr} = 'X'`);
	});

	it.each(
		CONTEXTS,
	)("leaves user-defined properties bare in %s context", (ctx) => {
		// `name`, `external_id`, `last_modified`, `date_opened`,
		// `closed_on`, and `case_name` are CSQL system metadata
		// registered without the `@` prefix; user-defined properties
		// follow the same bare convention. Pinning a representative
		// user property here locks the negative case — only the four
		// `<case>` XML attributes get prefixed.
		const p = eq(prop("patient", "name"), literal("Alice"));
		expect(emitXPath(p, ctx)).toBe("name = 'Alice'");
	});
});

describe("emitXPath — logical operators", () => {
	it("emits and(...) joining clauses with ' and '", () => {
		const p = and(
			eq(prop("patient", "name"), literal("Alice")),
			gt(prop("patient", "age"), literal(18)),
		);
		expect(emitXPath(p, "case-list-filter")).toBe(
			"name = 'Alice' and age > 18",
		);
	});

	it("emits or(...) joining clauses with ' or '", () => {
		const p = or(
			eq(prop("patient", "name"), literal("Alice")),
			eq(prop("patient", "name"), literal("Bob")),
		);
		expect(emitXPath(p, "case-list-filter")).toBe(
			"name = 'Alice' or name = 'Bob'",
		);
	});

	it("parenthesizes or-clauses inside an and (precedence)", () => {
		// XPath's `and` binds tighter than `or`. An or-of-clauses nested
		// inside an and must be wrapped in parens to preserve the
		// authored grouping; emitting `(A or B) and C` as `A or B and C`
		// would silently re-associate to `A or (B and C)`. The emitter's
		// parent-precedence threading is what makes this output correct,
		// so the test is the structural lock on that precedence rule.
		const p = and(
			or(
				eq(prop("patient", "name"), literal("Alice")),
				eq(prop("patient", "name"), literal("Bob")),
			),
			gt(prop("patient", "age"), literal(18)),
		);
		expect(emitXPath(p, "case-list-filter")).toBe(
			"(name = 'Alice' or name = 'Bob') and age > 18",
		);
	});

	it("emits not(...) wrapping its inner with not(...)", () => {
		// `not` is a function call in XPath, not a unary prefix
		// operator, so the wire form is `not(<expr>)` regardless of the
		// inner's precedence — the parens around the inner are the
		// function-call argument list, not an associativity guard.
		const p = not(eq(prop("patient", "name"), literal("Bob")));
		expect(emitXPath(p, "case-list-filter")).toBe("not(name = 'Bob')");
	});
});

describe("emitXPath — context invariance", () => {
	// Comparison and logical operator emission produces identical
	// strings under both contexts even after the reserved-attribute
	// prefix logic, because the reserved set converges across both
	// contexts in CCHQ (see RESERVED_CASE_ATTRIBUTES citations in
	// xpathEmitter.ts). This test exercises a representative
	// predicate that hits every term variant and every operator kind
	// at this layer, including `status` (a reserved attribute) and
	// `name` (a user-defined property), so a regression that
	// introduced any per-context divergence at the operator or term
	// layer surfaces here as a string mismatch.
	it("emits identical output for case-list-filter and csql at the operator layer", () => {
		const p = and(
			or(
				eq(prop("patient", "status"), literal("open")),
				eq(prop("patient", "status"), literal("active")),
			),
			not(
				and(
					gte(prop("patient", "age"), literal(18)),
					lt(prop("patient", "age"), literal(65)),
					neq(prop("patient", "name"), literal("O'Brien")),
					eq(prop("patient", "owner_id"), userField("commcare_location_id")),
					eq(prop("patient", "name"), input("name_query")),
				),
			),
		);
		expect(emitXPath(p, "csql")).toBe(emitXPath(p, "case-list-filter"));
	});
});
