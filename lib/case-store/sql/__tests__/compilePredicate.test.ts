// lib/case-store/sql/__tests__/compilePredicate.test.ts
//
// Compile-only acceptance tests for the Predicate compiler.
//
// Tests build a "cold" Kysely instance backed by `DummyDriver` +
// `Postgres*` adapters, wrap each compiled `Predicate` expression
// in a `selectFrom("cases as c").where(<compiled>)`, and call
// `.compile()` on the resulting query. Assertions inspect the
// emitted SQL string and parameter list rather than exact
// whitespace, since identifier quoting and parameter-placeholder
// layout are dialect-emitter details that aren't the contract this
// test guards.
//
// The contract this test guards:
//
//   1. Each `Predicate` discriminator arm emits the structurally
//      correct Kysely expression — sentinels collapse to `true` /
//      `false`, logical operators preserve precedence under
//      paren-wrapping, comparison operators map to the right SQL
//      tokens, JSONB / pg_trgm / fuzzystrmatch / PostGIS operators
//      reach the correct dispatch arm.
//   2. Postgres-strict null semantics: `is-null` emits the JSONB
//      key-existence test (`NOT (... ? '<key>')`); `is-blank` adds
//      the empty-string disjunction; `compare(prop, "")` and
//      `compare(prop, null)` execute as standard SQL equality
//      against the JSONB read.
//   3. Tenant scope (`appId` / `ownerId`) is exposed on the
//      context surface but not consumed by the predicate compiler
//      — tenant filtering is the caller's concern.
//   4. Non-term `ValueExpression` operands at the seven widened
//      operand slots (compare.left/right, in.left, between.left/
//      .lower/.upper, is-null.left, is-blank.left, within-distance
//      .center) dispatch through the expression compiler. Each
//      slot composes arith / count / if / coalesce expressions
//      without rejection.
//
// Tests use the AST builders from `lib/domain/predicate/builders.ts`
// to construct predicates — the one supported construction surface,
// and using it ensures the schema's invariants (kind discriminator,
// tuple-with-rest non-empty arms, etc.) are enforced at parse time
// rather than at compile time.

import {
	type CompiledQuery,
	DummyDriver,
	Kysely,
	PostgresAdapter,
	PostgresIntrospector,
	PostgresQueryCompiler,
} from "kysely";
import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	ancestorPath,
	and,
	anyRelationPath,
	arith,
	between,
	concat,
	count,
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
	or,
	prop,
	relationStep,
	selfPath,
	subcasePath,
	term,
	whenInput,
	within,
} from "@/lib/domain/predicate/builders";
import {
	compilePredicate,
	type PredicateCompileContext,
} from "../compilePredicate";
import type { Database } from "../database";

// ---------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------

const db = new Kysely<Database>({
	dialect: {
		createAdapter: () => new PostgresAdapter(),
		createDriver: () => new DummyDriver(),
		createIntrospector: (instance) => new PostgresIntrospector(instance),
		createQueryCompiler: () => new PostgresQueryCompiler(),
	},
});

const APP_ID = "app-uuid";
const OWNER_ID = "owner-uuid";

// `patient` schema — covers the full property surface every
// predicate-arm test needs: text, int, decimal, date, single_select,
// multi_select, geopoint, plus a `parent_type` for ancestor walks.
const PATIENT_SCHEMA: CaseType = {
	name: "patient",
	parent_type: "household",
	properties: [
		{ name: "nickname", label: "Nickname", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "bmi", label: "BMI", data_type: "decimal" },
		{ name: "dob", label: "DOB", data_type: "date" },
		{ name: "color", label: "Color", data_type: "single_select" },
		{ name: "tags", label: "Tags", data_type: "multi_select" },
		{ name: "loc", label: "Location", data_type: "geopoint" },
	],
};

const HOUSEHOLD_SCHEMA: CaseType = {
	name: "household",
	properties: [
		{ name: "size", label: "Size", data_type: "int" },
		{ name: "region", label: "Region", data_type: "text" },
	],
};

const CASE_TYPE_SCHEMAS = new Map<string, CaseType>([
	["patient", PATIENT_SCHEMA],
	["household", HOUSEHOLD_SCHEMA],
]);

function makeCtx(
	overrides: Partial<PredicateCompileContext> = {},
): PredicateCompileContext {
	return {
		db,
		appId: APP_ID,
		projectId: OWNER_ID,
		anchorAlias: "c",
		caseTypeSchemas: CASE_TYPE_SCHEMAS,
		bindings: {},
		...overrides,
	};
}

