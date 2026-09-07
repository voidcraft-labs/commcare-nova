// Execute compiled expressions against Postgres; assert values, types, and row correlation.

import { sql } from "kysely";
import { describe } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { CaseType } from "@/lib/domain";
import {
	ancestorPath,
	anyRelationPath,
	arith,
	coalesce,
	concat,
	count,
	dateAdd,
	dateCoerce,
	datetimeCoerce,
	datetimeLiteral,
	double,
	eq,
	formatDate,
	formField,
	ifExpr,
	input,
	literal,
	matchNone,
	now,
	prop,
	qualifiedLiteral,
	relationStep,
	selfPath,
	switchCase,
	switchExpr,
	term,
	today,
} from "@/lib/domain/predicate/builders";
import type {
	DateAddInterval,
	ValueExpression,
} from "@/lib/domain/predicate/types";
import { proseText } from "@/lib/domain/prose";
import { evaluate } from "@/lib/preview/xpath/evaluator";
import type { EvalContext } from "@/lib/preview/xpath/types";
import {
	compileExpression,
	type ExpressionCompileContext,
} from "../compileExpression";
import { compilePredicate } from "../compilePredicate";
import { expect, makeCaseRow, test } from "./setup";

// ---------------------------------------------------------------
// Stable fixture IDs / schema
// ---------------------------------------------------------------

const APP_ID = "app-expression-compiler";
const OWNER_ID = "owner-expression-compiler";

const PATIENT_CASE_ID = "30000000-0000-0000-0000-000000000001";
const HOUSEHOLD_CASE_ID = "30000000-0000-0000-0000-000000000002";
const SECOND_HOUSEHOLD_CASE_ID = "30000000-0000-0000-0000-000000000003";
const GUARDIAN_CASE_ID = "30000000-0000-0000-0000-000000000004";

const PATIENT_SCHEMA: CaseType = {
	name: "patient",
	parent_type: "household",
	properties: [
		{ name: "nickname", label: proseText("Nickname"), data_type: "text" },
		{ name: "age", label: proseText("Age"), data_type: "int" },
		{ name: "registered_at", label: proseText("When"), data_type: "datetime" },
	],
};

const HOUSEHOLD_SCHEMA: CaseType = {
	name: "household",
	properties: [{ name: "size", label: proseText("Size"), data_type: "int" }],
};

const GUARDIAN_SCHEMA: CaseType = {
	name: "guardian",
	properties: [
		{ name: "rating", label: proseText("Rating"), data_type: "int" },
	],
};

const SCHEMAS = new Map<string, CaseType>([
	["patient", PATIENT_SCHEMA],
	["household", HOUSEHOLD_SCHEMA],
	["guardian", GUARDIAN_SCHEMA],
]);

function makeCtx(
	db: ExpressionCompileContext["db"],
	overrides: Partial<ExpressionCompileContext> = {},
): ExpressionCompileContext {
	return {
		db,
		appId: APP_ID,
		projectId: OWNER_ID,
		anchorAlias: "c",
		currentCaseType: "patient",
		caseTypeSchemas: SCHEMAS,
		bindings: {},
		compilePredicate: (predicate, context) =>
			compilePredicate(predicate, context),
		...overrides,
	};
}

