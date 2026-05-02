// lib/case-store/sql/__tests__/compileTerm.harness.test.ts
//
// Execute-against-real-Postgres tests for the Term compiler.
// These tests insert rows, build a wider query that uses the
// compiled term expression, and execute the whole thing through
// the testcontainers harness. The point is to catch failures the
// compile-only sibling test (`compileTerm.test.ts`) can't see —
// most notably, a malformed JSONB read or a cast token Postgres
// rejects at parse time.
//
// ## Why a separate file from the cold compile-only suite
//
// Cold tests use Kysely's `DummyDriver` and assert on the
// `.compile()` output's string shape. They never execute. A
// regression that produces a syntactically-valid but semantically-
// wrong cast token (e.g. `::ints` instead of `::int`) would still
// pass every `toContain("::int")` check the cold suite makes —
// the cold suite answers "does the SQL contain these tokens",
// not "does Postgres parse and execute it correctly". This file's
// tests answer the second question.
//
// ## Round-trip coverage
//
//   1. Each `data_type` variant — round-trip a row whose
//      `properties` JSONB carries the typed value, query with the
//      term, assert the value matches. Pins the cast tokens
//      against Postgres's actual type system.
//   2. Reserved scalar columns — query a row by `case_id` (scalar
//      column read, not JSONB).
//   3. Relation-path read — round-trip an ancestor + descendant,
//      query with `prop({via: ancestor("parent")})`, assert the
//      joined-table read returns the ancestor's value.
//   4. Postgres-strict null semantics — insert a row with the
//      property absent, query with `eq(prop("X"), literal(""))`,
//      verify it does NOT match (because absent ≠ empty-string at
//      the Postgres layer per the lock-in
//      `feedback_postgres_strict_ast_null_semantics`).

import { sql } from "kysely";
import { describe } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	ancestorPath,
	dateLiteral,
	datetimeLiteral,
	literal,
	prop,
	relationStep,
	timeLiteral,
} from "@/lib/domain/predicate/builders";
import { compileRelationPath } from "../compileRelationPath";
import { compileTerm, type TermCompileContext } from "../compileTerm";
import { expect, makeCaseRow, test } from "./setup";

// ---------------------------------------------------------------
// Stable test fixture IDs and schema
// ---------------------------------------------------------------
//
// Deterministic UUIDs: per-test rollback isolation lets tests reuse
// these without conflicting, and stable IDs keep `WHERE case_id =
// ...` traces readable when a test fails.

const APP_ID = "app-term-compiler";
const OWNER_ID = "owner-term-compiler";

const PATIENT_CASE_ID = "10000000-0000-0000-0000-000000000001";
const HOUSEHOLD_CASE_ID = "10000000-0000-0000-0000-000000000002";