/**
 * Compile shorthand: wrap the predicate in a minimal `SELECT 1
 * FROM cases AS c WHERE <pred>` so Kysely renders the surrounding
 * SQL consistently. The `where(...)` call accepts any
 * `Expression<SqlBool>`, which `compilePredicate`'s typed return
 * satisfies directly.
 */
function compileWith(pred: ReturnType<typeof compilePredicate>): CompiledQuery {
	return db
		.selectFrom("cases as c")
		.select(["c.case_id"])
		.where(pred)
		.compile();
}

// ---------------------------------------------------------------
// Sentinels
// ---------------------------------------------------------------

describe("compilePredicate — sentinels", () => {
	it("emits SQL `true` for match-all", () => {
		const compiled = compileWith(compilePredicate(matchAll(), makeCtx()));
		expect(compiled.sql.toLowerCase()).toContain("true");
		expect(compiled.parameters).not.toContain(true);
	});

	it("emits SQL `false` for match-none", () => {
		const compiled = compileWith(compilePredicate(matchNone(), makeCtx()));
		expect(compiled.sql.toLowerCase()).toContain("false");
		expect(compiled.parameters).not.toContain(false);
	});
});

// ---------------------------------------------------------------
// Logical operators
// ---------------------------------------------------------------

describe("compilePredicate — logical operators", () => {
	it("composes an `and` of two clauses with paren-wrapping", () => {
		const pred = and(
			eq(prop("patient", "nickname"), literal("Alice")),
			eq(prop("patient", "age"), literal(30)),
		);
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		// Each clause is paren-wrapped, joined by ` and `.
		expect(compiled.sql.toLowerCase()).toContain(" and ");
		expect(compiled.parameters).toContain("Alice");
		expect(compiled.parameters).toContain(30);
	});

	it("composes an `or` of two clauses", () => {
		const pred = or(
			eq(prop("patient", "nickname"), literal("Alice")),
			eq(prop("patient", "nickname"), literal("Bob")),
		);
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		expect(compiled.sql.toLowerCase()).toContain(" or ");
		expect(compiled.parameters).toContain("Alice");
		expect(compiled.parameters).toContain("Bob");
	});

	it("composes a `not` wrapping an inner clause", () => {
		const pred = not(eq(prop("patient", "nickname"), literal("Alice")));
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		// Kysely's typed `eb.not(...)` emits the SQL `NOT <expr>`
		// keyword. Postgres operator precedence ranks `NOT` below
		// `=` (per docs § "Operator Precedence"), so `NOT a = b`
		// parses as `NOT (a = b)` without explicit parens — the
		// inner clause's grouping is preserved by the precedence
		// rules even when the SQL string lacks the literal `(...)`
		// wrap. The regex anchors `not` to the JSONB `cast(...)`
		// read so a stray `is not null` or `not in (...)` in
		// unrelated SQL would not satisfy the assertion.
		expect(compiled.sql.toLowerCase()).toMatch(/\bnot\s+cast\b/);
	});

	it("preserves grouping for `and` containing `or`", () => {
		// The outer `and` paren-wraps each clause, so the inner `or`'s
		// grouping survives splicing into the conjunction. Without
		// paren-wrapping, `(A or B) and C` would re-associate to
		// `A or (B and C)`.
		const pred = and(
			or(
				eq(prop("patient", "nickname"), literal("Alice")),
				eq(prop("patient", "nickname"), literal("Bob")),
			),
			gt(prop("patient", "age"), literal(18)),
		);
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		// The `or` clause is wrapped in parens (the and's per-clause
		// wrap) and the outer SQL contains both ` and ` and ` or `.
		expect(compiled.sql.toLowerCase()).toContain(" and ");
		expect(compiled.sql.toLowerCase()).toContain(" or ");
	});
});

// ---------------------------------------------------------------
// Comparison operators
// ---------------------------------------------------------------

describe("compilePredicate — comparison operators", () => {
	const ops = [
		{ name: "eq", builder: eq, token: "=" },
		{ name: "neq", builder: neq, token: "!=" },
		{ name: "gt", builder: gt, token: ">" },
		{ name: "gte", builder: gte, token: ">=" },
		{ name: "lt", builder: lt, token: "<" },
		{ name: "lte", builder: lte, token: "<=" },
	] as const;

	for (const { name, builder, token } of ops) {
		it(`emits ${token} for ${name}`, () => {
			const pred = builder(prop("patient", "age"), literal(30));
			const compiled = compileWith(compilePredicate(pred, makeCtx()));
			// The operator token appears in the SQL surrounded by
			// spaces; this lets `eq`'s `=` not match the JSONB-read
			// expression's other equality contexts.
			expect(compiled.sql).toContain(` ${token} `);
			expect(compiled.parameters).toContain(30);
		});
	}
});

