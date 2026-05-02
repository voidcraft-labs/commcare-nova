// lib/case-store/sql/__tests__/compileExpression.harness.test.ts
//
// Execute-against-real-Postgres tests for the Expression compiler.
// Insert a small fixture, build a wider query that selects the
// compiled value-expression as a column, and assert the row-set
// matches expectations. The cold-suite sibling
// (`compileExpression.test.ts`) pins the SQL string shape; this
// file pins runtime semantics.
//
// ## Why a separate file from the cold compile-only suite
//
// Cold tests use Kysely's `DummyDriver` and assert on the
// `.compile()` output's tokens. They never execute. A regression
// that emitted `::dates` instead of `::date`, or `INTERVAL '1
// dayz'` instead of `INTERVAL '1 days'`, would still pass every
// `toContain("::date")` / `toContain("interval")` check the cold
// suite makes — Postgres rejects the typo only at parse time. This
// file's tests answer that question.
//
// ## Round-trip coverage
//
//   1. `today` / `now` constants resolve to today / current time.
//   2. `date-coerce` / `datetime-coerce` lift wire strings into
//      typed values and round-trip through ordered comparisons.
//   3. `double` casts a numeric string to numeric.
//   4. Each `arith` op resolves to the expected numeric value.
//   5. `concat` returns the concatenation; `null` parts coerce to
//      empty (matching Postgres's `concat(...)` NULL-tolerant
//      semantic and the type checker's spec).
//   6. `coalesce` returns the first non-null value.
//   7. `format-date` renders a sample pattern.
//   8. `date-add` adds the expected interval for each unit.
//   9. `count` returns the cardinality of the relation walk.
//
// `if` / `switch` / `count(where)` use a stub predicate thunk that
// emits `(true)` so the harness exercises the arm dispatch in
// isolation from the Predicate compiler's internals. The
// integrating caller wires the real predicate compiler at the
// composition boundary.

import { sql } from "kysely";
import { describe } from "vitest";
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
	formatDate,
	ifExpr,
	literal,
	now,
	prop,
	relationStep,
	switchCase,
	switchExpr,
	term,
	today,
} from "@/lib/domain/predicate/builders";
import type { DateAddInterval } from "@/lib/domain/predicate/types";
import {
	compileExpression,
	type ExpressionCompileContext,
} from "../compileExpression";
import { expect, makeCaseRow, test } from "./setup";

// ---------------------------------------------------------------
// Stable fixture IDs / schema
// ---------------------------------------------------------------

const APP_ID = "app-expression-compiler";
const OWNER_ID = "owner-expression-compiler";

const PATIENT_CASE_ID = "30000000-0000-0000-0000-000000000001";
const HOUSEHOLD_CASE_ID = "30000000-0000-0000-0000-000000000002";
const SECOND_HOUSEHOLD_CASE_ID = "30000000-0000-0000-0000-000000000003";

const PATIENT_SCHEMA: CaseType = {
	name: "patient",
	parent_type: "household",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "registered_at", label: "When", data_type: "datetime" },
	],
};

const HOUSEHOLD_SCHEMA: CaseType = {
	name: "household",
	properties: [{ name: "size", label: "Size", data_type: "int" }],
};

const SCHEMAS = new Map<string, CaseType>([
	["patient", PATIENT_SCHEMA],
	["household", HOUSEHOLD_SCHEMA],
]);

function makeCtx(
	db: ExpressionCompileContext["db"],
	overrides: Partial<ExpressionCompileContext> = {},
): ExpressionCompileContext {
	return {
		db,
		appId: APP_ID,
		ownerId: OWNER_ID,
		anchorAlias: "c",
		caseTypeSchemas: SCHEMAS,
		bindings: {},
		...overrides,
	};
}

// ---------------------------------------------------------------
// `today` / `now` constants
// ---------------------------------------------------------------

describe("compileExpression — round-trip — today / now", () => {
	test("today resolves to the current date", async ({ db }) => {
		// Run a SELECT that materializes the `today` expression and
		// compares it to Postgres's `CURRENT_DATE`. If the compiler
		// emitted the right token, the comparison resolves to true.
		const expr = compileExpression(today(), makeCtx(db));
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(sql<boolean>`${expr} = current_date`.as("matches"))
			.execute();
		expect(rows).toEqual([{ matches: true }]);
	});

	test("now resolves to the current timestamp", async ({ db }) => {
		// `now()` returns `timestamptz`; the comparison `now() <=
		// CURRENT_TIMESTAMP + 1s` rules out a constant-folded
		// regression that returned a fixed clock value.
		const expr = compileExpression(now(), makeCtx(db));
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(
				sql<boolean>`${expr} <= current_timestamp + interval '1 second' and ${expr} >= current_timestamp - interval '1 second'`.as(
					"in_window",
				),
			)
			.execute();
		expect(rows).toEqual([{ in_window: true }]);
	});
});

