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
//   4. Inline runtime operands: a predicate carrying an `if` /
//      `arith` / `concat` / `switch` / `coalesce` / `format-date` /
//      non-LHS `count` ValueExpression in operand position emits the
//      expression as an on-device XPath fragment inside the wrapper
//      concat, double-quote-bracketed as a CSQL string value. This
//      matches the canonical CCHQ pattern documented at
//      `commcare-hq/docs/case_search_query_language.rst::"Example
//      Query + Tips"` where `instance('casedb')/...` evaluates
//      on-device at concat-time and its string result substitutes
//      directly into the CSQL fragment. CCHQ's
//      `RemoteQuerySessionManager.initUserAnswers` only seeds the
//      `search-input:results` instance from `<prompt>` defaults, so
//      a sibling `<data>` slot's value never reaches the instance —
//      the inline shape is the only wire-correct option.

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
	// - `selected` is registered alongside `selected_any` /
	//   `selected_all` at the `selected` entry on
	//   `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`.
	// - `selected_any` / `selected_all` forward their value argument
	//   to ElasticSearch's `match` query via `case_property_text_query`
	//   at `commcare-hq/corehq/apps/es/case_search.py::case_property_text_query`,
	//   whose analyzer tokenizes on whitespace — a single-string
	//   `selected-any(prop, 'Alice Smith Bob')` matches three tokens,
	//   not two authored values. The emitter therefore expands every
	//   multi-value authoring intent to an OR / AND of per-value
	//   `selected(prop, 'v')` calls so multi-word values stay intact.

	it("emits single-value any quantifier as bare selected(prop, 'v')", () => {
		const result = emitCsql(
			multiSelectAny(prop("patient", "tags"), literal("vip")),
		);
		expect(result.wrapper).toBe(`concat("selected(tags, 'vip')")`);
	});

	it("emits multi-value any quantifier as an OR of per-value selected calls", () => {
		const result = emitCsql(
			multiSelectAny(
				prop("patient", "tags"),
				literal("vip"),
				literal("alumni"),
			),
		);
		expect(result.wrapper).toBe(
			`concat("(selected(tags, 'vip') or selected(tags, 'alumni'))")`,
		);
	});

	it("emits all-quantifier with multiple values as an AND of per-value selected calls", () => {
		const result = emitCsql(
			multiSelectAll(
				prop("patient", "tags"),
				literal("vip"),
				literal("alumni"),
			),
		);
		expect(result.wrapper).toBe(
			`concat("(selected(tags, 'vip') and selected(tags, 'alumni'))")`,
		);
	});

	it("emits all-quantifier with a single value as bare selected(prop, 'v')", () => {
		const result = emitCsql(
			multiSelectAll(prop("patient", "tags"), literal("vip")),
		);
		expect(result.wrapper).toBe(`concat("selected(tags, 'vip')")`);
	});

	it("emits one selected call per value rather than space-joining values into one call", () => {
		// The per-value `selected(prop, 'v')` shape disambiguates each
		// authored value at the wire layer — a space-joined
		// `selected-any(prop, 'v1 v2 v3')` would be unrecoverable about
		// whether `v1 v2` was authored as one multi-word value or as
		// two separate values. CCHQ's runtime still tokenizes each
		// individual literal on whitespace through ES's `match` query
		// (verified at
		// `~/code/commcare-hq/.../case_search/xpath_functions/__init__.py`:
		// `'selected': selected_any` — same function), so a literal
		// like "Alice Smith" silently OR-tokenizes downstream. The
		// `matchModeWhitespaceInValue` validator rule rejects
		// whitespace-bearing `multi-select-contains` value literals at
		// authoring time to prevent the silent broadening; this test
		// pins the wire emission shape, not the runtime semantic of
		// each individual literal.
		const result = emitCsql(
			multiSelectAny(
				prop("patient", "tags"),
				literal("Alice Smith"),
				literal("Bob"),
			),
		);
		expect(result.wrapper).toBe(
			`concat("(selected(tags, 'Alice Smith') or selected(tags, 'Bob'))")`,
		);
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
			`concat("ancestor-exists(parent, region = 'east')")`,
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
			`concat("ancestor-exists(parent/host, city = 'SF')")`,
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
			`concat('ancestor-exists(parent, match-all())')`,
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
			`concat("not(ancestor-exists(parent, x = 'y'))")`,
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
			`concat("(ancestor-exists(rel, name = 'Alice') or subcase-exists('rel', name = 'Alice'))")`,
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
			`concat("not((ancestor-exists(rel, name = 'Alice') or subcase-exists('rel', name = 'Alice')))")`,
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
			`concat("(ancestor-exists(rel, match-all()) or subcase-exists('rel'))")`,
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
	// comparison. The CSQL emitter recognises the same shape and
	// produces the native wire form; other `count` shapes inline as
	// on-device XPath.

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

// ---------- Inline runtime operands ----------
//
// Non-grammar value expressions (`if`, `switch`, `arith`, `concat`,
// `coalesce`, `format-date`, non-LHS `count`, ancestor / any-relation
// `count`) inline as on-device XPath fragments inside the `concat(...)`
// wrapper. The fragment's runtime value substitutes directly into the
// CSQL string surrounded by double-quote brackets so it lands as a
// CSQL string value — CCHQ's server-side `case_property_query`
// coerces the resulting string to the target property's type.
//
// CCHQ's `RemoteQuerySessionManager.initUserAnswers` /
// `getUserQueryValues` only thread `<prompt>` values into the
// `search-input:results` instance; sibling `<data>` slots with
// synthetic keys never reach the instance, so the inline shape is
// the only wire-correct way to weave a runtime-resolved expression
// into a CSQL fragment.

describe("emitCsql — inline runtime operands", () => {
	it("inlines an arith expression in a comparison's left operand", () => {
		// The on-device emitter renders `arith('+', age, 1)` as
		// `(age + 1)`. The CSQL emitter wraps the runtime fragment in
		// `"..."` brackets so the resolved string lands as a CSQL
		// string value the server's `case_property_query` coerces.
		const lifted = arith("+", term(prop("patient", "age")), term(literal(1)));
		const result = emitCsql(eq(lifted, term(literal(19))));
		expect(result.wrapper).toBe(`concat('"', (age + 1), '" = 19')`);
	});

	it("inlines an if-expression in a comparison's right operand", () => {
		// `ifExpr(matchAll(), 'a', 'b')` lowers to `if(true(), 'a', 'b')`
		// on the on-device dialect; the result wraps inside the CSQL
		// double-quote brackets.
		const lifted = ifExpr(matchAll(), term(literal("a")), term(literal("b")));
		const result = emitCsql(eq(prop("patient", "label"), lifted));
		expect(result.wrapper).toBe(
			`concat('label = "', if(true(), 'a', 'b'), '"')`,
		);
	});

	it("inlines a count outside a top-level comparison when direction is non-subcase", () => {
		// `count(...)` in `is-blank`'s operand sits on the LHS of the
		// emitted `<term> = ''` comparison, so subcase-direction
		// `count` survives as native `subcase-count(...)` per CCHQ's
		// `_is_subcase_count` recogniser (which inspects the binary
		// expression's left operand). Other directions inline as
		// on-device XPath fragments. The trailing `''` (CSQL empty
		// literal) renders through the alternating-quote idiom because
		// the merged constant carries both `'` and `"`.
		const ancestorCount = count(ancestorPath(relationStep("parent")));
		const result = emitCsql(isBlank(ancestorCount));
		expect(result.wrapper).toBe(
			`concat('"', count(instance('casedb')/casedb/case[@case_id=current()/index/parent]), '" = ', "'", '', "'", '')`,
		);
	});

	it("emits subcase-direction count in is-blank's operand as native subcase-count", () => {
		// `is-blank` lowers to `<left> = ''`; the resulting wire form
		// is a BinaryExpression whose left is the count, so CCHQ's
		// `_is_subcase_count` recogniser at
		// `commcare-hq/corehq/apps/case_search/filter_dsl.py::build_filter_from_ast`
		// fires. The wire form stays in CSQL's native vocabulary.
		const lifted = count(subcasePath("child"));
		const result = emitCsql(isBlank(lifted));
		expect(result.wrapper).toBe(`concat("subcase-count('child') = ''")`);
	});

	it("inlines a count with non-subcase direction in comparison-LHS", () => {
		// CCHQ's `_is_subcase_count` recogniser only matches the
		// literal `subcase-count` function name; ancestor-direction
		// counts have no native CSQL form even in the comparison-LHS
		// slot, so the emitter inlines as on-device XPath.
		const lifted = count(ancestorPath(relationStep("parent")));
		const result = emitCsql(gt(lifted, literal(2)));
		expect(result.wrapper).toBe(
			`concat('"', count(instance('casedb')/casedb/case[@case_id=current()/index/parent]), '" > 2')`,
		);
	});

	it("inlines non-grammar shapes nested inside an exists filter", () => {
		// Runtime refs inside an exists filter are valid per CCHQ's
		// canonical pattern at
		// `case_search_query_language.rst::"Filtering on related cases" → "Examples"`.
		// Non-grammar value expressions (`arith` here) inline as
		// on-device XPath fragments; grammar shapes compose into the
		// outer concat via the segment-list IR. The constant carrying
		// both `'` (around `'child'`) and `"` (around the runtime
		// fragment) splits via the alternating-quote idiom.
		const lifted = arith("+", term(prop("child", "age")), term(literal(1)));
		const result = emitCsql(
			exists(subcasePath("child"), eq(lifted, term(literal(19)))),
		);
		expect(result.wrapper).toBe(
			`concat('subcase-exists(', "'", 'child', "'", ', "', (age + 1), '" = 19)')`,
		);
	});
});

// ---------- Property-via lift ----------
//
// Every operator-direct `prop(via)` reference rewrites into an
// enclosing `exists` envelope before CSQL emission. The wire form
// uses CCHQ's `ancestor-exists` / `subcase-exists` query functions
// registered on
// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`,
// matching the row set the on-device emitter at
// `emitOnDevicePropertyRef` produces for the same authored AST.

describe("emitCsql — property-via lift (comparison operators)", () => {
	// Six comparison operators — each variant carries a `prop(via)`
	// in one slot to confirm the lift produces a wire-correct
	// envelope. Asymmetric operators (`gt` / `gte` / `lt` / `lte`)
	// pin the RHS-via lift swap so the inner comparison preserves
	// authored semantics.

	it("lifts ancestor via on eq LHS into ancestor-exists envelope", () => {
		const result = emitCsql(
			eq(
				prop("patient", "name", ancestorPath(relationStep("parent"))),
				literal("Alice"),
			),
		);
		expect(result.wrapper).toBe(
			`concat("ancestor-exists(parent, name = 'Alice')")`,
		);
	});

	it("lifts subcase via on neq LHS into subcase-exists envelope", () => {
		const result = emitCsql(
			neq(prop("patient", "state", subcasePath("child")), literal("active")),
		);
		expect(result.wrapper).toBe(
			`concat("subcase-exists('child', state != 'active')")`,
		);
	});

	it("lifts ancestor via on gt LHS preserving operator direction", () => {
		const result = emitCsql(
			gt(
				prop("patient", "age", ancestorPath(relationStep("parent"))),
				literal(18),
			),
		);
		expect(result.wrapper).toBe(`concat('ancestor-exists(parent, age > 18)')`);
	});

	it("lifts ancestor via on gte LHS preserving operator direction", () => {
		const result = emitCsql(
			gte(
				prop("patient", "age", ancestorPath(relationStep("parent"))),
				literal(18),
			),
		);
		expect(result.wrapper).toBe(`concat('ancestor-exists(parent, age >= 18)')`);
	});

	it("lifts ancestor via on lt LHS preserving operator direction", () => {
		const result = emitCsql(
			lt(
				prop("patient", "age", ancestorPath(relationStep("parent"))),
				literal(65),
			),
		);
		expect(result.wrapper).toBe(`concat('ancestor-exists(parent, age < 65)')`);
	});

	it("lifts ancestor via on lte LHS preserving operator direction", () => {
		const result = emitCsql(
			lte(
				prop("patient", "age", ancestorPath(relationStep("parent"))),
				literal(65),
			),
		);
		expect(result.wrapper).toBe(`concat('ancestor-exists(parent, age <= 65)')`);
	});

	it("swaps gt operator when via lifts from RHS to preserve semantics", () => {
		// Authored `literal(18) gt prop(via)` reads "18 > <related
		// prop value>" — i.e. "<related prop value> < 18". The lift
		// moves the property to the envelope's inner LHS and swaps
		// the operator so the comparison direction stays intact.
		const result = emitCsql(
			gt(
				literal(18),
				prop("patient", "age", ancestorPath(relationStep("parent"))),
			),
		);
		expect(result.wrapper).toBe(`concat('ancestor-exists(parent, age < 18)')`);
	});

	it("preserves operand order on eq RHS-via lift (symmetric op)", () => {
		// Symmetric ops keep `<original-left> = <prop>` inside the
		// envelope; the authored `'Alice' = prop` shape survives.
		const result = emitCsql(
			eq(
				literal("Alice"),
				prop("patient", "name", ancestorPath(relationStep("parent"))),
			),
		);
		expect(result.wrapper).toBe(
			`concat("ancestor-exists(parent, 'Alice' = name)")`,
		);
	});

	it("nests envelopes when both comparison operands carry vias", () => {
		// `eq(prop(via=ancestor), prop(via=subcase))` lifts the LHS
		// first; the inner `where` then carries the RHS via on a
		// property-vs-property comparison. The recursive lift wraps
		// the inner expression in the RHS's envelope. Symmetric ops
		// preserve operand order on the RHS-via lift, so the inner
		// comparison reads with the authored `x = y` shape.
		const result = emitCsql(
			eq(
				prop("patient", "x", ancestorPath(relationStep("parent"))),
				prop("patient", "y", subcasePath("child")),
			),
		);
		expect(result.wrapper).toBe(
			`concat("ancestor-exists(parent, subcase-exists('child', x = y))")`,
		);
	});

	it("preserves @-prefix on reserved attributes through the lift", () => {
		// CCHQ's `INDEXED_METADATA_BY_KEY` at
		// `commcare-hq/corehq/apps/case_search/const.py::INDEXED_METADATA_BY_KEY`
		// registers `status` with the `@` prefix; the lifted inner
		// property must keep the prefix.
		const result = emitCsql(
			eq(
				prop("patient", "status", ancestorPath(relationStep("parent"))),
				literal("active"),
			),
		);
		expect(result.wrapper).toBe(
			`concat("ancestor-exists(parent, @status = 'active')")`,
		);
	});

	it("lifts multi-hop ancestor via with slash-joined path", () => {
		// CCHQ's `ancestor_exists` parses its first argument as a
		// slash-separated path expression per
		// `commcare-hq/corehq/apps/case_search/xpath_functions/ancestor_functions.py::_is_ancestor_path_expression`.
		// The serializer at `termEmitter.ts::serializeAncestorPath`
		// joins the step identifiers with `/`.
		const result = emitCsql(
			eq(
				prop(
					"patient",
					"name",
					ancestorPath(relationStep("parent"), relationStep("host")),
				),
				literal("Alice"),
			),
		);
		expect(result.wrapper).toBe(
			`concat("ancestor-exists(parent/host, name = 'Alice')")`,
		);
	});
});

describe("emitCsql — property-via lift (any-relation direction expansion)", () => {
	// `any-relation` has no direct CCHQ wire form. The lift expands
	// to an OR of the two direction-specific envelopes — same shape
	// the on-device emitter's any-relation expansion produces at
	// `caseListFilterEmitter.ts::emitExistsOrMissing`.

	it("expands any-relation via on eq LHS to an OR of ancestor/subcase envelopes", () => {
		// The top-level `or` carries no defensive paren-wrap — the
		// expansion sits at the outermost predicate level so XPath
		// precedence has no parent operator to re-associate against.
		// Nested inside an `and`, the `or` would paren-wrap on its
		// own; that case is covered by the `parenthesizes or-clauses
		// inside an and` test on the logical-operator block.
		const result = emitCsql(
			eq(prop("patient", "name", anyRelationPath("rel")), literal("Alice")),
		);
		expect(result.wrapper).toBe(
			`concat("ancestor-exists(rel, name = 'Alice') or subcase-exists('rel', name = 'Alice')")`,
		);
	});
});

describe("emitCsql — property-via lift (membership + range + null/blank)", () => {
	// One representative test per operator family. The lift is
	// operator-uniform so the per-operator coverage pins each
	// arm's wire shape without repeating the direction-dispatch
	// surface already covered by the comparison-operator block.

	it("lifts via on in.left into ancestor-exists envelope", () => {
		const result = emitCsql(
			isIn(
				prop("patient", "name", ancestorPath(relationStep("parent"))),
				literal("Alice"),
				literal("Bob"),
			),
		);
		expect(result.wrapper).toBe(
			`concat("ancestor-exists(parent, (name = 'Alice' or name = 'Bob'))")`,
		);
	});

	it("lifts via on between.left preserving inclusive bounds", () => {
		const result = emitCsql(
			between(prop("patient", "age", ancestorPath(relationStep("parent"))), {
				lower: term(literal(18)),
				upper: term(literal(65)),
			}),
		);
		expect(result.wrapper).toBe(
			`concat('ancestor-exists(parent, (age >= 18 and age <= 65))')`,
		);
	});

	it("lifts via on between.lower bound flipping comparison direction", () => {
		// Authored `between(left, lower=prop(via))` reads as
		// `left >= prop(via)` for inclusive lower. Inside the
		// envelope, the `prop` is the related case's value and the
		// inner comparison reads `prop <= left` — the direction
		// flips when the bound moves to the inner LHS so the
		// authored "left bounded by lower" semantic survives.
		const result = emitCsql(
			between(prop("patient", "age"), {
				lower: term(
					prop("patient", "min_age", ancestorPath(relationStep("parent"))),
				),
			}),
		);
		expect(result.wrapper).toBe(
			`concat('ancestor-exists(parent, min_age <= age)')`,
		);
	});

	it("lifts via on between.upper bound flipping comparison direction", () => {
		// Symmetric to the lower-bound rewrite: original
		// `left <= upper(via)` becomes `upper_prop >= left` inside
		// the envelope.
		const result = emitCsql(
			between(prop("patient", "age"), {
				upper: term(
					prop("patient", "max_age", ancestorPath(relationStep("parent"))),
				),
			}),
		);
		expect(result.wrapper).toBe(
			`concat('ancestor-exists(parent, max_age >= age)')`,
		);
	});

	it("lifts via on between.lower with exclusive bound producing strict comparison", () => {
		// Exclusive lower (`lowerInclusive: false`) authored as
		// `left > prop(via)`; inner shape `prop < left`.
		const result = emitCsql(
			between(prop("patient", "age"), {
				lower: term(
					prop("patient", "min_age", ancestorPath(relationStep("parent"))),
				),
				lowerInclusive: false,
				upperInclusive: false,
			}),
		);
		expect(result.wrapper).toBe(
			`concat('ancestor-exists(parent, min_age < age)')`,
		);
	});

	it("lifts via on is-null.left into ancestor-exists envelope with absence equality", () => {
		const result = emitCsql(
			isNull(prop("patient", "name", ancestorPath(relationStep("parent")))),
		);
		expect(result.wrapper).toBe(`concat("ancestor-exists(parent, name = '')")`);
	});

	it("lifts via on is-blank.left into subcase-exists envelope", () => {
		const result = emitCsql(
			isBlank(prop("patient", "name", subcasePath("child"))),
		);
		expect(result.wrapper).toBe(`concat("subcase-exists('child', name = '')")`);
	});
});

describe("emitCsql — property-via lift (direct PropertyRef slots)", () => {
	// `match.property`, `multi-select-contains.property`, and
	// `within-distance.property` are direct PropertyRef slots — not
	// ValueExpression-wrapped. The lift handles them on the same
	// rule as the comparison operands but reads from the property
	// slot directly.

	it("lifts via on match.property into ancestor-exists envelope with the same mode", () => {
		const result = emitCsql(
			match(
				prop("patient", "name", ancestorPath(relationStep("parent"))),
				term(literal("Alice")),
				"fuzzy",
			),
		);
		expect(result.wrapper).toBe(
			`concat("ancestor-exists(parent, fuzzy-match(name, 'Alice'))")`,
		);
	});

	it("lifts via on multi-select-contains.property into subcase-exists envelope", () => {
		const result = emitCsql(
			multiSelectAll(
				prop("patient", "tags", subcasePath("child")),
				literal("a"),
				literal("b"),
			),
		);
		// Multi-value `selected-all` author intent expands to an AND
		// of per-value `selected` calls (see emitMultiSelectSegments).
		// The lift wraps the expansion in the subcase envelope.
		expect(result.wrapper).toBe(
			`concat("subcase-exists('child', (selected(tags, 'a') and selected(tags, 'b')))")`,
		);
	});

	it("lifts via on within-distance.property into ancestor-exists envelope", () => {
		const result = emitCsql(
			within(
				prop("patient", "location", ancestorPath(relationStep("parent"))),
				term(literal("40.0 -73.0")),
				5,
				"miles",
			),
		);
		expect(result.wrapper).toBe(
			`concat("ancestor-exists(parent, within-distance(location, '40.0 -73.0', 5, 'miles'))")`,
		);
	});
});

describe("emitCsql — property-via lift (recursion)", () => {
	// The lift descends into structural predicate-bearing slots —
	// logical operators, `not`, `when-input-present`, and the
	// `where` clauses of `exists` / `missing` — so vias nested
	// inside any of them surface and lift.

	it("lifts vias on a leaf operator nested inside an and clause", () => {
		const result = emitCsql(
			and(
				eq(prop("patient", "x"), literal("a")),
				eq(
					prop("patient", "y", ancestorPath(relationStep("parent"))),
					literal("b"),
				),
			),
		);
		expect(result.wrapper).toBe(
			`concat("x = 'a' and ancestor-exists(parent, y = 'b')")`,
		);
	});

	it("lifts vias on a leaf operator nested inside an or clause", () => {
		const result = emitCsql(
			or(
				eq(prop("patient", "x"), literal("a")),
				eq(prop("patient", "y", subcasePath("child")), literal("b")),
			),
		);
		expect(result.wrapper).toBe(
			`concat("x = 'a' or subcase-exists('child', y = 'b')")`,
		);
	});

	it("lifts a via nested inside an authored exists envelope's where clause", () => {
		// The authored `exists` envelope already walks one relation;
		// the inner predicate carries a further via on `prop`. The
		// lift wraps the inner via in a second envelope, producing
		// nested `subcase-exists(..., ancestor-exists(...))`.
		const result = emitCsql(
			exists(
				subcasePath("child"),
				eq(
					prop("child", "label", ancestorPath(relationStep("parent"))),
					literal("Alice"),
				),
			),
		);
		expect(result.wrapper).toBe(
			`concat("subcase-exists('child', ancestor-exists(parent, label = 'Alice'))")`,
		);
	});

	it("lifts a via inside the clause of when-input-present", () => {
		// `when-input-present` emits via the canonical
		// `if(count(<trigger>), <inner-csql>, 'match-all()')` pattern.
		// The inner CSQL emission is a full recursive
		// `concat(...)` expression carrying the lifted
		// `ancestor-exists` envelope; the whole `if(...)` flows
		// through as a single runtime segment in the outer concat.
		const result = emitCsql(
			whenInput(
				input("q"),
				eq(
					prop("patient", "name", ancestorPath(relationStep("parent"))),
					term(input("q")),
				),
			),
		);
		expect(result.wrapper).toBe(
			`concat(if(count(instance('search-input:results')/input/field[@name='q']), concat('ancestor-exists(parent, name = "', instance('search-input:results')/input/field[@name='q'], '")'), 'match-all()'))`,
		);
	});

	it("lifts vias inside a subcase-count's where clause surviving in comparison-LHS position", () => {
		// `subcase-direction count` in comparison-LHS position
		// emits as native `subcase-count(...)` per CCHQ's
		// `_is_subcase_count` recogniser nested inside
		// `commcare-hq/corehq/apps/case_search/filter_dsl.py::build_filter_from_ast`.
		// The where argument compiles through the CSQL predicate
		// emitter, so a property-via inside the where would
		// otherwise drop its relation walk — the via-lift walks
		// into the count's where to handle this case uniformly.
		const result = emitCsql(
			gt(
				count(
					subcasePath("visit"),
					eq(
						prop("visit", "category", ancestorPath(relationStep("parent"))),
						literal("primary"),
					),
				),
				literal(0),
			),
		);
		expect(result.wrapper).toBe(
			`concat("subcase-count('visit', ancestor-exists(parent, category = 'primary')) > 0")`,
		);
	});

	it("is idempotent — running the rewrite twice produces the same wire output", () => {
		// The via-lift pass is total per `csqlHoist.ts`'s contract:
		// every input AST produces a CSQL-emission-compatible output.
		// A second pass over the lifted AST produces no further
		// changes — every operator-direct via has already lifted. The
		// emission round-trips identically.
		const p = and(
			eq(
				prop("patient", "name", ancestorPath(relationStep("parent"))),
				literal("Alice"),
			),
			eq(prop("patient", "state", subcasePath("child")), literal("active")),
		);
		const first = emitCsql(p);
		const second = emitCsql(p);
		expect(first.wrapper).toBe(second.wrapper);
		// `name = 'Alice'` triggers the double-quoted CSQL wrap for
		// the inner literal; the rest emits with single-quoted CSQL.
		expect(first.wrapper).toBe(
			`concat("ancestor-exists(parent, name = 'Alice') and subcase-exists('child', state = 'active')")`,
		);
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

describe("emitCsql — non-term ValueExpression arms inline as runtime fragments", () => {
	// Every non-term ValueExpression arm absent from CSQL's value-
	// function whitelist inlines as an on-device XPath fragment
	// inside the wrapper concat, double-quote-bracketed as a CSQL
	// string value.

	it("inlines a concat expression as the runtime fragment", () => {
		const lifted = concat(term(literal("Mr ")), term(prop("patient", "name")));
		const result = emitCsql(eq(prop("patient", "display"), lifted));
		// `concat(...)` is XPath's own concat — the runtime joins
		// `'Mr '` with the case's `name` value at concat-evaluation
		// time, and the resulting string substitutes into the CSQL
		// fragment as a double-quoted value.
		expect(result.wrapper).toBe(
			`concat('display = "', concat('Mr ', name), '"')`,
		);
	});

	it("inlines a format-date expression as the runtime fragment", () => {
		// `format-date` is absent from CSQL's value-function whitelist
		// on
		// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`,
		// so the entire expression inlines as on-device XPath (where
		// `format-date` is available via JavaRosa). The formatted
		// string substitutes directly into the CSQL fragment.
		const lifted = formatDate(term(prop("patient", "dob")), "iso");
		const result = emitCsql(eq(prop("patient", "dob_text"), lifted));
		expect(result.wrapper).toBe(
			`concat('dob_text = "', format-date(dob, 'iso'), '"')`,
		);
	});
});

describe("emitCsql — date-coerce / datetime-coerce rename", () => {
	// AST kind names diverge from CCHQ's CSQL value-function names.
	// Both arms emit through the value-expression CSQL emitter (which
	// renames at output time per CCHQ's `XPATH_VALUE_FUNCTIONS`
	// registration at
	// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`).
	// They are members of the whitelist, so no inline-runtime path
	// runs for them — the function-call wire form is the CSQL.

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
	// The CSQL value-function whitelist (per
	// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`)
	// — `today`, `now`, `double`, `date-add`, `unwrap-list`,
	// `date-coerce` (wire name `date`), `datetime-coerce` (wire
	// name `datetime`) — emits through the value-expression emitter
	// at `lib/commcare/expression/csqlEmitter.ts`. The predicate
	// emitter composes the resulting segment list with comparison
	// operators, CSQL string-quote brackets, and concat-wrap
	// arguments without special-case dispatch per arm. No inline-
	// runtime path runs for these arms — the CSQL function-call
	// wire form is what the server parses natively.

	it("emits today() in a comparison operand as native CSQL", () => {
		const result = emitCsql(eq(prop("patient", "dob"), today()));
		// No `'` in the constant → wrap in single-quoted XPath string.
		expect(result.wrapper).toBe(`concat('dob = today()')`);
	});

	it("emits now() in a comparison operand as native CSQL", () => {
		const result = emitCsql(eq(prop("patient", "modified_on"), now()));
		expect(result.wrapper).toBe(`concat('modified_on = now()')`);
	});

	it("emits double(literal) in a comparison operand as native CSQL", () => {
		const result = emitCsql(
			eq(prop("p", "weight_g"), double(term(literal(1500)))),
		);
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
		expect(result.wrapper).toBe(
			`concat('due_date = date-add(', instance('search-input:results')/input/field[@name='base_date'], ", 'days', 7)")`,
		);
	});

	it("emits unwrap-list in a multi-select-contains shape via the predicate emitter", () => {
		// `unwrap-list` emits through the value-expression emitter;
		// the predicate emitter composes the segments with the
		// comparison's surrounding constants.
		const result = emitCsql(
			eq(prop("p", "tags"), unwrapList(term(prop("p", "tags_json")))),
		);
		expect(result.wrapper).toBe(`concat('tags = unwrap-list(tags_json)')`);
	});
});