// ---------------------------------------------------------------
// `in` — set membership
// ---------------------------------------------------------------

describe("compilePredicate — in", () => {
	it("collapses one membership value to one equality", () => {
		const pred = isIn(prop("patient", "nickname"), literal("Alice"));
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		expect(compiled.sql).toContain(" = ");
		expect(compiled.sql.toLowerCase()).not.toContain(" or ");
		expect(compiled.parameters).toContain("Alice");
	});

	it("emits multiple membership values as OR-composed equalities", () => {
		const pred = isIn(
			prop("patient", "nickname"),
			literal("Alice"),
			literal("Bob"),
			literal("Carol"),
		);
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		expect(compiled.sql.match(/ = /g)).toHaveLength(3);
		expect(compiled.sql.match(/ or /gi)).toHaveLength(2);
		expect(compiled.parameters).toContain("Alice");
		expect(compiled.parameters).toContain("Bob");
		expect(compiled.parameters).toContain("Carol");
	});

	it("emits SQL null keyword for null literal in IN values", () => {
		const pred = isIn(
			prop("patient", "nickname"),
			literal("Alice"),
			literal(null),
		);
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		expect(compiled.sql.toLowerCase()).toContain("null");
		// Null is not bound as a parameter — it emits as the SQL
		// keyword.
		expect(compiled.parameters).toContain("Alice");
		expect(compiled.parameters).not.toContain(null);
	});
});

// ---------------------------------------------------------------
// `between` — bounded interval
// ---------------------------------------------------------------

describe("compilePredicate — between", () => {
	it("emits both bounds with default inclusivity", () => {
		const pred = between(prop("patient", "age"), {
			lower: literal(18),
			upper: literal(65),
		});
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		expect(compiled.sql).toContain(">=");
		expect(compiled.sql).toContain("<=");
		expect(compiled.parameters).toContain(18);
		expect(compiled.parameters).toContain(65);
	});

	it("emits strict comparators when bounds are exclusive", () => {
		const pred = between(prop("patient", "age"), {
			lower: literal(18),
			upper: literal(65),
			lowerInclusive: false,
			upperInclusive: false,
		});
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		// Both strict comparators present; non-strict variants
		// (`>=` / `<=`) absent.
		expect(compiled.sql).toContain(">");
		expect(compiled.sql).toContain("<");
		// Confirm the strict-only shape: no `>=` / `<=` in the SQL.
		expect(compiled.sql).not.toContain(">=");
		expect(compiled.sql).not.toContain("<=");
	});

	it("emits half-open interval (lower-inclusive, upper-exclusive)", () => {
		const pred = between(prop("patient", "age"), {
			lower: literal(18),
			upper: literal(65),
			lowerInclusive: true,
			upperInclusive: false,
		});
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		expect(compiled.sql).toContain(">=");
		expect(compiled.sql).toContain(" < ");
		// The upper-strict half-open form: `<` present, `<=` not.
		expect(compiled.sql).not.toContain("<=");
	});

	it("emits lower-only when upper is omitted", () => {
		const pred = between(prop("patient", "age"), { lower: literal(18) });
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		expect(compiled.sql).toContain(">=");
		// No upper-bound clause — no `<` / `<=` in the SQL.
		expect(compiled.sql).not.toContain(" < ");
		expect(compiled.sql).not.toContain("<=");
	});

	it("emits upper-only when lower is omitted", () => {
		const pred = between(prop("patient", "age"), { upper: literal(65) });
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		expect(compiled.sql).toContain("<=");
		expect(compiled.sql).not.toContain(" > ");
		expect(compiled.sql).not.toContain(">=");
	});
});

// ---------------------------------------------------------------
// `multi-select-contains` — JSONB containment
// ---------------------------------------------------------------