// `patient` carries one property per data_type variant — the same
// schema shape used by the cold compile-only suite. `parent_type:
// "household"` enables the ancestor-walk test below. Every
// `CasePropertyDataType` variant declared in
// `lib/domain/blueprint.ts` has a property here so each cast token
// in `POSTGRES_CAST_FOR_DATA_TYPE` round-trips against the live
// Postgres engine at least once.
const PATIENT_SCHEMA: CaseType = {
	name: "patient",
	parent_type: "household",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "bmi", label: "BMI", data_type: "decimal" },
		{ name: "dob", label: "DOB", data_type: "date" },
		{ name: "appointment_at", label: "Appointment", data_type: "time" },
		{ name: "registered_at", label: "When", data_type: "datetime" },
		{ name: "color", label: "Color", data_type: "single_select" },
		{ name: "tags", label: "Tags", data_type: "multi_select" },
		{ name: "home_location", label: "Home", data_type: "geopoint" },
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
	db: TermCompileContext["db"],
	overrides: Partial<TermCompileContext> = {},
): TermCompileContext {
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
// Self-via property reads — every data_type round-trip
// ---------------------------------------------------------------

describe("compileTerm — round-trip — prop (self via)", () => {
	test("text property round-trips and equality matches", async ({ db }) => {
		// Insert a patient with `name = "Alice"` and read it back
		// through a `compileTerm`-emitted equality predicate. The
		// canonical use site for the term compiler is on both sides
		// of an equality comparison, so the test exercises that
		// shape.
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

		const left = compileTerm(prop("patient", "name"), makeCtx(db));
		const right = compileTerm(literal("Alice"), makeCtx(db));
		const rows = await db
			.selectFrom("cases as c")
			.select(["c.case_id"])
			.where("c.app_id", "=", APP_ID)
			.where("c.owner_id", "=", OWNER_ID)
			.where(sql<boolean>`${left} = ${right}`)
			.execute();
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});

	test("int property casts and ordered comparison works", async ({ db }) => {
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

		// Ordered comparison forces the cast to land — `30 > 25`
		// works only if the JSONB read lifted to `int`.
		const left = compileTerm(prop("patient", "age"), makeCtx(db));
		const right = compileTerm(literal(25), makeCtx(db));
		const rows = await db
			.selectFrom("cases as c")
			.select(["c.case_id"])
			.where("c.app_id", "=", APP_ID)
			.where("c.owner_id", "=", OWNER_ID)
			.where(sql<boolean>`${left} > ${right}`)
			.execute();
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});

	test("decimal property casts to numeric", async ({ db }) => {
		await db
			.insertInto("cases")
			.values(
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ bmi: 22.5 }),
				}),
			)
			.execute();

		const left = compileTerm(prop("patient", "bmi"), makeCtx(db));
		const right = compileTerm(literal(20), makeCtx(db));
		const rows = await db
			.selectFrom("cases as c")
			.select(["c.case_id"])
			.where("c.app_id", "=", APP_ID)
			.where("c.owner_id", "=", OWNER_ID)
			.where(sql<boolean>`${left} > ${right}`)
			.execute();
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});

	test("date property casts and ordered comparison against a date literal works", async ({
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
					properties: JSON.stringify({ dob: "2000-06-15" }),
				}),
			)
			.execute();

		const left = compileTerm(prop("patient", "dob"), makeCtx(db));
		const right = compileTerm(dateLiteral("1990-01-01"), makeCtx(db));
		const rows = await db
			.selectFrom("cases as c")
			.select(["c.case_id"])
			.where("c.app_id", "=", APP_ID)
			.where("c.owner_id", "=", OWNER_ID)
			.where(sql<boolean>`${left} > ${right}`)
			.execute();
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});

	test("time property casts to time and ordered comparison works", async ({
		db,
	}) => {
		// `::time` is a unique cast token — a typo on the cast
		// (e.g. `::times`) would still pass every cold-suite
		// `toContain("::time")` check because Postgres rejects the
		// typo only at parse time. The round-trip pins the cast
		// token against Postgres's actual type system.
		//
		// Wire form for time literals is `HH:MM[:SS]` per
		// `timeLiteral`'s JSDoc; storing `09:00:00` and comparing
		// against an `08:00:00` literal forces the cast to land on
		// both sides for the `>` operator to dispatch ordinally.
		await db
			.insertInto("cases")
			.values(
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ appointment_at: "09:00:00" }),
				}),
			)
			.execute();

		const left = compileTerm(prop("patient", "appointment_at"), makeCtx(db));
		const right = compileTerm(timeLiteral("08:00:00"), makeCtx(db));
		const rows = await db
			.selectFrom("cases as c")
			.select(["c.case_id"])
			.where("c.app_id", "=", APP_ID)
			.where("c.owner_id", "=", OWNER_ID)
			.where(sql<boolean>`${left} > ${right}`)
			.execute();
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});

	test("datetime property casts to timestamptz and ordered comparison works", async ({
		db,
	}) => {
		// `::timestamptz` is a unique cast token (chosen over
		// `::timestamp` so timezone information from the wire
		// string round-trips). The wire form is the ISO 8601
		// datetime per `datetimeLiteral`'s JSDoc; storing
		// `2026-01-01T12:00:00Z` and comparing against
		// `2026-01-01T11:00:00Z` forces the cast to land on both
		// sides for the `>` operator to dispatch ordinally.
		await db
			.insertInto("cases")
			.values(
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({
						registered_at: "2026-01-01T12:00:00Z",
					}),
				}),
			)
			.execute();

		const left = compileTerm(prop("patient", "registered_at"), makeCtx(db));
		const right = compileTerm(
			datetimeLiteral("2026-01-01T11:00:00Z"),
			makeCtx(db),
		);
		const rows = await db
			.selectFrom("cases as c")
			.select(["c.case_id"])
			.where("c.app_id", "=", APP_ID)
			.where("c.owner_id", "=", OWNER_ID)
			.where(sql<boolean>`${left} > ${right}`)
			.execute();
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});

	test("single_select property casts to text and equality matches", async ({
		db,
	}) => {
		// `single_select` casts to `::text` — byte-identical with
		// the cast token plain `text` properties get, but the
		// schema-driven dispatch path is structurally distinct
		// (the `data_type: "single_select"` arm in
		// `POSTGRES_CAST_FOR_DATA_TYPE`). The round-trip exercises
		// that the dispatch arm reaches the live engine and that
		// the JSON-stringified option value round-trips through
		// the `->>` read.
		await db
			.insertInto("cases")
			.values(
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ color: "red" }),
				}),
			)
			.execute();

		const left = compileTerm(prop("patient", "color"), makeCtx(db));
		const right = compileTerm(literal("red"), makeCtx(db));
		const rows = await db
			.selectFrom("cases as c")
			.select(["c.case_id"])
			.where("c.app_id", "=", APP_ID)
			.where("c.owner_id", "=", OWNER_ID)
			.where(sql<boolean>`${left} = ${right}`)
			.execute();
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});

	test("geopoint property casts to text and equality matches the wire string", async ({
		db,
	}) => {
		// `geopoint` casts to `::text` — Postgres has no native
		// geopoint type at the term-read layer (the `within-distance`
		// predicate dispatches through PostGIS's `ST_DWithin`, which
		// is the predicate compiler's concern). The term-layer cast
		// surfaces the wire-form string as text so equality
		// comparisons and field-display paths work without PostGIS.
		//
		// CommCare's wire form is four space-separated decimals:
		// `latitude longitude altitude accuracy`, verified against
		// CCHQ's parser at
		// `commcare-hq/corehq/ex-submodules/couchforms/geopoint.py`
		// and pinned by `GEOPOINT_PATTERN` in
		// `lib/domain/predicate/jsonSchema.ts`.
		const wireFormPoint = "42.3739063 -71.1109113 0.0 886.0";
		await db
			.insertInto("cases")
			.values(
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ home_location: wireFormPoint }),
				}),
			)
			.execute();

		const left = compileTerm(prop("patient", "home_location"), makeCtx(db));
		const right = compileTerm(literal(wireFormPoint), makeCtx(db));
		const rows = await db
			.selectFrom("cases as c")
			.select(["c.case_id"])
			.where("c.app_id", "=", APP_ID)
			.where("c.owner_id", "=", OWNER_ID)
			.where(sql<boolean>`${left} = ${right}`)
			.execute();
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});

	test("multi_select property casts to jsonb and survives a JSONB containment check", async ({
		db,
	}) => {
		// `multi_select` reads via `->` (not `->>`) and casts to
		// `jsonb`. The predicate compiler uses JSONB operators
		// (`?|` / `?&` / `@>`) on the result, so the cast has to
		// land on a JSONB value not a stringified text blob.
		// Verify the cast lands by composing a `@>` containment
		// check against the term-compiler output directly — the
		// `?|` / `?&` operators are key-existence specific and
		// would test a tighter shape. `@>` on jsonb arrays is the
		// general "array contains all of these elements" check.
		await db
			.insertInto("cases")
			.values(
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					properties: JSON.stringify({ tags: ["urgent", "review"] }),
				}),
			)
			.execute();

		const left = compileTerm(prop("patient", "tags"), makeCtx(db));
		const rows = await db
			.selectFrom("cases as c")
			.select(["c.case_id"])
			.where("c.app_id", "=", APP_ID)
			.where("c.owner_id", "=", OWNER_ID)
			.where(sql<boolean>`${left} @> '["urgent"]'::jsonb`)
			.execute();
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});
});

