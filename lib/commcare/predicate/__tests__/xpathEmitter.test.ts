// lib/commcare/predicate/__tests__/xpathEmitter.test.ts
//
// Acceptance tests for the predicate-AST → CommCare XPath/CSQL emitter.
// Each `it` builds an AST via the typed builders and asserts the
// emitter's exact wire string. The strings are pinned to CommCare's
// shipped wire vocabulary, citation-anchored to commcare-hq source so
// any future change in the emitter that drifts from CommCare's accepted
// forms surfaces as a test failure.
//
// Coverage spans five concentric layers: (1) per-operator output
// for every comparison + logical kind landing in this emitter,
// (2) operand emission for each term variant (prop / input / user /
// literal), (3) the precedence invariant that and-of-or wraps the
// inner or in parens, (4) per-context divergence in the
// string-literal escape path — case-list-filter uses `concat()`
// for embedded single quotes; csql lacks `concat()` in its
// value-function whitelist and switches between single- and
// double-quoted literals, throwing on both-quote-styles values.
// Quote-free literals emit identically across both contexts; the
// cross-context invariance test below pins that path against future
// per-context drift in the non-string layers. (5) per-operator
// output for the four special operators (`isIn` / `within` /
// `fuzzy` / `whenInput`), each pinning the wire signature plus the
// operator-specific edge cases — single-vs-multi `isIn` collapse,
// or-of-equalities preservation of whitespace / null / numeric
// values, literal-vs-input `within-distance.center`, the
// distance: 0 boundary, embedded-quote escape reuse for
// `fuzzy-match`, the `true()` boolean-context fallback in
// case-list-filter for `when-input-present`, and the csql throw
// when `when-input-present` would emit unsupported `if` / `count`
// inside CSQL.
//
// Operand-emission tests for non-quote-related cases use the
// user-defined property `name` rather than `status` to keep the
// focus on operator behavior; the reserved-attribute prefix logic
// is exercised by its own dedicated describe block parameterized
// over both contexts.
//
// CCHQ citations for the emitted forms are in xpathEmitter.ts.

