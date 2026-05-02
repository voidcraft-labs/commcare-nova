// lib/case-store/sql/__tests__/harness.test.ts
//
// Smoke tests for the case-store Postgres harness.
//
// These tests prove the harness's contract end-to-end against the
// live container booted by `globalSetup.ts`:
//
//   - Container is reachable; the `inject("postgresTestUrl")` URI
//     is well-formed.
//   - Required extensions installed (`pg_trgm`, `fuzzystrmatch`,
//     `postgis`); optional `pg_jsonschema` either installed or
//     logged as missing.
//   - Schema seeded (three tables with the columns the spec
//     specifies).
//   - INSERT + SELECT round-trip succeeds against the live
//     engine.
//   - Per-test rollback isolation: a sentinel row inserted here
//     is invisible to the sibling smoke file. That sibling file
//     also verifies the URI is non-empty (the architectural
//     guarantee that parallel test files share the container —
//     Vitest's globalSetup runs once per `vitest run`, so any
//     two files seeing identical URIs prove the contract).
//
// ## What this file deliberately does not test
//
// Operator-level behavior — `pg_trgm`'s `%` matching, PostGIS's
// `ST_DWithin`, etc. — is the Term/Predicate compiler tests'
// concern. The harness's only contract is "the engine is real,
// the schema is seeded, transactions roll back."

import { describe, inject } from "vitest";
import { expect, makeCaseRow, test } from "./setup";

// -- Container reachability -----------------------------------------