// ---------------------------------------------------------------
// Reserved scalar column reads
// ---------------------------------------------------------------

describe("compileTerm — round-trip — prop (reserved scalar columns)", () => {
	test("case_id reads from the scalar column, not from JSONB", async ({
		db,
	}) => {
		// Insert a row with NO `case_id` key in the JSONB document.
		// If the term compiler routed `case_id` through JSONB, the
		// equality check would resolve to `NULL = '<uuid>'` and
		// return zero rows. The scalar-column read finds the row.
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

		const left = compileTerm(prop("patient", "case_id"), makeCtx(db));
		const right = compileTerm(literal(PATIENT_CASE_ID), makeCtx(db));
		const rows = await db
			.selectFrom("cases as c")
			.select(["c.case_id"])
			.where("c.app_id", "=", APP_ID)
			.where("c.owner_id", "=", OWNER_ID)
			.where(sql<boolean>`${left} = ${right}`)
			.execute();
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});
});

// ---------------------------------------------------------------
// Relation-path read — non-self via
// ---------------------------------------------------------------

describe("compileTerm — round-trip — prop (non-self via)", () => {
	test("ancestor walk reads through the joined leaf alias", async ({ db }) => {
		// Graph: patient --[parent]--> household. The patient has
		// no `size` property; the household has `size = 5`. Read
		// through the ancestor walk and assert the joined-leaf
		// read surfaces the household's value.
		//
		// This test wires the JOIN itself (the term compiler
		// returns only the column-read expression — the caller
		// drives the join via `compileRelationPath`).
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
					properties: JSON.stringify({ size: 5 }),
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

		const via = ancestorPath(relationStep("parent", "household"));
		const compiledPath = compileRelationPath(via, {
			db,
			appId: APP_ID,
			ownerId: OWNER_ID,
			anchorAlias: "c",
		});
		if (compiledPath.kind !== "joined") {
			throw new Error("expected joined relation path");
		}

		// `prop("patient", "size", via)` — caseType is the
		// originating scope; the property lives on the destination
		// (household).
		const sizeExpr = compileTerm(prop("patient", "size", via), makeCtx(db));
		const five = compileTerm(literal(5), makeCtx(db));
		const rows = await db
			.selectFrom("cases as c")
			.innerJoin(
				() => compiledPath.buildLeafSubquery(),
				(join) =>
					join.onRef(
						`${compiledPath.leafAlias}.anchor_case_id`,
						"=",
						"c.case_id",
					),
			)
			.where("c.app_id", "=", APP_ID)
			.where("c.owner_id", "=", OWNER_ID)
			.where(sql<boolean>`${sizeExpr} = ${five}`)
			.select(["c.case_id"])
			.execute();
		expect(rows).toEqual([{ case_id: PATIENT_CASE_ID }]);
	});
});

