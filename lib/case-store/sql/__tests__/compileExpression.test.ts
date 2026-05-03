// lib/case-store/sql/__tests__/compileExpression.test.ts
//
// Compile-only acceptance tests for the Expression compiler.
//
// The compiler covers fifteen `ValueExpression` arms — the AST's
// value-bearing union from `lib/domain/predicate/types.ts:1796-1845`.
// Each test wraps the compiled expression in a `select(... .as("v"))`
// call against a `DummyDriver`-backed Kysely instance and inspects
// the resulting SQL string and parameter list. This shape catches
// arm-dispatch regressions, missing operator tokens, and wrong cast
// emissions without booting Postgres.
//
// Postgres semantic correctness (do these tokens parse as the
// intended types? does the operator round-trip the expected value?)
// is the harness sibling's concern at
// `compileExpression.harness.test.ts`.
//
// ## Predicate-thunk strategy
//
// `if.cond` and `count.where` carry `Predicate` operands. The
// Expression compiler does not import the Predicate compiler
// directly; `ExpressionCompileContext` carries an optional
// `compilePredicate` callback that the integrating caller wires.
// Tests that exercise the predicate-bearing arms inject a stub
// callback that emits a simple SQL fragment so the arm dispatch is
// observable in isolation.

import {
	type CompiledQuery,
	DummyDriver,
	type Expression,
	Kysely,
	PostgresAdapter,
	PostgresIntrospector,
	PostgresQueryCompiler,
	sql,
} from "kysely";
import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	ancestorPath,
	arith,
	coalesce,
	concat,
	count,
	dateAdd,
	dateCoerce,
	datetimeCoerce,
	double,
	eq,
	formatDate,
	gt,
	ifExpr,
	literal,
	now,
	prop,
	relationStep,
	selfPath,
	switchCase,
	switchExpr,
	term,
	today,
	unwrapList,
} from "@/lib/domain/predicate/builders";
import type { ArithOp, DateAddInterval } from "@/lib/domain/predicate/types";
import {
	compileExpression,
	type ExpressionCompileContext,
} from "../compileExpression";
import type { Database } from "../database";

// ---------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------
//
// Every test in this file builds against the same `DummyDriver`
// Kysely instance — the dialect-emitter behavior is what's under
// test, not the driver's runtime semantics. The dummy driver lets
// `.compile()` produce the same SQL string as the live Postgres
// dialect would, without needing a live engine.

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

// `patient` schema: every property the expression compiler reads
// must exist on the case-type schema. The shape below mirrors the
// term-compiler test fixture so `prop("patient", "age")` resolves to
// `int` and `prop("patient", "name")` resolves to `text`.
const PATIENT_SCHEMA: CaseType = {
	name: "patient",
	parent_type: "household",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "bmi", label: "BMI", data_type: "decimal" },
		{ name: "dob", label: "DOB", data_type: "date" },
		{ name: "registered_at", label: "When", data_type: "datetime" },
		{ name: "tags", label: "Tags", data_type: "multi_select" },
	],
};

// `household` for relation-walk tests — `count(via: ancestor)` and
// the term compiler's destination resolution both need this schema
// resolved against `PATIENT_SCHEMA.parent_type`.
const HOUSEHOLD_SCHEMA: CaseType = {
	name: "household",
	properties: [{ name: "size", label: "Size", data_type: "int" }],
};

const CASE_TYPE_SCHEMAS = new Map<string, CaseType>([
	["patient", PATIENT_SCHEMA],
	["household", HOUSEHOLD_SCHEMA],
]);

// Stub predicate thunk — emits a constant `(true)` so tests can
// observe the arm dispatch without depending on the Predicate
// compiler's shape. Tests that need to inspect the threaded
// predicate inspect the stub's call log via the `predicateLog`
// closure.
function makeStubPredicateThunk(): {
	thunk: (_p: unknown, _c: ExpressionCompileContext) => Expression<unknown>;
	log: unknown[];
} {
	const log: unknown[] = [];
	return {
		thunk: (p, _c) => {
			log.push(p);
			// `(true)` is the recognisable sentinel — wider tests assert
			// the SQL contains it where a predicate is expected.
			return sql`(true)`;
		},
		log,
	};
}

function makeCtx(
	overrides: Partial<ExpressionCompileContext> = {},
): ExpressionCompileContext {
	return {
		db,
		appId: APP_ID,
		ownerId: OWNER_ID,
		anchorAlias: "c",
		caseTypeSchemas: CASE_TYPE_SCHEMAS,
		bindings: {},
		...overrides,
	};
}