describe("compilePredicate — multi-select-contains", () => {
	it("emits ?| for `any` quantifier (single value)", () => {
		const pred = multiSelectAny(prop("patient", "tags"), literal("urgent"));
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		// JSONB any-key-exists operator. The `multi_select` data_type
		// reads via `->`, so the property side lands as JSONB and
		// `?|` is the right operator dispatch. The property key inlines
		// as a quoted JSON key (kysely 0.29); the search value array
		// stays a bound parameter.
		expect(compiled.sql).toContain("?|");
		expect(compiled.sql).toContain(`->'tags'`);
		expect(compiled.parameters).toEqual(expect.arrayContaining([["urgent"]]));
	});

	it("emits ?| for `any` quantifier (multiple values)", () => {
		const pred = multiSelectAny(
			prop("patient", "tags"),
			literal("urgent"),
			literal("review"),
		);
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		expect(compiled.sql).toContain("?|");
		// The `text[]` array binds as a single parameter with
		// pg's array form.
		expect(compiled.parameters).toEqual(
			expect.arrayContaining([["urgent", "review"]]),
		);
	});

	it("emits ?& for `all` quantifier", () => {
		const pred = multiSelectAll(
			prop("patient", "tags"),
			literal("urgent"),
			literal("review"),
		);
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		// JSONB all-keys-exist operator.
		expect(compiled.sql).toContain("?&");
	});

	it("rejects non-string token literals at the SQL boundary", () => {
		// Multi-select tokens are wire-form strings on CommCare;
		// JSONB key-existence operators (?| / ?&) match by string
		// equality, so a numeric or boolean literal would silently
		// produce a never-matching predicate against a JSONB array
		// of strings. The compiler rejects with a clear error rather
		// than `String(v)`-coerce.
		const pred = multiSelectAny(
			prop("patient", "tags"),
			literal("urgent"),
			literal(5),
		);
		expect(() => compilePredicate(pred, makeCtx())).toThrow(
			/string-typed token literals/,
		);
	});
});

// ---------------------------------------------------------------
// `match` — text-match modes
// ---------------------------------------------------------------

describe("compilePredicate — match", () => {
	it.each([
		"starts-with",
		"fuzzy",
		"phonetic",
	] as const)("compiles a computed ValueExpression for %s mode", (mode) => {
		const pred = match(
			prop("patient", "nickname"),
			concat(term(literal("Ali")), term(literal("ce"))),
			mode,
		);
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		expect(compiled.sql.toLowerCase()).toContain("concat(");
		expect(compiled.parameters).toEqual(expect.arrayContaining(["Ali", "ce"]));
	});

	it("emits starts_with for starts-with mode", () => {
		const pred = match(prop("patient", "nickname"), "Ali", "starts-with");
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		// Postgres `starts_with(text, prefix)` — typed boolean prefix
		// match without LIKE meta-character escaping concerns. Works
		// for any text expression including dynamic search-input
		// values (per the match.value widening to ValueExpression).
		expect(compiled.sql.toLowerCase()).toContain("starts_with(");
		expect(compiled.parameters).toContain("Ali");
	});

	it("does NOT escape user input characters for starts-with mode", () => {
		// `starts_with()` has no wildcard semantics, so user-typed
		// `%` and `_` are matched literally — no escaping required at
		// the compiler layer. Pin the absence of escape transforms so
		// a future regression that reintroduces LIKE-meta escaping
		// surfaces here.
		const pred = match(prop("patient", "nickname"), "100% pure", "starts-with");
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		expect(compiled.parameters).toContain("100% pure");
	});

	it("emits the term-level fuzzy + exact-token-overlap shape for fuzzy mode", () => {
		const pred = match(prop("patient", "nickname"), "Alise", "fuzzy");
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		const sql = compiled.sql.toLowerCase();
		// Clause (a): a correlated `EXISTS (... unnest(...) ...)` over
		// the property tokens, checking `levenshtein` against the
		// whole lowered query string. Tokenization runs through
		// `regexp_split_to_array` + `array_remove`.
		expect(sql).toContain("levenshtein(");
		expect(sql).toContain("unnest(");
		expect(sql).toContain("regexp_split_to_array(");
		expect(sql).toContain("array_remove(");
		// Clause (b): exact-token overlap via the array `&&` operator.
		expect(sql).toContain(" && ");
		// pg_trgm's whole-string `%` similarity is GONE — the old
		// behavior matched partial strings HQ never would.
		expect(sql).not.toContain(" % ");
		expect(compiled.parameters).toContain("Alise");
	});

	it("emits per-token soundex equality for phonetic mode", () => {
		const pred = match(prop("patient", "nickname"), "Alice", "phonetic");
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		const sql = compiled.sql.toLowerCase();
		// fuzzystrmatch's `soundex` (HQ's phonetic encoder), compared
		// per-token across the two `unnest(...)` token sources — NOT
		// the old whole-string `dmetaphone`.
		expect(sql).toContain("soundex(");
		expect(sql).toContain("unnest(");
		expect(sql).not.toContain("dmetaphone(");
		expect(compiled.parameters).toContain("Alice");
	});

	it("emits IN over the digit-permutation set for fuzzy-date mode", () => {
		const pred = match(prop("patient", "dob"), "2024-12-03", "fuzzy-date");
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		// The permutation set lands as an `IN (...)` shape; the
		// canonical input is one of the permutations.
		expect(compiled.sql.toLowerCase()).toContain(" in (");
		expect(compiled.parameters).toContain("2024-12-03");
		// CCHQ's `date_permutations` produces `2024-03-12` (year-day-
		// month swap), among other variants.
		expect(compiled.parameters).toContain("2024-03-12");
	});

	it("rejects fuzzy-date with a malformed value", () => {
		const pred = match(prop("patient", "dob"), "not-a-date", "fuzzy-date");
		expect(() => compilePredicate(pred, makeCtx())).toThrow(/YYYY-MM-DD/);
	});

	it("rejects year zero like HQ's Python datetime parser", () => {
		const pred = match(prop("patient", "dob"), "0000-01-01", "fuzzy-date");
		expect(() => compilePredicate(pred, makeCtx())).toThrow(/YYYY-MM-DD/);
	});

	it("compiles runtime date permutations for a computed fuzzy-date value", () => {
		const pred = match(
			prop("patient", "dob"),
			concat(term(literal("2024-12")), term(literal("-03"))),
			"fuzzy-date",
		);
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		const sql = compiled.sql.toLowerCase();
		expect(sql).toContain("concat(");
		expect(sql).toContain("substr(");
		expect(sql).toContain("case");
		expect(compiled.parameters).toEqual(
			expect.arrayContaining(["2024-12", "-03"]),
		);
	});
});

