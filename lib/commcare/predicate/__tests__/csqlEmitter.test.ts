// lib/commcare/predicate/__tests__/csqlEmitter.test.ts
//
// Acceptance tests for the CSQL emitter — the on-device XPath wrapper
// that builds a CSQL `_xpath_query` string at runtime. The wire form
// is documented at
// `commcare-hq/docs/case_search_query_language.rst`; per-operator
// citations track to
// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py`.
//
// Coverage spans four layers:
//
//   1. Operator emission: every shared-operator shape (comparison,
//      logical, `in`, `is-blank`, `match-all` / `match-none`,
//      term-arm unwrap exhaustiveness) emits the documented CSQL
//      wire shape after concat-wrapping.
//   2. CSQL-specific operators: `multi-select-contains` (selected /
//      selected-any / selected-all), `match` (all four modes),
//      `within-distance`, `exists` ancestor (single + multi-hop),
//      `exists` subcase, `missing` wrapping `not(exists(...))`,
//      `between` expansion, `is-null` faithful emission as
//      `<term> = ''`, `when-input-present` conditional dispatch via
//      `if(count(<trigger>), <inner-csql>, 'match-all()')`.
//   3. concat-wrapping shape: predicates with no runtime
//      interpolation still wrap in `concat('<full string>')`;
//      predicates with one input ref lift the ref as a separate
//      `concat(...)` arg; multiple interpolation points each become
//      separate args.
//   4. Hoist consumption: a predicate carrying an `if` /
//      `arith` / `concat` ValueExpression in operand position lifts
//      the expression into the `hoists` list and emits a synthetic
//      input ref interpolated into the wrapper.

import { describe, expect, it } from "vitest";
import {
	ancestorPath,
	and,
	anyRelationPath,
	arith,
	between,
	concat,
	count,
	dateAdd,
	dateCoerce,
	datetimeCoerce,
	double,
	eq,
	exists,
	formatDate,
	gt,
	gte,
	ifExpr,
	input,
	isBlank,
	isIn,
	isNull,
	literal,
	lt,
	lte,
	match,
	matchAll,
	matchNone,
	missing,
	multiSelectAll,
	multiSelectAny,
	neq,
	not,
	now,
	or,
	prop,
	relationStep,
	selfPath,
	sessionContext,
	sessionUser,
	subcasePath,
	term,
	today,
	unwrapList,
	whenInput,
	within,
} from "@/lib/domain/predicate/builders";
import { emitCsql } from "../csqlEmitter";

// ---------- Backward-compat port from xpathEmitter.test.ts ----------

describe("emitCsql — comparison operators", () => {
	it("emits eq with a string literal wrapped in concat()", () => {
		const result = emitCsql(eq(prop("patient", "name"), literal("Alice")));
		expect(result.wrapper).toBe(`concat("name = 'Alice'")`);
		expect(result.hoists).toEqual([]);
	});

	it("emits eq with a numeric literal", () => {
		// Numeric literals emit unquoted on the wire; the inner CSQL
		// fragment `age = 42` has no `'` or `"` and the wrap is a
		// single single-quoted XPath literal.
		const result = emitCsql(eq(prop("patient", "age"), literal(42)));
		expect(result.wrapper).toBe("concat('age = 42')");
	});

	it("emits very small decimal literals without scientific notation", () => {
		const result = emitCsql(eq(prop("patient", "ratio"), literal(0.0000001)));
		expect(result.wrapper).toBe("concat('ratio = 0.0000001')");
	});

	it("emits very large numeric literals without scientific notation", () => {
		const result = emitCsql(eq(prop("patient", "big"), literal(1.5e21)));
		expect(result.wrapper).toBe("concat('big = 1500000000000000000000')");
	});

	it("emits negative numeric literals with the leading minus sign", () => {
		expect(emitCsql(eq(prop("patient", "delta"), literal(-3.14))).wrapper).toBe(
			"concat('delta = -3.14')",
		);
		expect(emitCsql(eq(prop("patient", "tiny"), literal(-1e-10))).wrapper).toBe(
			"concat('tiny = -0.0000000001')",
		);
	});

	it("emits neq / gt / gte / lt / lte", () => {
		expect(emitCsql(neq(prop("patient", "name"), literal("Bob"))).wrapper).toBe(
			`concat("name != 'Bob'")`,
		);
		expect(emitCsql(gt(prop("patient", "age"), literal(18))).wrapper).toBe(
			"concat('age > 18')",
		);
		expect(emitCsql(gte(prop("patient", "age"), literal(18))).wrapper).toBe(
			"concat('age >= 18')",
		);
		expect(emitCsql(lt(prop("patient", "age"), literal(18))).wrapper).toBe(
			"concat('age < 18')",
		);
		expect(emitCsql(lte(prop("patient", "age"), literal(18))).wrapper).toBe(
			"concat('age <= 18')",
		);
	});

	it("emits boolean literals as quoted 'true' / 'false' strings", () => {
		expect(
			emitCsql(eq(prop("patient", "is_active"), literal(true))).wrapper,
		).toBe(`concat("is_active = 'true'")`);
		expect(
			emitCsql(eq(prop("patient", "is_active"), literal(false))).wrapper,
		).toBe(`concat("is_active = 'false'")`);
	});

	it("emits null literals as the empty string", () => {
		expect(emitCsql(eq(prop("patient", "name"), literal(null))).wrapper).toBe(
			`concat("name = ''")`,
		);
	});
});

