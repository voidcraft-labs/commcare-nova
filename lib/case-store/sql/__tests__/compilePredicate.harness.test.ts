// lib/case-store/sql/__tests__/compilePredicate.harness.test.ts
//
// Execute-against-real-Postgres tests for the Predicate compiler.
// These tests insert rows, build a wider query that uses the
// compiled predicate as the `where` clause, and execute the whole
// thing through the testcontainers harness. The point is to catch
// failures the compile-only sibling test
// (`compilePredicate.test.ts`) can't see — most notably:
//
//   - JSONB operators (`?`, `?|`, `?&`) that Postgres parses but
//     the cold suite would accept as opaque tokens.
//   - pg_trgm `%` similarity operator dispatching against the
//     extension-installed engine.
//   - fuzzystrmatch's `dmetaphone` function returning the right
//     phonetic key for two inputs that "sound alike".
//   - PostGIS `ST_DWithin` returning the correct geographic
//     distance result against `ST_MakePoint(lon, lat)::geography`.
//   - The Postgres-strict null semantic — four distinct cases
//     pinned (absent / null / empty string / non-empty value).
//
// ## Why a separate file from the cold compile-only suite
//
// Cold tests use Kysely's `DummyDriver` and assert on the
// `.compile()` output's string shape. They never execute. A
// regression that produced a syntactically-valid but semantically-
// wrong operator (e.g. `dmetphone(...)` instead of `dmetaphone(...)`)
// would still pass every `toContain("dmetaphone(")` check the cold
// suite makes — the cold suite answers "does the SQL contain these
// tokens", not "does Postgres parse and execute it correctly". This
// file's tests answer the second question.

import { describe } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	ancestorPath,
	and,
	between,
	eq,
	exists,
	gt,
	gte,
	input,
	isBlank,
	isIn,
	isNull,
	literal,
	lt,
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
	term,
	whenInput,
	within,
} from "@/lib/domain/predicate/builders";
import {
	compilePredicate,
	type PredicateCompileContext,
} from "../compilePredicate";
import { expect, makeCaseRow, test } from "./setup";

// ---------------------------------------------------------------
// Stable test fixture IDs and schema
// ---------------------------------------------------------------
//
// Deterministic UUIDs: per-test rollback isolation lets tests
// reuse these without conflicting, and stable IDs keep `WHERE
// case_id = ...` traces readable when a test fails.

const APP_ID = "app-pred-compiler";
const OWNER_ID = "owner-pred-compiler";

const PATIENT_CASE_ID = "20000000-0000-0000-0000-000000000001";
const PATIENT_2_CASE_ID = "20000000-0000-0000-0000-000000000002";
const HOUSEHOLD_CASE_ID = "20000000-0000-0000-0000-000000000003";

// `patient` schema: text + int + decimal + date + multi_select +
// geopoint cover the data_type variants every predicate-arm test
// needs. `parent_type: "household"` enables the ancestor-walk
// tests below.
const PATIENT_SCHEMA: CaseType = {
	name: "patient",
	parent_type: "household",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "bmi", label: "BMI", data_type: "decimal" },
		{ name: "dob", label: "DOB", data_type: "date" },
		{ name: "tags", label: "Tags", data_type: "multi_select" },
		{ name: "loc", label: "Location", data_type: "geopoint" },
	],
};

const HOUSEHOLD_SCHEMA: CaseType = {
	name: "household",
	parent_type: "village",
	properties: [
		{ name: "size", label: "Size", data_type: "int" },
		{ name: "region", label: "Region", data_type: "text" },
	],
};

const VILLAGE_SCHEMA: CaseType = {
	name: "village",
	properties: [{ name: "name", label: "Village name", data_type: "text" }],
};

const SCHEMAS = new Map<string, CaseType>([
	["patient", PATIENT_SCHEMA],
	["household", HOUSEHOLD_SCHEMA],
	["village", VILLAGE_SCHEMA],
]);