// Compile a `ValueExpression` to a SQL string by wrapping it in a
// minimal SELECT so Kysely renders the surrounding identifiers
// consistently across tests. Returns `CompiledQuery` so tests can
// assert on `.sql` and `.parameters` independently.
function compileExpression_(
	expr: ReturnType<typeof compileExpression>,
): CompiledQuery {
	return db.selectFrom("cases as c").select(expr.as("v")).compile();
}

// ---------------------------------------------------------------
// `term` arm — delegates to the Term compiler
// ---------------------------------------------------------------
//
// `term` is the structural lifter that converts a Term into a
// ValueExpression. The expression compiler delegates verbatim to
// `compileTerm`; this test pins the delegation so a regression that
// inlined a term-handling branch would surface here.

describe("compileExpression — term arm", () => {
	it("delegates a property-ref term to the Term compiler", () => {
		const compiled = compileExpression_(
			compileExpression(term(prop("patient", "name")), makeCtx()),
		);
		// JSONB read shape from `compileTerm`'s self-via property arm.
		expect(compiled.sql).toContain('"c"."properties" ->>');
		expect(compiled.sql).toContain("as text)");
		expect(compiled.parameters).toContain("name");
	});

	it("delegates a literal term to the Term compiler", () => {
		const compiled = compileExpression_(
			compileExpression(term(literal("Alice")), makeCtx()),
		);
		expect(compiled.parameters).toContain("Alice");
	});
});

// ---------------------------------------------------------------
// `today` / `now` — discriminator-only constants
// ---------------------------------------------------------------
//
// Both are zero-argument constants. `today` resolves to `CURRENT_DATE`
// (Postgres returns a `date`); `now` resolves to `NOW()` (returns
// `timestamptz`). The cold-suite check pins the function-token
// emission; the harness sibling pins the runtime values match
// expectations.

describe("compileExpression — today / now constants", () => {
	it("emits CURRENT_DATE for `today`", () => {
		const compiled = compileExpression_(compileExpression(today(), makeCtx()));
		expect(compiled.sql.toLowerCase()).toContain("current_date");
	});

	it("emits NOW() for `now`", () => {
		const compiled = compileExpression_(compileExpression(now(), makeCtx()));
		expect(compiled.sql.toLowerCase()).toContain("now()");
	});
});

// ---------------------------------------------------------------
// `date-coerce` / `datetime-coerce` / `double` — typed casts
// ---------------------------------------------------------------
//
// Each of the three cast arms wraps the inner expression in
// `(<inner>)::<cast>`. The cast token differs per arm:
//
//   - `date-coerce` → `::date`
//   - `datetime-coerce` → `::timestamptz` (preserves timezone info)
//   - `double` → `::numeric` (Postgres's arbitrary-precision decimal)

describe("compileExpression — coercion casts", () => {
	it("emits date cast for date-coerce", () => {
		const compiled = compileExpression_(
			compileExpression(dateCoerce(term(literal("2026-01-01"))), makeCtx()),
		);
		expect(compiled.sql).toContain("as date)");
		expect(compiled.parameters).toContain("2026-01-01");
	});

	it("emits timestamptz cast for datetime-coerce", () => {
		const compiled = compileExpression_(
			compileExpression(
				datetimeCoerce(term(literal("2026-01-01T12:00:00Z"))),
				makeCtx(),
			),
		);
		expect(compiled.sql).toContain("as timestamptz)");
		expect(compiled.parameters).toContain("2026-01-01T12:00:00Z");
	});

	it("emits numeric cast for double", () => {
		const compiled = compileExpression_(
			compileExpression(double(term(literal("42.5"))), makeCtx()),
		);
		expect(compiled.sql).toContain("as numeric)");
		expect(compiled.parameters).toContain("42.5");
	});
});

// ---------------------------------------------------------------
// `arith` — five-op binary arithmetic
// ---------------------------------------------------------------
//
// Five operator dispatches: `+` / `-` / `*` (XPath arithmetic
// operators) plus `div` / `mod` (CCHQ-style spelled-out names that
// the SQL compiler maps to `/` and `%`). Per-op test pins each
// dispatch arm; a regression that swapped `*` for `/` would surface
// at the corresponding test.

