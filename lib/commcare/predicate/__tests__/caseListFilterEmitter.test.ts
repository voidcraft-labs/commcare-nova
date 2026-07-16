// lib/commcare/predicate/__tests__/caseListFilterEmitter.test.ts
//
// Acceptance tests for the on-device case-list-filter emitter — the
// dialect that produces XPath strings usable in both the case-list
// `<detail nodeset>` slot and the post-ES `<search_filter>` slot
// (both run on the same on-device XPath evaluator).
//
// Each test pins the exact wire string the emitter produces against
// CCHQ HQ's query-function grammar. CCHQ wire-syntax citations live
// in the source file alongside each operator arm.
//
// Coverage organizes around four shells: (1) shared-operator
// emissions (comparison, logical, term, string-literal escape, in,
// is-blank, when-input-present); (2) operators with on-device
// emissions specific to this visitor (sentinels, between,
// multi-select expansions, every match mode, within-distance,
// is-null collapsing to is-blank's wire form, exists / missing
// across all four relation kinds, the inline relational read on a
// `prop` term); (3) defensive throws for the structural-bypass
// shape `between` with both bounds absent; (4) ValueExpression
// operand integration — happy-path term arms plus the predicate ↔
// value-expression emitter handoff for non-term arms (`arith`, `if`,
// `today`, `now`).

import { describe, expect, it } from "vitest";
import {
	ancestorPath,
	and,
	anyRelationPath,
	arith,
	between,
	dateCoerce,
	datetimeCoerce,
	eq,
	exists,
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
	whenInput,
	within,
} from "@/lib/domain/predicate/builders";
import { emitCaseListFilter } from "../caseListFilterEmitter";

// ============================================================
// SHELL 1 — Shared-operator emissions
// ============================================================

describe("emitCaseListFilter — comparison operators", () => {
	it("emits eq with a string literal", () => {
		const p = eq(prop("patient", "full_name"), literal("Alice"));
		expect(emitCaseListFilter(p)).toBe("full_name = 'Alice'");
	});

	it("emits eq with a numeric literal", () => {
		const p = eq(prop("patient", "age"), literal(42));
		expect(emitCaseListFilter(p)).toBe("age = 42");
	});

	it("emits eq with a decimal literal preserving the fractional part", () => {
		const p = eq(prop("patient", "weight_kg"), literal(3.14));
		expect(emitCaseListFilter(p)).toBe("weight_kg = 3.14");
	});

	it("emits very small decimal literals without scientific notation", () => {
		const p = eq(prop("patient", "ratio"), literal(0.0000001));
		expect(emitCaseListFilter(p)).toBe("ratio = 0.0000001");
	});

	it("emits very large numeric literals without scientific notation", () => {
		const p = eq(prop("patient", "big"), literal(1.5e21));
		expect(emitCaseListFilter(p)).toBe("big = 1500000000000000000000");
	});

	it("emits negative numeric literals with the leading minus sign", () => {
		expect(emitCaseListFilter(eq(prop("p", "delta"), literal(-3.14)))).toBe(
			"delta = -3.14",
		);
		expect(emitCaseListFilter(eq(prop("p", "tiny"), literal(-1e-10)))).toBe(
			"tiny = -0.0000000001",
		);
	});

	it("emits neq", () => {
		const p = neq(prop("patient", "full_name"), literal("Bob"));
		expect(emitCaseListFilter(p)).toBe("full_name != 'Bob'");
	});

	it("emits gt / gte / lt / lte", () => {
		expect(emitCaseListFilter(gt(prop("p", "age"), literal(18)))).toBe(
			"age > 18",
		);
		expect(emitCaseListFilter(gte(prop("p", "age"), literal(18)))).toBe(
			"age >= 18",
		);
		expect(emitCaseListFilter(lt(prop("p", "age"), literal(18)))).toBe(
			"age < 18",
		);
		expect(emitCaseListFilter(lte(prop("p", "age"), literal(18)))).toBe(
			"age <= 18",
		);
	});

	it("emits boolean literals as quoted 'true' / 'false' strings", () => {
		expect(emitCaseListFilter(eq(prop("p", "is_active"), literal(true)))).toBe(
			"is_active = 'true'",
		);
		expect(emitCaseListFilter(eq(prop("p", "is_active"), literal(false)))).toBe(
			"is_active = 'false'",
		);
	});

	it("emits null literals as the empty string", () => {
		const p = eq(prop("patient", "full_name"), literal(null));
		expect(emitCaseListFilter(p)).toBe("full_name = ''");
	});
});

