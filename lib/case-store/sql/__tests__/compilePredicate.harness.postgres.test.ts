// Execute predicate semantics, boundary values, and composed expressions.
import { describe } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { CaseType } from "@/lib/domain";
import {
	dateRangeSearchPredicate,
	exactDateSearchPredicate,
} from "@/lib/domain/expression";
import {
	ancestorPath,
	and,
	arith,
	between,
	concat,
	count,
	dateLiteral,
	eq,
	exists,
	gt,
	gte,
	ifExpr,
	input,
	isBlank,
	isIn,
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
	sessionUser,
	switchCase,
	switchExpr,
	term,
	whenInput,
	within,
} from "@/lib/domain/expression/builders";
import {
	chosenCaseId,
	chosenCaseProperty,
} from "@/lib/domain/expression/chosenCase";
import { inferRecordQuery } from "@/lib/domain/expression/typeChecker";
import type { Expression } from "@/lib/domain/expression/types";
import { proseText } from "@/lib/domain/prose";
import {
	compilePredicate,
	type PredicateCompileContext,
} from "../compilePredicate";
import { recordQueryContextFor } from "../compileTerm";
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

// `patient` schema: text + int + decimal + date + multi_select +
// geopoint cover the data_type variants every predicate-arm test
// needs. `parent_type: "household"` enables the ancestor-walk
// tests below.
const PATIENT_SCHEMA: CaseType = {
	name: "patient",
	parent_type: "household",
	properties: [
		{ name: "nickname", label: proseText("Nickname"), data_type: "text" },
		{ name: "age", label: proseText("Age"), data_type: "int" },
		{ name: "bmi", label: proseText("BMI"), data_type: "decimal" },
		{ name: "dob", label: proseText("DOB"), data_type: "date" },
		{ name: "last_seen", label: proseText("Last seen"), data_type: "datetime" },
		{ name: "visit_time", label: proseText("Visit time"), data_type: "time" },
		{ name: "tags", label: proseText("Tags"), data_type: "multi_select" },
		{ name: "loc", label: proseText("Location"), data_type: "geopoint" },
	],
};

const HOUSEHOLD_SCHEMA: CaseType = {
	name: "household",
	parent_type: "village",
	properties: [
		{ name: "size", label: proseText("Size"), data_type: "int" },
		{ name: "region", label: proseText("Region"), data_type: "text" },
	],
};

const VILLAGE_SCHEMA: CaseType = {
	name: "village",
	properties: [
		{ name: "nickname", label: proseText("Village name"), data_type: "text" },
	],
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
		reading: "search",
		db,
		appId: APP_ID,
		projectId: OWNER_ID,
		anchorAlias: "c",
		currentCaseType: "patient",
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

		const typeContext = recordQueryContextFor(makeCtx(db));
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
});

// ---------------------------------------------------------------
// Comparison operators round-trip — six ops in one pass
// ---------------------------------------------------------------