describe("compileExpression — arith arm", () => {
	const cases: ReadonlyArray<{ op: ArithOp; sqlToken: string }> = [
		{ op: "+", sqlToken: "+" },
		{ op: "-", sqlToken: "-" },
		{ op: "*", sqlToken: "*" },
		{ op: "div", sqlToken: "/" },
		{ op: "mod", sqlToken: "%" },
	];

	for (const { op, sqlToken } of cases) {
		it(`emits the ${sqlToken} operator for arith op '${op}'`, () => {
			const compiled = compileExpression_(
				compileExpression(
					arith(op, term(literal(10)), term(literal(2))),
					makeCtx(),
				),
			);
			expect(compiled.sql).toContain(sqlToken);
			expect(compiled.parameters).toContain(10);
			expect(compiled.parameters).toContain(2);
		});
	}
});

// ---------------------------------------------------------------
// `concat` — Postgres `concat(...)` function
// ---------------------------------------------------------------
//
// Postgres's `concat(...)` function treats NULL inputs as empty
// strings (verified at
// `https://www.postgresql.org/docs/16/functions-string.html#FUNCTIONS-STRING-OTHER`).
// This NULL-tolerant behavior matches the type checker's spec at
// `lib/domain/predicate/typeChecker.ts:1525-1526` ("each part casts
// to text at evaluation, so no per-part type rule beyond
// resolution") and aligns with the on-device emitter's `concat(...)`
// dispatch. The `||` operator (string concat infix) propagates NULL
// instead and would diverge from the AST's spec.

describe("compileExpression — concat arm", () => {
	it("emits concat(...) for a multi-part concat", () => {
		const compiled = compileExpression_(
			compileExpression(
				concat(term(literal("Hello, ")), term(literal("World"))),
				makeCtx(),
			),
		);
		expect(compiled.sql.toLowerCase()).toContain("concat(");
		expect(compiled.parameters).toContain("Hello, ");
		expect(compiled.parameters).toContain("World");
	});
});

// ---------------------------------------------------------------
// `coalesce` — first-non-null fallback chain
// ---------------------------------------------------------------
//
// SQL `COALESCE(a, b, c)` returns the first non-null argument.
// Matches the AST's `coalesce` semantic ("first-non-empty fallback
// chain"); empty-string-as-null coercion lives at the AST layer
// (the validator surfaces a hint when an author writes `eq(prop,
// "")`) rather than in the SQL emission, so `COALESCE` against a
// `prop` read whose JSONB key is absent picks up the fallback —
// `IS NULL` → fallback under SQL three-valued logic.

describe("compileExpression — coalesce arm", () => {
	it("emits COALESCE(...) for a multi-value coalesce", () => {
		const compiled = compileExpression_(
			compileExpression(
				coalesce(term(literal("primary")), term(literal("fallback"))),
				makeCtx(),
			),
		);
		expect(compiled.sql.toLowerCase()).toContain("coalesce(");
		expect(compiled.parameters).toContain("primary");
		expect(compiled.parameters).toContain("fallback");
	});
});

// ---------------------------------------------------------------
// `if` — boolean-conditional value selection
// ---------------------------------------------------------------
//
// SQL `CASE WHEN <cond> THEN <then> ELSE <else> END`. The `cond`
// slot carries a `Predicate`; the compiler routes it through the
// `compilePredicate` thunk on the context. Decoupling the predicate
// compilation through a callback keeps the Expression and Predicate
// compilers structurally independent — neither imports the other.

describe("compileExpression — if arm", () => {
	it("emits CASE WHEN ... THEN ... ELSE ... END", () => {
		const { thunk } = makeStubPredicateThunk();
		const compiled = compileExpression_(
			compileExpression(
				ifExpr(
					eq(prop("patient", "name"), literal("Alice")),
					term(literal(1)),
					term(literal(0)),
				),
				makeCtx({ compilePredicate: thunk }),
			),
		);
		const sqlText = compiled.sql.toLowerCase();
		expect(sqlText).toContain("case when");
		expect(sqlText).toContain("then");
		expect(sqlText).toContain("else");
		expect(sqlText).toContain("end");
		expect(compiled.parameters).toContain(1);
		expect(compiled.parameters).toContain(0);
	});

	it("invokes the predicate thunk with the cond payload", () => {
		const { thunk, log } = makeStubPredicateThunk();
		compileExpression(
			ifExpr(
				eq(prop("patient", "name"), literal("Alice")),
				term(literal(1)),
				term(literal(0)),
			),
			makeCtx({ compilePredicate: thunk }),
		);
		expect(log).toHaveLength(1);
		expect(log[0]).toMatchObject({ kind: "eq" });
	});

	it("throws when the predicate thunk is absent and an `if` arm is reached", () => {
		expect(() =>
			compileExpression(
				ifExpr(
					eq(prop("patient", "name"), literal("Alice")),
					term(literal(1)),
					term(literal(0)),
				),
				makeCtx(),
			),
		).toThrow(/predicate/i);
	});
});