describe("emitCsql — reserved case attributes", () => {
	// CCHQ's `INDEXED_METADATA_BY_KEY` at
	// `commcare-hq/corehq/apps/case_search/const.py::INDEXED_METADATA_BY_KEY`
	// registers `case_id`, `case_type`, `owner_id`, and `status` with
	// the `@` prefix. The four below get the prefix; user-defined
	// properties emit bare.

	it.each([
		"case_id",
		"case_type",
		"owner_id",
		"status",
	] as const)("prefixes '%s' with @", (attr) => {
		const result = emitCsql(eq(prop("patient", attr), literal("X")));
		expect(result.wrapper).toBe(`concat("@${attr} = 'X'")`);
	});

	it("leaves user-defined properties bare", () => {
		const result = emitCsql(eq(prop("patient", "name"), literal("Alice")));
		expect(result.wrapper).toBe(`concat("name = 'Alice'")`);
	});
});

describe("emitCsql — logical operators", () => {
	it("emits and(...) joining clauses with ' and '", () => {
		const result = emitCsql(
			and(
				eq(prop("patient", "name"), literal("Alice")),
				gt(prop("patient", "age"), literal(18)),
			),
		);
		expect(result.wrapper).toBe(`concat("name = 'Alice' and age > 18")`);
	});

	it("emits or(...) joining clauses with ' or '", () => {
		const result = emitCsql(
			or(
				eq(prop("patient", "name"), literal("Alice")),
				eq(prop("patient", "name"), literal("Bob")),
			),
		);
		expect(result.wrapper).toBe(`concat("name = 'Alice' or name = 'Bob'")`);
	});

	it("parenthesizes or-clauses inside an and (precedence)", () => {
		// XPath's `and` binds tighter than `or`; the inner `or` wraps in
		// parens to preserve authored grouping.
		const result = emitCsql(
			and(
				or(
					eq(prop("patient", "name"), literal("Alice")),
					eq(prop("patient", "name"), literal("Bob")),
				),
				gt(prop("patient", "age"), literal(18)),
			),
		);
		expect(result.wrapper).toBe(
			`concat("(name = 'Alice' or name = 'Bob') and age > 18")`,
		);
	});

	it("emits not(...) wrapping its inner with not(...)", () => {
		const result = emitCsql(not(eq(prop("patient", "name"), literal("Bob"))));
		expect(result.wrapper).toBe(`concat("not(name = 'Bob')")`);
	});
});

describe("emitCsql — sentinel predicates", () => {
	// `match-all` / `match-none` are CCHQ's zero-arg query functions
	// registered on
	// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`
	// (the `match-all` and `match-none` entries).
	it("emits match-all() as a native zero-arg query function", () => {
		expect(emitCsql(matchAll()).wrapper).toBe("concat('match-all()')");
	});

	it("emits match-none() as a native zero-arg query function", () => {
		expect(emitCsql(matchNone()).wrapper).toBe("concat('match-none()')");
	});
});

describe("emitCsql — string-literal escape", () => {
	it("emits embedded single quote with double-quoted CSQL string", () => {
		// CSQL admits both single- and double-quoted string literals
		// natively per the canonical example at
		// `case_search_query_language.rst::"Example Query + Tips"`. The
		// inner CSQL emitter routes the value through `quoteLiteral`
		// in csql mode, which switches to double-quoted CSQL when the
		// value contains a single quote; the resulting CSQL fragment
		// `name = "O'Brien"` carries both quote styles, and the wrap
		// step splits via the XPath concat-of-alternating-quotes
		// idiom.
		const result = emitCsql(eq(prop("patient", "name"), literal("O'Brien")));
		expect(result.wrapper).toBe(`concat('name = "O', "'", 'Brien"')`);
	});

	it("throws when a string literal contains both ' and \"", () => {
		// `quoteLiteral` in csql mode rejects values containing both
		// quote styles per `stringQuoting.ts`'s "no portable escape"
		// branch — XPath 1.0 has no string-escape syntax that handles
		// both, and the wrap step is itself a `concat(...)` call
		// where the alternating-quote fallback isn't available for
		// the inner CSQL string.
		expect(() =>
			emitCsql(eq(prop("patient", "name"), literal(`it's "quoted"`))),
		).toThrow(/no portable escape/i);
	});
});

describe("emitCsql — isIn", () => {
	it("emits single-value isIn as a plain equality (reserved attribute)", () => {
		const result = emitCsql(isIn(prop("patient", "status"), literal("open")));
		expect(result.wrapper).toBe(`concat("@status = 'open'")`);
	});

	it("emits single-value isIn as a plain equality (user-defined)", () => {
		const result = emitCsql(isIn(prop("patient", "category"), literal("open")));
		expect(result.wrapper).toBe(`concat("category = 'open'")`);
	});

	it("emits multi-value isIn as a parenthesized or-of-equalities", () => {
		const result = emitCsql(
			isIn(prop("patient", "tags"), literal("open"), literal("active")),
		);
		expect(result.wrapper).toBe(`concat("(tags = 'open' or tags = 'active')")`);
	});

	it("emits multi-value isIn with a quote-bearing value via per-value escape", () => {
		// `O'Brien` switches its own value to double-quoted CSQL; the
		// other value `active` stays single-quoted. The merged CSQL
		// fragment carries both quote styles and the wrap splits
		// via the XPath concat-of-alternating-quotes idiom.
		const result = emitCsql(
			isIn(prop("patient", "tags"), literal("O'Brien"), literal("active")),
		);
		expect(result.wrapper).toBe(
			`concat('(tags = "O', "'", 'Brien" or tags = ', "'", 'active', "'", ')')`,
		);
	});

	it("emits multi-value isIn with whitespace-bearing values without tokenizing", () => {
		const result = emitCsql(
			isIn(
				prop("patient", "name"),
				literal("Alice Smith"),
				literal("Bob Jones"),
			),
		);
		expect(result.wrapper).toBe(
			`concat("(name = 'Alice Smith' or name = 'Bob Jones')")`,
		);
	});

	it("emits multi-value isIn with mixed null + string values", () => {
		const result = emitCsql(
			isIn(prop("patient", "name"), literal(null), literal("Alice")),
		);
		expect(result.wrapper).toBe(`concat("(name = '' or name = 'Alice')")`);
	});

	it("emits multi-value isIn with numeric literals as bare XPath numbers", () => {
		const result = emitCsql(
			isIn(prop("patient", "age"), literal(18), literal(21)),
		);
		expect(result.wrapper).toBe("concat('(age = 18 or age = 21)')");
	});
});