describe("compilePredicate — round-trip — comparison operators", () => {
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
// Postgres blank semantics
// ---------------------------------------------------------------
//
// The AST's portable blank operator matches absent or empty string; direct
// comparisons remain exact.

// ---------------------------------------------------------------
// `in` round-trip — single + multi value
// ---------------------------------------------------------------

// ---------------------------------------------------------------
// `between` round-trip — four inclusivity combinations
// ---------------------------------------------------------------

// ---------------------------------------------------------------
// `multi-select-contains` round-trip — three quantifier shapes
// ---------------------------------------------------------------

// ---------------------------------------------------------------
// `match` round-trip — four modes
// ---------------------------------------------------------------

describe("compilePredicate — round-trip — match", () => {
	for (const [mode, first, second] of [
		["starts-with", "Ali", "ce"],
		["fuzzy", "Ali", "se"],
		["phonetic", "Sm", "ith"],
	] as const) {
		test(`${mode} executes a computed DomainExpression match value`, async ({
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

	test("fuzzy with a search-input ref drives the match value at runtime", async ({
		db,
	}) => {
		// The widened `match.value: DomainExpression` (per the schema
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
			term(input(testUuid("name_search"))),
			"fuzzy",
		);
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(
				pred,
				makeCtx(db, {
					bindings: {
						searchInputs: new Map([[testUuid("name_search"), "Alise"]]),
					},
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
					target_case_type: "household",
					identifier: "parent",
					relationship: "child",
					depth: 1,
				},
				{
					case_id: PATIENT_2_CASE_ID,
					ancestor_id: HOUSEHOLD_SMALL,
					target_case_type: "household",
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
					target_case_type: "household",
					identifier: "parent",
					relationship: "child",
					depth: 1,
				},
				{
					case_id: PATIENT_2_CASE_ID,
					ancestor_id: HOUSEHOLD_SMALL,
					target_case_type: "household",
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
		// DomainExpression:
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
					target_case_type: "household",
					identifier: "parent",
					relationship: "child",
					depth: 1,
				},
				{
					case_id: PATIENT_2_CASE_ID,
					ancestor_id: HOUSEHOLD_SOUTH,
					target_case_type: "household",
					identifier: "parent",
					relationship: "child",
					depth: 1,
				},
				{
					case_id: HOUSEHOLD_NORTH,
					ancestor_id: VILLAGE_NORTH,
					target_case_type: "village",
					identifier: "parent",
					relationship: "child",
					depth: 1,
				},
				{
					case_id: HOUSEHOLD_SOUTH,
					ancestor_id: VILLAGE_SOUTH,
					target_case_type: "village",
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
		// Same graph as the previous test. DomainExpression:
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
					target_case_type: "household",
					identifier: "parent",
					relationship: "child",
					depth: 1,
				},
				{
					case_id: PATIENT_2_CASE_ID,
					ancestor_id: HOUSEHOLD_SOUTH,
					target_case_type: "household",
					identifier: "parent",
					relationship: "child",
					depth: 1,
				},
				{
					case_id: HOUSEHOLD_NORTH,
					ancestor_id: VILLAGE_NORTH,
					target_case_type: "village",
					identifier: "parent",
					relationship: "child",
					depth: 1,
				},
				{
					case_id: HOUSEHOLD_SOUTH,
					ancestor_id: VILLAGE_SOUTH,
					target_case_type: "village",
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

test("is-blank on an arithmetic value matches missing operands without casting blank to numeric", async ({
	db,
}) => {
	await db
		.insertInto("cases")
		.values([
			makeCaseRow({
				case_id: "missing-age",
				app_id: APP_ID,
				project_id: OWNER_ID,
			}),
			makeCaseRow({
				case_id: "zero-age",
				app_id: APP_ID,
				project_id: OWNER_ID,
				properties: JSON.stringify({ age: 0 }),
			}),
			makeCaseRow({
				case_id: "present-age",
				app_id: APP_ID,
				project_id: OWNER_ID,
				properties: JSON.stringify({ age: 30 }),
			}),
		])
		.execute();
	const predicate = isBlank(
		arith("+", term(prop("patient", "age")), term(literal(1))),
	);
	expect(
		inferRecordQuery(predicate, recordQueryContextFor(makeCtx(db)), "condition")
			.errors,
	).toEqual([]);
	expect(
		await executeAgainstPredicate(db, compilePredicate(predicate, makeCtx(db))),
	).toEqual([{ case_id: "missing-age" }]);
});

test("is-blank gives bound null, empty and nonempty session values a SQL type", async ({
	db,
}) => {
	await db
		.insertInto("cases")
		.values(
			makeCaseRow({
				case_id: PATIENT_CASE_ID,
				app_id: APP_ID,
				project_id: OWNER_ID,
			}),
		)
		.execute();
	for (const value of [
		null,
		"",
		"present",
		0,
		false,
		new Date("2026-01-01T00:00:00Z"),
	]) {
		const ctx = makeCtx(db, {
			bindings: { sessionUser: new Map([["value", value]]) },
		});
		const rows = await executeAgainstPredicate(
			db,
			compilePredicate(isBlank(term(sessionUser("value"))), ctx),
		);
		expect(rows, String(value)).toEqual(
			value === null || value === "" ? [{ case_id: PATIENT_CASE_ID }] : [],
		);
	}
});

// One fixture per operator family keeps both matches and exclusions visible.
async function seedProperties(
	db: PredicateCompileContext["db"],
	rows: ReadonlyArray<readonly [string, Record<string, unknown>]>,
) {
	await db
		.insertInto("cases")
		.values(
			rows.map(([case_id, properties]) =>
				makeCaseRow({
					case_id,
					app_id: APP_ID,
					project_id: OWNER_ID,
					case_type: "patient",
					properties: JSON.stringify(properties),
				}),
			),
		)
		.execute();
}
async function matchedIds(
	db: PredicateCompileContext["db"],
	predicate: Parameters<typeof compilePredicate>[0],
	ctx = makeCtx(db),
) {
	return (await executeAgainstPredicate(db, compilePredicate(predicate, ctx)))
		.map((row) => row.case_id)
		.sort();
}

test("boolean operators and self quantifiers preserve grouping, and a negation keeps the row that lacks the property", async ({
	db,
}) => {
	await seedProperties(db, [
		["a", { nickname: "Alice", age: 17 }],
		["b", { nickname: "Alice", age: 30 }],
		["c", { nickname: "Bob", age: 30 }],
		["d", { nickname: "Carol", age: 30 }],
		["e", {}],
	]);
	const alice = eq(prop("patient", "nickname"), literal("Alice"));
	const aliceOrBob = or(alice, eq(prop("patient", "nickname"), literal("Bob")));
	for (const [pred, expected] of [
		[matchAll(), ["a", "b", "c", "d", "e"]],
		[matchNone(), []],
		[and(alice, eq(prop("patient", "age"), literal(30))), ["b"]],
		[aliceOrBob, ["a", "b", "c"]],
		// A device reads the absent nickname as '' and keeps `e`.
		[not(alice), ["c", "d", "e"]],
		[and(aliceOrBob, gt(prop("patient", "age"), literal(18))), ["b", "c"]],
		[exists(selfPath()), ["a", "b", "c", "d", "e"]],
		[missing(selfPath()), []],
		[exists(selfPath(), alice), ["a", "b"]],
		[missing(selfPath(), alice), ["c", "d", "e"]],
	] as const)
		expect(await matchedIds(db, pred), JSON.stringify(pred)).toEqual(expected);
});

test("all six comparisons distinguish lower, equal and higher values", async ({
	db,
}) => {
	await seedProperties(db, [
		["20", { age: 20 }],
		["30", { age: 30 }],
		["40", { age: 40 }],
		["absent", {}],
	]);
	for (const [operator, expected] of [
		[eq, ["30"]],
		// `!=` is the negation of `=`, so the absent age is not 30.
		[neq, ["20", "40", "absent"]],
		[gt, ["40"]],
		[gte, ["30", "40"]],
		[lt, ["20"]],
		[lte, ["20", "30"]],
	] as const) {
		expect(
			await matchedIds(db, operator(prop("patient", "age"), literal(30))),
		).toEqual(expected);
	}
});

test("blank and empty equality are one absence check over absent, empty and JSON null, and a null literal is the blank comparand every reader prints", async ({
	db,
}) => {
	await seedProperties(db, [
		["absent", {}],
		["blank", { nickname: "" }],
		["null", { nickname: null }],
		["Alice", { nickname: "Alice" }],
		["Bob", { nickname: "Bob" }],
		["Carol", { nickname: "Carol" }],
	]);
	const name = prop("patient", "nickname");
	// A device's wire and a CSQL search both print a literal null as '', so
	// each reading answers `p = null` as the device and HQ answer `p = ''`.
	for (const reading of ["casedb", "results", "search"] as const)
		for (const [predicate, expected] of [
			[isBlank(name), ["absent", "blank", "null"]],
			[eq(name, literal("")), ["absent", "blank", "null"]],
			[neq(name, literal("")), ["Alice", "Bob", "Carol"]],
			[eq(name, literal(null)), ["absent", "blank", "null"]],
			[neq(name, literal(null)), ["Alice", "Bob", "Carol"]],
			[neq(literal(null), name), ["Alice", "Bob", "Carol"]],
			[
				eq(literal(null), literal(null)),
				["Alice", "Bob", "Carol", "absent", "blank", "null"],
			],
			[gt(prop("patient", "age"), literal(null)), []],
			[lt(name, literal(null)), []],
			[isIn(name, literal("Alice")), ["Alice"]],
			[
				isIn(name, literal("Alice"), literal("Bob"), literal(null)),
				["Alice", "Bob", "absent", "blank", "null"],
			],
		] as const)
			expect(
				await matchedIds(db, predicate, makeCtx(db, { reading })),
				`${reading} ${JSON.stringify(predicate)}`,
			).toEqual(expected);
});

test("negated atoms, inequality and blank comparisons keep the rows a device and HQ keep", async ({
	db,
}) => {
	// The two-valued table: a device reads an absent property as '' and
	// `!=` as not `=`; HQ writes `!=` and `not()` as `must_not` and `= ''` as
	// "not set or empty". `n` holds no blank, as a number property's stored
	// value never is one.
	await seedProperties(db, [
		["absent", {}],
		["blank", { nickname: "" }],
		["x", { nickname: "x", age: 3 }],
		["y", { nickname: "y", age: 7 }],
	]);
	const p = prop("patient", "nickname");
	const n = prop("patient", "age");
	const x = literal("x");
	for (const [predicate, expected] of [
		[not(eq(p, x)), ["absent", "blank", "y"]],
		[neq(p, x), ["absent", "blank", "y"]],
		[eq(p, literal("")), ["absent", "blank"]],
		[neq(p, literal("")), ["x", "y"]],
		[not(lt(n, literal(5))), ["absent", "blank", "y"]],
		[not(isIn(p, x, literal("y"))), ["absent", "blank"]],
		[
			not(between(n, { lower: literal(1), upper: literal(5) })),
			["absent", "blank", "y"],
		],
		[or(not(eq(p, x)), eq(p, x)), ["absent", "blank", "x", "y"]],
		// A number compared with '' is the absence check too, never a cast.
		[eq(n, literal("")), ["absent", "blank"]],
	] as const)
		expect(await matchedIds(db, predicate), JSON.stringify(predicate)).toEqual(
			expected,
		);
});

test("a bound blank comparand is decided before the query: the absence check for equality, nothing for an ordering", async ({
	db,
}) => {
	await seedProperties(db, [
		["absent", {}],
		["blank", { nickname: "" }],
		["x", { nickname: "x", age: 3 }],
	]);
	const uuid = testUuid("blank-comparand");
	const p = prop("patient", "nickname");
	const n = prop("patient", "age");
	for (const value of ["", null]) {
		const ctx = makeCtx(db, {
			bindings: { searchInputs: new Map([[uuid, value]]) },
		});
		for (const [predicate, expected] of [
			[eq(p, input(uuid)), ["absent", "blank"]],
			[neq(p, input(uuid)), ["x"]],
			[eq(n, input(uuid)), ["absent", "blank"]],
			[gt(n, input(uuid)), []],
			[not(gt(n, input(uuid))), ["absent", "blank", "x"]],
		] as const)
			expect(
				await matchedIds(db, predicate, ctx),
				`${String(value)} ${JSON.stringify(predicate)}`,
			).toEqual(expected);
	}
});

test("two text operands read per row are equal when both are blank, as '' = '' is on a device", async ({
	db,
}) => {
	await seedProperties(db, [
		["both-absent", {}],
		["one-blank", { nickname: "" }],
		["equal", { nickname: "a", alias: "a" }],
		["different", { nickname: "a", alias: "b" }],
		["one-side", { nickname: "a" }],
	]);
	const ctx = makeCtx(db, {
		caseTypeSchemas: new Map([
			[
				"patient",
				{
					...PATIENT_SCHEMA,
					properties: [
						...PATIENT_SCHEMA.properties,
						{ name: "alias", label: proseText("Alias"), data_type: "text" },
					],
				},
			],
		]),
	});
	const sameName = eq(prop("patient", "nickname"), prop("patient", "alias"));
	expect(await matchedIds(db, sameName, ctx)).toEqual([
		"both-absent",
		"equal",
		"one-blank",
	]);
	expect(await matchedIds(db, not(sameName), ctx)).toEqual([
		"different",
		"one-side",
	]);
});

test("ranges respect each endpoint, omitted bounds and interior values", async ({
	db,
}) => {
	await seedProperties(
		db,
		[17, 18, 30, 65, 70].map((age) => [String(age), { age }]),
	);
	const lower = literal(18),
		upper = literal(65);
	for (const [bounds, expected] of [
		[{ lower, upper }, ["18", "30", "65"]],
		[{ lower, upper, lowerInclusive: false, upperInclusive: false }, ["30"]],
		[{ lower, upper, upperInclusive: false }, ["18", "30"]],
		[{ lower, upper, lowerInclusive: false }, ["30", "65"]],
		[{ lower }, ["18", "30", "65", "70"]],
		[{ upper }, ["17", "18", "30", "65"]],
	] as const)
		expect(
			await matchedIds(db, between(prop("patient", "age"), bounds)),
			JSON.stringify(bounds),
		).toEqual(expected);
});

test("select membership distinguishes any, all, empty and absent arrays", async ({
	db,
}) => {
	await seedProperties(db, [
		["urgent", { tags: ["urgent"] }],
		["review", { tags: ["review"] }],
		["both", { tags: ["urgent", "review"] }],
		["neither", { tags: ["routine"] }],
		["empty", { tags: [] }],
		["absent", {}],
	]);
	const tags = prop("patient", "tags");
	for (const [predicate, expected] of [
		[multiSelectAny(tags, literal("urgent")), ["both", "urgent"]],
		[
			multiSelectAny(tags, literal("urgent"), literal("review")),
			["both", "review", "urgent"],
		],
		[multiSelectAll(tags, literal("urgent"), literal("review")), ["both"]],
	] as const)
		expect(await matchedIds(db, predicate), JSON.stringify(predicate)).toEqual(
			expected,
		);
});

test("input presence gates the clause even for bound blank and null", async ({
	db,
}) => {
	await seedProperties(db, [
		["Alice", { nickname: "Alice" }],
		["Bob", { nickname: "Bob" }],
	]);
	const uuid = testUuid("name_filter");
	const predicate = whenInput(
		input(uuid),
		eq(prop("patient", "nickname"), input(uuid)),
	);
	for (const value of [undefined, "Alice", "", null]) {
		const ctx = makeCtx(db, {
			bindings: {
				searchInputs:
					value === undefined ? undefined : new Map([[uuid, value]]),
			},
		});
		expect(await matchedIds(db, predicate, ctx), String(value)).toEqual(
			value === undefined
				? ["Alice", "Bob"]
				: value === "Alice"
					? ["Alice"]
					: [],
		);
	}
});

test("computed operands execute in comparisons, membership, ranges and distance centers", async ({
	db,
}) => {
	await seedProperties(db, [
		["young", { age: 17, loc: "42.3736 -71.1097 0 0" }],
		["older", { age: 30, loc: "40.7128 -74.0060 0 0" }],
	]);
	const nextAge = arith("+", term(prop("patient", "age")), term(literal(1)));
	for (const [predicate, expected] of [
		[gt(nextAge, literal(18)), ["older"]],
		[lt(literal(18), nextAge), ["older"]],
		[isIn(nextAge, literal(18), literal(40)), ["young"]],
		[
			between(nextAge, {
				lower: arith("+", term(literal(15)), term(literal(3))),
				upper: arith("+", term(literal(20)), term(literal(2))),
			}),
			["young"],
		],
		[
			eq(
				count(selfPath(), gt(prop("patient", "age"), literal(18))),
				literal(1),
			),
			["older"],
		],
		[
			within(
				prop("patient", "loc"),
				ifExpr(
					gt(prop("patient", "age"), literal(18)),
					term(literal("0 0 0 0")),
					term(literal("42.3601 -71.0589 0 0")),
				),
				10,
				"miles",
			),
			["young"],
		],
	] as const)
		expect(await matchedIds(db, predicate), JSON.stringify(predicate)).toEqual(
			expected,
		);
});

test("starts-with treats percent and underscore as literal prefix characters", async ({
	db,
}) => {
	await seedProperties(db, [
		["literal", { nickname: "A%_tail" }],
		["wildcard", { nickname: "Abtail" }],
		["middle", { nickname: "prefixA%_tail" }],
	]);
	expect(
		await matchedIds(
			db,
			match(prop("patient", "nickname"), "A%_", "starts-with"),
		),
	).toEqual(["literal"]);
});

test("distance units change which points fit the same numeric radius", async ({
	db,
}) => {
	// At the equator, 0.01 longitude degrees is about 1.11 km: outside
	// one kilometer but inside one mile. The origin is a positive control.
	await seedProperties(db, [
		["origin", { loc: "0 0" }],
		["between-units", { loc: "0 0.01" }],
		["outside", { loc: "0 1" }],
	]);
	const point = prop("patient", "loc");
	expect(
		await matchedIds(db, within(point, literal("0 0"), 1, "kilometers")),
	).toEqual(["origin"]);
	expect(
		await matchedIds(db, within(point, literal("0 0"), 1, "miles")),
	).toEqual(["between-units", "origin"]);
});

test("a distance center takes the E-notation a location handler's Double.toString prints, from a literal or here()", async ({
	db,
}) => {
	// 5.0E-4 degrees of latitude is about 56 metres; 0.01 is about 1.1 km.
	await seedProperties(db, [
		["near", { loc: "0 0" }],
		["far", { loc: "0.01 0" }],
	]);
	const point = prop("patient", "loc");
	expect(
		await matchedIds(db, within(point, literal("5.0E-4 0.0"), 1, "kilometers")),
	).toEqual(["near"]);
	const nearHere = within(point, { kind: "here" }, 1, "kilometers");
	// Formplayer's two values, which Preview binds.
	expect(
		await matchedIds(
			db,
			nearHere,
			makeCtx(db, { bindings: { viewerLocation: "5.0E-4 0.0" } }),
		),
	).toEqual(["near"]);
	// A device handler's four values.
	expect(
		await matchedIds(
			db,
			nearHere,
			makeCtx(db, { bindings: { viewerLocation: "5.0E-4 0.0 0.0 1.0E1" } }),
		),
	).toEqual(["near"]);
	// No fix yet reads '', which is no center: nothing is near it.
	expect(await matchedIds(db, nearHere)).toEqual([]);
});

test("blank metadata reads scalar text and timestamp columns", async ({
	db,
}) => {
	await db
		.insertInto("cases")
		.values([
			makeCaseRow({
				case_id: "blank",
				app_id: APP_ID,
				project_id: OWNER_ID,
				case_type: "patient",
				owner_id: "",
				modified_on: null,
				properties: JSON.stringify({
					owner_id: "shadow",
					last_modified: "shadow",
				}),
			}),
			makeCaseRow({
				case_id: "null",
				app_id: APP_ID,
				project_id: OWNER_ID,
				case_type: "patient",
				owner_id: null,
				modified_on: null,
			}),
			makeCaseRow({
				case_id: "present",
				app_id: APP_ID,
				project_id: OWNER_ID,
				case_type: "patient",
				owner_id: "worker",
				modified_on: new Date("2026-01-01T00:00:00Z"),
				properties: JSON.stringify({ owner_id: "", last_modified: "" }),
			}),
		])
		.execute();
	expect(await matchedIds(db, isBlank(prop("patient", "owner_id")))).toEqual([
		"blank",
		"null",
	]);
	expect(
		await matchedIds(db, isBlank(prop("patient", "last_modified"))),
	).toEqual(["blank", "null"]);
});

test("a radius or unit read from a value is a number above zero and one of CommCare's nine units, or matches nothing", async ({
	db,
}) => {
	// 0.01 degrees of latitude is about 1.11 km from the center.
	await seedProperties(db, [
		["origin", { loc: "0 0" }],
		["about-1.1-km", { loc: "0.01 0" }],
		["unplaced", {}],
	]);
	const near = (radius: string, unit: string) =>
		makeCtx(db, {
			reading: "casedb",
			bindings: {
				sessionUser: new Map([
					["radius", radius],
					["unit", unit],
				]),
			},
		});
	const fromValues = within(
		prop("patient", "loc"),
		literal("0 0"),
		term(sessionUser("radius")),
		term(sessionUser("unit")),
	);
	for (const [radius, unit, expected] of [
		["1", "kilometers", ["origin"]],
		[" 1.5 ", "kilometers", ["about-1.1-km", "origin"]],
		["1", "miles", ["about-1.1-km", "origin"]],
		["1300", "yards", ["about-1.1-km", "origin"]],
		["1000", "meters", ["origin"]],
		["0", "kilometers", []],
		["-1", "kilometers", []],
		["abc", "kilometers", []],
		["1e3", "meters", []],
		["1", "parsecs", []],
		["1", "Kilometers", []],
	] as const) {
		expect(
			await matchedIds(db, fromValues, near(radius, unit)),
			`${radius} ${unit}`,
		).toEqual(expected);
		// No radius matches nothing, so its negation keeps every case, as a
		// device's NaN comparison and HQ's NOT both do.
		if (expected.length === 0)
			expect(await matchedIds(db, not(fromValues), near(radius, unit))).toEqual(
				["about-1.1-km", "origin", "unplaced"],
			);
	}
	// A literal radius beside a value unit, and the reverse.
	expect(
		await matchedIds(
			db,
			within(
				prop("patient", "loc"),
				literal("0 0"),
				1,
				term(sessionUser("unit")),
			),
			near("", "miles"),
		),
	).toEqual(["about-1.1-km", "origin"]);
	expect(
		await matchedIds(
			db,
			within(
				prop("patient", "loc"),
				literal("0 0"),
				term(sessionUser("radius")),
				"kilometers",
			),
			near("2", ""),
		),
	).toEqual(["about-1.1-km", "origin"]);
});

test("a list of values is an exact any-of, and its negation keeps the case that lacks the property", async ({
	db,
}) => {
	await seedProperties(db, [
		["red", { nickname: "red" }],
		["quote", { nickname: "it's" }],
		["blue", { nickname: "blue" }],
		["empty", { nickname: "" }],
		["absent", {}],
	]);
	const list: Expression = {
		kind: "value-list",
		items: [term(literal("red")), term(literal("it's"))],
	};
	expect(await matchedIds(db, eq(prop("patient", "nickname"), list))).toEqual([
		"quote",
		"red",
	]);
	expect(await matchedIds(db, neq(prop("patient", "nickname"), list))).toEqual([
		"absent",
		"blue",
		"empty",
	]);
	expect(
		await matchedIds(
			db,
			eq(prop("patient", "age"), {
				kind: "value-list",
				items: [term(literal(3)), term(literal(30))],
			}),
		),
	).toEqual([]);
});

test("a list of values matches each item as the exact text the case holds, a number's as the text Nova stores", async ({
	db,
}) => {
	await seedProperties(db, [
		["five", { age: 5, visit_time: "10:00:00", tags: ["urgent", "home"] }],
		["thirty", { age: 30 }],
		["empty", { nickname: "" }],
		["absent", {}],
	]);
	const list = (...values: (string | number)[]): Expression => ({
		kind: "value-list",
		items: values.map((value) => term(literal(value))) as [
			Expression,
			...Expression[],
		],
	});
	// HQ's terms compare the stored text. Nova stores a number as its JSONB
	// number, so each of these is the text Nova stores for it, `'5'`.
	expect(
		await matchedIds(
			db,
			eq(prop("patient", "age"), list("5.0", "05", " 5", "5e0")),
		),
	).toEqual(["five"]);
	expect(
		await matchedIds(db, eq(prop("patient", "age"), list("five", "50"))),
	).toEqual([]);
	expect(
		await matchedIds(db, eq(prop("patient", "age"), list("5", 30))),
	).toEqual(["five", "thirty"]);
	expect(
		await matchedIds(db, eq(prop("patient", "visit_time"), list("10:00"))),
	).toEqual([]);
	expect(
		await matchedIds(db, eq(prop("patient", "visit_time"), list("10:00:00"))),
	).toEqual(["five"]);
	expect(
		await matchedIds(db, eq(prop("patient", "tags"), list("urgent home"))),
	).toEqual(["five"]);
	// A blank item finds the blank value, absent or empty, on a number too.
	expect(
		await matchedIds(db, eq(prop("patient", "age"), list("", "30"))),
	).toEqual(["absent", "empty", "thirty"]);
	expect(
		await matchedIds(db, eq(prop("patient", "nickname"), list(""))),
	).toEqual(["absent", "empty", "five", "thirty"]);
	expect(
		await matchedIds(db, neq(prop("patient", "age"), list("", "30"))),
	).toEqual(["five"]);
	expect(
		await matchedIds(db, neq(prop("patient", "age"), list("abc"))),
	).toEqual(["absent", "empty", "five", "thirty"]);
});

test("a choice between clauses takes the else branch when its condition reads nothing", async ({
	db,
}) => {
	await seedProperties(db, [
		["child", { age: 10 }],
		["adult", { age: 30 }],
		["unknown", {}],
	]);
	const adult = gt(prop("patient", "age"), literal(18));
	expect(await matchedIds(db, ifExpr(adult, matchAll(), matchNone()))).toEqual([
		"adult",
	]);
	expect(await matchedIds(db, ifExpr(adult, matchNone(), matchAll()))).toEqual([
		"child",
		"unknown",
	]);
	expect(
		await matchedIds(db, not(ifExpr(adult, matchAll(), matchNone()))),
	).toEqual(["child", "unknown"]);
	// A switch over the row's own value chooses a clause per row.
	const byAge = switchExpr(
		term(prop("patient", "age")),
		[switchCase(literal(10), matchAll()), switchCase(literal(30), matchNone())],
		eq(prop("patient", "nickname"), literal("x")),
	);
	expect(await matchedIds(db, byAge)).toEqual(["child"]);
	expect(await matchedIds(db, not(byAge))).toEqual(["adult", "unknown"]);
});

test("a case list filter reads the case chosen in an earlier menu from that case's row in the Project", async ({
	db,
}) => {
	const households = testUuid("harness-households-menu");
	const north = "harness-household-north";
	const south = "harness-household-south";
	await db
		.insertInto("cases")
		.values([
			makeCaseRow({
				case_id: north,
				app_id: APP_ID,
				project_id: OWNER_ID,
				case_type: "household",
				properties: JSON.stringify({ region: "North" }),
			}),
			makeCaseRow({
				case_id: south,
				app_id: APP_ID,
				project_id: OWNER_ID,
				case_type: "household",
				properties: JSON.stringify({ region: "South" }),
			}),
		])
		.execute();
	await seedProperties(db, [
		["north-north", { nickname: "North" }],
		["north-south", { nickname: "South" }],
		["south-north", { nickname: "North" }],
		["no-name", {}],
	]);
	await db
		.insertInto("case_indices")
		.values(
			(
				[
					["north-north", north],
					["north-south", north],
					["south-north", south],
				] as const
			).map(([case_id, ancestor_id]) => ({
				case_id,
				ancestor_id,
				target_case_type: "household",
				identifier: "parent",
				relationship: "child" as const,
				depth: 1,
			})),
		)
		.execute();
	const choosing = (id: string) =>
		makeCtx(db, {
			reading: "casedb",
			bindings: { chosenCaseIds: { [households]: id } },
		});
	// The harness reads every row of the tenant; the list is of patients.
	const patients = async (predicate: Expression, chosen: string) =>
		(await matchedIds(db, predicate, choosing(chosen))).filter(
			(id) => id !== north && id !== south,
		);
	const ofChosen = eq(
		prop("patient", "case_id", ancestorPath(relationStep("parent"))),
		chosenCaseId(households),
	);
	expect(await patients(ofChosen, north)).toEqual([
		"north-north",
		"north-south",
	]);
	const inChosenRegion = eq(
		prop("patient", "nickname"),
		chosenCaseProperty(households, "household", "region"),
	);
	expect(await patients(inChosenRegion, north)).toEqual([
		"north-north",
		"south-north",
	]);
	expect(await patients(not(inChosenRegion), south)).toEqual([
		"no-name",
		"north-north",
		"south-north",
	]);
	// An id that names no household of this Project reads no row, so the
	// property is absent, which a device reads as '': it equals only a case
	// that lacks the property too.
	expect(await patients(inChosenRegion, "north-north")).toEqual(["no-name"]);
	expect(await patients(not(inChosenRegion), "missing")).toEqual([
		"north-north",
		"north-south",
		"south-north",
	]);
});
