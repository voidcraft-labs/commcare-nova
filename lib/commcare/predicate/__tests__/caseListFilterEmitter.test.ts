// lib/commcare/predicate/__tests__/caseListFilterEmitter.test.ts
//
// Acceptance tests for the on-device case-list-filter emitter — the
// dialect that drops directly into a casedb XPath nodeset
// (`instance('casedb')/casedb/case[<this>]`). Every wire string the
// visitor produces is pinned here against CommCare's accepted forms;
// the citations on the emission rules live in the source file.
//
// Coverage organizes around three shells: (1) shared-operator
// backward-compat — every operator that already had a pinned shape in
// the transitional emitter for case-list-filter context produces an
// identical wire string here; (2) the new operators the visitor adds
// over the transitional emitter (sentinels, `between`, multi-select
// quantifier expansions, `match` per-mode dispatch, `exists` /
// `missing` join expansions); (3) defensive throws — the operators
// the on-device dialect cannot represent surface as throws even when
// B5's representability checker is bypassed.

import { describe, expect, it } from "vitest";
import {
	ancestorPath,
	and,
	anyRelationPath,
	arith,
	between,
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
// SHELL 1 — Backward-compatible shared operators
// ============================================================
//
// Every shape pinned by `xpathEmitter.test.ts` for the
// `case-list-filter` context is mirrored here under the new
// visitor. A regression on this shell would mean the visitor
// diverged from the wire forms the transitional emitter pinned
// against CCHQ source — i.e. a CCHQ-side breakage.

describe("emitCaseListFilter — comparison operators", () => {
	it("emits eq with a string literal", () => {
		const p = eq(prop("patient", "name"), literal("Alice"));
		expect(emitCaseListFilter(p)).toBe("name = 'Alice'");
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
		const p = neq(prop("patient", "name"), literal("Bob"));
		expect(emitCaseListFilter(p)).toBe("name != 'Bob'");
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
		const p = eq(prop("patient", "name"), literal(null));
		expect(emitCaseListFilter(p)).toBe("name = ''");
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
		const p = eq(prop("patient", "name"), sessionContext("username"));
		expect(emitCaseListFilter(p)).toBe(
			"name = instance('commcaresession')/session/context/username",
		);
	});

	it("emits search-input refs against the search-input results instance", () => {
		const p = eq(prop("patient", "name"), input("name_query"));
		expect(emitCaseListFilter(p)).toBe(
			"name = instance('search-input:results')/input/field[@name='name_query']",
		);
	});
});

describe("emitCaseListFilter — reserved case attributes", () => {
	// CCHQ stores these four as XML attributes on `<case>` in the casedb
	// restore output; the wire form prefixes them with `@` so XPath reads
	// the attribute rather than a child element. Citations on
	// `RESERVED_CASE_ATTRIBUTES` in the emitter source.
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
		const p = eq(prop("patient", "name"), literal("Alice"));
		expect(emitCaseListFilter(p)).toBe("name = 'Alice'");
	});
});

describe("emitCaseListFilter — logical operators", () => {
	it("emits and(...) joining clauses with ' and '", () => {
		const p = and(
			eq(prop("patient", "name"), literal("Alice")),
			gt(prop("patient", "age"), literal(18)),
		);
		expect(emitCaseListFilter(p)).toBe("name = 'Alice' and age > 18");
	});

	it("emits or(...) joining clauses with ' or '", () => {
		const p = or(
			eq(prop("patient", "name"), literal("Alice")),
			eq(prop("patient", "name"), literal("Bob")),
		);
		expect(emitCaseListFilter(p)).toBe("name = 'Alice' or name = 'Bob'");
	});

	it("parenthesizes or-clauses inside an and (precedence)", () => {
		// XPath's `and` binds tighter than `or`; without grouping,
		// `(A or B) and C` would silently re-associate to `A or (B and
		// C)`. The visitor's parent-precedence threading is the lock.
		const p = and(
			or(
				eq(prop("patient", "name"), literal("Alice")),
				eq(prop("patient", "name"), literal("Bob")),
			),
			gt(prop("patient", "age"), literal(18)),
		);
		expect(emitCaseListFilter(p)).toBe(
			"(name = 'Alice' or name = 'Bob') and age > 18",
		);
	});

	it("emits not(...) wrapping its inner with not(...)", () => {
		const p = not(eq(prop("patient", "name"), literal("Bob")));
		expect(emitCaseListFilter(p)).toBe("not(name = 'Bob')");
	});
});