describe("emitCsql — is-blank", () => {
	it("emits is-blank against a property as prop = ''", () => {
		const result = emitCsql(isBlank(prop("patient", "name")));
		expect(result.wrapper).toBe(`concat("name = ''")`);
	});

	it("emits is-blank against a search-input ref via the runtime path", () => {
		// Runtime LHS interpolates the search-input XPath inside
		// double-quoted CSQL brackets; the trailing `' = '''` constant
		// fragment carries both `'` and `"` quote styles, so the wrap
		// step splits at quote-style boundaries. The XPath
		// concat-of-alternating-quotes idiom built on
		// `lib/commcare/xpath/grammar.lezer.grammar::StringLiteral`
		// produces the segment chain.
		const result = emitCsql(isBlank(input("name_query")));
		expect(result.wrapper).toBe(
			`concat('"', instance('search-input:results')/input/field[@name='name_query'], '" = ', "'", '', "'", '')`,
		);
	});

	it("emits is-blank against a session-context ref", () => {
		const result = emitCsql(isBlank(sessionContext("userid")));
		expect(result.wrapper).toBe(
			`concat('"', instance('commcaresession')/session/context/userid, '" = ', "'", '', "'", '')`,
		);
	});
});

describe("emitCsql — is-null faithful emission", () => {
	it("emits is-null as <term> = '' (the same wire form is-blank uses)", () => {
		// CCHQ's wire absent/cleared/empty collapse at
		// `commcare-hq/corehq/apps/es/case_search.py::case_property_query`
		// makes the strict-absent intent of `is-null` emit the same wire
		// form `is-blank` produces. The strict semantic surfaces only
		// on the Postgres target where JSONB key presence is
		// observable; CSQL gets the closest faithful emission.
		const result = emitCsql(isNull(prop("patient", "name")));
		expect(result.wrapper).toBe(`concat("name = ''")`);
	});
});

describe("emitCsql — when-input-present conditional dispatch", () => {
	it("emits if(count(<trigger>), <inner-csql>, 'match-all()')", () => {
		// CCHQ's canonical pattern documented in
		// `commcare-hq/docs/case_search_query_language.rst`
		// keeps the conditional dispatch OUTSIDE the inner CSQL by
		// emitting an XPath `if(count(<trigger>), <inner>, <fallback>)`
		// wrapper. The fallback is `'match-all()'` (CSQL's
		// AND-identity — the `match-all` entry on
		// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`):
		// when the trigger is unset, the wrapper returns
		// `'match-all()'`, which AND-combines with sibling clauses as
		// a no-op; when the trigger is set, the wrapper returns the
		// inner clause's CSQL fragment.
		const result = emitCsql(
			whenInput(
				input("name_query"),
				eq(prop("patient", "name"), input("name_query")),
			),
		);
		expect(result.wrapper).toBe(
			`concat(if(count(instance('search-input:results')/input/field[@name='name_query']), concat('name = "', instance('search-input:results')/input/field[@name='name_query'], '"'), 'match-all()'))`,
		);
	});

	it("emits when-input-present nested inside an and", () => {
		// The conditional dispatch composes inside a logical operator;
		// the outer `and` joins the static clause with the
		// conditionally-included one via the standard separator.
		const result = emitCsql(
			and(
				eq(prop("patient", "age"), literal(18)),
				whenInput(
					input("name_query"),
					eq(prop("patient", "name"), input("name_query")),
				),
			),
		);
		expect(result.wrapper).toBe(
			`concat('age = 18 and ', if(count(instance('search-input:results')/input/field[@name='name_query']), concat('name = "', instance('search-input:results')/input/field[@name='name_query'], '"'), 'match-all()'))`,
		);
	});
});

// ---------- New CSQL operator coverage ----------

describe("emitCsql — multi-select-contains", () => {
	// CCHQ wire functions:
	// - `selected` is registered as an alias for `selected-any` at the
	//   `selected` entry on
	//   `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`.
	// - Multi-value `selected-any` / `selected-all` use one
	//   space-joined token string per
	//   `commcare-hq/corehq/apps/es/case_search.py::case_property_text_query`'s
	//   `case_property_text_query` whitespace-tokenization rule.

	it("emits single-value any quantifier as bare selected(prop, 'v')", () => {
		const result = emitCsql(
			multiSelectAny(prop("patient", "tags"), literal("vip")),
		);
		expect(result.wrapper).toBe(`concat("selected(tags, 'vip')")`);
	});

	it("emits multi-value any quantifier as selected-any(prop, 'token1 token2')", () => {
		const result = emitCsql(
			multiSelectAny(
				prop("patient", "tags"),
				literal("vip"),
				literal("alumni"),
			),
		);
		expect(result.wrapper).toBe(`concat("selected-any(tags, 'vip alumni')")`);
	});

	it("emits all-quantifier as selected-all(prop, 'token1 token2')", () => {
		const result = emitCsql(
			multiSelectAll(
				prop("patient", "tags"),
				literal("vip"),
				literal("alumni"),
			),
		);
		expect(result.wrapper).toBe(`concat("selected-all(tags, 'vip alumni')")`);
	});

	it("emits all-quantifier with a single value as selected-all(prop, 'v')", () => {
		const result = emitCsql(
			multiSelectAll(prop("patient", "tags"), literal("vip")),
		);
		expect(result.wrapper).toBe(`concat("selected-all(tags, 'vip')")`);
	});
});