// ---------------------------------------------------------------
// `within-distance` — PostGIS predicate
// ---------------------------------------------------------------

describe("compilePredicate — within-distance", () => {
	it("emits ST_DWithin with split_part on the geopoint wire form", () => {
		const pred = within(
			prop("patient", "loc"),
			literal("42.37 -71.11 0 0"),
			10,
			"miles",
		);
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		// PostGIS function call. Compares the geopoint property
		// against a geopoint center literal (both wire-form
		// strings) within 10 miles.
		expect(compiled.sql.toLowerCase()).toContain("st_dwithin(");
		// Geography points are constructed via `ST_GeogFromText`
		// (returns geography directly — no separate cast token
		// needed). The lat/lon components are split out via
		// `split_part` and composed into a `POINT(<lon> <lat>)`
		// WKT string through Postgres's `concat`.
		expect(compiled.sql.toLowerCase()).toContain("st_geogfromtext(");
		expect(compiled.sql.toLowerCase()).toContain("split_part(");
		expect(compiled.sql.toLowerCase()).toContain("concat(");
		// The WKT prefix / suffix tokens bind as text parameters so
		// `concat`'s implicit text resolution stays well-typed.
		expect(compiled.parameters).toContain("POINT(");
		expect(compiled.parameters).toContain(")");
	});

	it("converts miles to meters in the distance scalar", () => {
		const pred = within(
			prop("patient", "loc"),
			literal("42.37 -71.11 0 0"),
			1,
			"miles",
		);
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		// 1 mile = 1609.344 meters per the international mile
		// definition.
		expect(compiled.parameters).toContain(1609.344);
	});

	it("converts kilometers to meters in the distance scalar", () => {
		const pred = within(
			prop("patient", "loc"),
			literal("42.37 -71.11 0 0"),
			5,
			"kilometers",
		);
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		// 5 km = 5000 meters.
		expect(compiled.parameters).toContain(5000);
	});
});

// ---------------------------------------------------------------
// `exists` / `missing` — relational quantifiers
// ---------------------------------------------------------------