describe("compileExpression — round-trip — form bindings", () => {
	test("preserves a multi-select answer as a JSONB array for operation writes", async ({
		db,
	}) => {
		const fieldUuid = testUuid("44444444-4444-4444-8444-444444444444");
		const expr = compileExpression(
			term(formField(fieldUuid)),
			makeCtx(db, {
				bindings: {
					formFields: new Map([[fieldUuid, ["urgent", "review"]]]),
				},
			}),
		);
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(sql<unknown>`${expr}`.as("answer"))
			.execute();

		expect(rows).toEqual([{ answer: ["urgent", "review"] }]);
	});
});

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

	test("datetime-coerce treats a date-only value as UTC midnight in a non-UTC session", async ({
		db,
		pgClient,
	}) => {
		// CCHQ's CSQL `datetime('2026-01-01')` is explicitly UTC. A bare
		// Postgres text→timestamptz cast would instead use this session zone
		// and shift the instant to 08:00Z.
		await pgClient.query("SET LOCAL TIME ZONE 'America/Los_Angeles'");
		const expr = compileExpression(
			datetimeCoerce(term(literal("2026-01-01"))),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(
				sql<boolean>`${expr} = timestamptz '2026-01-01 00:00:00+00'`.as(
					"matches",
				),
			)
			.execute();
		expect(rows).toEqual([{ matches: true }]);
	});

	test("datetime-coerce treats a naive datetime-with-time as UTC in a non-UTC session", async ({
		db,
		pgClient,
	}) => {
		// CCHQ resolves a zone-less datetime on its UTC servers; the bare
		// `timestamptz` cast this arm previously fell to would instead read
		// 20:00 as Los Angeles wall time and shift the instant to 04:00Z.
		await pgClient.query("SET LOCAL TIME ZONE 'America/Los_Angeles'");
		const expr = compileExpression(
			datetimeCoerce(term(literal("2026-01-01 20:00:00"))),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(
				sql<boolean>`${expr} = timestamptz '2026-01-01 20:00:00+00'`.as(
					"matches",
				),
			)
			.execute();
		expect(rows).toEqual([{ matches: true }]);
	});

	test("datetime-coerce pins every non-padded naive spelling Postgres accepts", async ({
		db,
		pgClient,
	}) => {
		// The naive-shape grammar must cover single-digit month/day/
		// hour/minute/second and a run-of-spaces separator — any naive
		// spelling it misses falls to the bare `timestamptz` arm and
		// silently re-inherits the session zone.
		await pgClient.query("SET LOCAL TIME ZONE 'America/Los_Angeles'");
		const spellings: ReadonlyArray<[spelling: string, expected: string]> = [
			["2026-1-1", "2026-01-01 00:00:00+00"],
			["2026-01-01 20:00", "2026-01-01 20:00:00+00"],
			["2026-01-01 8:00:00", "2026-01-01 08:00:00+00"],
			["2026-01-01  20:00:00", "2026-01-01 20:00:00+00"],
			["2026-1-1T20:0:0", "2026-01-01 20:00:00+00"],
		];
		for (const [spelling, expected] of spellings) {
			const expr = compileExpression(
				datetimeCoerce(term(literal(spelling))),
				makeCtx(db),
			);
			const rows = await db
				.selectFrom(sql`(values (1))`.as("v"))
				.select(
					sql<boolean>`${expr} = timestamptz ${sql.lit(expected)}`.as(
						"matches",
					),
				)
				.execute();
			expect(rows, spelling).toEqual([{ matches: true }]);
		}
	});

	test("a naive datetime literal is UTC in a non-UTC session", async ({
		db,
		pgClient,
	}) => {
		// The `data_type: "datetime"` literal cast shares CSQL's naive→UTC
		// contract; the decision is static because the value is known at
		// compile time.
		await pgClient.query("SET LOCAL TIME ZONE 'America/Los_Angeles'");
		const expr = compileExpression(
			term(datetimeLiteral("2026-01-01T20:00:00")),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(
				sql<boolean>`${expr} = timestamptz '2026-01-01 20:00:00+00'`.as(
					"matches",
				),
			)
			.execute();
		expect(rows).toEqual([{ matches: true }]);
	});

	test("datetime-coerce preserves an explicit datetime offset in a non-UTC session", async ({
		db,
		pgClient,
	}) => {
		await pgClient.query("SET LOCAL TIME ZONE 'America/Los_Angeles'");
		const expr = compileExpression(
			datetimeCoerce(term(literal("2026-01-01T12:00:00-05:00"))),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(
				sql<boolean>`${expr} = timestamptz '2026-01-01 17:00:00+00'`.as(
					"matches",
				),
			)
			.execute();
		expect(rows).toEqual([{ matches: true }]);
	});

	test("date-coerce over a date-shaped operand is identity", async ({ db }) => {
		// The redundant-but-sound shape derived property typing keeps
		// legal: an explicit coerce around a value that's already a
		// date. `date::date` is identity in Postgres, matching the
		// on-device evaluator (JavaRosa `date()` of a date is itself).
		const expr = compileExpression(
			dateCoerce(dateCoerce(term(literal("2026-01-01")))),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(sql<boolean>`${expr} = date '2026-01-01'`.as("matches"))
			.execute();
		expect(rows).toEqual([{ matches: true }]);
	});

	test("datetime-coerce over a datetime-shaped operand is identity", async ({
		db,
	}) => {
		const expr = compileExpression(
			datetimeCoerce(datetimeCoerce(term(literal("2026-01-01T12:00:00Z")))),
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

	test("date-coerce over a datetime-shaped operand truncates to the date", async ({
		db,
	}) => {
		// `timestamptz::date` truncates time-of-day. The on-device arm
		// agrees observationally: JavaRosa comparisons coerce every
		// date to whole days (`XPathCmpExpr` → `FunctionUtils::
		// toNumeric` → `DateUtils::daysSinceEpoch`), so a device
		// filter comparing this coercion sees the same day-granular
		// value Postgres computes here. The expected side re-runs the
		// same cast in the same session (a `timestamptz → date`
		// truncation is session-time-zone-relative, so a calendar-day
		// literal would flip on far-east-of-UTC servers); the
		// assertion still proves the compiled expression parses,
		// yields a DATE, and equals the truncation.
		const expr = compileExpression(
			dateCoerce(datetimeCoerce(term(literal("2026-01-01T12:00:00Z")))),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(
				sql<boolean>`${expr} = (timestamptz '2026-01-01 12:00:00+00')::date`.as(
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
			.select(sql<boolean>`${expr} = 42.5`.as("matches"))
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

describe("compileExpression — arithmetic", () => {
	test("bound numeric answers keep declared types for all operators", async ({
		db,
	}) => {
		const left = testUuid("arithmetic-left");
		const right = testUuid("arithmetic-right");
		for (const [type, a, b, quotient, remainder] of [
			["int", "10", "3", 3, 1],
			["int", "-10", "3", -3, -1],
			["int", "10", "-3", -3, 1],
			["int", "-10", "-3", 3, -1],
			["int", "2147483648", "3", 715827882, 2],
			["decimal", "10", "3", 10 / 3, 1],
			["decimal", "10.5", "3", 3.5, 1.5],
		] as const) {
			const ctx = {
				...makeCtx(db),
				formFieldTypes: new Map([
					[left, type],
					[right, "int" as const],
				]),
				bindings: {
					formFields: new Map([
						[left, a],
						[right, b],
					]),
				},
			};
			for (const [op, expected] of [
				["div", quotient],
				["mod", remainder],
				["+", Number(a) + Number(b)],
				["-", Number(a) - Number(b)],
				["*", Number(a) * Number(b)],
			] as const) {
				const expression = arith(
					op,
					term(formField(left)),
					term(formField(right)),
				);
				const row = await db
					.selectNoFrom(compileExpression(expression, ctx).as("value"))
					.executeTakeFirstOrThrow();
				expect(typeof row.value).not.toBe("boolean");
				expect(Number(row.value)).toBe(expected);
			}
		}
	});
	test("evaluates ordinary numeric literals and preserves integer versus decimal operations", async ({
		db,
	}) => {
		const cases: ReadonlyArray<[ValueExpression, number | null]> = [
			[arith("+", term(literal(10)), term(literal(3))), 13],
			[arith("-", term(literal(10)), term(literal(3))), 7],
			[arith("*", term(literal(10)), term(literal(3))), 30],
			[arith("div", term(literal(10)), term(literal(3))), 3],
			[arith("mod", term(literal(10)), term(literal(3))), 1],
			[arith("div", term(literal(10.5)), term(literal(3))), 3.5],
			[arith("div", term(literal(2147483648)), term(literal(3))), 715827882],
			[
				arith("div", term(qualifiedLiteral(10, "decimal")), term(literal(3))),
				10 / 3,
			],
			[arith("+", term(literal(10)), term(literal(0.5))), 10.5],
			[arith("-", term(literal(-2147483649)), term(literal(1))), -2147483650],
			[arith("+", term(literal(2147483648)), term(literal(1))), 2147483649],
			[
				arith(
					"*",
					arith("+", term(literal(2)), term(literal(3))),
					term(literal(4)),
				),
				20,
			],
			[
				arith(
					"-",
					term(literal(10)),
					arith("-", term(literal(5)), term(literal(2))),
				),
				7,
			],
			[
				arith(
					"+",
					coalesce(term(literal(null)), term(literal(2))),
					term(literal(3)),
				),
				5,
			],
			[arith("+", term(literal(null)), term(literal(1))), null],
		];
		for (const [expression, expected] of cases) {
			const row = await db
				.selectNoFrom(compileExpression(expression, makeCtx(db)).as("value"))
				.executeTakeFirstOrThrow();
			expect(
				row.value === null ? null : Number(row.value),
				JSON.stringify(expression),
			).toBe(expected);
		}
	});
});

// ---------------------------------------------------------------
// `concat` arm
// ---------------------------------------------------------------

describe("compileExpression — round-trip — concat arm", () => {
	test("single bare literal part executes with an inferred text parameter type", async ({
		db,
	}) => {
		// This is the exact default shape authored by Combined text before the
		// user fills its first part. PostgreSQL cannot infer the type of a lone
		// prepared parameter in `concat($1)`; the compiler must emit the AST's
		// declared per-part text cast rather than requiring UI-authored literals
		// to carry a redundant data_type annotation.
		const expr = compileExpression(concat(term(literal(""))), makeCtx(db));
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(sql<string>`${expr}`.as("v"))
			.execute();

		expect(rows).toEqual([{ v: "" }]);
	});

	test("concat joins string parts in order", async ({ db }) => {
		const expr = compileExpression(
			concat(
				term(literal("Hello, ")),
				term(literal("World")),
				term(literal("!")),
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
		// `properties->>'nickname'` returns SQL `NULL`; Postgres's
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
					project_id: OWNER_ID,
					properties: JSON.stringify({}),
				}),
			)
			.execute();

		const expr = compileExpression(
			concat(
				term(literal("[")),
				term(prop("patient", "nickname")),
				term(literal("]")),
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
					project_id: OWNER_ID,
					// `name` ABSENT → null in SQL; coalesce should pick
					// the fallback literal.
					properties: JSON.stringify({}),
				}),
			)
			.execute();

		const expr = compileExpression(
			coalesce(term(prop("patient", "nickname")), term(literal("default"))),
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
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "Alice" }),
				}),
			)
			.execute();

		const expr = compileExpression(
			coalesce(term(prop("patient", "nickname")), term(literal("default"))),
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

	test("a custom JavaRosa pattern renders identically in Preview and Postgres", async ({
		db,
		pgClient,
	}) => {
		await pgClient.query("SET LOCAL TIME ZONE 'UTC'");
		const customDatetime = "2026-08-05T03:04:05.123Z";
		const pattern =
			"%Y|%y|%m|%n|%B|%b|%d|%e|%H|%h|%M|%S|%3|%A|%a|%w|%Z|%%|Day DD";
		const expr = compileExpression(
			formatDate(datetimeCoerce(term(literal(customDatetime))), pattern),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(sql<string>`${expr}`.as("v"))
			.execute();
		const previousTimeZone = process.env.TZ;
		process.env.TZ = "UTC";
		try {
			const previewValue = evaluate(
				`format-date('${customDatetime}', '${pattern}')`,
				EMPTY_PREVIEW_CONTEXT,
			);
			expect(rows[0].v).toBe(previewValue);
			expect(rows[0].v).toBe(
				"2026|26|08|8|August|Aug|05|5|03|3|04|05|123|Wednesday|Wed|3|Z|%|Day DD",
			);
		} finally {
			if (previousTimeZone === undefined) {
				delete process.env.TZ;
			} else {
				process.env.TZ = previousTimeZone;
			}
		}
	});

	test("format-date renders viewer-zone wall time, independent of the session zone", async ({
		db,
		pgClient,
	}) => {
		// 12:00Z on 2 May 2026 is 05:00 in Los Angeles (PDT, UTC-7). The
		// session zone is deliberately somewhere else entirely — rendering
		// must read the viewer binding, never the connection `TimeZone`.
		await pgClient.query("SET LOCAL TIME ZONE 'Asia/Tokyo'");
		const expr = compileExpression(
			formatDate(
				datetimeCoerce(term(literal(FIXTURE_DATETIME))),
				"%Y-%m-%d %H:%M %Z",
			),
			makeCtx(db, {
				bindings: { viewerTimeZone: "America/Los_Angeles" },
			}),
		);
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(sql<string>`${expr}`.as("v"))
			.execute();
		expect(rows[0].v).toBe("2026-05-02 05:00 -07");
	});

	test("format-date reads a naive stored value as viewer wall time (stable round-trip)", async ({
		db,
		pgClient,
	}) => {
		// A zone-less stored string means wall time on the device; parsing
		// AND rendering in the viewer zone keeps it stable (09:30 in,
		// 09:30 out) instead of shifting by session-vs-viewer offsets.
		await pgClient.query("SET LOCAL TIME ZONE 'Asia/Tokyo'");
		const expr = compileExpression(
			formatDate(term(literal("2026-05-02 09:30:00")), "%H:%M"),
			makeCtx(db, {
				bindings: { viewerTimeZone: "America/Los_Angeles" },
			}),
		);
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(sql<string>`${expr}`.as("v"))
			.execute();
		expect(rows[0].v).toBe("09:30");
	});

	test("format-date falls back to UTC when no viewer timezone is bound", async ({
		db,
		pgClient,
	}) => {
		await pgClient.query("SET LOCAL TIME ZONE 'Asia/Tokyo'");
		const expr = compileExpression(
			formatDate(datetimeCoerce(term(literal(FIXTURE_DATETIME))), "%H:%M %Z"),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(sql<string>`${expr}`.as("v"))
			.execute();
		expect(rows[0].v).toBe("12:00 Z");
	});

	test("format-date treats an unrecognized viewer timezone as UTC", async ({
		db,
	}) => {
		const expr = compileExpression(
			formatDate(datetimeCoerce(term(literal(FIXTURE_DATETIME))), "%H:%M"),
			makeCtx(db, { bindings: { viewerTimeZone: "Not/AZone" } }),
		);
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(sql<string>`${expr}`.as("v"))
			.execute();
		expect(rows[0].v).toBe("12:00");
	});

	test("format-date rejects an offset-style viewer timezone (UTC fallback, never sign-inverted)", async ({
		db,
	}) => {
		// ICU accepts bare offset spellings like "+05:30", but Postgres
		// `timezone(...)` reads them with the POSIX-inverted sign (5½ hours
		// WEST). Passing the Intl-validated string through would render
		// 06:30; honoring it as IANA-east would render 17:30. The gate must
		// do neither — the shape check rejects it and falls back to UTC.
		const expr = compileExpression(
			formatDate(datetimeCoerce(term(literal(FIXTURE_DATETIME))), "%H:%M %Z"),
			makeCtx(db, { bindings: { viewerTimeZone: "+05:30" } }),
		);
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(sql<string>`${expr}`.as("v"))
			.execute();
		expect(rows[0].v).toBe("12:00 Z");
	});

	test("format-date renders a half-hour viewer zone with the paired %Z offset", async ({
		db,
		pgClient,
	}) => {
		await pgClient.query("SET LOCAL TIME ZONE 'Asia/Tokyo'");
		const expr = compileExpression(
			formatDate(datetimeCoerce(term(literal(FIXTURE_DATETIME))), "%H:%M %Z"),
			makeCtx(db, { bindings: { viewerTimeZone: "Asia/Kolkata" } }),
		);
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(sql<string>`${expr}`.as("v"))
			.execute();
		expect(rows[0].v).toBe("17:30 +05:30");
	});
});

const EMPTY_PREVIEW_CONTEXT: EvalContext = {
	getValue: () => undefined,
	resolveHashtag: () => "",
	contextPath: "/data/current",
	position: 1,
};

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

	test("date-add keeps a date result and floors a negative fractional day", async ({
		db,
	}) => {
		const expr = compileExpression(
			dateAdd(
				dateCoerce(term(literal("2026-05-02"))),
				"days",
				term(literal(-0.5)),
			),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select([
				sql<boolean>`${expr} = date '2026-05-01'`.as("matches"),
				sql<boolean>`pg_typeof(${expr}) = 'date'::regtype`.as("is_date"),
			])
			.execute();
		expect(rows).toEqual([{ matches: true, is_date: true }]);
	});

	test("date-add preserves a pre-epoch date after a sub-day addition", async ({
		db,
	}) => {
		const expr = compileExpression(
			dateAdd(
				dateCoerce(term(literal("1969-12-31"))),
				"hours",
				term(literal(12)),
			),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select(sql<boolean>`${expr} = date '1969-12-31'`.as("matches"))
			.execute();
		expect(rows).toEqual([{ matches: true }]);
	});

	test("date-add keeps a datetime result and its time of day", async ({
		db,
	}) => {
		const expr = compileExpression(
			dateAdd(
				datetimeCoerce(term(literal("2026-05-02T12:30:00Z"))),
				"minutes",
				term(literal(30)),
			),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select([
				sql<boolean>`${expr} = timestamptz '2026-05-02T13:00:00Z'`.as(
					"matches",
				),
				sql<boolean>`pg_typeof(${expr}) = 'timestamp with time zone'::regtype`.as(
					"is_datetime",
				),
			])
			.execute();
		expect(rows).toEqual([{ matches: true, is_datetime: true }]);
	});

	for (const [interval, expected] of [
		["months", "2024-02-29T12:30:00Z"],
		["years", "2025-01-31T12:30:00Z"],
	] as const) {
		test(`date-add accepts an integral decimal runtime binding for ${interval}`, async ({
			db,
		}) => {
			const expr = compileExpression(
				dateAdd(
					datetimeCoerce(term(literal("2024-01-31T12:30:00Z"))),
					interval,
					double(term(input(testUuid("calendar_quantity")))),
				),
				makeCtx(db, {
					bindings: {
						searchInputs: new Map([[testUuid("calendar_quantity"), "1.0"]]),
					},
				}),
			);
			const rows = await db
				.selectFrom(sql`(values (1))`.as("v"))
				.select(
					sql<boolean>`${expr} = timestamptz '${sql.raw(expected)}'`.as(
						"matches",
					),
				)
				.execute();
			expect(rows).toEqual([{ matches: true }]);
		});
	}

	for (const interval of ["months", "years"] as const) {
		test(`date-add rejects a non-integral decimal runtime binding for ${interval}`, async ({
			db,
		}) => {
			const expr = compileExpression(
				dateAdd(
					datetimeCoerce(term(literal("2024-01-31T12:30:00Z"))),
					interval,
					double(term(input(testUuid("calendar_quantity")))),
				),
				makeCtx(db, {
					bindings: {
						searchInputs: new Map([[testUuid("calendar_quantity"), "1.5"]]),
					},
				}),
			);
			await expect(
				db
					.selectFrom(sql`(values (1))`.as("v"))
					.select(expr.as("shifted"))
					.execute(),
			).rejects.toThrow(/invalid input syntax for type integer/i);
		});
	}
});

// ---------------------------------------------------------------
// `count` arm
// ---------------------------------------------------------------

describe("compileExpression — round-trip — count arm", () => {
	test("count(self) is one and its where clause gates that one row", async ({
		db,
	}) => {
		const one = compileExpression(count(selfPath()), makeCtx(db));
		const falseCount = compileExpression(
			count(selfPath(), matchNone()),
			makeCtx(db),
		);
		const trueCount = compileExpression(
			count(selfPath(), { kind: "match-all" }),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom(sql`(values (1))`.as("v"))
			.select([
				sql<number>`${one}`.as("one"),
				sql<number>`${falseCount}`.as("zero"),
				sql<number>`${trueCount}`.as("filtered_one"),
			])
			.execute();
		expect(Number(rows[0].one)).toBe(1);
		expect(Number(rows[0].zero)).toBe(0);
		expect(Number(rows[0].filtered_one)).toBe(1);
	});

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
					project_id: OWNER_ID,
					properties: JSON.stringify({}),
				}),
				makeCaseRow({
					case_id: HOUSEHOLD_CASE_ID,
					case_type: "household",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ size: 4 }),
				}),
			])
			.execute();
		await db
			.insertInto("case_indices")
			.values({
				case_id: PATIENT_CASE_ID,
				ancestor_id: HOUSEHOLD_CASE_ID,
				target_case_type: "household",
				identifier: "parent",
				relationship: "child",
				depth: 1,
			})
			.execute();

		const expr = compileExpression(
			count(ancestorPath(relationStep("parent", "household"))),
			makeCtx(db),
		);
		const arithmeticCount = compileExpression(
			arith(
				"div",
				arith(
					"*",
					count(
						ancestorPath(relationStep("parent")),
						eq(prop("household", "size"), literal(4)),
					),
					term(literal(10)),
				),
				term(literal(3)),
			),
			{ ...makeCtx(db), currentCaseType: "patient" },
		);
		const rows = await db
			.selectFrom("cases as c")
			.where("c.case_id", "=", PATIENT_CASE_ID)
			.select([
				sql<number>`${expr}`.as("v"),
				arithmeticCount.as("arithmetic_count"),
			])
			.execute();
		expect(Number(rows[0].v)).toBe(1);
		expect(Number(rows[0].arithmetic_count)).toBe(3);
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
					project_id: OWNER_ID,
					properties: JSON.stringify({}),
				}),
				makeCaseRow({
					case_id: HOUSEHOLD_CASE_ID,
					case_type: "household",
					app_id: APP_ID,
					project_id: OWNER_ID,
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
					project_id: OWNER_ID,
					properties: JSON.stringify({}),
				}),
				makeCaseRow({
					case_id: HOUSEHOLD_CASE_ID,
					case_type: "household",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ size: 4 }),
				}),
				makeCaseRow({
					case_id: SECOND_HOUSEHOLD_CASE_ID,
					case_type: "household",
					app_id: APP_ID,
					project_id: OWNER_ID,
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
					target_case_type: "household",
					identifier: "parent",
					relationship: "child",
					depth: 1,
				},
				{
					case_id: PATIENT_CASE_ID,
					ancestor_id: SECOND_HOUSEHOLD_CASE_ID,
					target_case_type: "household",
					identifier: "parent",
					relationship: "child",
					depth: 1,
				},
			])
			.execute();

		const expr = compileExpression(
			count(
				ancestorPath(relationStep("parent", "household")),
				eq(prop("household", "size"), literal(4)),
			),
			makeCtx(db),
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
// Relational property reads used by calculated columns / sort keys
// ---------------------------------------------------------------

describe("compileExpression — round-trip — relational term arm", () => {
	test("an unqualified either-direction read resolves its unique parent", async ({
		db,
	}) => {
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
				}),
				makeCaseRow({
					case_id: HOUSEHOLD_CASE_ID,
					case_type: "household",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ size: 7 }),
				}),
			])
			.execute();
		await db
			.insertInto("case_indices")
			.values({
				case_id: PATIENT_CASE_ID,
				ancestor_id: HOUSEHOLD_CASE_ID,
				target_case_type: "household",
				identifier: "parent",
				relationship: "child",
				depth: 1,
			})
			.execute();

		const expression = compileExpression(
			term(prop("patient", "size", anyRelationPath("parent"))),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom("cases as c")
			.where("c.case_id", "=", PATIENT_CASE_ID)
			.select(sql<number>`${expression}`.as("v"))
			.execute();
		expect(Number(rows[0].v)).toBe(7);
	});

	test("a custom ancestor read uses its explicit destination instead of the parent graph", async ({
		db,
	}) => {
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
				}),
				makeCaseRow({
					case_id: GUARDIAN_CASE_ID,
					case_type: "guardian",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ rating: 9 }),
				}),
			])
			.execute();
		await db
			.insertInto("case_indices")
			.values({
				case_id: PATIENT_CASE_ID,
				ancestor_id: GUARDIAN_CASE_ID,
				target_case_type: "guardian",
				identifier: "guardian_link",
				relationship: "child",
				depth: 1,
			})
			.execute();

		const expression = compileExpression(
			term(
				prop(
					"patient",
					"rating",
					ancestorPath(relationStep("guardian_link", "guardian")),
				),
			),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom("cases as c")
			.where("c.case_id", "=", PATIENT_CASE_ID)
			.select(sql<number>`${expression}`.as("v"))
			.execute();
		expect(Number(rows[0].v)).toBe(9);
	});
});