describe("emitCsql — match", () => {
	// Each mode maps to a CCHQ wire query function on
	// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`.

	it("emits match mode=fuzzy as fuzzy-match(prop, 'v')", () => {
		const result = emitCsql(match(prop("patient", "name"), "alice", "fuzzy"));
		expect(result.wrapper).toBe(`concat("fuzzy-match(name, 'alice')")`);
	});

	it("emits match mode=phonetic as phonetic-match(prop, 'v')", () => {
		const result = emitCsql(
			match(prop("patient", "name"), "alice", "phonetic"),
		);
		expect(result.wrapper).toBe(`concat("phonetic-match(name, 'alice')")`);
	});

	it("emits match mode=fuzzy-date as fuzzy-date(prop, 'v')", () => {
		const result = emitCsql(
			match(prop("patient", "dob"), "2024-12-03", "fuzzy-date"),
		);
		expect(result.wrapper).toBe(`concat("fuzzy-date(dob, '2024-12-03')")`);
	});

	it("emits match mode=starts-with as starts-with(prop, 'v')", () => {
		const result = emitCsql(
			match(prop("patient", "name"), "Al", "starts-with"),
		);
		expect(result.wrapper).toBe(`concat("starts-with(name, 'Al')")`);
	});
});

describe("emitCsql — within-distance", () => {
	// CCHQ's `within-distance(property, coords, distance, unit)` is
	// 4-arg per
	// `commcare-hq/corehq/apps/case_search/xpath_functions/query_functions.py::within_distance`.

	it("emits within-distance with a literal center and miles", () => {
		const result = emitCsql(
			within(prop("clinic", "location"), literal("40.7,-74.0"), 50, "miles"),
		);
		expect(result.wrapper).toBe(
			`concat("within-distance(location, '40.7,-74.0', 50, 'miles')")`,
		);
	});

	it("emits within-distance with kilometers", () => {
		const result = emitCsql(
			within(
				prop("clinic", "location"),
				literal("40.7,-74.0"),
				25,
				"kilometers",
			),
		);
		expect(result.wrapper).toBe(
			`concat("within-distance(location, '40.7,-74.0', 25, 'kilometers')")`,
		);
	});

	it("emits within-distance with an input center via runtime interpolation", () => {
		// Runtime center interpolates as `<prop>, "<runtime>", <dist>,
		// '<unit>'`. The leading constant carries `"` and the trailing
		// constant carries `'` (the unit literal); when those segments
		// merge after the runtime ref, the result has both quote
		// styles and the wrap step splits via the XPath
		// concat-of-alternating-quotes idiom.
		const result = emitCsql(
			within(prop("clinic", "location"), input("user_loc"), 25, "kilometers"),
		);
		expect(result.wrapper).toBe(
			`concat('within-distance(location, "', instance('search-input:results')/input/field[@name='user_loc'], '", 25, ', "'", 'kilometers', "'", ')')`,
		);
	});

	it("emits within-distance with distance 0 as a bare zero literal", () => {
		const result = emitCsql(
			within(prop("clinic", "location"), literal("40.7,-74.0"), 0, "miles"),
		);
		expect(result.wrapper).toBe(
			`concat("within-distance(location, '40.7,-74.0', 0, 'miles')")`,
		);
	});
});