describe("case-store harness — container connectivity", () => {
	// `it.runs-without-fixtures` checks the URI surface that
	// globalSetup populates. Kept outside the fixture-using tests
	// because a missing URI would also break the fixture itself,
	// so this assertion has to surface the failure first.
	test("publishes a postgres:// connection URI via globalSetup", () => {
		// `inject` returns the URI globalSetup published. A typed
		// surface (the `ProvidedContext` augmentation in
		// globalSetup.ts) guarantees `string`, not `unknown`.
		const url = inject("postgresTestUrl");
		expect(url).toMatch(/^postgres:\/\//);
	});

	test("connects through the per-test fixture and runs SELECT 1", async ({
		pgClient,
	}) => {
		// Use the bare `pgClient` escape hatch: Kysely doesn't model
		// a `SELECT 1` literal, and this test exists to prove the
		// raw connection path before any Kysely code runs.
		const result = await pgClient.query<{ ok: number }>("SELECT 1 AS ok");
		expect(result.rows[0]?.ok).toBe(1);
	});
});

// -- Extensions -----------------------------------------------------

describe("case-store harness — extensions", () => {
	test("installs pg_trgm, fuzzystrmatch, and postgis", async ({ pgClient }) => {
		// `pg_extension` is the catalog of installed extensions
		// (vs. `pg_available_extensions`, which lists candidates).
		// The required set must all be present; absence is a fatal
		// harness error.
		const result = await pgClient.query<{ extname: string }>(
			`SELECT extname FROM pg_extension WHERE extname = ANY($1)`,
			[["pg_trgm", "fuzzystrmatch", "postgis"]],
		);
		const installed = new Set(result.rows.map((row) => row.extname));
		expect(installed).toContain("pg_trgm");
		expect(installed).toContain("fuzzystrmatch");
		expect(installed).toContain("postgis");
	});

	test("either installs pg_jsonschema or recorded availability", async ({
		pgClient,
	}) => {
		// `pg_jsonschema` is allowlist-gated; the harness installs
		// it when available on the image and logs a warning when
		// not. This test asserts the binary outcome — either it's
		// in `pg_extension` or `pg_available_extensions` reports it
		// missing on the running image. Both are valid harness
		// states.
		const installed = await pgClient.query<{ extname: string }>(
			`SELECT extname FROM pg_extension WHERE extname = 'pg_jsonschema'`,
		);
		const available = await pgClient.query<{ name: string }>(
			`SELECT name FROM pg_available_extensions WHERE name = 'pg_jsonschema'`,
		);
		const isInstalled = installed.rows.length > 0;
		const isAvailable = available.rows.length > 0;
		// Truth table:
		//   installed=T → pass (extension is wired up)
		//   installed=F, available=F → pass (image doesn't ship it,
		//     trigger code falls back to PL/pgSQL)
		//   installed=F, available=T → fail (harness should have
		//     installed it but didn't)
		expect(isInstalled || !isAvailable).toBe(true);
	});
});

// -- Schema ---------------------------------------------------------

describe("case-store harness — schema", () => {
	test("seeds the three case-store tables with spec columns", async ({
		pgClient,
	}) => {
		// `information_schema.columns` is the portable inspector for
		// table shape. Pulling all columns for our three tables in
		// one query keeps the test focused on shape, not on
		// per-column reachability — the type-level reachability
		// tests live next door in `database.test.ts`. This test
		// catches DDL drift that would prevent every other live-DB
		// test from running.
		const result = await pgClient.query<{
			table_name: string;
			column_name: string;
		}>(
			`SELECT table_name, column_name
			 FROM information_schema.columns
			 WHERE table_schema = 'public'
			   AND table_name IN ('cases', 'case_type_schemas', 'case_indices')`,
		);

		const columnsByTable = new Map<string, Set<string>>();
		for (const { table_name, column_name } of result.rows) {
			let bucket = columnsByTable.get(table_name);
			if (!bucket) {
				bucket = new Set();
				columnsByTable.set(table_name, bucket);
			}
			bucket.add(column_name);
		}

		// Spec-line citations match `globalSetup.ts`'s SCHEMA_DDL.
		expect(columnsByTable.get("cases")).toEqual(
			new Set([
				"case_id",
				"app_id",
				"case_type",
				"owner_id",
				"status",
				"opened_on",
				"modified_on",
				"closed_on",
				"parent_case_id",
				"properties",
			]),
		);
		expect(columnsByTable.get("case_type_schemas")).toEqual(
			new Set(["app_id", "case_type", "schema"]),
		);
		expect(columnsByTable.get("case_indices")).toEqual(
			new Set([
				"case_id",
				"ancestor_id",
				"identifier",
				"relationship",
				"depth",
			]),
		);
	});
});

// -- Round-trip + isolation ----------------------------------------

describe("case-store harness — INSERT/SELECT round-trip", () => {
	test("inserts a case via Kysely and reads it back", async ({ db }) => {
		const caseRow = makeCaseRow({
			case_id: "11111111-1111-1111-1111-111111111111",
			properties: JSON.stringify({ name: "Alice", age: 30 }),
		});

		await db.insertInto("cases").values(caseRow).execute();

		const fetched = await db
			.selectFrom("cases")
			.selectAll()
			.where("case_id", "=", caseRow.case_id)
			.executeTakeFirstOrThrow();

		expect(fetched.app_id).toBe("app-test");
		expect(fetched.case_type).toBe("patient");
		expect(fetched.status).toBe("open");
		// `properties` round-trips as a JSON object (the column is
		// JSONB; Kysely deserializes via `JSONColumnType`'s read
		// arm).
		expect(fetched.properties).toEqual({ name: "Alice", age: 30 });
	});

	test("rollback isolates per-test writes", async ({ db, pgClient }) => {
		// Insert a row through Kysely, then verify a parallel
		// query through the same transaction sees it (sanity
		// check — same connection, same BEGIN scope, must see
		// uncommitted writes).
		await db
			.insertInto("cases")
			.values(
				makeCaseRow({
					case_id: "22222222-2222-2222-2222-222222222222",
					case_type: "isolation-marker",
				}),
			)
			.execute();
		const uncommittedView = await pgClient.query<{ case_type: string }>(
			`SELECT case_type FROM cases WHERE case_id = $1`,
			["22222222-2222-2222-2222-222222222222"],
		);
		expect(uncommittedView.rows[0]?.case_type).toBe("isolation-marker");

		// The next test in this file runs in its own transaction;
		// we don't have to assert isolation HERE — the assertion
		// happens in the next test below. The fixture's afterEach
		// rollback runs between this test and the next.
	});

	test("subsequent test sees no prior writes", async ({ pgClient }) => {
		// If the rollback from the prior test failed, the
		// "isolation-marker" row would still be visible. A
		// `SELECT count` against the prior test's case_id must
		// return zero — proof that BEGIN/ROLLBACK contains writes.
		const result = await pgClient.query<{ count: string }>(
			`SELECT count(*)::text AS count FROM cases WHERE case_id = $1`,
			["22222222-2222-2222-2222-222222222222"],
		);
		expect(result.rows[0]?.count).toBe("0");
	});
});

// Cross-file container-sharing is verified by
// `harness-isolation.test.ts` (sibling). That file reads the same
// `inject("postgresTestUrl")` URI; equality across files proves
// Vitest's globalSetup ran once for the whole `vitest run`. The
// architectural guarantee is documented in `globalSetup.ts`'s
// header — the test confirms the behavior end-to-end.