// ---------------------------------------------------------------
// `if` / `switch` — predicate-bearing arms (stub thunk)
// ---------------------------------------------------------------

describe("compileExpression — round-trip — if / switch arms", () => {
	test("if branches by the predicate thunk's verdict", async ({ db }) => {
		const expr = compileExpression(
			ifExpr(matchNone(), term(literal("then")), term(literal("else"))),
			makeCtx(db),
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

	test("switch dispatches simple CASE end-to-end against an outer-row property discriminator", async ({
		db,
	}) => {
		const PATIENT_LOW = "60000000-0000-0000-0000-000000000001";
		const PATIENT_MEDIUM = "60000000-0000-0000-0000-000000000002";
		const PATIENT_HIGH = "60000000-0000-0000-0000-000000000003";
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_LOW,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ age: 5 }),
				}),
				makeCaseRow({
					case_id: PATIENT_MEDIUM,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ age: 30 }),
				}),
				makeCaseRow({
					case_id: PATIENT_HIGH,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ age: 80 }),
				}),
			])
			.execute();
		const expr = compileExpression(
			switchExpr(
				term(prop("patient", "age")),
				[
					switchCase(literal(5), term(literal("low"))),
					switchCase(literal(30), term(literal("medium"))),
					switchCase(literal(30), term(literal("duplicate"))),
				],
				term(literal("high")),
			),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom("cases as c")
			.where("c.case_id", "in", [PATIENT_LOW, PATIENT_MEDIUM, PATIENT_HIGH])
			.select(["c.case_id", sql<string>`${expr}`.as("category")])
			.orderBy("c.case_id")
			.execute();
		// Each patient resolves to its expected switch branch.
		expect(rows).toEqual([
			{ case_id: PATIENT_LOW, category: "low" },
			{ case_id: PATIENT_MEDIUM, category: "medium" },
			{ case_id: PATIENT_HIGH, category: "high" },
		]);
	});
});