// ---------------------------------------------------------------
// Coercion arms
// ---------------------------------------------------------------

describe("compileExpression — round-trip — coercion arms", () => {
	test("date-coerce parses a wire string into a date", async ({ db }) => {
		const expr = compileExpression(
			dateCoerce(term(literal("2026-01-01"))),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(sql<boolean>`${expr} = date '2026-01-01'`.as("matches"))
			.execute();
		expect(rows).toEqual([{ matches: true }]);
	});

	test("datetime-coerce parses a wire string into a timestamptz", async ({
		db,
	}) => {
		const expr = compileExpression(
			datetimeCoerce(term(literal("2026-01-01T12:00:00Z"))),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(
				sql<boolean>`${expr} = timestamptz '2026-01-01 12:00:00+00'`.as(
					"matches",
				),
			)
			.execute();
		expect(rows).toEqual([{ matches: true }]);
	});

	test("double casts a numeric string to numeric", async ({ db }) => {
		// `42.5::numeric > 42` rules out a regression that emitted
		// `::int` (which would truncate) or `::text` (which would
		// fail at the comparison operator).
		const expr = compileExpression(double(term(literal("42.5"))), makeCtx(db));
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(sql<boolean>`${expr} > 42`.as("matches"))
			.execute();
		expect(rows).toEqual([{ matches: true }]);
	});
});

// ---------------------------------------------------------------
// `arith` arm — every op
// ---------------------------------------------------------------
//
// Each op resolves to a known numeric value. A regression that
// swapped `*` for `+` would surface immediately because the
// expected value differs.

describe("compileExpression — round-trip — arith arm", () => {
	const cases = [
		{ op: "+", left: 10, right: 3, expected: 13 },
		{ op: "-", left: 10, right: 3, expected: 7 },
		{ op: "*", left: 10, right: 3, expected: 30 },
		{ op: "div", left: 10, right: 3, expected: 3 }, // integer division
		{ op: "mod", left: 10, right: 3, expected: 1 },
	] as const;

	for (const { op, left, right, expected } of cases) {
		test(`arith op '${op}' resolves to the expected value`, async ({ db }) => {
			// Cast both operands to `int` at the AST layer so the
			// resulting parameter bindings carry an explicit Postgres
			// type. Without the cast, `$1 + $2` is structurally
			// untypeable in Postgres (each parameter is "unknown" and
			// the operator overload set is ambiguous), which surfaces
			// at parse time as `operator is not unique`. The
			// `data_type` slot on the literal AST is the single source
			// of truth for parameter casts; threading it here mirrors
			// how typed temporal literals (`dateLiteral` etc.) carry
			// their cast through `compileTerm`.
			const expr = compileExpression(
				arith(
					op,
					term({ kind: "literal", value: left, data_type: "int" }),
					term({ kind: "literal", value: right, data_type: "int" }),
				),
				makeCtx(db),
			);
			const rows = await db
				.selectFrom(sql`(values (1))`.as("v"))
				.select(sql<number>`${expr}`.as("v"))
				.execute();
			// pg-driver returns integer arithmetic as `number`; numeric
			// arithmetic returns `string` (Postgres's arbitrary-precision
			// numerics). Both `+` / `-` / `*` / `mod` against integer
			// literals stay integer; `div` against integer literals
			// returns integer (Postgres `/` on int operands). Cast the
			// returned value to number to compare uniformly.
			expect(Number(rows[0].v)).toBe(expected);
		});
	}
});

// ---------------------------------------------------------------
// `concat` arm
// ---------------------------------------------------------------

describe("compileExpression — round-trip — concat arm", () => {
	test("concat joins string parts in order", async ({ db }) => {
		// Cast each literal to `text` at the AST layer so the
		// resulting parameter bindings carry an explicit Postgres
		// type — bare `$1` parameters in a tableless SELECT are
		// structurally untypeable per Postgres's overload-resolution
		// rules. Same defense as the `arith` arm above.
		const expr = compileExpression(
			concat(
				term({ kind: "literal", value: "Hello, ", data_type: "text" }),
				term({ kind: "literal", value: "World", data_type: "text" }),
				term({ kind: "literal", value: "!", data_type: "text" }),
			),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(sql<string>`${expr}`.as("v"))
			.execute();
		expect(rows[0].v).toBe("Hello, World!");
	});

	test("concat treats SQL NULL parts as empty (Postgres `concat()` semantic)", async ({
		db,
	}) => {
		// Insert a row with `name` ABSENT from the JSONB document.
		// `properties->>'name'` returns SQL `NULL`; Postgres's
		// `concat(...)` coerces that to empty string. A regression to
		// `||` (NULL-propagating string concatenation) would return
		// `NULL` and the assertion below would fail.
		await db
			.insertInto("cases")
			.values(
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({}),
				}),
			)
			.execute();

		const expr = compileExpression(
			concat(
				term({ kind: "literal", value: "[", data_type: "text" }),
				term(prop("patient", "name")),
				term({ kind: "literal", value: "]", data_type: "text" }),
			),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom("cases as c")
			.where("c.case_id", "=", PATIENT_CASE_ID)
			.select(sql<string>`${expr}`.as("v"))
			.execute();
		expect(rows[0].v).toBe("[]");
	});
});

// ---------------------------------------------------------------
// `coalesce` arm
// ---------------------------------------------------------------

describe("compileExpression — round-trip — coalesce arm", () => {
	test("coalesce returns the first non-null value", async ({ db }) => {
		await db
			.insertInto("cases")
			.values(
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					// `name` ABSENT → null in SQL; coalesce should pick
					// the fallback literal.
					properties: JSON.stringify({}),
				}),
			)
			.execute();

		const expr = compileExpression(
			coalesce(term(prop("patient", "name")), term(literal("default"))),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom("cases as c")
			.where("c.case_id", "=", PATIENT_CASE_ID)
			.select(sql<string>`${expr}`.as("v"))
			.execute();
		expect(rows[0].v).toBe("default");
	});

	test("coalesce returns the first value when it is non-null", async ({
		db,
	}) => {
		await db
			.insertInto("cases")
			.values(
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: "Alice" }),
				}),
			)
			.execute();

		const expr = compileExpression(
			coalesce(term(prop("patient", "name")), term(literal("default"))),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom("cases as c")
			.where("c.case_id", "=", PATIENT_CASE_ID)
			.select(sql<string>`${expr}`.as("v"))
			.execute();
		expect(rows[0].v).toBe("Alice");
	});
});