describe("emitCsql — exists / missing", () => {
	// Direction dispatch:
	// - `subcase` → `subcase-exists('<id>', <filter>)` per
	//   `commcare-hq/corehq/apps/case_search/xpath_functions/subcase_functions.py::subcase`.
	// - `ancestor` → `ancestor-exists(<slash-path>, <filter>)` per
	//   `commcare-hq/corehq/apps/case_search/xpath_functions/ancestor_functions.py::ancestor_exists`.
	// - `missing` wraps the corresponding `<...>-exists(...)` in
	//   `not(...)`.

	it("emits exists subcase with a filter", () => {
		// `state` is a user-defined property — `status` triggers the
		// reserved-attribute `@`-prefix per CCHQ's `INDEXED_METADATA_BY_KEY`
		// at `commcare-hq/corehq/apps/case_search/const.py::INDEXED_METADATA_BY_KEY`,
		// which would distract the test from the exists-subcase shape
		// being pinned.
		const result = emitCsql(
			exists(
				subcasePath("child"),
				eq(prop("patient", "state"), literal("active")),
			),
		);
		expect(result.wrapper).toBe(
			`concat("subcase-exists('child', state = 'active')")`,
		);
	});

	it("emits exists subcase without a filter", () => {
		const result = emitCsql(exists(subcasePath("child")));
		expect(result.wrapper).toBe(`concat("subcase-exists('child')")`);
	});

	it("emits exists ancestor with a single hop and a filter", () => {
		const result = emitCsql(
			exists(
				ancestorPath(relationStep("parent")),
				eq(prop("patient", "region"), literal("east")),
			),
		);
		expect(result.wrapper).toBe(
			`concat("ancestor-exists('parent', region = 'east')")`,
		);
	});

	it("emits exists ancestor with a multi-hop slash path", () => {
		const result = emitCsql(
			exists(
				ancestorPath(relationStep("parent"), relationStep("host")),
				eq(prop("patient", "city"), literal("SF")),
			),
		);
		expect(result.wrapper).toBe(
			`concat("ancestor-exists('parent/host', city = 'SF')")`,
		);
	});

	it("emits exists ancestor without a filter by injecting match-all()", () => {
		// CCHQ's `ancestor-exists` requires exactly two arguments per
		// `confirm_args_count(node, 2)` at
		// `commcare-hq/corehq/apps/case_search/xpath_functions/ancestor_functions.py::ancestor_exists`.
		// The no-where case injects `match-all()` (a CSQL query
		// function at the `match-all` entry on
		// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`)
		// to satisfy the arity requirement; the natural "any case
		// along this ancestor path exists" semantic.
		const result = emitCsql(exists(ancestorPath(relationStep("parent"))));
		expect(result.wrapper).toBe(
			`concat("ancestor-exists('parent', match-all())")`,
		);
	});

	it("emits exists subcase with a runtime ref inside the filter", () => {
		// CCHQ's canonical pattern documented in
		// `commcare-hq/docs/case_search_query_language.rst`
		// uses `subcase-exists("parent", ... clinic_case_id = "',
		// instance(...), '")')` — a runtime user clinic id
		// interpolates inside the inner CSQL filter via the outer
		// concat. The segment-list IR composes filter segments into
		// the outer concat at the call site.
		const result = emitCsql(
			exists(subcasePath("child"), eq(prop("child", "x"), input("q"))),
		);
		expect(result.wrapper).toBe(
			`concat('subcase-exists(', "'", 'child', "'", ', x = "', instance('search-input:results')/input/field[@name='q'], '")')`,
		);
	});

	it("emits missing subcase as not(subcase-exists(...))", () => {
		const result = emitCsql(
			missing(
				subcasePath("child"),
				eq(prop("patient", "state"), literal("active")),
			),
		);
		expect(result.wrapper).toBe(
			`concat("not(subcase-exists('child', state = 'active'))")`,
		);
	});

	it("emits missing ancestor as not(ancestor-exists(...))", () => {
		const result = emitCsql(
			missing(
				ancestorPath(relationStep("parent")),
				eq(prop("patient", "x"), literal("y")),
			),
		);
		expect(result.wrapper).toBe(
			`concat("not(ancestor-exists('parent', x = 'y'))")`,
		);
	});

	it("throws on exists with via.kind === 'self'", () => {
		expect(() =>
			emitCsql(exists(selfPath(), eq(prop("patient", "name"), literal("a")))),
		).toThrow(/self/);
	});

	it("expands exists any-relation to (ancestor-exists or subcase-exists)", () => {
		// Direction-agnostic walks have no single CCHQ wire form, so
		// the emitter expands to the OR of both direction-specific
		// forms — symmetric with the on-device any-relation expansion
		// in `caseListFilterEmitter`.
		const result = emitCsql(
			exists(
				anyRelationPath("rel"),
				eq(prop("patient", "name"), literal("Alice")),
			),
		);
		expect(result.wrapper).toBe(
			`concat("(ancestor-exists('rel', name = 'Alice') or subcase-exists('rel', name = 'Alice'))")`,
		);
	});

	it("expands missing any-relation to not((ancestor-exists or subcase-exists))", () => {
		// Negation wraps the disjunction in `not(...)` rather than
		// flipping the inner forms — symmetric with the on-device
		// expansion in `caseListFilterEmitter`.
		const result = emitCsql(
			missing(
				anyRelationPath("rel"),
				eq(prop("patient", "name"), literal("Alice")),
			),
		);
		expect(result.wrapper).toBe(
			`concat("not((ancestor-exists('rel', name = 'Alice') or subcase-exists('rel', name = 'Alice')))")`,
		);
	});

	it("expands exists any-relation without a where filter using injected match-all() on the ancestor side", () => {
		// CCHQ's `ancestor-exists` requires exactly two arguments
		// (`confirm_args_count(node, 2)` at
		// `commcare-hq/corehq/apps/case_search/xpath_functions/ancestor_functions.py::ancestor_exists`),
		// so the no-where path injects `match-all()` on the ancestor
		// side. `subcase-exists` accepts the 1-arg form per
		// `subcase_functions.py::_extract_subcase_query_parts` and
		// emits without a filter argument.
		const result = emitCsql(exists(anyRelationPath("rel")));
		expect(result.wrapper).toBe(
			`concat("(ancestor-exists('rel', match-all()) or subcase-exists('rel'))")`,
		);
	});
});

describe("emitCsql — between", () => {
	it("emits both bounds as (left >= lower and left <= upper)", () => {
		const result = emitCsql(
			between(prop("patient", "age"), {
				lower: term(literal(18)),
				upper: term(literal(65)),
			}),
		);
		expect(result.wrapper).toBe("concat('(age >= 18 and age <= 65)')");
	});

	it("emits exclusive bounds with > / <", () => {
		const result = emitCsql(
			between(prop("patient", "age"), {
				lower: term(literal(18)),
				upper: term(literal(65)),
				lowerInclusive: false,
				upperInclusive: false,
			}),
		);
		expect(result.wrapper).toBe("concat('(age > 18 and age < 65)')");
	});

	it("emits lower-only bound as a single comparison", () => {
		const result = emitCsql(
			between(prop("patient", "age"), { lower: term(literal(18)) }),
		);
		expect(result.wrapper).toBe("concat('age >= 18')");
	});

	it("emits upper-only bound as a single comparison", () => {
		const result = emitCsql(
			between(prop("patient", "age"), { upper: term(literal(65)) }),
		);
		expect(result.wrapper).toBe("concat('age <= 65')");
	});
});