describe("emitCaseListFilter — term emission", () => {
	it("emits session-user refs against /session/user/data/<field>", () => {
		const p = eq(
			prop("patient", "region"),
			sessionUser("commcare_location_id"),
		);
		expect(emitCaseListFilter(p)).toBe(
			"region = instance('commcaresession')/session/user/data/commcare_location_id",
		);
	});

	it("emits session-context refs against /session/context/<field>", () => {
		const p = eq(prop("patient", "full_name"), sessionContext("username"));
		expect(emitCaseListFilter(p)).toBe(
			"full_name = instance('commcaresession')/session/context/username",
		);
	});

	it("emits search-input refs against the search-input results instance", () => {
		const p = eq(prop("patient", "full_name"), input("name_query"));
		expect(emitCaseListFilter(p)).toBe(
			"full_name = instance('search-input:results')/input/field[@name='name_query']",
		);
	});
});

describe("emitCaseListFilter — reserved case attributes", () => {
	it.each([
		"case_id",
		"case_type",
		"owner_id",
		"status",
	] as const)("prefixes '%s' with @", (attr) => {
		const p = eq(prop("patient", attr), literal("X"));
		expect(emitCaseListFilter(p)).toBe(`@${attr} = 'X'`);
	});

	it("leaves user-defined properties bare", () => {
		const p = eq(prop("patient", "full_name"), literal("Alice"));
		expect(emitCaseListFilter(p)).toBe("full_name = 'Alice'");
	});
});

describe("emitCaseListFilter — logical operators", () => {
	it("emits and(...) joining clauses with ' and '", () => {
		const p = and(
			eq(prop("patient", "full_name"), literal("Alice")),
			gt(prop("patient", "age"), literal(18)),
		);
		expect(emitCaseListFilter(p)).toBe("full_name = 'Alice' and age > 18");
	});

	it("emits or(...) joining clauses with ' or '", () => {
		const p = or(
			eq(prop("patient", "full_name"), literal("Alice")),
			eq(prop("patient", "full_name"), literal("Bob")),
		);
		expect(emitCaseListFilter(p)).toBe(
			"full_name = 'Alice' or full_name = 'Bob'",
		);
	});

	it("parenthesizes or-clauses inside an and (precedence)", () => {
		// XPath's `and` binds tighter than `or`; without grouping,
		// `(A or B) and C` would silently re-associate to `A or (B and
		// C)`. The visitor's parent-precedence threading is the lock.
		const p = and(
			or(
				eq(prop("patient", "full_name"), literal("Alice")),
				eq(prop("patient", "full_name"), literal("Bob")),
			),
			gt(prop("patient", "age"), literal(18)),
		);
		expect(emitCaseListFilter(p)).toBe(
			"(full_name = 'Alice' or full_name = 'Bob') and age > 18",
		);
	});

	it("emits not(...) wrapping its inner with not(...)", () => {
		const p = not(eq(prop("patient", "full_name"), literal("Bob")));
		expect(emitCaseListFilter(p)).toBe("not(full_name = 'Bob')");
	});
});

describe("emitCaseListFilter — string-literal escape", () => {
	it("emits a quote-free string in single quotes", () => {
		const p = eq(prop("patient", "full_name"), literal("Alice"));
		expect(emitCaseListFilter(p)).toBe("full_name = 'Alice'");
	});

	it("emits embedded single quote with concat()", () => {
		// XPath 1.0's `concat()` is the portable embedded-quote escape:
		// alternating single-quoted and double-quoted segments produce a
		// well-formed string literal with the original quote preserved.
		const p = eq(prop("patient", "full_name"), literal("O'Brien"));
		expect(emitCaseListFilter(p)).toBe(`full_name = concat('O', "'", 'Brien')`);
	});

	it("emits a quote-only string with concat() boundary segments", () => {
		const p = eq(prop("patient", "full_name"), literal("'"));
		expect(emitCaseListFilter(p)).toBe(`full_name = concat('', "'", '')`);
	});

	it("emits embedded double quote with single-quoted wrap", () => {
		const p = eq(prop("patient", "full_name"), literal('say "hello"'));
		expect(emitCaseListFilter(p)).toBe(`full_name = 'say "hello"'`);
	});

	it("emits both-quote-styles via concat()", () => {
		const p = eq(prop("patient", "full_name"), literal(`it's "quoted"`));
		expect(emitCaseListFilter(p)).toBe(
			`full_name = concat('it', "'", 's "quoted"')`,
		);
	});
});