describe("compilePredicate — exists / missing", () => {
	it("emits EXISTS for ancestor-walk exists", () => {
		const pred = exists(ancestorPath(relationStep("parent", "household")));
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		expect(compiled.sql.toLowerCase()).toContain("exists (");
	});

	it("emits NOT EXISTS for ancestor-walk missing", () => {
		const pred = missing(ancestorPath(relationStep("parent", "household")));
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		expect(compiled.sql.toLowerCase()).toContain("not exists (");
	});

	it("threads inner where into the EXISTS subquery", () => {
		const pred = exists(
			ancestorPath(relationStep("parent", "household")),
			eq(prop("household", "size"), literal(5)),
		);
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		// The inner `where`'s value is parameter-bound inside the
		// EXISTS subquery body.
		expect(compiled.parameters).toContain(5);
		expect(compiled.sql.toLowerCase()).toContain("exists (");
	});

	it("collapses exists(self) to trivial-true", () => {
		const pred = exists(selfPath());
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		expect(compiled.sql.toLowerCase()).toContain("true");
		expect(compiled.sql.toLowerCase()).not.toContain("exists");
	});

	it("collapses exists(self, where) to compiled where", () => {
		const pred = exists(
			selfPath(),
			eq(prop("patient", "nickname"), literal("Alice")),
		);
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		// The collapse means no EXISTS keyword in the SQL — it's
		// just the inner clause.
		expect(compiled.sql.toLowerCase()).not.toContain("exists");
		expect(compiled.parameters).toContain("Alice");
	});

	it("collapses missing(self) to trivial-false", () => {
		const pred = missing(selfPath());
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		expect(compiled.sql.toLowerCase()).toContain("false");
		expect(compiled.sql.toLowerCase()).not.toContain("exists");
	});

	it("collapses missing(self, where) to NOT (where)", () => {
		const pred = missing(
			selfPath(),
			eq(prop("patient", "nickname"), literal("Alice")),
		);
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		// The collapse rewrites to `NOT (where)`; no EXISTS, but
		// the SQL still contains a `not` token.
		expect(compiled.sql.toLowerCase()).toContain("not");
		expect(compiled.sql.toLowerCase()).not.toContain("exists");
		expect(compiled.parameters).toContain("Alice");
	});

	it("emits EXISTS for subcase-walk", () => {
		const pred = exists(subcasePath("child", "patient"));
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		expect(compiled.sql.toLowerCase()).toContain("exists (");
	});

	it("emits EXISTS for any-relation walk", () => {
		const pred = exists(anyRelationPath("link", "patient"));
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		expect(compiled.sql.toLowerCase()).toContain("exists (");
		// The any-relation arm composes a `UNION ALL` of ancestor
		// + subcase shapes inside the leaf subquery.
		expect(compiled.sql.toLowerCase()).toContain("union all");
	});
});

// ---------------------------------------------------------------
// `when-input-present` — compile-time short-circuit
// ---------------------------------------------------------------

describe("compilePredicate — when-input-present", () => {
	it("compiles the inner clause when the input is bound", () => {
		const pred = whenInput(
			input("region_filter"),
			eq(prop("patient", "nickname"), literal("Alice")),
		);
		const compiled = compileWith(
			compilePredicate(
				pred,
				makeCtx({
					bindings: { searchInputs: new Map([["region_filter", "north"]]) },
				}),
			),
		);
		// Bound input — inner clause compiles directly. The
		// inner clause's value parameter lands in the final SQL.
		expect(compiled.parameters).toContain("Alice");
	});

	it("collapses to true when the input is unbound", () => {
		const pred = whenInput(
			input("region_filter"),
			eq(prop("patient", "nickname"), literal("Alice")),
		);
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		// Unbound input — short-circuit to "match every row".
		// The inner clause's value never reaches the SQL.
		expect(compiled.sql.toLowerCase()).toContain("true");
		expect(compiled.parameters).not.toContain("Alice");
	});
});

// ---------------------------------------------------------------
// `is-null` and `is-blank` — Postgres-strict null semantics
// ---------------------------------------------------------------