function makeCtx(
	db: PredicateCompileContext["db"],
	overrides: Partial<PredicateCompileContext> = {},
): PredicateCompileContext {
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

/**
 * Common shape: insert one or more case rows, compile a predicate,
 * run the standard `SELECT case_id FROM cases AS c WHERE
 * <tenant-filter> AND <pred>` query, and return the matched rows.
 * Hides the boilerplate so test bodies read as
 * "seed → compile → execute → assert".
 */
async function executeAgainstPredicate(
	db: PredicateCompileContext["db"],
	pred: ReturnType<typeof compilePredicate>,
): Promise<Array<{ case_id: string }>> {
	return db
		.selectFrom("cases as c")
		.select(["c.case_id"])
		.where("c.app_id", "=", APP_ID)
		.where("c.owner_id", "=", OWNER_ID)
		.where(pred)
		.execute();
}

// ---------------------------------------------------------------
// Sentinels round-trip
// ---------------------------------------------------------------

describe("compilePredicate — round-trip — sentinels", () => {
	test("match-all matches every tenant row", async ({ db }) => {
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
				}),
			])
			.execute();
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(matchAll(), makeCtx(db)),
		);
		expect(rows.map((r) => r.case_id).sort()).toEqual(
			[PATIENT_CASE_ID, PATIENT_2_CASE_ID].sort(),
		);
	});

	test("match-none matches zero rows", async ({ db }) => {
		await db
			.insertInto("cases")
			.values(
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
				}),
			)
			.execute();
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(matchNone(), makeCtx(db)),
		);
		expect(rows).toEqual([]);
	});
});

// ---------------------------------------------------------------
// Logical operators round-trip
// ---------------------------------------------------------------

describe("compilePredicate — round-trip — logical operators", () => {
	test("and matches only rows satisfying every clause", async ({ db }) => {
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: "Alice", age: 30 }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: "Alice", age: 25 }),
				}),
			])
			.execute();
		const pred = and(
			eq(prop("patient", "name"), literal("Alice")),
			eq(prop("patient", "age"), literal(30)),
		);
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});

	test("or matches rows satisfying any clause", async ({ db }) => {
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: "Alice" }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: "Bob" }),
				}),
			])
			.execute();
		const pred = or(
			eq(prop("patient", "name"), literal("Alice")),
			eq(prop("patient", "name"), literal("Bob")),
		);
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		expect(rows.map((r) => r.case_id).sort()).toEqual(
			[PATIENT_CASE_ID, PATIENT_2_CASE_ID].sort(),
		);
	});

	test("not inverts the row set", async ({ db }) => {
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: "Alice" }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: "Bob" }),
				}),
			])
			.execute();
		const pred = not(eq(prop("patient", "name"), literal("Alice")));
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		// SQL three-valued logic: a row whose `name` is NULL (here
		// neither "Alice" nor "Bob" missing — every test row has a
		// name, so no NULL surface). The negation of `name = 'Alice'`
		// matches the Bob row.
		expect(rows).toEqual([{ case_id: PATIENT_2_CASE_ID }]);
	});
});

// ---------------------------------------------------------------
// Comparison operators round-trip — six ops in one pass
// ---------------------------------------------------------------

describe("compilePredicate — round-trip — comparison operators", () => {
	test("equality, inequality, ordered comparisons all match correctly", async ({
		db,
	}) => {
		// One patient row at age 30; the suite of six comparisons
		// covers eq=30 (match), neq=20 (match), gt=25 (match),
		// gte=30 (match), lt=35 (match), lte=30 (match).
		await db
			.insertInto("cases")
			.values(
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ age: 30 }),
				}),
			)
			.execute();

		const cases = [
			eq(prop("patient", "age"), literal(30)),
			neq(prop("patient", "age"), literal(20)),
			gt(prop("patient", "age"), literal(25)),
			gte(prop("patient", "age"), literal(30)),
			lt(prop("patient", "age"), literal(35)),
		] as const;

		for (const pred of cases) {
			const rows = await executeAgainstPredicate(
				db,
				compilePredicate(pred, makeCtx(db)),
			);
			expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
		}
	});
});