describe("emitCsql — subcase-count in comparison-LHS (native)", () => {
	// CCHQ's `_is_subcase_count` recogniser nested inside
	// `commcare-hq/corehq/apps/case_search/filter_dsl.py::build_filter_from_ast`
	// matches `subcase-count` literally as the LHS of a binary
	// comparison. The hoist pass leaves it untouched; the inner
	// emitter must produce the wire form natively.

	it("emits subcase-count(...) > N", () => {
		const result = emitCsql(gt(count(subcasePath("child")), literal(2)));
		// `count(subcase)` in comparison-LHS context emits as
		// `subcase-count('child')`; the rest of the comparison
		// emits as plain `<lhs> > 2`.
		expect(result.wrapper).toBe(`concat("subcase-count('child') > 2")`);
	});

	it("emits subcase-count(...) = 0 with a filter", () => {
		// `state` rather than `status` to avoid the reserved-attribute
		// `@` prefix that would distract from the subcase-count shape.
		const result = emitCsql(
			eq(
				count(
					subcasePath("visit"),
					eq(prop("visit", "state"), literal("done")),
				),
				literal(0),
			),
		);
		expect(result.wrapper).toBe(
			`concat("subcase-count('visit', state = 'done') = 0")`,
		);
	});
});

// ---------- concat() wrapping shape ----------

describe("emitCsql — concat() wrapping shape", () => {
	it("wraps a fully-constant predicate in concat('<full string>')", () => {
		// The wrap is unconditional even when no runtime interpolation
		// appears, so the wire layer reads one shape per CSQL value.
		const result = emitCsql(eq(prop("patient", "name"), literal("Alice")));
		// Single concat() arg.
		expect(result.wrapper).toMatch(/^concat\((?!.*,).*\)$/);
		expect(result.wrapper).toBe(`concat("name = 'Alice'")`);
	});

	it("lifts a single input ref as a separate concat() arg", () => {
		const result = emitCsql(eq(prop("patient", "name"), input("name_query")));
		// Three args: `name = "`, the runtime XPath, `"`.
		expect(result.wrapper).toBe(
			`concat('name = "', instance('search-input:results')/input/field[@name='name_query'], '"')`,
		);
	});

	it("lifts multiple interpolation points as separate concat() args in document order", () => {
		const result = emitCsql(
			and(
				eq(prop("patient", "name"), input("name_query")),
				eq(prop("patient", "region"), sessionUser("region")),
			),
		);
		// 7 args total: `name = "`, name xpath, `" and region = "`,
		// region xpath, `"`.
		expect(result.wrapper).toBe(
			`concat('name = "', instance('search-input:results')/input/field[@name='name_query'], '" and region = "', instance('commcaresession')/session/user/data/region, '"')`,
		);
	});

	it("composes mixed constant + runtime parts in document order", () => {
		// The literal value `'Alice'` uses single-quoted CSQL while the
		// runtime interpolation uses double-quoted CSQL brackets, so
		// the merged constant `name = 'Alice' and region = "` carries
		// both quote styles. The wrap step splits via the XPath
		// concat-of-alternating-quotes idiom — each split fragment is
		// either single-quoted (no `'` after split) or `"'"` (the
		// literal-quote separator).
		const result = emitCsql(
			and(
				eq(prop("patient", "name"), literal("Alice")),
				eq(prop("patient", "region"), input("user_region")),
			),
		);
		expect(result.wrapper).toBe(
			`concat('name = ', "'", 'Alice', "'", ' and region = "', instance('search-input:results')/input/field[@name='user_region'], '"')`,
		);
	});

	it("wraps match-all() in concat('match-all()')", () => {
		expect(emitCsql(matchAll()).wrapper).toBe("concat('match-all()')");
	});

	it("wraps match-none() in concat('match-none()')", () => {
		expect(emitCsql(matchNone()).wrapper).toBe("concat('match-none()')");
	});
});

// ---------- Hoist consumption ----------

describe("emitCsql — hoist consumption", () => {
	it("lifts an arith expression in a comparison's left operand into the hoists list", () => {
		const lifted = arith("+", term(prop("patient", "age")), term(literal(1)));
		const result = emitCsql(eq(lifted, term(literal(19))));
		// One hoist; the wrapper interpolates the synthetic input ref
		// in place of the arith.
		expect(result.hoists).toHaveLength(1);
		expect(result.hoists[0]?.inputRef).toBe("csql_hoist_0");
		expect(result.hoists[0]?.expression).toEqual(lifted);
		expect(result.wrapper).toBe(
			`concat('"', instance('search-input:results')/input/field[@name='csql_hoist_0'], '" = 19')`,
		);
	});

	it("lifts an if-expression in a comparison's right operand", () => {
		const lifted = ifExpr(matchAll(), term(literal("a")), term(literal("b")));
		const result = emitCsql(eq(prop("patient", "label"), lifted));
		expect(result.hoists).toHaveLength(1);
		expect(result.hoists[0]?.expression).toEqual(lifted);
		// The synthetic input ref interpolates as a runtime value
		// inside double-quoted CSQL.
		expect(result.wrapper).toBe(
			`concat('label = "', instance('search-input:results')/input/field[@name='csql_hoist_0'], '"')`,
		);
	});

	it("lifts a count outside a top-level comparison as a wrapper", () => {
		// `count(...)` in `is-blank`'s operand is not in a
		// comparison-LHS slot; the hoist pass lifts it into an on-
		// device wrapper. The wire layer evaluates the count and
		// injects the resolved numeric literal into the CSQL fragment
		// via the synthetic search-input ref.
		const lifted = count(subcasePath("child"));
		const result = emitCsql(isBlank(lifted));
		expect(result.hoists).toHaveLength(1);
		expect(result.hoists[0]?.expression).toEqual(lifted);
	});

	it("lifts a count with non-subcase direction in comparison-LHS as a wrapper", () => {
		// CCHQ's `_is_subcase_count` recogniser only matches the
		// literal `subcase-count` function name; ancestor-direction
		// counts have no native CSQL form even in the comparison-LHS
		// slot, so they lift into the on-device wrapper.
		const lifted = count(ancestorPath(relationStep("parent")));
		const result = emitCsql(gt(lifted, literal(2)));
		expect(result.hoists).toHaveLength(1);
		expect(result.hoists[0]?.expression).toEqual(lifted);
	});

	it("lifts non-grammar shapes inside an exists filter as wrappers", () => {
		// Runtime refs inside an exists filter are valid per CCHQ's
		// canonical pattern at
		// `case_search_query_language.rst::"Filtering on related cases" → "Examples"`.
		// Non-grammar value expressions (like `arith` here) lift into
		// the on-device wrapper for runtime resolution; grammar shapes
		// compose into the outer concat via the segment-list IR.
		const lifted = arith("+", term(prop("child", "age")), term(literal(1)));
		const result = emitCsql(
			exists(subcasePath("child"), eq(lifted, term(literal(19)))),
		);
		expect(result.hoists).toHaveLength(1);
		expect(result.hoists[0]?.expression).toEqual(lifted);
	});
});