// ---------------------------------------------------------------
// `format-date` arm
// ---------------------------------------------------------------

describe("compileExpression — round-trip — format-date arm", () => {
	// Shared fixture datetime — every preset test runs against the
	// same wall-clock instant so per-preset rendering can be compared
	// against a single expected calendar date (Saturday, 2 May 2026).
	const FIXTURE_DATETIME = "2026-05-02T12:00:00Z";

	test("format-date renders the iso preset", async ({ db }) => {
		// `iso` → `YYYY-MM-DD` per the compiler's preset map.
		const expr = compileExpression(
			formatDate(datetimeCoerce(term(literal(FIXTURE_DATETIME))), "iso"),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(sql<string>`${expr}`.as("v"))
			.execute();
		expect(rows[0].v).toBe("2026-05-02");
	});

	test("format-date renders the short preset", async ({ db }) => {
		// `short` → `MM/DD/YYYY` (locale-default short form, US
		// month/day/year ordering, slash separator). The fixture
		// datetime falls on May 2, 2026 — the rendered string is
		// the calendar-date interpretation of the timestamptz in
		// UTC (Postgres's `to_char` honors the session timezone;
		// the harness boots in UTC so the day boundary matches the
		// wire string's day component).
		const expr = compileExpression(
			formatDate(datetimeCoerce(term(literal(FIXTURE_DATETIME))), "short"),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(sql<string>`${expr}`.as("v"))
			.execute();
		expect(rows[0].v).toBe("05/02/2026");
	});

	test("format-date renders the long preset", async ({ db }) => {
		// `long` → `FMMonth FMDD, YYYY`. `FMMonth` strips Postgres's
		// fixed-width month-name fill spaces (bare `Month` would
		// return `"May       "` filled out to 9 chars); `FMDD`
		// strips the day-of-month leading zero.
		const expr = compileExpression(
			formatDate(datetimeCoerce(term(literal(FIXTURE_DATETIME))), "long"),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(sql<string>`${expr}`.as("v"))
			.execute();
		expect(rows[0].v).toBe("May 2, 2026");
	});

	test("format-date renders a custom Postgres pattern verbatim", async ({
		db,
	}) => {
		// Free-form patterns pass through to `to_char`. Authors target
		// Postgres's pattern vocabulary on Nova-runtime apps.
		const expr = compileExpression(
			formatDate(
				datetimeCoerce(term(literal(FIXTURE_DATETIME))),
				"FMDay, FMDD-Mon-YYYY",
			),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(sql<string>`${expr}`.as("v"))
			.execute();
		// `FMDay` strips trailing whitespace; `FMDD` strips leading
		// zeros. The exact rendering depends on Postgres's locale, but
		// the day-of-week string in the en-US locale is "Saturday" for
		// 2026-05-02.
		expect(rows[0].v).toMatch(/^Saturday, 2-May-2026$/);
	});
});

// ---------------------------------------------------------------
// `date-add` arm — every interval
// ---------------------------------------------------------------

describe("compileExpression — round-trip — date-add arm", () => {
	const intervals: ReadonlyArray<{
		interval: DateAddInterval;
		expectedDelta: string; // Postgres interval literal for the assertion
	}> = [
		{ interval: "seconds", expectedDelta: "1 second" },
		{ interval: "minutes", expectedDelta: "1 minute" },
		{ interval: "hours", expectedDelta: "1 hour" },
		{ interval: "days", expectedDelta: "1 day" },
		{ interval: "weeks", expectedDelta: "1 week" },
		{ interval: "months", expectedDelta: "1 month" },
		{ interval: "years", expectedDelta: "1 year" },
	];

	for (const { interval, expectedDelta } of intervals) {
		test(`date-add adds 1 ${interval} to a base datetime`, async ({ db }) => {
			const base = "2026-05-02T12:00:00Z";
			const expr = compileExpression(
				dateAdd(
					datetimeCoerce(term(literal(base))),
					interval,
					term(literal(1)),
				),
				makeCtx(db),
			);
			const rows = await db
				.selectFrom(sql`(values (1))`.as("v"))
				.select(
					sql<boolean>`${expr} = (timestamptz '${sql.raw(base)}') + interval '${sql.raw(expectedDelta)}'`.as(
						"matches",
					),
				)
				.execute();
			expect(rows).toEqual([{ matches: true }]);
		});
	}

	test("date-add accepts a negative quantity", async ({ db }) => {
		// `-1` quantity through the `arith` quantity slot exercises a
		// negative interval expression. The quantity expression's
		// value is multiplied into the interval literal at the SQL
		// layer.
		const base = "2026-05-02T12:00:00Z";
		const expr = compileExpression(
			dateAdd(datetimeCoerce(term(literal(base))), "days", term(literal(-1))),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(
				sql<boolean>`${expr} = (timestamptz '${sql.raw(base)}') - interval '1 day'`.as(
					"matches",
				),
			)
			.execute();
		expect(rows).toEqual([{ matches: true }]);
	});
});

// ---------------------------------------------------------------
// `count` arm
// ---------------------------------------------------------------

describe("compileExpression — round-trip — count arm", () => {
	test("count returns the cardinality of the ancestor walk", async ({ db }) => {
		// Graph: patient --[parent]--> household. Insert one ancestor
		// edge; the count should return 1.
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({}),
				}),
				makeCaseRow({
					case_id: HOUSEHOLD_CASE_ID,
					case_type: "household",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ size: 4 }),
				}),
			])
			.execute();
		await db
			.insertInto("case_indices")
			.values({
				case_id: PATIENT_CASE_ID,
				ancestor_id: HOUSEHOLD_CASE_ID,
				identifier: "parent",
				relationship: "child",
				depth: 1,
			})
			.execute();

		const expr = compileExpression(
			count(ancestorPath(relationStep("parent", "household"))),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom("cases as c")
			.where("c.case_id", "=", PATIENT_CASE_ID)
			.select(sql<number>`${expr}`.as("v"))
			.execute();
		expect(Number(rows[0].v)).toBe(1);
	});

	test("count returns zero when no ancestor matches", async ({ db }) => {
		// Same graph as above but the patient has no `case_indices`
		// row at all — the relation walk returns the empty leaf set;
		// `COUNT(*)` over the empty set returns zero.
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({}),
				}),
				makeCaseRow({
					case_id: HOUSEHOLD_CASE_ID,
					case_type: "household",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ size: 4 }),
				}),
			])
			.execute();

		const expr = compileExpression(
			count(ancestorPath(relationStep("parent", "household"))),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom("cases as c")
			.where("c.case_id", "=", PATIENT_CASE_ID)
			.select(sql<number>`${expr}`.as("v"))
			.execute();
		expect(Number(rows[0].v)).toBe(0);
	});

	test("count threads the predicate thunk and filters leaf rows", async ({
		db,
	}) => {
		// Graph: patient with two parent households of different
		// sizes. The predicate thunk emits `(size = 4)` so only the
		// matching household is counted. Without the thunk routing,
		// the count would return 2.
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({}),
				}),
				makeCaseRow({
					case_id: HOUSEHOLD_CASE_ID,
					case_type: "household",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ size: 4 }),
				}),
				makeCaseRow({
					case_id: SECOND_HOUSEHOLD_CASE_ID,
					case_type: "household",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ size: 7 }),
				}),
			])
			.execute();
		await db
			.insertInto("case_indices")
			.values([
				{
					case_id: PATIENT_CASE_ID,
					ancestor_id: HOUSEHOLD_CASE_ID,
					identifier: "parent",
					relationship: "child",
					depth: 1,
				},
				{
					case_id: PATIENT_CASE_ID,
					ancestor_id: SECOND_HOUSEHOLD_CASE_ID,
					identifier: "parent",
					relationship: "child",
					depth: 1,
				},
			])
			.execute();

		// Stub thunk that hand-emits the JSONB predicate against the
		// leaf alias. The leaf alias for the count subquery is the
		// inner `rp_leaf` alias (per `compileRelationPath`). The
		// stub's signature mirrors what an integrating caller would
		// compose with the real predicate compiler.
		const stub: ExpressionCompileContext["compilePredicate"] = (_p, _ctx) =>
			sql`("rp_leaf"."properties" ->> 'size')::int = 4`;

		const expr = compileExpression(
			count(
				ancestorPath(relationStep("parent", "household")),
				// Predicate body is unused in the stub — the stub emits
				// a fixed SQL fragment regardless. The arm dispatch is
				// what's under test.
				{ kind: "match-all" },
			),
			makeCtx(db, { compilePredicate: stub }),
		);
		const rows = await db
			.selectFrom("cases as c")
			.where("c.case_id", "=", PATIENT_CASE_ID)
			.select(sql<number>`${expr}`.as("v"))
			.execute();
		expect(Number(rows[0].v)).toBe(1);
	});
});