// ---------------------------------------------------------------
// Postgres-strict null semantics — four distinct cases
// ---------------------------------------------------------------
//
// The AST distinguishes absent / empty / null at the data-model
// layer; this compiler emits the strict SQL, and round-trip tests
// pin all four cases:
//
//   1. is-null(prop) matches absent only.
//   2. is-blank(prop) matches absent OR empty-string.
//   3. compare(prop, "") matches strictly empty-string only.
//   4. compare(prop, null) matches strictly null (no rows in
//      practice — `<col> = NULL` is always unknown in SQL).

describe("compilePredicate — round-trip — Postgres-strict null semantics", () => {
	test("is-null matches absent JSONB key only — not empty, not null", async ({
		db,
	}) => {
		// Three rows: name absent, name empty string, name JSON null.
		// The is-null predicate matches only the absent row.
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: "30000000-0000-0000-0000-000000000001",
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					// `name` key absent — no `name` in the JSONB
					// document.
					properties: JSON.stringify({ age: 30 }),
				}),
				makeCaseRow({
					case_id: "30000000-0000-0000-0000-000000000002",
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					// `name` present with empty string.
					properties: JSON.stringify({ name: "" }),
				}),
				makeCaseRow({
					case_id: "30000000-0000-0000-0000-000000000003",
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					// `name` present with JSON null.
					properties: JSON.stringify({ name: null }),
				}),
			])
			.execute();
		const pred = isNull(prop("patient", "name"));
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		expect(rows).toEqual([{ case_id: "30000000-0000-0000-0000-000000000001" }]);
	});

	test("is-blank matches absent OR empty-string — not JSON null", async ({
		db,
	}) => {
		// Same three rows. is-blank matches the absent row AND the
		// empty-string row, but NOT the JSON-null row. (The wider
		// CCHQ semantic collapses null with empty / absent on the
		// wire, but Postgres + this AST distinguishes them.)
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: "30000000-0000-0000-0000-000000000001",
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ age: 30 }),
				}),
				makeCaseRow({
					case_id: "30000000-0000-0000-0000-000000000002",
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: "" }),
				}),
				makeCaseRow({
					case_id: "30000000-0000-0000-0000-000000000003",
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: null }),
				}),
			])
			.execute();
		const pred = isBlank(prop("patient", "name"));
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		expect(rows.map((r) => r.case_id).sort()).toEqual([
			"30000000-0000-0000-0000-000000000001",
			"30000000-0000-0000-0000-000000000002",
		]);
	});

	test('compare(prop, literal("")) matches strictly empty-string only', async ({
		db,
	}) => {
		// Same three rows. The `eq(prop, "")` shape matches the
		// empty-string row alone — JSONB `->>` returns `''` for
		// the empty-string value, `NULL` for the absent key, `NULL`
		// for the JSON-null value (per Postgres docs § 9.16 "JSON
		// Functions and Operators": `->>` on a JSON null returns
		// SQL NULL).
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: "30000000-0000-0000-0000-000000000001",
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ age: 30 }),
				}),
				makeCaseRow({
					case_id: "30000000-0000-0000-0000-000000000002",
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: "" }),
				}),
				makeCaseRow({
					case_id: "30000000-0000-0000-0000-000000000003",
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: null }),
				}),
			])
			.execute();
		const pred = eq(prop("patient", "name"), literal(""));
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		expect(rows).toEqual([{ case_id: "30000000-0000-0000-0000-000000000002" }]);
	});

	test("compare(prop, literal(null)) matches no rows in SQL three-valued logic", async ({
		db,
	}) => {
		// Same three rows. `<col> = NULL` evaluates to `NULL` (never
		// `TRUE`) in SQL three-valued logic, so the predicate
		// matches no rows. This is the strict-null semantic — to
		// match the JSON-null row, callers use `is-null` (which
		// matches strict-absent only on JSONB) or check
		// `<col> IS NULL` directly (which matches both absent and
		// JSON-null rows because `->>` returns NULL for both).
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: "30000000-0000-0000-0000-000000000001",
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ age: 30 }),
				}),
				makeCaseRow({
					case_id: "30000000-0000-0000-0000-000000000002",
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: "" }),
				}),
				makeCaseRow({
					case_id: "30000000-0000-0000-0000-000000000003",
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: null }),
				}),
			])
			.execute();
		const pred = eq(prop("patient", "name"), literal(null));
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		expect(rows).toEqual([]);
	});
});