describe("emitCaseListFilter — in (set membership)", () => {
	it("emits single-value in as a plain equality (reserved attribute)", () => {
		const p = isIn(prop("patient", "status"), literal("open"));
		expect(emitCaseListFilter(p)).toBe("@status = 'open'");
	});

	it("emits single-value in as a plain equality (user-defined)", () => {
		const p = isIn(prop("patient", "category"), literal("open"));
		expect(emitCaseListFilter(p)).toBe("category = 'open'");
	});

	it("emits multi-value in as a parenthesized or-of-equalities", () => {
		const p = isIn(prop("patient", "tags"), literal("open"), literal("active"));
		expect(emitCaseListFilter(p)).toBe("(tags = 'open' or tags = 'active')");
	});

	it("emits multi-value in with a quote-bearing value via per-value concat()", () => {
		const p = isIn(
			prop("patient", "tags"),
			literal("O'Brien"),
			literal("active"),
		);
		expect(emitCaseListFilter(p)).toBe(
			`(tags = concat('O', "'", 'Brien') or tags = 'active')`,
		);
	});

	it("emits multi-value in preserving whitespace inside values", () => {
		// Or-of-equalities preserves each value as a single equality
		// RHS, so spaces inside a value are wire-side opaque.
		const p = isIn(
			prop("patient", "full_name"),
			literal("Alice Smith"),
			literal("Bob Jones"),
		);
		expect(emitCaseListFilter(p)).toBe(
			"(full_name = 'Alice Smith' or full_name = 'Bob Jones')",
		);
	});

	it("emits multi-value in with mixed null + string values", () => {
		const p = isIn(
			prop("patient", "full_name"),
			literal(null),
			literal("Alice"),
		);
		expect(emitCaseListFilter(p)).toBe(
			"(full_name = '' or full_name = 'Alice')",
		);
	});

	it("emits multi-value in with numeric literals as bare XPath numbers", () => {
		const p = isIn(prop("patient", "age"), literal(18), literal(21));
		expect(emitCaseListFilter(p)).toBe("(age = 18 or age = 21)");
	});
});

describe("emitCaseListFilter — when-input-present", () => {
	it("wraps the inner clause in if(count(input), then, true())", () => {
		// `true()` (not `''`) is the AND-chain identity; XPath's
		// boolean coercion of `''` is `false`, which would silently
		// exclude every case on input-unset.
		const p = whenInput(
			input("name_query"),
			eq(prop("patient", "full_name"), input("name_query")),
		);
		expect(emitCaseListFilter(p)).toBe(
			"if(count(instance('search-input:results')/input/field[@name='name_query']), full_name = instance('search-input:results')/input/field[@name='name_query'], true())",
		);
	});

	it("recurses into a logical-conjunction inner clause without redundant grouping", () => {
		const p = whenInput(
			input("region"),
			and(
				eq(prop("patient", "region"), input("region")),
				gt(prop("patient", "age"), literal(18)),
			),
		);
		expect(emitCaseListFilter(p)).toBe(
			"if(count(instance('search-input:results')/input/field[@name='region']), region = instance('search-input:results')/input/field[@name='region'] and age > 18, true())",
		);
	});
});

describe("emitCaseListFilter — is-blank", () => {
	it("emits is-blank against a property reference as prop = ''", () => {
		const p = isBlank(prop("patient", "full_name"));
		expect(emitCaseListFilter(p)).toBe("full_name = ''");
	});

	it("emits is-blank against a search-input reference as input = ''", () => {
		const p = isBlank(input("name_query"));
		expect(emitCaseListFilter(p)).toBe(
			"instance('search-input:results')/input/field[@name='name_query'] = ''",
		);
	});

	it("emits is-blank against a session-context reference as path = ''", () => {
		const p = isBlank(sessionContext("userid"));
		expect(emitCaseListFilter(p)).toBe(
			"instance('commcaresession')/session/context/userid = ''",
		);
	});

	it("emits is-blank against a session-user reference as path = ''", () => {
		const p = isBlank(sessionUser("region"));
		expect(emitCaseListFilter(p)).toBe(
			"instance('commcaresession')/session/user/data/region = ''",
		);
	});
});

// ============================================================
// SHELL 2 — Operator-specific emissions
// ============================================================

describe("emitCaseListFilter — sentinels", () => {
	it("emits match-all as true()", () => {
		expect(emitCaseListFilter(matchAll())).toBe("true()");
	});

	it("emits match-none as false()", () => {
		expect(emitCaseListFilter(matchNone())).toBe("false()");
	});
});