describe("compilePredicate — Postgres-strict null semantics", () => {
	// is-null: strict-absent. JSONB `?` (key-exists) negation for
	// property refs.
	it("emits NOT (... ? key) for is-null on a JSONB-document property", () => {
		const pred = isNull(prop("patient", "nickname"));
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		// The `?` is the JSONB key-exists operator; the negation
		// wraps the test.
		expect(compiled.sql).toContain("?");
		expect(compiled.sql.toLowerCase()).toContain("not");
		// The key is parameter-bound, not inlined.
		expect(compiled.parameters).toContain("nickname");
	});

	it("emits IS NULL for is-null on a reserved scalar column", () => {
		const pred = isNull(prop("patient", "case_id"));
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		// Reserved-column dispatch: read off the column directly,
		// `IS NULL` rather than JSONB `?`.
		expect(compiled.sql.toLowerCase()).toContain("is null");
		expect(compiled.sql).toContain('"c"."case_id"');
		// JSONB `?` operator is NOT in the SQL because the property
		// routes through the scalar-column branch.
		expect(compiled.sql).not.toContain('"properties" ?');
	});

	it("emits IS NULL for is-null on a non-property term", () => {
		// `compileTerm` parameter-binds `input` / `session-user` /
		// `session-context` as scalars, so the strict-absent JSONB
		// semantic doesn't apply — the standard SQL `IS NULL` is the
		// right shape.
		const pred = isNull(input("region_filter"));
		const compiled = compileWith(
			compilePredicate(
				pred,
				makeCtx({
					bindings: { searchInputs: new Map([["region_filter", "north"]]) },
				}),
			),
		);
		expect(compiled.sql.toLowerCase()).toContain("is null");
	});

	// is-blank: absent-or-empty. Adds the empty-string disjunction
	// to the is-null shape.
	it("emits OR =-empty disjunction for is-blank on a JSONB-document property", () => {
		const pred = isBlank(prop("patient", "nickname"));
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		// Both branches present: the JSONB key-existence check
		// (`... ? key`) negation plus the `->> key = ''` empty-
		// string disjunction. The empty-string literal binds as a
		// parameter (`$N`) rather than inlining as `''` because
		// `eb.val("")` routes through Kysely's parameter channel —
		// inspect via the parameters list rather than the SQL
		// string.
		expect(compiled.sql).toContain("?");
		expect(compiled.sql).toContain("->>");
		expect(compiled.sql.toLowerCase()).toContain(" or ");
		expect(compiled.parameters).toContain("");
	});

	it("emits IS NULL OR =-empty for is-blank on a reserved scalar column", () => {
		const pred = isBlank(prop("patient", "status"));
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		// Reserved scalar column reads through `<alias>.<col>`
		// directly; the absence check is `IS NULL`, the blank
		// addition is the `= <empty-parameter>` disjunction.
		expect(compiled.sql.toLowerCase()).toContain("is null");
		expect(compiled.sql.toLowerCase()).toContain(" or ");
		expect(compiled.parameters).toContain("");
	});

	it("maps a standard name to its scalar column for is-null (date_opened → opened_on)", () => {
		const pred = isNull(prop("patient", "date_opened"));
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		expect(compiled.sql).toContain('"c"."opened_on"');
		expect(compiled.sql.toLowerCase()).toContain("is null");
		expect(compiled.sql).not.toContain('"properties" ?');
	});

	it("collapses is-blank to plain IS NULL on a timestamp scalar (last_modified)", () => {
		// `''` is not a value a timestamptz column can hold, and
		// comparing one to `''` is a Postgres type ERROR — the
		// non-blankable entries in `RESERVED_SCALAR_COLUMN_BY_PROPERTY`
		// drop the empty-string disjunction entirely.
		const pred = isBlank(prop("patient", "last_modified"));
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		expect(compiled.sql).toContain('"c"."modified_on"');
		expect(compiled.sql.toLowerCase()).toContain("is null");
		expect(compiled.sql.toLowerCase()).not.toContain(" or ");
		expect(compiled.parameters).not.toContain("");
	});

	// compare(prop, "") — strict empty-string match. Distinct from
	// is-blank because the JSONB read evaluates to empty string
	// only if the key is present and the stored value is the
	// empty string.
	it('emits standard equality for compare(prop, literal(""))', () => {
		const pred = eq(prop("patient", "nickname"), literal(""));
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		// JSONB read on the left, empty-string parameter on the
		// right. NOT routed through the absence-check shape.
		expect(compiled.sql).toContain("->>");
		expect(compiled.parameters).toContain("");
		// Confirm no JSONB-key-exists check leaked in — that's
		// is-null's shape, not compare's.
		expect(compiled.sql).not.toContain("not (");
	});

	it("emits standard equality for compare(prop, literal(null))", () => {
		const pred = eq(prop("patient", "nickname"), literal(null));
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		// JSONB read on the left, SQL `null` keyword on the right.
		expect(compiled.sql).toContain("->>");
		expect(compiled.sql.toLowerCase()).toContain("null");
		// `null` is not bound as a parameter — it emits as the SQL
		// keyword. Postgres's `<col> = NULL` evaluates to NULL
		// (three-valued logic), so the predicate matches no rows
		// — the strict-null semantic.
		expect(compiled.parameters).not.toContain(null);
	});
});

// ---------------------------------------------------------------
// Tenant scope contract — predicate compiler does NOT emit filter
// ---------------------------------------------------------------

describe("compilePredicate — tenant scope contract", () => {
	it("does not emit appId or ownerId parameters", () => {
		const pred = eq(prop("patient", "nickname"), literal("Alice"));
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		// The tenant scope is on the context surface but the
		// predicate compiler doesn't read it for self-via reads.
		expect(compiled.parameters).not.toContain(APP_ID);
		expect(compiled.parameters).not.toContain(OWNER_ID);
	});
});

// ---------------------------------------------------------------
// Non-term ValueExpression operand dispatch — seven sites
// ---------------------------------------------------------------
//
// The predicate compiler exposes seven slots that accept any
// `ValueExpression` (not just the `term` arm): comparison.left /
// .right, in.left, between.left / .lower / .upper, is-null.left,
// is-blank.left, and within-distance.center. Each test below
// builds a non-term expression at the corresponding slot and
// verifies the dispatch routes through the expression compiler,
// emitting the expression's signature SQL shape (an arithmetic
// operator, a `case when ... end`, a counting subquery) at the
// operand position.