// ---------------------------------------------------------------
// `if` / `switch` — predicate-bearing arms (stub thunk)
// ---------------------------------------------------------------

describe("compileExpression — round-trip — if / switch arms", () => {
	test("if branches by the predicate thunk's verdict", async ({ db }) => {
		// Stub thunk emits a fixed `false` so the `else` branch wins.
		// An integrating caller would supply the real predicate
		// compiler in this slot; this test only verifies arm dispatch.
		const stub: ExpressionCompileContext["compilePredicate"] = () =>
			sql`(false)`;
		// Use the `ifExpr` builder rather than an inline object
		// literal — building the AST through the builder keeps the
		// `then` / `else` slots inside the builder's
		// `noThenProperty`-suppressed scope.
		const expr = compileExpression(
			ifExpr(
				{ kind: "match-all" },
				term({ kind: "literal", value: "then", data_type: "text" }),
				term({ kind: "literal", value: "else", data_type: "text" }),
			),
			makeCtx(db, { compilePredicate: stub }),
		);
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(sql<string>`${expr}`.as("v"))
			.execute();
		expect(rows[0].v).toBe("else");
	});

	test("switch picks the first matching case's then value", async ({ db }) => {
		const expr = compileExpression(
			switchExpr(
				term(literal("medium")),
				[
					switchCase(literal("low"), term(literal(1))),
					switchCase(literal("medium"), term(literal(5))),
					switchCase(literal("high"), term(literal(10))),
				],
				term(literal(0)),
			),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(sql<number>`${expr}`.as("v"))
			.execute();
		expect(Number(rows[0].v)).toBe(5);
	});

	test("switch falls back when no case matches", async ({ db }) => {
		const expr = compileExpression(
			switchExpr(
				term(literal("unknown")),
				[
					switchCase(literal("low"), term(literal(1))),
					switchCase(literal("medium"), term(literal(5))),
				],
				term(literal(99)),
			),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(sql<number>`${expr}`.as("v"))
			.execute();
		expect(Number(rows[0].v)).toBe(99);
	});
});