describe("emitCaseListFilter — between", () => {
	it("expands closed [lo, hi] interval to (gte and lte)", () => {
		const p = between(prop("patient", "age"), {
			lower: literal(18),
			upper: literal(65),
		});
		expect(emitCaseListFilter(p)).toBe("(age >= 18 and age <= 65)");
	});

	it("uses gt / lt for exclusive bounds", () => {
		const p = between(prop("patient", "age"), {
			lower: literal(18),
			upper: literal(65),
			lowerInclusive: false,
			upperInclusive: false,
		});
		expect(emitCaseListFilter(p)).toBe("(age > 18 and age < 65)");
	});

	it("emits half-open [lo, hi) with lower inclusive and upper exclusive", () => {
		const p = between(prop("patient", "age"), {
			lower: literal(18),
			upper: literal(65),
			lowerInclusive: true,
			upperInclusive: false,
		});
		expect(emitCaseListFilter(p)).toBe("(age >= 18 and age < 65)");
	});

	it("emits lower-only as a single inclusive comparison", () => {
		const p = between(prop("patient", "age"), { lower: literal(18) });
		expect(emitCaseListFilter(p)).toBe("age >= 18");
	});

	it("emits lower-only exclusive as a single gt comparison", () => {
		const p = between(prop("patient", "age"), {
			lower: literal(18),
			lowerInclusive: false,
		});
		expect(emitCaseListFilter(p)).toBe("age > 18");
	});

	it("emits upper-only as a single inclusive comparison", () => {
		const p = between(prop("patient", "age"), { upper: literal(65) });
		expect(emitCaseListFilter(p)).toBe("age <= 65");
	});

	it("emits upper-only exclusive as a single lt comparison", () => {
		const p = between(prop("patient", "age"), {
			upper: literal(65),
			upperInclusive: false,
		});
		expect(emitCaseListFilter(p)).toBe("age < 65");
	});
});

describe("emitCaseListFilter — multi-select-contains", () => {
	it("emits any-quantifier single-value as selected(prop, 'v')", () => {
		const p = multiSelectAny(prop("patient", "tags"), literal("vip"));
		expect(emitCaseListFilter(p)).toBe("selected(tags, 'vip')");
	});

	it("emits any-quantifier multi-value as OR of selected() calls", () => {
		const p = multiSelectAny(
			prop("patient", "tags"),
			literal("vip"),
			literal("frequent"),
		);
		expect(emitCaseListFilter(p)).toBe(
			"(selected(tags, 'vip') or selected(tags, 'frequent'))",
		);
	});

	it("emits all-quantifier single-value as a single selected() call", () => {
		const p = multiSelectAll(prop("patient", "tags"), literal("vip"));
		expect(emitCaseListFilter(p)).toBe("selected(tags, 'vip')");
	});

	it("emits all-quantifier multi-value as AND of selected() calls", () => {
		const p = multiSelectAll(
			prop("patient", "tags"),
			literal("vip"),
			literal("frequent"),
		);
		expect(emitCaseListFilter(p)).toBe(
			"(selected(tags, 'vip') and selected(tags, 'frequent'))",
		);
	});

	it("routes per-value through quoteLiteral for embedded quote escape", () => {
		const p = multiSelectAny(
			prop("patient", "tags"),
			literal("O'Brien"),
			literal("vip"),
		);
		expect(emitCaseListFilter(p)).toBe(
			`(selected(tags, concat('O', "'", 'Brien')) or selected(tags, 'vip'))`,
		);
	});

	it("prefixes reserved attributes inside selected()", () => {
		const p = multiSelectAny(prop("patient", "status"), literal("vip"));
		expect(emitCaseListFilter(p)).toBe("selected(@status, 'vip')");
	});
});