// ---------------------------------------------------------------
// `switch` — value-driven multi-case selector
// ---------------------------------------------------------------
//
// SQL `CASE WHEN <on> = <when1> THEN <then1> WHEN ... ELSE <fallback> END`.
// The `on` operand is a ValueExpression; each case's `when` is a
// Literal compared by equality; `fallback` is the no-match value.
// `switch` does NOT carry a Predicate (each `when` is a literal,
// per `switchCaseSchema` in `types.ts:867-871`), so it does not
// need the predicate thunk.

describe("compileExpression — switch arm", () => {
	it("emits CASE <on> WHEN <when> THEN <then> ... ELSE <fallback> END (simple CASE form)", () => {
		const compiled = compileExpression_(
			compileExpression(
				switchExpr(
					term(prop("patient", "age")),
					[
						switchCase(literal(18), term(literal("adult"))),
						switchCase(literal(13), term(literal("teen"))),
					],
					term(literal("child")),
				),
				makeCtx(),
			),
		);
		const sqlText = compiled.sql.toLowerCase();
		// Simple CASE: the discriminator is named once between
		// `case` and the first `when`, with no equality operator
		// between them. Match the structural shape rather than the
		// inline operand text so the assertion stays stable against
		// operand-emission tweaks.
		expect(sqlText).toMatch(/\bcase\b[\s\S]*\bwhen\b[\s\S]*\bthen\b/);
		expect(sqlText).toContain("else");
		expect(sqlText).toContain("end");
		expect(compiled.parameters).toContain(18);
		expect(compiled.parameters).toContain(13);
		expect(compiled.parameters).toContain("adult");
		expect(compiled.parameters).toContain("teen");
		expect(compiled.parameters).toContain("child");
	});

	it("emits the simple CASE discriminator exactly once (not searched CASE)", () => {
		// Pin the simple-CASE shape against a regression to
		// searched-CASE (`case when <on> = <when_1> then ...`).
		// Searched-CASE re-evaluates the discriminator per branch;
		// for an expensive `<on>` (`count(...)`, `arith(...)` over
		// joined cases) Postgres's planner does not deduplicate
		// non-idempotent operands, so a regression here would show
		// up as N relation-walk scans per row at runtime.
		//
		// The fingerprint test: a simple-CASE SQL emits the
		// discriminator exactly once between `case` and the first
		// `when`. A searched-CASE SQL emits the discriminator N
		// times — once per `when` arm. Discriminator chosen here
		// is a `count(...)` subquery so the fingerprint matches a
		// recognisable substring (`count(*)`) rather than an
		// opaque cast token.
		const compiled = compileExpression_(
			compileExpression(
				switchExpr(
					count(ancestorPath(relationStep("parent", "household"))),
					[
						switchCase(literal(0), term(literal("none"))),
						switchCase(literal(1), term(literal("one"))),
					],
					term(literal("many")),
				),
				makeCtx(),
			),
		);
		const sqlText = compiled.sql.toLowerCase();
		// Simple-CASE: the `count(*)` discriminator appears exactly
		// ONCE in the entire SQL, NOT once per `when` arm (which
		// would be 2 in this test). A regression to searched-CASE
		// would emit `count(*)` twice, failing this assertion.
		const countMatches = sqlText.match(/count\(\*\)/g) ?? [];
		expect(countMatches).toHaveLength(1);
		// Simple-CASE never has the searched-CASE shape `case
		// when` (the keyword `when` immediately following the
		// `case` keyword). Simple-CASE always has a discriminator
		// expression between `case` and the first `when`.
		expect(sqlText).not.toMatch(/\bcase\s+when\b/);
	});
});

// ---------------------------------------------------------------
// `count` — relational aggregation
// ---------------------------------------------------------------
//
// `count(via, where?)` returns the cardinality of cases reachable
// along `via` whose optional `where` predicate holds. Compiles to
// `(SELECT COUNT(*) FROM (<rp_leaf-subquery>) AS rp [WHERE <pred>])`
// — the relation-path leaf is wrapped in a counting subquery and
// the optional predicate filters the leaf rows before counting.