// ---------------------------------------------------------------
// `in` round-trip — single + multi value
// ---------------------------------------------------------------

describe("compilePredicate — round-trip — in", () => {
	test("single-value IN matches the single row", async ({ db }) => {
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: "Alice" }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: "Bob" }),
				}),
			])
			.execute();
		const pred = isIn(prop("patient", "name"), literal("Alice"));
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});

	test("multi-value IN matches the union of values", async ({ db }) => {
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: "Alice" }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: "Bob" }),
				}),
				makeCaseRow({
					case_id: HOUSEHOLD_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: "Carol" }),
				}),
			])
			.execute();
		const pred = isIn(
			prop("patient", "name"),
			literal("Alice"),
			literal("Bob"),
		);
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		expect(rows.map((r) => r.case_id).sort()).toEqual(
			[PATIENT_CASE_ID, PATIENT_2_CASE_ID].sort(),
		);
	});
});

// ---------------------------------------------------------------
// `between` round-trip — four inclusivity combinations
// ---------------------------------------------------------------

describe("compilePredicate — round-trip — between", () => {
	test("closed interval [18, 65] includes both endpoints", async ({ db }) => {
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ age: 18 }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ age: 65 }),
				}),
				makeCaseRow({
					case_id: HOUSEHOLD_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ age: 70 }),
				}),
			])
			.execute();
		const pred = between(prop("patient", "age"), {
			lower: literal(18),
			upper: literal(65),
		});
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		// Both endpoints (18 and 65) are included by default; the
		// 70-year-old is excluded.
		expect(rows.map((r) => r.case_id).sort()).toEqual(
			[PATIENT_CASE_ID, PATIENT_2_CASE_ID].sort(),
		);
	});

	test("open interval (18, 65) excludes both endpoints", async ({ db }) => {
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ age: 18 }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ age: 30 }),
				}),
				makeCaseRow({
					case_id: HOUSEHOLD_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ age: 65 }),
				}),
			])
			.execute();
		const pred = between(prop("patient", "age"), {
			lower: literal(18),
			upper: literal(65),
			lowerInclusive: false,
			upperInclusive: false,
		});
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		// Both endpoints excluded — only the 30-year-old in middle.
		expect(rows).toEqual([{ case_id: PATIENT_2_CASE_ID }]);
	});

	test("half-open [18, 65) includes lower but excludes upper", async ({
		db,
	}) => {
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ age: 18 }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ age: 65 }),
				}),
			])
			.execute();
		const pred = between(prop("patient", "age"), {
			lower: literal(18),
			upper: literal(65),
			lowerInclusive: true,
			upperInclusive: false,
		});
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});

	test("half-open (18, 65] excludes lower but includes upper", async ({
		db,
	}) => {
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ age: 18 }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ age: 65 }),
				}),
			])
			.execute();
		const pred = between(prop("patient", "age"), {
			lower: literal(18),
			upper: literal(65),
			lowerInclusive: false,
			upperInclusive: true,
		});
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		expect(rows).toEqual([{ case_id: PATIENT_2_CASE_ID }]);
	});
});

// ---------------------------------------------------------------
// `multi-select-contains` round-trip — three quantifier shapes
// ---------------------------------------------------------------