describe("emitCaseListFilter — match", () => {
	it("emits mode=starts-with as starts-with(prop, 'v')", () => {
		const p = match(prop("patient", "full_name"), "Ali", "starts-with");
		expect(emitCaseListFilter(p)).toBe("starts-with(full_name, 'Ali')");
	});

	it("emits mode=fuzzy as fuzzy-match(prop, 'v')", () => {
		const p = match(prop("patient", "full_name"), "alice", "fuzzy");
		expect(emitCaseListFilter(p)).toBe("fuzzy-match(full_name, 'alice')");
	});

	it("emits mode=phonetic as phonetic-match(prop, 'v')", () => {
		const p = match(prop("patient", "full_name"), "alice", "phonetic");
		expect(emitCaseListFilter(p)).toBe("phonetic-match(full_name, 'alice')");
	});

	it("emits mode=fuzzy-date as fuzzy-date(prop, 'v')", () => {
		const p = match(prop("patient", "dob"), "2020-01-01", "fuzzy-date");
		expect(emitCaseListFilter(p)).toBe("fuzzy-date(dob, '2020-01-01')");
	});

	it("routes the match value through quoteLiteral for embedded quote escape", () => {
		const p = match(prop("patient", "full_name"), "O'Brien", "starts-with");
		expect(emitCaseListFilter(p)).toBe(
			`starts-with(full_name, concat('O', "'", 'Brien'))`,
		);
	});
});

describe("emitCaseListFilter — within-distance", () => {
	it("emits within-distance with a literal center and miles", () => {
		// Wire signature: `within-distance(prop, '<lat,lon>', <distance>,
		// '<unit>')` per `corehq/apps/case_search/xpath_functions/query_functions.py::within_distance`.
		// Arg 2 is the coord string; arg 3 is a bare numeric literal;
		// arg 4 is the schema-validated unit enum.
		const p = within(
			prop("clinic", "location"),
			literal("40.7,-74.0"),
			50,
			"miles",
		);
		expect(emitCaseListFilter(p)).toBe(
			"within-distance(location, '40.7,-74.0', 50, 'miles')",
		);
	});

	it("emits within-distance with an input center and kilometers", () => {
		const p = within(
			prop("clinic", "location"),
			input("user_loc"),
			25,
			"kilometers",
		);
		expect(emitCaseListFilter(p)).toBe(
			"within-distance(location, instance('search-input:results')/input/field[@name='user_loc'], 25, 'kilometers')",
		);
	});

	it("emits within-distance distances without scientific notation", () => {
		const p = within(
			prop("clinic", "location"),
			literal("40.7,-74.0"),
			0.0000001,
			"miles",
		);
		expect(emitCaseListFilter(p)).toBe(
			"within-distance(location, '40.7,-74.0', 0.0000001, 'miles')",
		);
	});

	it("emits within-distance with distance 0 as a bare zero literal", () => {
		const p = within(
			prop("clinic", "location"),
			literal("40.7,-74.0"),
			0,
			"miles",
		);
		expect(emitCaseListFilter(p)).toBe(
			"within-distance(location, '40.7,-74.0', 0, 'miles')",
		);
	});
});

describe("emitCaseListFilter — is-null", () => {
	// CCHQ wire collapses absent / cleared / empty alike on every
	// dialect — `prop = ''` is the closest CCHQ form for a strict-
	// absent semantic. The AST distinction (`is-null` vs `is-blank`)
	// is preserved on the Postgres runtime; both collapse to the same
	// CCHQ wire string.

	it("emits is-null against a property reference as prop = ''", () => {
		const p = isNull(prop("patient", "full_name"));
		expect(emitCaseListFilter(p)).toBe("full_name = ''");
	});

	it("emits is-null identically to is-blank for the same operand", () => {
		const left = prop("patient", "full_name");
		expect(emitCaseListFilter(isNull(left))).toBe(
			emitCaseListFilter(isBlank(left)),
		);
	});

	it("emits is-null against a search-input reference as input = ''", () => {
		const p = isNull(input("name_query"));
		expect(emitCaseListFilter(p)).toBe(
			"instance('search-input:results')/input/field[@name='name_query'] = ''",
		);
	});
});