import { describe, expect, it } from "vitest";
import {
	and,
	eq,
	fuzzy,
	gt,
	gte,
	input,
	isIn,
	literal,
	lt,
	lte,
	neq,
	not,
	or,
	prop,
	userField,
	whenInput,
	within,
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

describe("emitXPath — string-literal escape", () => {
	// String literals are the one place where the two contexts
	// diverge, because the available escape mechanisms differ:
	// case-list-filter has XPath 1.0's `concat()` available; csql's
	// value-function whitelist excludes it (see file header for the
	// CCHQ source citations). Each test below pins one cell of the
	// divergence matrix or the both-quotes-rejection path that has
	// no portable escape in csql.

	it("emits a quote-free string identically across both contexts", () => {
		// For values without any embedded quote, both contexts wrap
		// the value in single quotes — no divergence. Pinning a
		// non-trivial multi-clause predicate here also locks the
		// quote-free path of the string-escape branch against future
		// per-context drift in the surrounding operator layer.
		const p = and(
			eq(prop("patient", "name"), literal("Alice")),
			or(
				gt(prop("patient", "age"), literal(18)),
				eq(prop("patient", "owner_id"), userField("commcare_location_id")),
			),
		);
		expect(emitXPath(p, "csql")).toBe(emitXPath(p, "case-list-filter"));
	});

	it("emits embedded single quote with concat() in case-list-filter context", () => {
		// XPath 1.0 in the case-list nodeset has `concat()` available,
		// so an embedded single quote splits into alternating
		// single-quoted and double-quoted segments. The exact concat
		// shape is pinned here so a regression that rebuilt the
		// string in some other order surfaces as a fixture mismatch
		// rather than silent encoding drift.
		const p = eq(prop("patient", "name"), literal("O'Brien"));
		expect(emitXPath(p, "case-list-filter")).toBe(
			`name = concat('O', "'", 'Brien')`,
		);
	});

	it("emits embedded single quote with double-quoted string in csql context", () => {
		// CSQL's value-function whitelist excludes `concat()`, so the
		// emitter switches the wrapping quote style to double when
		// the value contains a single quote. CSQL admits both quote
		// styles for string literals — see
		// `docs/case_search_query_language.rst:417` for the canonical
		// post-`concat()` CSQL string with double-quoted property
		// values.
		const p = eq(prop("patient", "name"), literal("O'Brien"));
		expect(emitXPath(p, "csql")).toBe(`name = "O'Brien"`);
	});

	it("emits a quote-only string with concat() in case-list-filter context", () => {
		// A literal containing nothing but a single quote splits
		// into two empty string halves around the quote. Emitting
		// empty boundary segments keeps the segment count predictable
		// (`n + 1` segments for `n` quotes) so reasoning about the
		// concat output stays uniform regardless of where the quotes
		// sit in the source string.
		const p = eq(prop("patient", "name"), literal("'"));
		expect(emitXPath(p, "case-list-filter")).toBe(`name = concat('', "'", '')`);
	});

	it("emits multiple consecutive embedded quotes in case-list-filter context", () => {
		// Two quotes in a row produce three string segments separated
		// by two literal-quote separators. The middle segment is
		// empty; emitting it keeps the segment count consistent with
		// the single-quote case and avoids a special branch that
		// would only fire on adjacent quotes.
		const p = eq(prop("patient", "note"), literal("a''b"));
		expect(emitXPath(p, "case-list-filter")).toBe(
			`note = concat('a', "'", '', "'", 'b')`,
		);
	});

	it("emits a quote-only string with double-quoted wrap in csql context", () => {
		// Mirror of the case-list-filter quote-only test above. The
		// double-quoted wrap is a single concise wire form, in
		// contrast with the case-list-filter path's empty-bookended
		// `concat()`.
		const p = eq(prop("patient", "name"), literal("'"));
		expect(emitXPath(p, "csql")).toBe(`name = "'"`);
	});

	it("emits embedded double quote with single-quoted wrap in both contexts", () => {
		// A value containing only a double quote is wrapped in
		// single quotes in both contexts — no escape needed. Pinning
		// the both-contexts identity here is the asymmetry pin to
		// the embedded-single-quote case which DOES diverge.
		const p = eq(prop("patient", "name"), literal('say "hello"'));
		const expected = `name = 'say "hello"'`;
		expect(emitXPath(p, "case-list-filter")).toBe(expected);
		expect(emitXPath(p, "csql")).toBe(expected);
	});

	it("emits both-quote-styles via concat() in case-list-filter context", () => {
		// Even when a value contains both ' and ", case-list-filter
		// can still emit a portable wire form because `concat()` is
		// available: the value is split on single quote, each segment
		// is single-quoted (with any embedded double quote sitting
		// inside the single-quoted segment unchanged), and the
		// quote separator interleaves between segments.
		const p = eq(prop("patient", "name"), literal(`it's "quoted"`));
		expect(emitXPath(p, "case-list-filter")).toBe(
			`name = concat('it', "'", 's "quoted"')`,
		);
	});

	it("throws in csql when a string literal contains both ' and \"", () => {
		// CSQL has no portable inline escape that handles both quote
		// styles in the same literal: `concat()` is not in the
		// value-function whitelist, and XPath 1.0 string literals
		// can carry only one quote style. The emitter throws rather
		// than emit broken wire output; authors must restructure the
		// filter or strip one quote type upstream.
		const p = eq(prop("patient", "name"), literal(`it's "quoted"`));
		expect(() => emitXPath(p, "csql")).toThrow(/no portable escape/i);
	});
});

describe("emitXPath — special operators", () => {
	// `isIn` expands to a plain equality (single value) or an
	// or-of-equalities (multi-value), keeping value-equality set
	// membership semantics continuous across list size.
	// `within-distance` and `fuzzy-match` map to their CCHQ wire
	// signatures (verified against
	// `corehq/apps/case_search/xpath_functions/query_functions.py`).
	// `whenInput` wraps its clause in `if(count(<input>), <then>, true())`
	// in case-list-filter context and throws in csql context because
	// CSQL has no native conditional construct.

	it("emits isIn with a single value as a plain equality (reserved attribute)", () => {
		// Single-value membership reduces to plain equality, the
		// canonical "this property equals this value" form.
		// `status` is a reserved attribute, so the property reference
		// still flows through `emitTerm` and picks up the `@` prefix;
		// the test pins both the single-value collapse and the
		// reserved-attribute prefix path in one assertion.
		const p = isIn(prop("patient", "status"), literal("open"));
		expect(emitXPath(p, "case-list-filter")).toBe("@status = 'open'");
	});

	it("emits isIn with a single value as a plain equality (user-defined property)", () => {
		// Mirror of the reserved-attribute test above against a
		// user-defined property — the wire form differs in the prop
		// reference (no `@` prefix) and pins the bare-name path.
		const p = isIn(prop("patient", "category"), literal("open"));
		expect(emitXPath(p, "case-list-filter")).toBe("category = 'open'");
	});

	it("emits isIn with multiple values as a parenthesized or-of-equalities", () => {
		// Multi-value `isIn` expands to `(prop = v1 or prop = v2)` so
		// the semantics stay continuous with the single-value
		// equality collapse. The defensive paren wrap defends against
		// a parent `and` that would otherwise re-associate the
		// or-chain (XPath's `and` binds tighter than `or`).
		const p = isIn(prop("patient", "tags"), literal("open"), literal("active"));
		expect(emitXPath(p, "case-list-filter")).toBe(
			"(tags = 'open' or tags = 'active')",
		);
	});

	it("emits isIn multi-value with a quote-bearing value via the per-value escape pipeline (case-list-filter)", () => {
		// Each value flows independently through `emitLiteral`, so
		// only the value carrying an embedded single quote falls back
		// to `concat()`; the other clauses keep the simple
		// single-quoted wrap. This pins that quote escape is per-value
		// rather than across the whole list.
		const p = isIn(
			prop("patient", "tags"),
			literal("O'Brien"),
			literal("active"),
		);
		expect(emitXPath(p, "case-list-filter")).toBe(
			`(tags = concat('O', "'", 'Brien') or tags = 'active')`,
		);
	});

	it("emits isIn multi-value identically across both contexts when no quotes are present", () => {
		// Quote-free values produce the same wire form across both
		// contexts; only the per-value embedded-quote escape diverges.
		const p = isIn(prop("patient", "tags"), literal("open"), literal("active"));
		expect(emitXPath(p, "csql")).toBe(emitXPath(p, "case-list-filter"));
	});

	it("emits isIn multi-value with whitespace-bearing values without tokenizing them", () => {
		// or-of-equalities preserves each value as a single equality
		// RHS, so spaces inside a value are wire-side opaque. CCHQ's
		// `selected-any` would have tokenized "Alice Smith" into
		// "Alice" and "Smith" (per the `case_property_text_query`
		// docstring at `corehq/apps/es/case_search.py:294-296`), which
		// is why `isIn` does NOT compile to `selected-any`. This test
		// is the structural pin against any future regression that
		// reintroduces tokenization semantics for `isIn`.
		const p = isIn(
			prop("patient", "name"),
			literal("Alice Smith"),
			literal("Bob Jones"),
		);
		expect(emitXPath(p, "case-list-filter")).toBe(
			"(name = 'Alice Smith' or name = 'Bob Jones')",
		);
	});

	it("emits isIn multi-value with mixed null + string values", () => {
		// `null` flows through `emitLiteral` and emits as `''` —
		// XPath's idiomatic "is unset" form. A mixed list expresses
		// "is unset OR equals one of these values" as a single
		// predicate, which is the meaningful use case the schema's
		// `.refine` allows (the all-null degenerate is rejected at
		// parse time).
		const p = isIn(prop("patient", "name"), literal(null), literal("Alice"));
		expect(emitXPath(p, "case-list-filter")).toBe(
			"(name = '' or name = 'Alice')",
		);
	});

	it("emits isIn multi-value with numeric literals as bare XPath numbers", () => {
		// Numeric values flow through `emitLiteral` →
		// `emitNumericLiteral`, so they emit unquoted on the RHS of
		// each equality and dodge scientific-notation form per the
		// `emitNumericLiteral` JSDoc.
		const p = isIn(prop("patient", "age"), literal(18), literal(21));
		expect(emitXPath(p, "case-list-filter")).toBe("(age = 18 or age = 21)");
	});

	it("emits within-distance with a literal center and miles", () => {
		// CCHQ's `within-distance(prop, coords, distance, unit)` is
		// 4-arg with the property first, the coordinate string second,
		// the distance number third, and the unit identifier last
		// (verified at
		// `corehq/apps/case_search/xpath_functions/query_functions.py:54-81`).
		// The literal coordinate string flows through `emitTerm` →
		// `emitLiteral` → `emitStringLiteral`, so it picks up the
		// per-context escape behavior automatically.
		const p = within(
			prop("clinic", "location"),
			literal("40.7,-74.0"),
			50,
			"miles",
		);
		expect(emitXPath(p, "case-list-filter")).toBe(
			"within-distance(location, '40.7,-74.0', 50, 'miles')",
		);
	});

	it("emits within-distance with an input center and kilometers", () => {
		// The center can be any term, including a search-input ref
		// resolved at runtime to the user's typed coordinate. Pinning
		// both the input-term emission path and the `kilometers` unit
		// here covers the two configuration axes that vary in real use.
		const p = within(
			prop("clinic", "location"),
			input("user_loc"),
			25,
			"kilometers",
		);
		expect(emitXPath(p, "case-list-filter")).toBe(
			"within-distance(location, instance('search-input:results')/input/field[@name='user_loc'], 25, 'kilometers')",
		);
	});

	it("emits within-distance distances without scientific notation", () => {
		// Distances flow through `emitNumericLiteral`, so very small
		// or very large radii avoid the `1e-7` / `1.5e+21` exponent
		// form that CommCare's XPath grammar rejects. Pinning the
		// reformat path here protects against a regression that
		// dropped the numeric-helper call and interpolated the raw
		// `String(n)` value.
		const p = within(
			prop("clinic", "location"),
			literal("40.7,-74.0"),
			0.0000001,
			"miles",
		);
		expect(emitXPath(p, "case-list-filter")).toBe(
			"within-distance(location, '40.7,-74.0', 0.0000001, 'miles')",
		);
	});

	it("emits within-distance with distance 0 as a bare zero literal", () => {
		// Boundary pin on the `.nonnegative()` schema constraint:
		// distance 0 is admitted by the AST and emits as the bare
		// numeric literal `0`. A regression that swapped the sign
		// during numeric reformat (e.g. by treating zero as negative
		// or shifting the decimal off-by-one) would surface here.
		const p = within(
			prop("clinic", "location"),
			literal("40.7,-74.0"),
			0,
			"miles",
		);
		expect(emitXPath(p, "case-list-filter")).toBe(
			"within-distance(location, '40.7,-74.0', 0, 'miles')",
		);
	});

	it("emits fuzzy as fuzzy-match(prop, 'value')", () => {
		// CCHQ's `fuzzy-match(prop, value)` is 2-arg with the
		// property first and the match value second (verified at
		// `corehq/apps/case_search/xpath_functions/query_functions.py:92-98`).
		// The match value flows through `emitStringLiteral` for
		// per-context escape consistency with the comparison operators.
		const p = fuzzy(prop("patient", "name"), "alice");
		expect(emitXPath(p, "case-list-filter")).toBe("fuzzy-match(name, 'alice')");
	});

	it("emits fuzzy with an embedded single quote via the escape pipeline (csql)", () => {
		// CSQL's value-function whitelist excludes `concat()`, so
		// the emitter switches to a double-quoted wrap when the
		// match value contains a single quote — matching the
		// comparison-operator escape divergence pinned above.
		const p = fuzzy(prop("patient", "name"), "O'Brien");
		expect(emitXPath(p, "csql")).toBe(`fuzzy-match(name, "O'Brien")`);
	});

	it("emits when-input-present as if(count(input), then, true()) in case-list-filter context", () => {
		// case-list-filter drops the predicate directly into a
		// casedb XPath nodeset (`instance('casedb')/casedb/case[<this>]`),
		// where CommCare's XPath dialect supports `if` and `count`.
		// The fallback is `true()` (not `''`): XPath's boolean
		// coercion of `''` is `false`, which would silently exclude
		// every case when the trigger input is unset. `true()` is
		// the AND-chain identity element, so AND-combining the
		// wrapper with sibling clauses leaves them unchanged on
		// input-unset and applies the wrapped clause on input-set.
		const p = whenInput(
			input("name_query"),
			eq(prop("patient", "name"), input("name_query")),
		);
		expect(emitXPath(p, "case-list-filter")).toBe(
			"if(count(instance('search-input:results')/input/field[@name='name_query']), name = instance('search-input:results')/input/field[@name='name_query'], true())",
		);
	});

	it("throws in csql context for when-input-present (wire wrapper handles conditionality)", () => {
		// CSQL has no native conditional construct: `if` and
		// `count` are absent from both CSQL function whitelists at
		// `corehq/apps/case_search/xpath_functions/__init__.py:27-50`.
		// CCHQ's canonical pattern at
		// `docs/case_search_query_language.rst:299-303` keeps the
		// conditionality OUTSIDE the CSQL string — an outer XPath
		// `if(count(<input>), <CSQL-A>, <CSQL-B>)` chooses between
		// two pre-built CSQL strings, neither of which contains the
		// conditional itself. The emitter therefore cannot encode
		// `when-input-present` in csql context at this layer, and
		// throws to surface the requirement loudly. The wire-
		// wrapping layer that builds the outer XPath emits two
		// distinct CSQL strings (one with the input substituted,
		// one without) and selects between them at runtime.
		const p = whenInput(
			input("name_query"),
			eq(prop("patient", "name"), input("name_query")),
		);
		expect(() => emitXPath(p, "csql")).toThrow(/csql context/i);
	});

	it("emits when-input-present with a logical-conjunction inner clause", () => {
		// Pinning the recursive case here — the inner clause is an
		// `and(...)` whose own emission is exercised in the logical-
		// operator describe block. The `emitPredicate` recursion
		// passes `parentPrec: 0` into the inner because the function-
		// call argument position is its own grouping boundary, so no
		// outer parens wrap the conjunction.
		const p = whenInput(
			input("region"),
			and(
				eq(prop("patient", "region"), input("region")),
				gt(prop("patient", "age"), literal(18)),
			),
		);
		expect(emitXPath(p, "case-list-filter")).toBe(
			"if(count(instance('search-input:results')/input/field[@name='region']), region = instance('search-input:results')/input/field[@name='region'] and age > 18, true())",
		);
	});

	it.each(
		CONTEXTS,
	)("emits isIn / within-distance / fuzzy-match identically across contexts when no quotes are present (%s)", (ctx) => {
		// Multi-value `isIn` (or-of-equalities), `within-distance`,
		// and `fuzzy-match` are wire forms admitted by both
		// case-list-filter XPath and CSQL, so their bare-token
		// (quote-free) emission is identical across both contexts.
		// `when-input-present` is excluded from this invariance
		// because CSQL has no `if` / `count` and the emitter throws
		// in csql context — that divergence is pinned in its own
		// test above.
		expect(
			emitXPath(
				isIn(prop("patient", "tags"), literal("open"), literal("active")),
				ctx,
			),
		).toBe("(tags = 'open' or tags = 'active')");
		expect(
			emitXPath(
				within(prop("clinic", "location"), literal("40.7,-74.0"), 50, "miles"),
				ctx,
			),
		).toBe("within-distance(location, '40.7,-74.0', 50, 'miles')");
		expect(emitXPath(fuzzy(prop("patient", "name"), "alice"), ctx)).toBe(
			"fuzzy-match(name, 'alice')",
		);
	});
});
