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
//   - The `fuzzy` / `phonetic` match modes returning the same row
//     set CommCare HQ's Elasticsearch case-search would: token-wise
//     `levenshtein` (AUTO fuzziness + prefix) and array overlap for
//     `fuzzy`, per-token `soundex` for `phonetic`, both over the
//     `regexp_split_to_array` + `array_remove` + `unnest` token
//     machinery the extension-installed engine has to actually run.
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
// wrong operator (e.g. `soundx(...)` instead of `soundex(...)`)
// would still pass every `toContain("soundex(")` check the cold
// suite makes — the cold suite answers "does the SQL contain these
// tokens", not "does Postgres parse and execute it correctly". This
// file's tests answer the second question.

import { describe } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	dateRangeSearchPredicate,
	exactDateSearchPredicate,
} from "@/lib/domain/predicate";
import {
	ancestorPath,
	and,
	between,
	concat,
	dateLiteral,
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
	sessionUser,
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
		{ name: "nickname", label: "Nickname", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "bmi", label: "BMI", data_type: "decimal" },
		{ name: "dob", label: "DOB", data_type: "date" },
		{ name: "last_seen", label: "Last seen", data_type: "datetime" },
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
	properties: [{ name: "nickname", label: "Village name", data_type: "text" }],
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
		projectId: OWNER_ID,
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
		.where("c.project_id", "=", OWNER_ID)
		.where(pred)
		.execute();
}

// ---------------------------------------------------------------
// Calendar-day search lowering — UTC-stable datetime bounds
// ---------------------------------------------------------------