// ---------- Term-arm unwrap exhaustiveness ----------

describe("emitCsql — term-arm unwrap (happy path)", () => {
	it("unwraps a property reference in a comparison's left operand", () => {
		const result = emitCsql(eq(prop("patient", "name"), literal("Alice")));
		expect(result.wrapper).toBe(`concat("name = 'Alice'")`);
	});

	it("unwraps a search-input reference in a comparison's right operand", () => {
		const result = emitCsql(eq(prop("patient", "phone"), input("phone_query")));
		expect(result.wrapper).toBe(
			`concat('phone = "', instance('search-input:results')/input/field[@name='phone_query'], '"')`,
		);
	});

	it("emits a session-user reference via the user/data XPath", () => {
		const result = emitCsql(
			eq(prop("patient", "region"), sessionUser("region")),
		);
		expect(result.wrapper).toBe(
			`concat('region = "', instance('commcaresession')/session/user/data/region, '"')`,
		);
	});

	it("emits a session-context reference via the context XPath", () => {
		const result = emitCsql(
			eq(prop("patient", "owner_id"), sessionContext("userid")),
		);
		expect(result.wrapper).toBe(
			`concat('@owner_id = "', instance('commcaresession')/session/context/userid, '"')`,
		);
	});
});

describe("emitCsql — non-term ValueExpression arms hoist into wrappers", () => {
	// Every non-term ValueExpression arm in a hoistable position lifts
	// into the on-device wrapper list, with the synthetic input ref
	// taking the lifted node's place inside the inner CSQL fragment.

	it("lifts a concat expression into the wrapper list", () => {
		const lifted = concat(term(literal("Mr ")), term(prop("patient", "name")));
		const result = emitCsql(eq(prop("patient", "display"), lifted));
		expect(result.hoists).toHaveLength(1);
		expect(result.hoists[0]?.expression).toEqual(lifted);
	});

	it("lifts a format-date expression into the wrapper list", () => {
		// `format-date` is absent from CSQL's value-function whitelist
		// on
		// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`,
		// so the entire expression lifts as a wrapper that runs on-
		// device (where `format-date` is available via JavaRosa) and
		// produces the formatted string injected into the CSQL fragment
		// via the synthetic search-input ref.
		const lifted = formatDate(term(prop("patient", "dob")), "iso");
		const result = emitCsql(eq(prop("patient", "dob_text"), lifted));
		expect(result.hoists).toHaveLength(1);
		expect(result.hoists[0]?.expression).toEqual(lifted);
		expect(result.wrapper).toBe(
			`concat('dob_text = "', instance('search-input:results')/input/field[@name='csql_hoist_0'], '"')`,
		);
	});
});

describe("emitCsql — date-coerce / datetime-coerce rename", () => {
	// AST kind names diverge from CCHQ's CSQL value-function names.
	// The hoist pass leaves both arms intact; the emitter renames at
	// output time per CCHQ's `XPATH_VALUE_FUNCTIONS` registration at
	// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`.

	it("emits date-coerce(literal) as date('<value>') in operand position", () => {
		// AST `date-coerce(value)` maps to wire `date(value)` (the `date`
		// entry on `XPATH_VALUE_FUNCTIONS`).
		const result = emitCsql(
			eq(prop("patient", "dob"), dateCoerce(term(literal("2024-12-03")))),
		);
		expect(result.wrapper).toBe(`concat("dob = date('2024-12-03')")`);
	});

	it("emits datetime-coerce(literal) as datetime('<value>') in operand position", () => {
		// AST `datetime-coerce(value)` maps to wire `datetime(value)`
		// (the `datetime` entry on `XPATH_VALUE_FUNCTIONS`).
		const result = emitCsql(
			eq(
				prop("patient", "modified_on"),
				datetimeCoerce(term(literal("2024-12-03T10:00:00"))),
			),
		);
		expect(result.wrapper).toBe(
			`concat("modified_on = datetime('2024-12-03T10:00:00')")`,
		);
	});

	it("emits date-coerce of a runtime input ref with the runtime XPath inside the call", () => {
		// `date-coerce(input("user_date"))` becomes
		// `date(<runtime-xpath>)` — runtime XPath result interpolates
		// inside the function-call argument unwrapped (CSQL function
		// calls accept value arguments directly, no string-quote
		// brackets).
		const result = emitCsql(
			eq(prop("patient", "dob"), dateCoerce(term(input("user_date")))),
		);
		expect(result.wrapper).toBe(
			`concat('dob = date(', instance('search-input:results')/input/field[@name='user_date'], ')')`,
		);
	});

	it("emits datetime-coerce of a runtime ref with the runtime XPath inside the call", () => {
		const result = emitCsql(
			eq(
				prop("patient", "modified_on"),
				datetimeCoerce(term(input("user_dt"))),
			),
		);
		expect(result.wrapper).toBe(
			`concat('modified_on = datetime(', instance('search-input:results')/input/field[@name='user_dt'], ')')`,
		);
	});
});