describe("compileExpression — count arm", () => {
	it("emits a counting subquery over the relation-path leaf", () => {
		const compiled = compileExpression_(
			compileExpression(
				count(ancestorPath(relationStep("parent", "household"))),
				makeCtx(),
			),
		);
		const sqlText = compiled.sql.toLowerCase();
		expect(sqlText).toContain("select count(*)");
		// The relation-path leaf subquery is already aliased
		// `rp_leaf` by `compileRelationPath` (per
		// `RELATION_PATH_LEAF_ALIAS`); the count's outer FROM
		// embeds that aliased expression directly so the alias
		// surfaces in the emitted SQL.
		expect(sqlText).toContain("rp_leaf");
	});

	it("threads the optional where predicate through the predicate thunk", () => {
		const { thunk, log } = makeStubPredicateThunk();
		compileExpression(
			count(
				ancestorPath(relationStep("parent", "household")),
				eq(prop("household", "size"), literal(5)),
			),
			makeCtx({ compilePredicate: thunk }),
		);
		expect(log).toHaveLength(1);
		expect(log[0]).toMatchObject({ kind: "eq" });
	});

	it("throws when count is invoked with a self via", () => {
		// `count(self)` is rejected by the type checker — the type-
		// checker's `checkRelationalQuantifier` short-circuits any
		// `via.kind === "self"` at the operator boundary before
		// reaching the SQL compiler. The compiler defends the
		// invariant with a clear error rather than emit a degenerate
		// "count anchor row" subquery.
		expect(() => compileExpression(count(selfPath()), makeCtx())).toThrow(
			/self/i,
		);
	});

	it("throws when count carries a where but no predicate thunk is supplied", () => {
		expect(() =>
			compileExpression(
				count(
					ancestorPath(relationStep("parent", "household")),
					eq(prop("household", "size"), literal(5)),
				),
				makeCtx(),
			),
		).toThrow(/predicate/i);
	});
});

// ---------------------------------------------------------------
// `date-add` — date / datetime + interval arithmetic
// ---------------------------------------------------------------
//
// SQL: `(<date>)::timestamptz + (<quantity> * INTERVAL '1 <unit>')`.
// Each `DateAddInterval` value maps to the corresponding Postgres
// interval unit name (`seconds`, `minutes`, `hours`, `days`,
// `weeks`, `months`, `years` — names are byte-identical between
// the AST enum and Postgres's interval vocabulary). A typo on a
// single arm would still pass the `toContain("INTERVAL")` check;
// the per-interval iteration pins each arm independently.

describe("compileExpression — date-add arm", () => {
	const intervals: ReadonlyArray<DateAddInterval> = [
		"seconds",
		"minutes",
		"hours",
		"days",
		"weeks",
		"months",
		"years",
	];

	for (const interval of intervals) {
		it(`binds a '1 ${interval}' interval parameter for the ${interval} arm`, () => {
			const compiled = compileExpression_(
				compileExpression(
					dateAdd(today(), interval, term(literal(1))),
					makeCtx(),
				),
			);
			const sqlText = compiled.sql.toLowerCase();
			// Typed builder casts a `'1 <unit>'` parameter to
			// Postgres `interval` rather than splicing the unit token
			// inline. The cold suite's structural check is "the
			// interval cast is present and the unit string is a
			// parameter"; the harness pins the runtime equivalence
			// against `+ INTERVAL '1 <unit>'`.
			expect(sqlText).toContain("as interval)");
			expect(compiled.parameters).toContain(`1 ${interval}`);
		});
	}
});

// ---------------------------------------------------------------
// `format-date` — Postgres `to_char` rendering
// ---------------------------------------------------------------
//
// SQL: `to_char((<date>)::timestamptz, '<pattern>')`. Postgres's
// `to_char` is documented at
// `https://www.postgresql.org/docs/16/functions-formatting.html`.
// The three preset names (`short` / `long` / `iso`) map to fixed
// Postgres patterns; arbitrary author-supplied strings pass
// through verbatim under the assumption that authors target
// Postgres's pattern vocabulary on Nova-runtime apps. This
// pass-through choice keeps the compiler reasoning purely
// dialect-aligned — Nova owns the runtime, so it owns the pattern
// vocabulary at the export boundary.