describe("compilePredicate — non-term ValueExpression operand dispatch", () => {
	it("dispatches arith on compare.left through the expression compiler", () => {
		// `gt(prop.age + 1, 18)` — the canonical "future-age check"
		// shape from the AST docs. compare.left is an `arith`, not a
		// term; the dispatch routes it through compileExpression and
		// emits the arithmetic SQL.
		const pred = gt(
			arith("+", term(prop("patient", "age")), term(literal(1))),
			term(literal(18)),
		);
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		// The arithmetic operator and both operands are present.
		expect(compiled.sql).toContain("+");
		expect(compiled.parameters).toContain(1);
		expect(compiled.parameters).toContain(18);
	});

	it("dispatches count on compare.left through the expression compiler", () => {
		// `eq(count(parent), 2)` — count's relational subquery on
		// the LHS of an equality. The dispatch routes it through
		// compileExpression and emits a counting subquery.
		const pred = eq(
			count(ancestorPath(relationStep("parent", "household"))),
			term(literal(2)),
		);
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		expect(compiled.sql.toLowerCase()).toContain("count(*)");
		expect(compiled.parameters).toContain(2);
	});

	it("dispatches arith on in.left through each membership equality", () => {
		// `isIn(prop.age + 1, 10, 20, 30)` — arithmetic on the LHS
		// of an IN list. The dispatch routes through
		// compileExpression and emits a typed arith expression.
		const pred = isIn(
			arith("+", term(prop("patient", "age")), term(literal(1))),
			literal(10),
			literal(20),
			literal(30),
		);
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		expect(compiled.sql).toContain("+");
		expect(compiled.sql.match(/ = /g)).toHaveLength(3);
		expect(compiled.sql.match(/ or /gi)).toHaveLength(2);
		expect(compiled.parameters).toContain(10);
		expect(compiled.parameters).toContain(30);
	});

	it("dispatches arith on between.left with literal bounds through the expression compiler", () => {
		// `between(prop.age + 1, { lower: 0, upper: 100 })`. The
		// dispatch routes the arith on `.left` while keeping
		// literal bounds as terms.
		const pred = between(
			arith("+", term(prop("patient", "age")), term(literal(1))),
			{ lower: literal(0), upper: literal(100) },
		);
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		expect(compiled.sql).toContain("+");
		expect(compiled.sql).toContain(">=");
		expect(compiled.sql).toContain("<=");
		expect(compiled.parameters).toContain(0);
		expect(compiled.parameters).toContain(100);
	});

	it("dispatches arith on is-null.left as a scalar IS NULL check", () => {
		// `isNull(prop.age + 1)` — the strict-absent semantic on a
		// scalar arithmetic expression. The dispatch routes through
		// compileExpression; the result is a scalar `IS NULL` check
		// (NOT a JSONB key-existence test, which is reserved for
		// property-ref operands).
		const pred = isNull(
			arith("+", term(prop("patient", "age")), term(literal(1))),
		);
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		expect(compiled.sql.toLowerCase()).toContain("is null");
		// The JSONB `?` key-existence operator is property-ref
		// specific; arithmetic operands route through scalar IS
		// NULL.
		expect(compiled.sql).not.toMatch(/\bnot\b\s*\([^)]*\?[^)]*\)/);
	});

	it("dispatches arith on is-blank.left as a scalar IS NULL OR =-empty check", () => {
		// `isBlank(prop.age + 1)` — same dispatch as is-null on the
		// arith arm, with the empty-string disjunction added.
		const pred = isBlank(
			arith("+", term(prop("patient", "age")), term(literal(1))),
		);
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		expect(compiled.sql.toLowerCase()).toContain("is null");
		expect(compiled.sql.toLowerCase()).toContain(" or ");
		expect(compiled.parameters).toContain("");
	});

	it("dispatches a non-term `if` expression on within-distance.center", () => {
		// `within(prop.loc, if(<true>, "x", "y"), 1000, miles)` — the
		// conditional expression on the center slot. The dispatch
		// routes through compileExpression; the conditional resolves
		// to a CASE WHEN expression, which `split_part` parses for
		// the lat/lon decomposition. The `if`'s predicate body
		// recurses back through `compilePredicate` via the
		// expression compiler's predicate-thunk wiring.
		const pred = within(
			prop("patient", "loc"),
			ifExpr(
				matchAll(),
				term(literal("42.37 -71.11 0 0")),
				term(literal("0 0 0 0")),
			),
			1000,
			"miles",
		);
		const compiled = compileWith(compilePredicate(pred, makeCtx()));
		expect(compiled.sql.toLowerCase()).toContain("case when");
		expect(compiled.sql.toLowerCase()).toContain("st_dwithin(");
		expect(compiled.parameters).toContain("42.37 -71.11 0 0");
	});
});