describe("emitCsql — value-function whitelist arms in operand position", () => {
	// The remaining CSQL value-function whitelist arms (per
	// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`)
	// — `today`, `now`, `double`, `date-add`, `unwrap-list` — survive
	// the hoist pass and emit through the value-expression emitter at
	// `lib/commcare/expression/csqlEmitter.ts`. The predicate emitter
	// composes the resulting segment list with comparison operators,
	// CSQL string-quote brackets, and concat-wrap arguments without
	// special-case dispatch per arm.

	it("emits today() in a comparison operand without hoisting", () => {
		const result = emitCsql(eq(prop("patient", "dob"), today()));
		expect(result.hoists).toHaveLength(0);
		// No `'` in the constant → wrap in single-quoted XPath string.
		expect(result.wrapper).toBe(`concat('dob = today()')`);
	});

	it("emits now() in a comparison operand without hoisting", () => {
		const result = emitCsql(eq(prop("patient", "modified_on"), now()));
		expect(result.hoists).toHaveLength(0);
		expect(result.wrapper).toBe(`concat('modified_on = now()')`);
	});

	it("emits double(literal) in a comparison operand without hoisting", () => {
		const result = emitCsql(
			eq(prop("p", "weight_g"), double(term(literal(1500)))),
		);
		expect(result.hoists).toHaveLength(0);
		expect(result.wrapper).toBe(`concat('weight_g = double(1500)')`);
	});

	it("emits date-add with three arguments per CCHQ's wire signature", () => {
		// CCHQ's wire signature: `date-add(date, interval, quantity)`.
		// Source: `value_functions.py::date_add` —
		// `date-add('2022-01-01', 'days', -1) => '2021-12-31'`.
		// The interval `'days'` carries an inner single quote, which
		// flips the outer XPath wrap to double-quoted.
		const result = emitCsql(
			eq(
				prop("patient", "due_date"),
				dateAdd(today(), "days", term(literal(7))),
			),
		);
		expect(result.hoists).toHaveLength(0);
		expect(result.wrapper).toBe(
			`concat("due_date = date-add(today(), 'days', 7)")`,
		);
	});

	it("emits date-add with a runtime-resolved date argument", () => {
		const result = emitCsql(
			eq(
				prop("patient", "due_date"),
				dateAdd(term(input("base_date")), "days", term(literal(7))),
			),
		);
		expect(result.hoists).toHaveLength(0);
		expect(result.wrapper).toBe(
			`concat('due_date = date-add(', instance('search-input:results')/input/field[@name='base_date'], ", 'days', 7)")`,
		);
	});

	it("emits unwrap-list in a multi-select-contains shape via the predicate emitter", () => {
		// `unwrap-list` survives the hoist pass and emits through the
		// value-expression emitter; the predicate emitter composes the
		// segments with the comparison's surrounding constants.
		const result = emitCsql(
			eq(prop("p", "tags"), unwrapList(term(prop("p", "tags_json")))),
		);
		expect(result.hoists).toHaveLength(0);
		expect(result.wrapper).toBe(`concat('tags = unwrap-list(tags_json)')`);
	});
});

describe("emitCsql — synthetic input collision avoidance", () => {
	// The synthetic-name counter seeds past any author-written input
	// ref that shares the `csql_hoist_` prefix and a numeric suffix,
	// so synthetic refs never shadow author refs even when authors
	// deliberately reuse the prefix.

	it("seeds the synthetic counter past an author-written csql_hoist_<n> ref", () => {
		const lifted = arith("+", term(prop("patient", "age")), term(literal(1)));
		// Author writes `csql_hoist_5` themselves (rare but typeable);
		// the lifted arith should NOT collide with that name. The
		// synthetic counter starts at 6.
		const result = emitCsql(
			and(
				eq(prop("patient", "x"), input("csql_hoist_5")),
				eq(lifted, term(literal(19))),
			),
		);
		expect(result.hoists).toHaveLength(1);
		expect(result.hoists[0]?.inputRef).toBe("csql_hoist_6");
	});

	it("starts at 0 when no author ref shares the synthetic prefix", () => {
		const lifted = arith("+", term(prop("patient", "age")), term(literal(1)));
		const result = emitCsql(eq(lifted, term(literal(19))));
		expect(result.hoists[0]?.inputRef).toBe("csql_hoist_0");
	});

	it("ignores author refs sharing the prefix but with non-numeric suffix", () => {
		// `csql_hoist_foo` shares the prefix but the suffix doesn't
		// parse as an integer; synthetic refs are always numeric, so
		// no collision is possible. The counter starts at 0.
		const lifted = arith("+", term(prop("patient", "age")), term(literal(1)));
		const result = emitCsql(
			and(
				eq(prop("patient", "x"), input("csql_hoist_foo")),
				eq(lifted, term(literal(19))),
			),
		);
		expect(result.hoists[0]?.inputRef).toBe("csql_hoist_0");
	});
});