describe("compileExpression — format-date arm", () => {
	it("emits to_char with a mapped pattern for the `iso` preset", () => {
		const compiled = compileExpression_(
			compileExpression(formatDate(today(), "iso"), makeCtx()),
		);
		const sqlText = compiled.sql.toLowerCase();
		expect(sqlText).toContain("to_char");
		// `iso` → `YYYY-MM-DD` (ISO 8601 date-only).
		expect(compiled.parameters).toContain("YYYY-MM-DD");
	});

	it("emits to_char with a mapped pattern for the `short` preset", () => {
		const compiled = compileExpression_(
			compileExpression(formatDate(today(), "short"), makeCtx()),
		);
		const sqlText = compiled.sql.toLowerCase();
		expect(sqlText).toContain("to_char");
		// `short` → `MM/DD/YYYY` (locale-default short form).
		expect(compiled.parameters).toContain("MM/DD/YYYY");
	});

	it("emits to_char with a mapped pattern for the `long` preset", () => {
		const compiled = compileExpression_(
			compileExpression(formatDate(today(), "long"), makeCtx()),
		);
		const sqlText = compiled.sql.toLowerCase();
		expect(sqlText).toContain("to_char");
		// `long` → `FMMonth FMDD, YYYY` (locale-default long form;
		// `FM` prefix strips Postgres's fixed-width month padding).
		expect(compiled.parameters).toContain("FMMonth FMDD, YYYY");
	});

	it("passes a free-form pattern through verbatim", () => {
		const compiled = compileExpression_(
			compileExpression(formatDate(today(), "Day, DD-Mon-YYYY"), makeCtx()),
		);
		const sqlText = compiled.sql.toLowerCase();
		expect(sqlText).toContain("to_char");
		expect(compiled.parameters).toContain("Day, DD-Mon-YYYY");
	});
});

// ---------------------------------------------------------------
// `unwrap-list` — defensive throw (no SQL-side consumer)
// ---------------------------------------------------------------
//
// `unwrap-list` resolves to the type checker's `_sequence`
// sentinel (per `lib/domain/predicate/typeChecker.ts:1545`); no AST
// operator on the Predicate side or the Expression side consumes a
// sequence (`in.values` and `multi-select-contains.values` stay
// literal-only). The CSQL hoist pass routes the arm into
// `selected-any(prop, unwrap-list(...))` at the wire-emission
// boundary; that path does not flow through the SQL compiler.
// Reaching this arm in `compileExpression` is an invariant
// violation, so the compiler throws with a descriptive error
// rather than emit ambiguous SQL.

describe("compileExpression — unwrap-list arm", () => {
	it("throws because no AST consumer wires unwrap-list to a SQL value position", () => {
		expect(() =>
			compileExpression(unwrapList(term(prop("patient", "tags"))), makeCtx()),
		).toThrow(/unwrap-list/i);
	});
});

// ---------------------------------------------------------------
// Composition — nested expressions thread through arm dispatch
// ---------------------------------------------------------------
//
// The arms compose freely. A representative composition test
// catches regressions where one arm's emission corrupts a parent
// arm's surrounding tokens (e.g. an `arith` that left an open
// paren behind would surface as a parse error inside an
// enclosing `concat`).

describe("compileExpression — composition", () => {
	it("composes arith inside a comparison via term-bearing operands", () => {
		// `gt(arith("+", term(prop("age")), literal(1)), literal(18))`
		// — the standard "future-age check" shape from the AST docs.
		// The expression compiler emits the LHS; the assertion below
		// just verifies the LHS shape and operand binding.
		const compiled = compileExpression_(
			compileExpression(
				arith("+", term(prop("patient", "age")), term(literal(1))),
				makeCtx(),
			),
		);
		expect(compiled.sql).toContain("+");
		expect(compiled.sql).toContain("as integer)");
		expect(compiled.parameters).toContain("age");
		expect(compiled.parameters).toContain(1);
	});

	it("composes coalesce around two prop reads", () => {
		const compiled = compileExpression_(
			compileExpression(
				coalesce(term(prop("patient", "name")), term(literal("unknown"))),
				makeCtx(),
			),
		);
		expect(compiled.sql.toLowerCase()).toContain("coalesce(");
		expect(compiled.parameters).toContain("name");
		expect(compiled.parameters).toContain("unknown");
	});

	it("threads a count expression through a comparison's LHS", () => {
		// `count(...)`'s primary use site — comparison LHS — pins the
		// composition with a typed RHS literal. The Predicate compiler
		// assembles the `gt` at the integrating boundary; this test
		// verifies the count's own SQL fragment in isolation.
		void gt; // silence the `gt` import — this test composes the LHS only.
		const compiled = compileExpression_(
			compileExpression(
				count(ancestorPath(relationStep("parent", "household"))),
				makeCtx(),
			),
		);
		expect(compiled.sql.toLowerCase()).toContain("select count(*)");
	});
});