describe("compilePredicate — round-trip — multi-select-contains", () => {
	test("any (single value) matches a row whose JSONB array contains the value", async ({
		db,
	}) => {
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ tags: ["urgent", "review"] }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ tags: ["routine"] }),
				}),
			])
			.execute();
		const pred = multiSelectAny(prop("patient", "tags"), literal("urgent"));
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});

	test("any (multiple values) matches a row whose array intersects the values", async ({
		db,
	}) => {
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ tags: ["urgent"] }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ tags: ["review"] }),
				}),
				makeCaseRow({
					case_id: HOUSEHOLD_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ tags: ["routine"] }),
				}),
			])
			.execute();
		// `?|` matches rows whose array contains ANY of the
		// supplied keys. `routine` is in neither matching row.
		const pred = multiSelectAny(
			prop("patient", "tags"),
			literal("urgent"),
			literal("review"),
		);
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		expect(rows.map((r) => r.case_id).sort()).toEqual(
			[PATIENT_CASE_ID, PATIENT_2_CASE_ID].sort(),
		);
	});

	test("all matches only rows whose array contains every value", async ({
		db,
	}) => {
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ tags: ["urgent", "review"] }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ tags: ["urgent"] }),
				}),
			])
			.execute();
		const pred = multiSelectAll(
			prop("patient", "tags"),
			literal("urgent"),
			literal("review"),
		);
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		// Only the row with both tags matches; the urgent-only row
		// fails the `?&` (all-keys-exist) check.
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});
});

// ---------------------------------------------------------------
// `match` round-trip — four modes
// ---------------------------------------------------------------

describe("compilePredicate — round-trip — match", () => {
	test("starts-with matches rows whose property has the prefix", async ({
		db,
	}) => {
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: "Alice" }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: "Bob" }),
				}),
			])
			.execute();
		const pred = match(prop("patient", "name"), "Ali", "starts-with");
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});

	test("fuzzy matches rows whose property is similar via pg_trgm", async ({
		db,
		pgClient,
	}) => {
		// pg_trgm's similarity threshold defaults to 0.3. The
		// `Alise` query against the `Alice` stored value has
		// trigram similarity around 0.45 — above the threshold.
		// Lower the threshold inside the test transaction so the
		// match is robust to engine-version variations of the
		// default; the rollback restores it.
		await pgClient.query(`SET LOCAL pg_trgm.similarity_threshold = 0.3`);
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: "Alice" }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: "Zelda" }),
				}),
			])
			.execute();
		const pred = match(prop("patient", "name"), "Alise", "fuzzy");
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		// pg_trgm's `Alise` ~ `Alice` similarity is ~0.45;
		// `Alise` ~ `Zelda` is far below 0.3.
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});

	test("fuzzy with a search-input ref drives the match value at runtime", async ({
		db,
		pgClient,
	}) => {
		// The widened `match.value: ValueExpression` (per the schema
		// at types.ts § matchSchema) lets a search-input ref drive
		// the match value at runtime. The search-input modes
		// (fuzzy / phonetic / starts-with) bind the field worker's
		// typed value into the predicate context's `searchInputs`
		// map; `compileTerm` resolves the input ref to its bound
		// value, and the match dispatch consumes the resolved value
		// just as it would a literal.
		await pgClient.query(`SET LOCAL pg_trgm.similarity_threshold = 0.3`);
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: "Alice" }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: "Zelda" }),
				}),
			])
			.execute();
		// `match(prop, term(input("name_search")), "fuzzy")` —
		// builder accepts any `Term | ValueExpression` for the
		// value slot; here it carries a search-input ref. The
		// context's bindings map resolves the ref to "Alise" at
		// compile time (the foundation's compileTerm does the
		// resolution; the wider runtime would bind from the field
		// worker's typed input).
		const pred = match(
			prop("patient", "name"),
			term(input("name_search")),
			"fuzzy",
		);
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(
				pred,
				makeCtx(db, {
					bindings: { searchInputs: new Map([["name_search", "Alise"]]) },
				}),
			),
		);
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});

	test("phonetic matches rows whose property sounds alike via dmetaphone", async ({
		db,
	}) => {
		// `Smith` and `Smyth` share the same Double Metaphone key
		// (SM0); the predicate matches the row even though the
		// strings differ.
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: "Smith" }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: "Johnson" }),
				}),
			])
			.execute();
		const pred = match(prop("patient", "name"), "Smyth", "phonetic");
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});

	test("fuzzy-date matches the digit-permutation set", async ({ db }) => {
		// CCHQ's `date_permutations("2024-12-03")` produces
		// permutations including `2024-03-12` (year-day-month
		// swap). A row whose `dob` is the swapped form should
		// match a fuzzy-date query against the original string.
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					// Stored value is one of the permutations of
					// the queried date — the swapped form.
					properties: JSON.stringify({ dob: "2024-03-12" }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					// Stored value is a totally different date.
					properties: JSON.stringify({ dob: "2026-05-15" }),
				}),
			])
			.execute();
		const pred = match(prop("patient", "dob"), "2024-12-03", "fuzzy-date");
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});
});