describe("emitCaseListFilter — string-literal escape", () => {
	it("emits a quote-free string in single quotes", () => {
		const p = eq(prop("patient", "name"), literal("Alice"));
		expect(emitCaseListFilter(p)).toBe("name = 'Alice'");
	});

	it("emits embedded single quote with concat()", () => {
		// XPath 1.0 in the on-device casedb nodeset has `concat()`
		// available, so an embedded single quote splits into
		// alternating single-quoted and double-quoted segments.
		const p = eq(prop("patient", "name"), literal("O'Brien"));
		expect(emitCaseListFilter(p)).toBe(`name = concat('O', "'", 'Brien')`);
	});

	it("emits a quote-only string with concat() boundary segments", () => {
		const p = eq(prop("patient", "name"), literal("'"));
		expect(emitCaseListFilter(p)).toBe(`name = concat('', "'", '')`);
	});

	it("emits embedded double quote with single-quoted wrap", () => {
		const p = eq(prop("patient", "name"), literal('say "hello"'));
		expect(emitCaseListFilter(p)).toBe(`name = 'say "hello"'`);
	});

	it("emits both-quote-styles via concat()", () => {
		const p = eq(prop("patient", "name"), literal(`it's "quoted"`));
		expect(emitCaseListFilter(p)).toBe(
			`name = concat('it', "'", 's "quoted"')`,
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
		// `selected-any` would tokenize "Alice Smith" into "Alice" /
		// "Smith"; or-of-equalities preserves the literal value.
		const p = isIn(
			prop("patient", "name"),
			literal("Alice Smith"),
			literal("Bob Jones"),
		);
		expect(emitCaseListFilter(p)).toBe(
			"(name = 'Alice Smith' or name = 'Bob Jones')",
		);
	});

	it("emits multi-value in with mixed null + string values", () => {
		const p = isIn(prop("patient", "name"), literal(null), literal("Alice"));
		expect(emitCaseListFilter(p)).toBe("(name = '' or name = 'Alice')");
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
			eq(prop("patient", "name"), input("name_query")),
		);
		expect(emitCaseListFilter(p)).toBe(
			"if(count(instance('search-input:results')/input/field[@name='name_query']), name = instance('search-input:results')/input/field[@name='name_query'], true())",
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
		const p = isBlank(prop("patient", "name"));
		expect(emitCaseListFilter(p)).toBe("name = ''");
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
// SHELL 2 — Operators new to this visitor
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
		// Reserved-attribute prefix is uniform across every emit path
		// — pinning here protects the @-prefix branch on the
		// multi-select expansion.
		const p = multiSelectAny(prop("patient", "status"), literal("vip"));
		expect(emitCaseListFilter(p)).toBe("selected(@status, 'vip')");
	});
});

describe("emitCaseListFilter — match", () => {
	it("emits mode=starts-with as starts-with(prop, 'v')", () => {
		const p = match(prop("patient", "name"), "Ali", "starts-with");
		expect(emitCaseListFilter(p)).toBe("starts-with(name, 'Ali')");
	});

	it("routes the match value through quoteLiteral for embedded quote escape", () => {
		const p = match(prop("patient", "name"), "O'Brien", "starts-with");
		expect(emitCaseListFilter(p)).toBe(
			`starts-with(name, concat('O', "'", 'Brien'))`,
		);
	});

	it("throws on mode=fuzzy (CSQL-only)", () => {
		const p = match(prop("patient", "name"), "alice", "fuzzy");
		expect(() => emitCaseListFilter(p)).toThrow(/fuzzy/i);
	});

	it("throws on mode=phonetic (CSQL-only)", () => {
		const p = match(prop("patient", "name"), "alice", "phonetic");
		expect(() => emitCaseListFilter(p)).toThrow(/phonetic/i);
	});

	it("throws on mode=fuzzy-date (CSQL-only)", () => {
		const p = match(prop("patient", "dob"), "2020-01-01", "fuzzy-date");
		expect(() => emitCaseListFilter(p)).toThrow(/fuzzy-date/i);
	});
});

describe("emitCaseListFilter — exists / missing (relational quantifiers)", () => {
	// On-device joins use `instance('casedb')/casedb/case[@case_id =
	// current()/index/<rel>]` for ancestor walks (per CCHQ
	// `xpath.py:101-103` — the `#parent` / `#host` hashtag transform
	// builds exactly this nodeset against a parent CaseXPath base).
	// Subcase walks reverse direction: the inner case is the one whose
	// `index/<rel>` points back at the outer case (per CCHQ
	// `entries.py:1118-1131` — the canonical `[index/parent =
	// <case-id>]` shape on a subcase nodeset).

	it("emits ancestor exists as count(instance('casedb')/.../case[@case_id=current()/index/<rel>][filter]) > 0", () => {
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
		// Two hops: outer anchor reads `current()/index/parent`, then
		// the inner-case's `@case_id` links to that outer case's
		// `index/host`. The wire form composes one nested
		// `[@case_id=...]` predicate per hop.
		const p = exists(
			ancestorPath(relationStep("parent"), relationStep("host")),
			eq(prop("household", "region"), literal("south")),
		);
		expect(emitCaseListFilter(p)).toBe(
			"count(instance('casedb')/casedb/case[@case_id=instance('casedb')/casedb/case[@case_id=current()/index/parent]/index/host][region = 'south']) > 0",
		);
	});

	it("emits subcase exists as a reverse-direction join on index/<rel>", () => {
		// Reverse direction: inner case has `index/parent` pointing at
		// the outer case's `@case_id`. The `current()/@case_id` path
		// reads the outer case's id from the predicate's evaluation
		// context. (CCHQ canonical example pins this against
		// session-data — `entries.py:1118-1131` — but the same shape
		// applies with `current()/@case_id` when the outer case is
		// the casedb-scoped row the predicate is filtering.)
		//
		// `case_status` (not `status`) avoids the reserved-attribute
		// `@`-prefix path so the test pins the subcase nodeset shape
		// directly rather than the attribute-prefix path that the
		// reserved-attribute suite already covers.
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
		// The filter inside an `exists` is itself a Predicate that
		// recurses through the visitor's full operator dispatch. Pin
		// a multi-clause filter so a regression that flattened the
		// recursion (e.g. emitted only the first clause) surfaces.
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
});

// ============================================================
// SHELL 3 — Defensive throws
// ============================================================
//
// Each throw locks the contract that this dialect cannot represent
// the operator / operand shape; B5's representability checker
// catches the same shapes at authoring time. The throws are the
// emitter-side backstop in case authoring time is bypassed.

describe("emitCaseListFilter — defensive throws", () => {
	it("throws on is-null (strict-absent has no on-device wire form)", () => {
		const p = isNull(prop("patient", "name"));
		expect(() => emitCaseListFilter(p)).toThrow(/is-null/i);
	});

	it("throws on within-distance (CSQL-only)", () => {
		const p = within(
			prop("clinic", "location"),
			literal("40.7,-74.0"),
			50,
			"miles",
		);
		expect(() => emitCaseListFilter(p)).toThrow(/within-distance/i);
	});

	it("throws on exists with any-relation via (CCHQ has no direction-agnostic walk)", () => {
		const p = exists(anyRelationPath("parent"));
		expect(() => emitCaseListFilter(p)).toThrow(/any-relation/i);
	});

	it("throws on missing with any-relation via (same direction-agnostic limit)", () => {
		const p = missing(anyRelationPath("parent"));
		expect(() => emitCaseListFilter(p)).toThrow(/any-relation/i);
	});

	it("throws on exists with self via (degenerate; no relational walk)", () => {
		// `self` collapses to "the predicate runs in the current
		// case-type scope" — equivalent to dropping the `exists`
		// wrapper. The emitter throws so the structural defect
		// surfaces rather than silently emitting a no-op.
		const p = exists(selfPath());
		expect(() => emitCaseListFilter(p)).toThrow(/self/i);
	});

	it("throws on prop with non-self via (use exists() to read across relations)", () => {
		// Property references with a `via` walk are conceptually
		// `exists`-shaped — the AST reads a property on a related
		// case, but the on-device wire dispatch needs a count-based
		// presence test, not an inline relational read.
		const p = eq(
			prop("patient", "region", ancestorPath(relationStep("parent"))),
			literal("south"),
		);
		expect(() => emitCaseListFilter(p)).toThrow(/via/i);
	});
});

// ============================================================
// SHELL 4 — Term-arm ValueExpression handling
// ============================================================
//
// Predicate operators carry `ValueExpression` operands. The visitor
// accepts only the `term` arm and throws on every other arm. The
// block below pins both the term-arm unwrap (the happy path) and
// the per-arm exhaustive throws so a regression at either end
// surfaces here rather than in the larger per-operator suites
// above.

describe("emitCaseListFilter — term-arm unwrap (happy path)", () => {
	it("unwraps a property reference in a comparison's left operand", () => {
		const p = eq(prop("patient", "name"), literal("Alice"));
		expect(emitCaseListFilter(p)).toMatch(/^name = /);
	});

	it("unwraps a search-input reference in a comparison's right operand", () => {
		const p = eq(prop("patient", "phone"), input("phone_query"));
		expect(emitCaseListFilter(p)).toMatch(/instance\('search-input:results'\)/);
	});
});

describe("emitCaseListFilter — non-term ValueExpression arms throw", () => {
	it("throws on an arith expression in a comparison's left operand", () => {
		const p = eq(
			arith("+", term(prop("patient", "age")), term(literal(1))),
			literal(19),
		);
		expect(() => emitCaseListFilter(p)).toThrow(/arith/);
	});

	it("throws on an if-expression in is-blank's left", () => {
		const p = isBlank(
			ifExpr(matchAll(), term(literal("a")), term(literal("b"))),
		);
		expect(() => emitCaseListFilter(p)).toThrow(/'if'/);
	});

	it("throws on a today() constant in is-blank's left", () => {
		const p = isBlank(today());
		expect(() => emitCaseListFilter(p)).toThrow(/'today'/);
	});

	it("throws on a now() constant in within-distance's center", () => {
		// `within-distance` itself throws (CSQL-only) before any
		// operand walk runs — we don't reach the unwrap helper here.
		// Pinning the within-distance throw separately above keeps
		// the contract explicit; this test confirms the operator-
		// level rejection beats the operand-level walk in dispatch
		// order, so authors get the correct error message.
		const p = within(prop("clinic", "location"), now(), 50, "miles");
		expect(() => emitCaseListFilter(p)).toThrow(/within-distance/i);
	});
});