test("date arithmetic resolves property and nullable-wrapper types, including scalar metadata", async ({
	db,
}) => {
	const schemas = new Map(SCHEMAS);
	schemas.set("patient", {
		...PATIENT_SCHEMA,
		properties: [
			...PATIENT_SCHEMA.properties,
			{ name: "dob", label: proseText("Birth date"), data_type: "date" },
		],
	});
	await db
		.insertInto("cases")
		.values(
			makeCaseRow({
				case_id: PATIENT_CASE_ID,
				app_id: APP_ID,
				project_id: OWNER_ID,
				case_type: "patient",
				opened_on: new Date("2026-01-01T12:30:00Z"),
				properties: JSON.stringify({
					dob: "2026-01-01",
					registered_at: "2026-01-01T12:30:00Z",
				}),
			}),
		)
		.execute();
	const ctx = makeCtx(db, { caseTypeSchemas: schemas });
	const cases: ReadonlyArray<[ValueExpression, string, string]> = [
		[term(prop("patient", "dob")), "date", "2026-01-02"],
		[
			coalesce(term(literal(null)), term(prop("patient", "dob"))),
			"date",
			"2026-01-02",
		],
		[
			term(prop("patient", "registered_at")),
			"timestamp with time zone",
			"2026-01-02T12:30:00+00:00",
		],
		[
			term(prop("patient", "date_opened")),
			"timestamp with time zone",
			"2026-01-02T12:30:00+00:00",
		],
	];
	for (const [base, type, expected] of cases) {
		const expr = compileExpression(
			dateAdd(base, "days", term(literal(1))),
			ctx,
		);
		const row = await db
			.selectFrom("cases as c")
			.where("c.case_id", "=", PATIENT_CASE_ID)
			.select([
				sql<string>`pg_typeof(${expr})::text`.as("type"),
				sql<string>`to_jsonb(${expr})`.as("value"),
			])
			.executeTakeFirstOrThrow();
		expect(row).toEqual({ type, value: expected });
	}
});

test("date formatting propagates null even with surrounding literal text", async ({
	db,
}) => {
	const row = await db
		.selectNoFrom([
			compileExpression(
				formatDate(term(literal(null)), "Recorded: %Y"),
				makeCtx(db),
			).as("missing"),
			compileExpression(
				formatDate(term(literal("2026-01-01")), ""),
				makeCtx(db),
			).as("emptyPattern"),
		])
		.executeTakeFirstOrThrow();
	expect(row).toEqual({ missing: null, emptyPattern: "" });
});