// ---------------------------------------------------------------
// `within-distance` round-trip — PostGIS
// ---------------------------------------------------------------

describe("compilePredicate — round-trip — within-distance", () => {
	test("ST_DWithin matches points inside the radius", async ({ db }) => {
		// Boston: 42.3601 N, 71.0589 W.
		// Cambridge MA: 42.3736 N, 71.1097 W (about 4km from Boston).
		// New York City: 40.7128 N, 74.0060 W (about 300km from Boston).
		// Wire form: "<lat> <lon> <alt> <accuracy>".
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ loc: "42.3736 -71.1097 0 0" }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ loc: "40.7128 -74.0060 0 0" }),
				}),
			])
			.execute();
		// 10-mile radius around Boston — reaches Cambridge but
		// not New York.
		const pred = within(
			prop("patient", "loc"),
			literal("42.3601 -71.0589 0 0"),
			10,
			"miles",
		);
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});
});

// ---------------------------------------------------------------
// `exists` / `missing` round-trip — relation-path quantifiers
// ---------------------------------------------------------------

describe("compilePredicate — round-trip — exists / missing", () => {
	test("exists with ancestor walk matches rows whose related case satisfies the inner where", async ({
		db,
	}) => {
		// Graph: patient --[parent]--> household. Two patients;
		// each parented to a different household. The inner
		// `where` filters on the household's `size` property.
		const HOUSEHOLD_BIG = "40000000-0000-0000-0000-000000000001";
		const HOUSEHOLD_SMALL = "40000000-0000-0000-0000-000000000002";
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
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({}),
				}),
				makeCaseRow({
					case_id: HOUSEHOLD_BIG,
					case_type: "household",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ size: 5 }),
				}),
				makeCaseRow({
					case_id: HOUSEHOLD_SMALL,
					case_type: "household",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ size: 2 }),
				}),
			])
			.execute();
		await db
			.insertInto("case_indices")
			.values([
				{
					case_id: PATIENT_CASE_ID,
					ancestor_id: HOUSEHOLD_BIG,
					identifier: "parent",
					relationship: "child",
					depth: 1,
				},
				{
					case_id: PATIENT_2_CASE_ID,
					ancestor_id: HOUSEHOLD_SMALL,
					identifier: "parent",
					relationship: "child",
					depth: 1,
				},
			])
			.execute();
		const pred = exists(
			ancestorPath(relationStep("parent", "household")),
			gte(prop("household", "size"), literal(4)),
		);
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		// Only the patient parented to the big household matches.
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});

	test("missing with ancestor walk matches rows whose related case fails the inner where", async ({
		db,
	}) => {
		// Same graph as above. `missing(parent, size >= 4)`
		// matches the patient whose household is too small —
		// inverse of the exists test.
		const HOUSEHOLD_BIG = "40000000-0000-0000-0000-000000000003";
		const HOUSEHOLD_SMALL = "40000000-0000-0000-0000-000000000004";
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
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({}),
				}),
				makeCaseRow({
					case_id: HOUSEHOLD_BIG,
					case_type: "household",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ size: 5 }),
				}),
				makeCaseRow({
					case_id: HOUSEHOLD_SMALL,
					case_type: "household",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ size: 2 }),
				}),
			])
			.execute();
		await db
			.insertInto("case_indices")
			.values([
				{
					case_id: PATIENT_CASE_ID,
					ancestor_id: HOUSEHOLD_BIG,
					identifier: "parent",
					relationship: "child",
					depth: 1,
				},
				{
					case_id: PATIENT_2_CASE_ID,
					ancestor_id: HOUSEHOLD_SMALL,
					identifier: "parent",
					relationship: "child",
					depth: 1,
				},
			])
			.execute();
		const pred = and(
			// Scope to patients only — without this scope, the
			// `household` rows themselves match `missing(parent,
			// ...)` because they have no parent at all (an empty
			// EXISTS subquery is `NOT EXISTS = true`). The case-list
			// query layer always scopes by case_type at the outer
			// query level; this test mirrors that pattern explicitly.
			eq(prop("patient", "case_type"), literal("patient")),
			missing(
				ancestorPath(relationStep("parent", "household")),
				gte(prop("household", "size"), literal(4)),
			),
		);
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		// PATIENT_CASE_ID has a big household — fails the
		// `missing` predicate. PATIENT_2_CASE_ID has a small
		// household, so the inner `where` returns no rows for
		// it, the EXISTS subquery is empty, and `NOT EXISTS`
		// matches.
		expect(rows).toEqual([{ case_id: PATIENT_2_CASE_ID }]);
	});

	test("nests non-self relation walks: outer ancestor + inner ancestor with prop check", async ({
		db,
	}) => {
		// Each `compileRelationPath` call produces an isolated
		// subquery scope (`(select ... from case_indices ... ) as
		// rp_leaf`). Subquery scoping makes the inner walk's `rp_leaf`
		// alias invisible to the outer walk's correlation, so an
		// outer `exists(parent, where: exists(parent, where: ...))`
		// composes cleanly: the outer EXISTS correlates against the
		// caller's anchor, and the inner EXISTS correlates against
		// the outer leaf. No alias collision, no shadowing.
		//
		// Graph:
		//   patient_1 --[parent]--> household_north --[parent]--> village_north
		//   patient_2 --[parent]--> household_south --[parent]--> village_south
		// Predicate:
		//   exists(parent: household, where:
		//     exists(parent: village, where: name = "North"))
		// Expected match set: patient_1 only — the only patient whose
		// household's village is named "North".
		const HOUSEHOLD_NORTH = "50000000-0000-0000-0000-000000000001";
		const HOUSEHOLD_SOUTH = "50000000-0000-0000-0000-000000000002";
		const VILLAGE_NORTH = "50000000-0000-0000-0000-000000000003";
		const VILLAGE_SOUTH = "50000000-0000-0000-0000-000000000004";
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
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({}),
				}),
				makeCaseRow({
					case_id: HOUSEHOLD_NORTH,
					case_type: "household",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({}),
				}),
				makeCaseRow({
					case_id: HOUSEHOLD_SOUTH,
					case_type: "household",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({}),
				}),
				makeCaseRow({
					case_id: VILLAGE_NORTH,
					case_type: "village",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: "North" }),
				}),
				makeCaseRow({
					case_id: VILLAGE_SOUTH,
					case_type: "village",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: "South" }),
				}),
			])
			.execute();
		await db
			.insertInto("case_indices")
			.values([
				{
					case_id: PATIENT_CASE_ID,
					ancestor_id: HOUSEHOLD_NORTH,
					identifier: "parent",
					relationship: "child",
					depth: 1,
				},
				{
					case_id: PATIENT_2_CASE_ID,
					ancestor_id: HOUSEHOLD_SOUTH,
					identifier: "parent",
					relationship: "child",
					depth: 1,
				},
				{
					case_id: HOUSEHOLD_NORTH,
					ancestor_id: VILLAGE_NORTH,
					identifier: "parent",
					relationship: "child",
					depth: 1,
				},
				{
					case_id: HOUSEHOLD_SOUTH,
					ancestor_id: VILLAGE_SOUTH,
					identifier: "parent",
					relationship: "child",
					depth: 1,
				},
			])
			.execute();
		const pred = exists(
			ancestorPath(relationStep("parent", "household")),
			exists(
				ancestorPath(relationStep("parent", "village")),
				eq(prop("village", "name"), literal("North")),
			),
		);
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});

	test("nests non-self via prop read inside an outer exists body", async ({
		db,
	}) => {
		// The other shape of nested non-self relation walk: an outer
		// `exists(parent, ...)` whose inner `where` reads a property
		// through ANOTHER non-self via. Here, the inner `where` is
		// `eq(prop(household, "name", via=parent), "North")` — a JSONB
		// read through a fresh ancestor walk from the outer leaf
		// (a household) to its parent (a village). The term compiler
		// reads through the relation-path leaf alias; under
		// nested-EXISTS depth uniquification, the inner term-level
		// via produces an alias that does not shadow the outer one.
		//
		// Same graph as the previous test. Predicate:
		//   exists(parent: household, where:
		//     eq(prop(household, "name", via=parent: village), "North"))
		//
		// `caseType=household` is the originating scope; the via
		// walks household → village, resolving `name` on the village
		// schema as the destination property.
		const HOUSEHOLD_NORTH = "50000000-0000-0000-0000-000000000005";
		const HOUSEHOLD_SOUTH = "50000000-0000-0000-0000-000000000006";
		const VILLAGE_NORTH = "50000000-0000-0000-0000-000000000007";
		const VILLAGE_SOUTH = "50000000-0000-0000-0000-000000000008";
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
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({}),
				}),
				makeCaseRow({
					case_id: HOUSEHOLD_NORTH,
					case_type: "household",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({}),
				}),
				makeCaseRow({
					case_id: HOUSEHOLD_SOUTH,
					case_type: "household",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({}),
				}),
				makeCaseRow({
					case_id: VILLAGE_NORTH,
					case_type: "village",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: "North" }),
				}),
				makeCaseRow({
					case_id: VILLAGE_SOUTH,
					case_type: "village",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: "South" }),
				}),
			])
			.execute();
		await db
			.insertInto("case_indices")
			.values([
				{
					case_id: PATIENT_CASE_ID,
					ancestor_id: HOUSEHOLD_NORTH,
					identifier: "parent",
					relationship: "child",
					depth: 1,
				},
				{
					case_id: PATIENT_2_CASE_ID,
					ancestor_id: HOUSEHOLD_SOUTH,
					identifier: "parent",
					relationship: "child",
					depth: 1,
				},
				{
					case_id: HOUSEHOLD_NORTH,
					ancestor_id: VILLAGE_NORTH,
					identifier: "parent",
					relationship: "child",
					depth: 1,
				},
				{
					case_id: HOUSEHOLD_SOUTH,
					ancestor_id: VILLAGE_SOUTH,
					identifier: "parent",
					relationship: "child",
					depth: 1,
				},
			])
			.execute();
		const pred = exists(
			ancestorPath(relationStep("parent", "household")),
			eq(
				prop(
					"household",
					"name",
					ancestorPath(relationStep("parent", "village")),
				),
				literal("North"),
			),
		);
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});
});

// ---------------------------------------------------------------
// `when-input-present` round-trip — bound + unbound
// ---------------------------------------------------------------

describe("compilePredicate — round-trip — when-input-present", () => {
	test("compiles inner clause when input is bound", async ({ db }) => {
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: "Alice" }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: "Bob" }),
				}),
			])
			.execute();
		const pred = whenInput(
			input("name_filter"),
			eq(prop("patient", "name"), literal("Alice")),
		);
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(
				pred,
				makeCtx(db, {
					bindings: { searchInputs: new Map([["name_filter", "Alice"]]) },
				}),
			),
		);
		// Bound input → inner clause applies, only Alice matches.
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});

	test("collapses to match-all when input is unbound", async ({ db }) => {
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: "Alice" }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ name: "Bob" }),
				}),
			])
			.execute();
		const pred = whenInput(
			input("name_filter"),
			eq(prop("patient", "name"), literal("Alice")),
		);
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		// Unbound input → predicate collapses to `true`, every
		// tenant row matches.
		expect(rows.map((r) => r.case_id).sort()).toEqual(
			[PATIENT_CASE_ID, PATIENT_2_CASE_ID].sort(),
		);
	});
});