// ---------------------------------------------------------------
// Postgres-strict null semantics
// ---------------------------------------------------------------

describe("compileTerm — round-trip — Postgres-strict null semantics", () => {
	test("absent JSONB key does NOT equal an empty-string literal", async ({
		db,
	}) => {
		// The Postgres-strict null semantic locked in
		// `feedback_postgres_strict_ast_null_semantics.md`: the
		// distinction between "key absent" and "key present with
		// empty string" lives in the AST and at the data-model
		// layer. `properties->>'X'` returns SQL `NULL` when the
		// key is absent; `NULL = ''` evaluates to `NULL` (not
		// true) under SQL three-valued logic, so the row is NOT
		// matched by the predicate. This is the foundational
		// distinction the `is-null` operator at the predicate
		// layer relies on.
		await db
			.insertInto("cases")
			.values(
				makeCaseRow({
					case_id: PATIENT_CASE_ID,
					case_type: "patient",
					app_id: APP_ID,
					owner_id: OWNER_ID,
					// Note: `name` key is intentionally absent from
					// the JSONB document below. The Postgres-strict
					// rule says absent ≠ empty-string.
					properties: JSON.stringify({ age: 30 }),
				}),
			)
			.execute();

		const left = compileTerm(prop("patient", "name"), makeCtx(db));
		const empty = compileTerm(literal(""), makeCtx(db));
		const rows = await db
			.selectFrom("cases as c")
			.select(["c.case_id"])
			.where("c.app_id", "=", APP_ID)
			.where("c.owner_id", "=", OWNER_ID)
			.where(sql<boolean>`${left} = ${empty}`)
			.execute();
		expect(rows).toEqual([]);
	});
});