describe("emitCaseListFilter — prop term with non-self via (inline relational read)", () => {
	// The bare `prop` term carries an optional `via` walk that emits
	// as an inline relational path expression. Existence checks
	// remain `exists(via, where: ...)`; this pinning covers the
	// VALUE-read shape.

	it("emits an ancestor walk as an inline relational path", () => {
		const p = eq(
			prop("patient", "region", ancestorPath(relationStep("parent"))),
			literal("south"),
		);
		expect(emitCaseListFilter(p)).toBe(
			"instance('casedb')/casedb/case[@case_id=current()/index/parent]/region = 'south'",
		);
	});

	it("composes multi-hop ancestor walks with nested @case_id joins", () => {
		const p = eq(
			prop(
				"patient",
				"region",
				ancestorPath(relationStep("parent"), relationStep("host")),
			),
			literal("south"),
		);
		expect(emitCaseListFilter(p)).toBe(
			"instance('casedb')/casedb/case[@case_id=instance('casedb')/casedb/case[@case_id=current()/index/parent]/index/host]/region = 'south'",
		);
	});

	it("emits a subcase walk as a reverse-direction join", () => {
		const p = eq(
			prop("parent", "case_status", subcasePath("parent")),
			literal("open"),
		);
		expect(emitCaseListFilter(p)).toBe(
			"instance('casedb')/casedb/case[index/parent=current()/@case_id]/case_status = 'open'",
		);
	});

	it("prefixes reserved attributes when reached via a relation walk", () => {
		// Reserved attributes (`status`, etc.) keep their `@` prefix
		// even when emitted at the tail of a relational path.
		const p = eq(
			prop("patient", "status", ancestorPath(relationStep("parent"))),
			literal("open"),
		);
		expect(emitCaseListFilter(p)).toBe(
			"instance('casedb')/casedb/case[@case_id=current()/index/parent]/@status = 'open'",
		);
	});

	it("emits an any-relation walk as a node-set union of both directions", () => {
		// XPath's `|` is the node-set union operator; the result is
		// one node-set containing every node from either direction.
		// `(set) = 'south'` then returns true when any member of the
		// set equals the RHS — XPath's existential equality semantics
		// over a node-set. Boolean `or` would coerce each path to a
		// boolean (non-empty → true) before string comparison and
		// always be false; the union form is the only correct shape.
		const p = eq(
			prop("any", "region", anyRelationPath("parent")),
			literal("south"),
		);
		expect(emitCaseListFilter(p)).toBe(
			"(instance('casedb')/casedb/case[@case_id=current()/index/parent]/region | instance('casedb')/casedb/case[index/parent=current()/@case_id]/region) = 'south'",
		);
	});
});