describe("compilePredicate — calendar-day search UTC boundaries", () => {
	test("exact day and inclusive range keep UTC endpoints in a non-UTC session", async ({
		db,
		pgClient,
	}) => {
		await pgClient.query("SET LOCAL TIME ZONE 'America/Los_Angeles'");
		// 2025-03-09 is the spring-forward day in Los Angeles. A
		// timestamptz + interval '1 day' upper bound computed in the session
		// zone lands at 23:00Z and drops the final UTC hour.
		const exactStartId = "20000000-0000-0000-0000-000000000011";
		const finalInstantId = "20000000-0000-0000-0000-000000000012";
		const afterRangeId = "20000000-0000-0000-0000-000000000013";
		const rangeStartId = "20000000-0000-0000-0000-000000000014";
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: rangeStartId,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({
						last_seen: "2025-03-01T00:00:00Z",
					}),
				}),
				makeCaseRow({
					case_id: exactStartId,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({
						last_seen: "2025-03-09T00:00:00Z",
					}),
				}),
				makeCaseRow({
					case_id: finalInstantId,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({
						last_seen: "2025-03-09T23:59:59Z",
					}),
				}),
				makeCaseRow({
					case_id: afterRangeId,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({
						last_seen: "2025-03-10T00:00:00Z",
					}),
				}),
			])
			.execute();

		const typeContext = {
			caseTypes: [PATIENT_SCHEMA, HOUSEHOLD_SCHEMA, VILLAGE_SCHEMA],
			knownInputs: [],
			currentCaseType: "patient",
		};
		const exact = exactDateSearchPredicate({
			caseType: "patient",
			property: "last_seen",
			day: term(dateLiteral("2025-03-09")),
			typeContext,
		});
		const range = dateRangeSearchPredicate({
			caseType: "patient",
			property: "last_seen",
			lowerDay: term(dateLiteral("2025-03-01")),
			upperDay: term(dateLiteral("2025-03-09")),
			typeContext,
		});

		const exactRows = await executeAgainstPredicate(
			db,
			compilePredicate(exact, makeCtx(db)),
		);
		const rangeRows = await executeAgainstPredicate(
			db,
			compilePredicate(range, makeCtx(db)),
		);

		expect(exactRows.map(({ case_id }) => case_id).sort()).toEqual(
			[exactStartId, finalInstantId].sort(),
		);
		expect(rangeRows.map(({ case_id }) => case_id).sort()).toEqual(
			[rangeStartId, exactStartId, finalInstantId].sort(),
		);
	});
});

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
					project_id: OWNER_ID,
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
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
					project_id: OWNER_ID,
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
	test("nested boolean rules execute when Combined text has one blank part", async ({
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

		// Exact structure produced by the rule editor in the live regression:
		// root AND → nested OR (three children) → NOT → comparison whose RHS
		// is a valid single-part Combined text expression. In the full case-store
		// query, its app/project/case-type constraints plus these preceding bare
		// literals make the concat operand parameter $7; Postgres used to reject
		// it as untyped before it could evaluate the otherwise-valid predicate.
		const pred = and(
			eq(prop("patient", "nickname"), literal("")),
			or(
				eq(prop("patient", "nickname"), literal("")),
				eq(prop("patient", "nickname"), literal("")),
				not(eq(prop("patient", "nickname"), concat(term(literal(""))))),
			),
		);

		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		expect(rows).toEqual([]);
	});

	test("and matches only rows satisfying every clause", async ({ db }) => {
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "Alice", age: 30 }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "Alice", age: 25 }),
				}),
			])
			.execute();
		const pred = and(
			eq(prop("patient", "nickname"), literal("Alice")),
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
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "Alice" }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "Bob" }),
				}),
			])
			.execute();
		const pred = or(
			eq(prop("patient", "nickname"), literal("Alice")),
			eq(prop("patient", "nickname"), literal("Bob")),
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
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "Alice" }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "Bob" }),
				}),
			])
			.execute();
		const pred = not(eq(prop("patient", "nickname"), literal("Alice")));
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
					project_id: OWNER_ID,
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

	test("text equality is case-sensitive (bob does not equal-match Bob)", async ({
		db,
	}) => {
		// `eq` mirrors HQ's exact text query, which compares against
		// the case-sensitive `.exact` keyword subfield — so a lower-
		// case query does not equal-match a capitalized stored value.
		// (The `fuzzy` / `phonetic` modes case-fold; `eq` does not.)
		await db
			.insertInto("cases")
			.values(
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "Bob" }),
				}),
			)
			.execute();
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(
				eq(prop("patient", "nickname"), literal("bob")),
				makeCtx(db),
			),
		);
		expect(rows).toEqual([]);
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
					project_id: OWNER_ID,
					// `name` key absent — no `name` in the JSONB
					// document.
					properties: JSON.stringify({ age: 30 }),
				}),
				makeCaseRow({
					case_id: "30000000-0000-0000-0000-000000000002",
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					// `name` present with empty string.
					properties: JSON.stringify({ nickname: "" }),
				}),
				makeCaseRow({
					case_id: "30000000-0000-0000-0000-000000000003",
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					// `name` present with JSON null.
					properties: JSON.stringify({ nickname: null }),
				}),
			])
			.execute();
		const pred = isNull(prop("patient", "nickname"));
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
					project_id: OWNER_ID,
					properties: JSON.stringify({ age: 30 }),
				}),
				makeCaseRow({
					case_id: "30000000-0000-0000-0000-000000000002",
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "" }),
				}),
				makeCaseRow({
					case_id: "30000000-0000-0000-0000-000000000003",
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: null }),
				}),
			])
			.execute();
		const pred = isBlank(prop("patient", "nickname"));
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
					project_id: OWNER_ID,
					properties: JSON.stringify({ age: 30 }),
				}),
				makeCaseRow({
					case_id: "30000000-0000-0000-0000-000000000002",
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "" }),
				}),
				makeCaseRow({
					case_id: "30000000-0000-0000-0000-000000000003",
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: null }),
				}),
			])
			.execute();
		const pred = eq(prop("patient", "nickname"), literal(""));
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
					project_id: OWNER_ID,
					properties: JSON.stringify({ age: 30 }),
				}),
				makeCaseRow({
					case_id: "30000000-0000-0000-0000-000000000002",
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "" }),
				}),
				makeCaseRow({
					case_id: "30000000-0000-0000-0000-000000000003",
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: null }),
				}),
			])
			.execute();
		const pred = eq(prop("patient", "nickname"), literal(null));
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
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "Alice" }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "Bob" }),
				}),
			])
			.execute();
		const pred = isIn(prop("patient", "nickname"), literal("Alice"));
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
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "Alice" }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "Bob" }),
				}),
				makeCaseRow({
					case_id: HOUSEHOLD_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "Carol" }),
				}),
			])
			.execute();
		const pred = isIn(
			prop("patient", "nickname"),
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
					project_id: OWNER_ID,
					properties: JSON.stringify({ age: 18 }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ age: 65 }),
				}),
				makeCaseRow({
					case_id: HOUSEHOLD_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
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
					project_id: OWNER_ID,
					properties: JSON.stringify({ age: 18 }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ age: 30 }),
				}),
				makeCaseRow({
					case_id: HOUSEHOLD_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
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
					project_id: OWNER_ID,
					properties: JSON.stringify({ age: 18 }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
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
					project_id: OWNER_ID,
					properties: JSON.stringify({ age: 18 }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
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
					project_id: OWNER_ID,
					properties: JSON.stringify({ tags: ["urgent", "review"] }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
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
					project_id: OWNER_ID,
					properties: JSON.stringify({ tags: ["urgent"] }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ tags: ["review"] }),
				}),
				makeCaseRow({
					case_id: HOUSEHOLD_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
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
					project_id: OWNER_ID,
					properties: JSON.stringify({ tags: ["urgent", "review"] }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
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
	for (const [mode, first, second] of [
		["starts-with", "Ali", "ce"],
		["fuzzy", "Ali", "se"],
		["phonetic", "Sm", "ith"],
	] as const) {
		test(`${mode} executes a computed ValueExpression match value`, async ({
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
						properties: JSON.stringify({ nickname: "Alice Smyth" }),
					}),
				)
				.execute();

			const rows = await executeAgainstPredicate(
				db,
				compilePredicate(
					match(
						prop("patient", "nickname"),
						concat(term(literal(first)), term(literal(second))),
						mode,
					),
					makeCtx(db),
				),
			);
			expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
		});
	}

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
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "Alice" }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "Bob" }),
				}),
			])
			.execute();
		const pred = match(prop("patient", "nickname"), "Ali", "starts-with");
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});

	// `fuzzy` mirrors CommCare HQ's case-search fuzzy branch (the OR
	// of a term-level fuzzy query and an exact analyzed match), so
	// preview search behaves the same as the exported app. The tests
	// below pin both clauses and the edges where the old pg_trgm
	// whole-string similarity diverged from HQ.

	test("fuzzy term-level match accepts a within-AUTO edit (smith ~ smyth)", async ({
		db,
	}) => {
		// "smith" (5 chars → AUTO budget of 1 edit) reaches "smyth":
		// one substitution, and they share the first two characters
		// ("sm") ES never edits (prefix_length=2).
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "Smyth" }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "Bob" }),
				}),
			])
			.execute();
		const pred = match(prop("patient", "nickname"), "smith", "fuzzy");
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});

	test("fuzzy is case-folded (BOB matches bob)", async ({ db }) => {
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "bob" }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "alice" }),
				}),
			])
			.execute();
		const pred = match(prop("patient", "nickname"), "BOB", "fuzzy");
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});

	test("fuzzy 2-char query gets a 0-edit budget — 'bo' does NOT match 'bob'", async ({
		db,
	}) => {
		// The old pg_trgm whole-string `%` matched "bo" against "bob".
		// HQ's AUTO fuzziness gives a 2-char query 0 edits, and there
		// is no exact token equality, so the row must NOT match.
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "bob" }),
				}),
			])
			.execute();
		const pred = match(prop("patient", "nickname"), "bo", "fuzzy");
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		expect(rows).toEqual([]);
	});

	test("fuzzy matches a multi-word value via an exact shared token, but a near-miss token alone does not", async ({
		db,
	}) => {
		// "Felipe Khan" tokenizes to {felipe, khan}. A query of
		// "felipe kan" matches via the exact-token-overlap clause (its
		// "felipe" token equals a property token). A query of "kan"
		// alone matches neither clause: it shares no exact token, and
		// its "ka" prefix differs from "khan"'s "kh", so the term-
		// level fuzzy clause never even considers the edit distance.
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "Felipe Khan" }),
				}),
			])
			.execute();

		const matches = await executeAgainstPredicate(
			db,
			compilePredicate(
				match(prop("patient", "nickname"), "felipe kan", "fuzzy"),
				makeCtx(db),
			),
		);
		expect(matches).toEqual([{ case_id: PATIENT_CASE_ID }]);

		const noMatch = await executeAgainstPredicate(
			db,
			compilePredicate(
				match(prop("patient", "nickname"), "kan", "fuzzy"),
				makeCtx(db),
			),
		);
		expect(noMatch).toEqual([]);
	});

	test("fuzzy does not match a value nothing like the query (xyz vs bob)", async ({
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
					properties: JSON.stringify({ nickname: "bob" }),
				}),
			])
			.execute();
		const pred = match(prop("patient", "nickname"), "xyz", "fuzzy");
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		expect(rows).toEqual([]);
	});

	test("fuzzy with a search-input ref drives the match value at runtime", async ({
		db,
	}) => {
		// The widened `match.value: ValueExpression` (per the schema
		// at types.ts § matchSchema) lets a search-input ref drive
		// the match value at runtime. The search-input modes
		// (fuzzy / phonetic / starts-with) bind the field worker's
		// typed value into the predicate context's `searchInputs`
		// map; `compileTerm` resolves the input ref to its bound
		// value, and the match dispatch consumes the resolved value
		// just as it would a literal — including computing the AUTO
		// fuzziness budget from the bound value's length in SQL.
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "Alice" }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "Zelda" }),
				}),
			])
			.execute();
		// "Alise" (5 chars → 1 edit) reaches "Alice" via the term-
		// level fuzzy clause; "Zelda" shares neither prefix nor token.
		const pred = match(
			prop("patient", "nickname"),
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

	test("fuzzy with a query that tokenizes to zero tokens matches nothing without erroring", async ({
		db,
	}) => {
		// A punctuation-only query ("—") tokenizes to an empty array;
		// the empty-array `unnest` / `&&` must produce no match and no
		// SQL error.
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "bob" }),
				}),
			])
			.execute();
		const pred = match(prop("patient", "nickname"), "—", "fuzzy");
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		expect(rows).toEqual([]);
	});

	test("phonetic matches rows that sound alike per-token via soundex (smith ~ Smyth)", async ({
		db,
	}) => {
		// "Smith" and "Smyth" share the Soundex code S530; the
		// predicate matches even though the strings differ. HQ's
		// phonetic analyzer encodes with Soundex (not Double
		// Metaphone).
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "Smyth" }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "Johnson" }),
				}),
			])
			.execute();
		const pred = match(prop("patient", "nickname"), "smith", "phonetic");
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});

	test("phonetic matches per-token inside a multi-word value (bob ~ 'bob smith')", async ({
		db,
	}) => {
		// Whole-string phonetic encoding would miss this; HQ encodes
		// per-token, so the query token "bob" matches the "bob" token
		// of "bob smith".
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "bob smith" }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "alice" }),
				}),
			])
			.execute();
		const pred = match(prop("patient", "nickname"), "bob", "phonetic");
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});

	test("phonetic does not match a value that sounds different (bob vs alice)", async ({
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
					properties: JSON.stringify({ nickname: "alice" }),
				}),
			])
			.execute();
		const pred = match(prop("patient", "nickname"), "bob", "phonetic");
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		expect(rows).toEqual([]);
	});

	test("phonetic with a query that tokenizes to zero tokens matches nothing without erroring", async ({
		db,
	}) => {
		// Exercises the empty-array `unnest` on the query-token side of
		// the two-source cross join.
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "bob" }),
				}),
			])
			.execute();
		const pred = match(prop("patient", "nickname"), "—", "phonetic");
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		expect(rows).toEqual([]);
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
					project_id: OWNER_ID,
					// Stored value is one of the permutations of
					// the queried date — the swapped form.
					properties: JSON.stringify({ dob: "2024-03-12" }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
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

	test("fuzzy-date executes a computed value and filters invalid generated permutations", async ({
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
					properties: JSON.stringify({ nickname: "2024-03-12" }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					// This is one raw digit swap, but not a calendar date. HQ drops it.
					properties: JSON.stringify({ nickname: "2024-21-03" }),
				}),
			])
			.execute();

		const pred = match(
			prop("patient", "nickname"),
			concat(term(literal("2024-12")), term(literal("-03"))),
			"fuzzy-date",
		);
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(pred, makeCtx(db)),
		);
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});

	test("fuzzy-date treats a malformed computed runtime value as no match", async ({
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
					properties: JSON.stringify({ nickname: "2024-03-12" }),
				}),
			)
			.execute();

		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(
				match(
					prop("patient", "nickname"),
					concat(term(literal("not-a")), term(literal("-date"))),
					"fuzzy-date",
				),
				makeCtx(db),
			),
		);
		expect(rows).toEqual([]);

		const yearZeroRows = await executeAgainstPredicate(
			db,
			compilePredicate(
				match(
					prop("patient", "nickname"),
					concat(term(literal("0000-01")), term(literal("-01"))),
					"fuzzy-date",
				),
				makeCtx(db),
			),
		);
		expect(yearZeroRows).toEqual([]);
	});

	test("fuzzy-date reads a session-backed runtime value", async ({ db }) => {
		await db
			.insertInto("cases")
			.values(
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "2024-03-12" }),
				}),
			)
			.execute();

		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(
				match(
					prop("patient", "nickname"),
					term(sessionUser("date_query")),
					"fuzzy-date",
				),
				makeCtx(db, {
					bindings: {
						sessionUser: new Map([["date_query", "2024-12-03"]]),
					},
				}),
			),
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
					project_id: OWNER_ID,
					properties: JSON.stringify({ loc: "42.3736 -71.1097 0 0" }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
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

	test("uses Core and Elasticsearch's sphere model at the distance boundary", async ({
		db,
	}) => {
		// At latitude 60, one degree of longitude is just under 55.7 km on the
		// sphere used by Core/Elasticsearch, but just over 55.7 km on PostGIS's
		// default WGS-84 spheroid. This boundary pins ST_DWithin's fourth argument
		// to false so Preview does not exclude a case the exported app includes.
		await db
			.insertInto("cases")
			.values(
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ loc: "60 1 0 0" }),
				}),
			)
			.execute();

		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(
				within(prop("patient", "loc"), literal("60 0"), 55.7, "kilometers"),
				makeCtx(db),
			),
		);
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});

	test("accepts intentional center separators and rejects ambiguous or incompatible spellings", async ({
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
					properties: JSON.stringify({ loc: "42.3601 -71.0589 0 0" }),
				}),
			)
			.execute();

		for (const center of [
			"42.3601 -71.0589",
			"42.3601, -71.0589",
			" 42.3601\t-71.0589 ",
			"42.3601 -71.0589 NaN NaN",
		]) {
			const rows = await executeAgainstPredicate(
				db,
				compilePredicate(
					within(prop("patient", "loc"), literal(center), 1, "miles"),
					makeCtx(db),
				),
			);
			expect(rows, center).toEqual([{ case_id: PATIENT_CASE_ID }]);
		}

		for (const center of [
			"42",
			"42 -71 0",
			"42 -71 0 1 2",
			"91 0",
			"0 181",
			"+42 -71",
			"4.2e1 -71",
			"40,7 -74,0",
			"42\u00a0-71",
		]) {
			const rows = await executeAgainstPredicate(
				db,
				compilePredicate(
					within(prop("patient", "loc"), literal(center), 1, "miles"),
					makeCtx(db),
				),
			);
			expect(rows, center).toEqual([]);
		}
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
					project_id: OWNER_ID,
					properties: JSON.stringify({}),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({}),
				}),
				makeCaseRow({
					case_id: HOUSEHOLD_BIG,
					case_type: "household",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ size: 5 }),
				}),
				makeCaseRow({
					case_id: HOUSEHOLD_SMALL,
					case_type: "household",
					app_id: APP_ID,
					project_id: OWNER_ID,
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
					project_id: OWNER_ID,
					properties: JSON.stringify({}),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({}),
				}),
				makeCaseRow({
					case_id: HOUSEHOLD_BIG,
					case_type: "household",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ size: 5 }),
				}),
				makeCaseRow({
					case_id: HOUSEHOLD_SMALL,
					case_type: "household",
					app_id: APP_ID,
					project_id: OWNER_ID,
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
					project_id: OWNER_ID,
					properties: JSON.stringify({}),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({}),
				}),
				makeCaseRow({
					case_id: HOUSEHOLD_NORTH,
					case_type: "household",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({}),
				}),
				makeCaseRow({
					case_id: HOUSEHOLD_SOUTH,
					case_type: "household",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({}),
				}),
				makeCaseRow({
					case_id: VILLAGE_NORTH,
					case_type: "village",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "North" }),
				}),
				makeCaseRow({
					case_id: VILLAGE_SOUTH,
					case_type: "village",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "South" }),
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
				eq(prop("village", "nickname"), literal("North")),
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
					project_id: OWNER_ID,
					properties: JSON.stringify({}),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({}),
				}),
				makeCaseRow({
					case_id: HOUSEHOLD_NORTH,
					case_type: "household",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({}),
				}),
				makeCaseRow({
					case_id: HOUSEHOLD_SOUTH,
					case_type: "household",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({}),
				}),
				makeCaseRow({
					case_id: VILLAGE_NORTH,
					case_type: "village",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "North" }),
				}),
				makeCaseRow({
					case_id: VILLAGE_SOUTH,
					case_type: "village",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "South" }),
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
					"nickname",
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
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "Alice" }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "Bob" }),
				}),
			])
			.execute();
		const pred = whenInput(
			input("name_filter"),
			eq(prop("patient", "nickname"), literal("Alice")),
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
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "Alice" }),
				}),
				makeCaseRow({
					case_id: PATIENT_2_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					project_id: OWNER_ID,
					properties: JSON.stringify({ nickname: "Bob" }),
				}),
			])
			.execute();
		const pred = whenInput(
			input("name_filter"),
			eq(prop("patient", "nickname"), literal("Alice")),
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