describe("emitCaseListFilter — exists / missing (relational quantifiers)", () => {
	// Ancestor walks anchor on `current()/index/<rel>` per the CCHQ
	// hashtag-replacement pattern at
	// `corehq/apps/app_manager/xpath.py::interpolate_xpath` (`#parent` /
	// `#host` build
	// `instance('casedb')/casedb/case[@case_id=<base>/index/<rel>]`).
	// Subcase walks reverse direction per the canonical example at
	// `corehq/apps/app_manager/suite_xml/sections/entries.py::_update_refs`
	// (`[index/parent = <case-id>]` on a subcase nodeset).

	it("emits ancestor exists as count(.../case[@case_id=current()/index/<rel>][filter]) > 0", () => {
		const p = exists(
			ancestorPath(relationStep("parent")),
			eq(prop("household", "region"), literal("south")),
		);
		expect(emitCaseListFilter(p)).toBe(
			"count(instance('casedb')/casedb/case[@case_id=current()/index/parent][region = 'south']) > 0",
		);
	});

	it("emits ancestor exists with no filter as a presence test only", () => {
		const p = exists(ancestorPath(relationStep("parent")));
		expect(emitCaseListFilter(p)).toBe(
			"count(instance('casedb')/casedb/case[@case_id=current()/index/parent]) > 0",
		);
	});

	it("emits multi-hop ancestor exists with nested @case_id joins (host of parent)", () => {
		const p = exists(
			ancestorPath(relationStep("parent"), relationStep("host")),
			eq(prop("household", "region"), literal("south")),
		);
		expect(emitCaseListFilter(p)).toBe(
			"count(instance('casedb')/casedb/case[@case_id=instance('casedb')/casedb/case[@case_id=current()/index/parent]/index/host][region = 'south']) > 0",
		);
	});

	it("emits subcase exists as a reverse-direction join on index/<rel>", () => {
		const p = exists(
			subcasePath("parent"),
			eq(prop("child", "case_status"), literal("open")),
		);
		expect(emitCaseListFilter(p)).toBe(
			"count(instance('casedb')/casedb/case[index/parent=current()/@case_id][case_status = 'open']) > 0",
		);
	});

	it("emits missing as the count-equals-zero form", () => {
		const p = missing(
			ancestorPath(relationStep("parent")),
			eq(prop("household", "region"), literal("south")),
		);
		expect(emitCaseListFilter(p)).toBe(
			"count(instance('casedb')/casedb/case[@case_id=current()/index/parent][region = 'south']) = 0",
		);
	});

	it("emits missing with no filter as the no-related-case form", () => {
		const p = missing(ancestorPath(relationStep("parent")));
		expect(emitCaseListFilter(p)).toBe(
			"count(instance('casedb')/casedb/case[@case_id=current()/index/parent]) = 0",
		);
	});

	it("nests filter recursively (and-of-comparisons inside the filter)", () => {
		const p = exists(
			ancestorPath(relationStep("parent")),
			and(
				eq(prop("household", "region"), literal("south")),
				gt(prop("household", "size"), literal(3)),
			),
		);
		expect(emitCaseListFilter(p)).toBe(
			"count(instance('casedb')/casedb/case[@case_id=current()/index/parent][region = 'south' and size > 3]) > 0",
		);
	});

	it("emits missing with a `> 0` substring inside the filter without comparator collision", () => {
		// Regression pin: a naive `String.replace('> 0', '= 0')` on
		// the count-comparison wire form would corrupt the FIRST
		// occurrence in the string — and an inner filter clause like
		// `gt(prop, literal(0))` produces a `> 0` substring inside
		// the bracketed predicate. The trailing comparator MUST be
		// the one flipped from `> 0` to `= 0` for the `missing` form;
		// the inner filter is opaque to the count-comparator choice.
		const p = missing(
			ancestorPath(relationStep("parent")),
			gt(prop("household", "size"), literal(0)),
		);
		expect(emitCaseListFilter(p)).toBe(
			"count(instance('casedb')/casedb/case[@case_id=current()/index/parent][size > 0]) = 0",
		);
	});

	// ----------------------------------------------------------
	// `self` collapses to a no-op
	// ----------------------------------------------------------

	it("emits exists(self, filter) as the filter alone", () => {
		// An existence check with no traversal is just the filter
		// running against the current case.
		const p = exists(
			selfPath(),
			eq(prop("patient", "full_name"), literal("Alice")),
		);
		expect(emitCaseListFilter(p)).toBe("full_name = 'Alice'");
	});

	it("emits exists(self) with no filter as true()", () => {
		// A case always exists in the row being filtered; the
		// presence check is trivially true.
		const p = exists(selfPath());
		expect(emitCaseListFilter(p)).toBe("true()");
	});

	it("emits missing(self) with no filter as false()", () => {
		// The same case always exists; absence is trivially false.
		const p = missing(selfPath());
		expect(emitCaseListFilter(p)).toBe("false()");
	});

	it("emits missing(self, filter) as not(filter)", () => {
		// "No self-case satisfies <filter>" reduces to the negation
		// of <filter> evaluated on the current case.
		const p = missing(
			selfPath(),
			eq(prop("patient", "full_name"), literal("Alice")),
		);
		expect(emitCaseListFilter(p)).toBe("not(full_name = 'Alice')");
	});

	// ----------------------------------------------------------
	// `any-relation` expands to ancestor OR subcase
	// ----------------------------------------------------------

	it("emits exists(any-relation, filter) as (ancestor-form or subcase-form)", () => {
		// Direction-agnostic walk: emit both the ancestor-direction
		// nested-join expansion and the subcase-direction expansion,
		// OR'd, so the predicate matches a related case in either
		// direction.
		const p = exists(
			anyRelationPath("parent"),
			eq(prop("related", "case_status"), literal("open")),
		);
		expect(emitCaseListFilter(p)).toBe(
			"(count(instance('casedb')/casedb/case[@case_id=current()/index/parent][case_status = 'open']) > 0 or count(instance('casedb')/casedb/case[index/parent=current()/@case_id][case_status = 'open']) > 0)",
		);
	});

	it("emits exists(any-relation) with no filter as the OR of both presence tests", () => {
		const p = exists(anyRelationPath("parent"));
		expect(emitCaseListFilter(p)).toBe(
			"(count(instance('casedb')/casedb/case[@case_id=current()/index/parent]) > 0 or count(instance('casedb')/casedb/case[index/parent=current()/@case_id]) > 0)",
		);
	});

	it("emits missing(any-relation, filter) as not((ancestor-form or subcase-form))", () => {
		// "No related case in either direction satisfies <filter>"
		// is the negation of the existential disjunction.
		const p = missing(
			anyRelationPath("parent"),
			eq(prop("related", "case_status"), literal("open")),
		);
		expect(emitCaseListFilter(p)).toBe(
			"not((count(instance('casedb')/casedb/case[@case_id=current()/index/parent][case_status = 'open']) > 0 or count(instance('casedb')/casedb/case[index/parent=current()/@case_id][case_status = 'open']) > 0))",
		);
	});

	it("emits missing(any-relation) with no filter as not((presence-or-presence))", () => {
		const p = missing(anyRelationPath("parent"));
		expect(emitCaseListFilter(p)).toBe(
			"not((count(instance('casedb')/casedb/case[@case_id=current()/index/parent]) > 0 or count(instance('casedb')/casedb/case[index/parent=current()/@case_id]) > 0))",
		);
	});
});

// ============================================================
// SHELL 3 — Defensive throws
// ============================================================
//
// The structural-bypass cases that round-trip through the AST
// shape but cannot produce a meaningful wire string. The schema
// rejects these at parse time; the throws here defend the bypass
// path for any consumer that constructs the AST shape outside the
// builder + schema pipeline.

describe("emitCaseListFilter — defensive throws on structural-bypass shapes", () => {
	// `between` with both bounds absent is structurally typeable but
	// schema-rejected (`betweenSchema.refine(...)`). Defending the
	// bypass path here keeps the emitter from producing an empty
	// wire string on a shape the schema is meant to filter out.
	//
	// The test exercises the bypass via direct AST construction
	// rather than the `between(...)` builder, since the builder
	// emits a shape the schema would reject — the bypass path is
	// what's being defended.
	it("throws on between with both bounds absent", () => {
		const bypassed = {
			kind: "between" as const,
			left: { kind: "term" as const, term: prop("patient", "age") },
			lowerInclusive: true,
			upperInclusive: true,
		};
		expect(() => emitCaseListFilter(bypassed)).toThrow(/between/i);
	});
});

// ============================================================
// SHELL 4 — ValueExpression operand integration
// ============================================================
//
// Predicate operators carry `ValueExpression` operands. The on-device
// emitter delegates non-term arms to the on-device value-expression
// emitter at `lib/commcare/expression/onDeviceEmitter.ts`. This shell
// pins the happy-path delegations across the operand-bearing
// predicate sites so a regression in either emitter surfaces against
// these acceptance tests rather than in a downstream consumer.

describe("emitCaseListFilter — term-arm operand (happy path)", () => {
	it("emits a property reference in a comparison's left operand", () => {
		const p = eq(prop("patient", "full_name"), literal("Alice"));
		expect(emitCaseListFilter(p)).toMatch(/^full_name = /);
	});

	it("emits a search-input reference in a comparison's right operand", () => {
		const p = eq(prop("patient", "phone"), input("phone_query"));
		expect(emitCaseListFilter(p)).toMatch(/instance\('search-input:results'\)/);
	});
});

describe("emitCaseListFilter — non-term ValueExpression operands delegate to expression emitter", () => {
	it("emits an arith expression in a comparison's left operand", () => {
		const p = eq(
			arith("+", term(prop("patient", "age")), term(literal(1))),
			literal(19),
		);
		expect(emitCaseListFilter(p)).toBe("(age + 1) = 19");
	});

	it("emits an if-expression in is-blank's left", () => {
		const p = isBlank(
			ifExpr(matchAll(), term(literal("a")), term(literal("b"))),
		);
		expect(emitCaseListFilter(p)).toBe(`if(true(), 'a', 'b') = ''`);
	});

	it("emits a today() constant in is-blank's left", () => {
		const p = isBlank(today());
		expect(emitCaseListFilter(p)).toBe(`today() = ''`);
	});

	it("emits a now() constant in within-distance's center", () => {
		// `within-distance.center` is a `ValueExpression` slot; the
		// expression emitter handles every arm of the union, so a
		// `now()` constant flows through cleanly.
		const p = within(prop("clinic", "location"), now(), 50, "miles");
		expect(emitCaseListFilter(p)).toBe(
			`within-distance(location, now(), 50, 'miles')`,
		);
	});

	it("emits BOTH coercions as date(...) — the filter slot's evaluator has no datetime()", () => {
		// The case-list filter is evaluated by the on-device XPath
		// engine (`commcare-core` — the web-apps evaluator), whose
		// function grammar dispatches `date` but not `datetime`
		// (`org.javarosa.xpath.parser.ast.ASTNodeFunctionCall`). A
		// `datetime(...)` call in this slot fails the whole case list
		// as an unknown function, so the datetime coercion lowers to
		// `date(...)` — whose String arm preserves time-of-day, and
		// comparisons coerce dates to whole days either way
		// (`XPathCmpExpr` → `FunctionUtils::toNumeric`).
		const p = and(
			gt(dateCoerce(term(prop("patient", "order_date"))), today()),
			lt(datetimeCoerce(term(prop("patient", "last_visit"))), now()),
		);
		expect(emitCaseListFilter(p)).toBe(
			"date(order_date) > today() and date(last_visit) < now()",
		);
	});
});
