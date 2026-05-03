// lib/case-store/migrations/__tests__/runner.test.ts
//
// Tests for the migration runner.
//
// ## Why these tests don't share the harness's `db` fixture
//
// The harness's per-test fixture wraps every test in BEGIN/
// ROLLBACK against a database that already has the migrations
// applied (globalSetup runs them once per `vitest run`). Tests
// here need to exercise migrate-from-empty and rollback-from-
// latest paths — neither shape is achievable from inside an
// already-migrated database. Re-running migrations against the
// shared database would also conflict with the
// `kysely_migration` table state globalSetup already initialized.
//
// The fix: each test creates its own short-lived database against
// the testcontainer's superuser URI (`CREATE DATABASE
// runner_test_<rand>`), runs migrations there, asserts, and
// drops it on cleanup. Adds ~50ms per test but keeps the test's
// schema state fully isolated from the harness's shared one.
//
// ## Why a fresh DB, not a fresh schema (`CREATE SCHEMA`)
//
// The migrations DDL is `public`-implicit — every `CREATE TABLE`
// lands in `public` because we don't set `search_path`. Running
// migrations into a non-`public` schema would either require
// rewriting every migration to be schema-aware (rejected — adds
// boilerplate to every future migration for a per-test concern)
// or pre-setting `search_path` and praying every migration
// honors it (fragile). Per-database isolation has none of those
// concerns.

import { describe, expect, it } from "vitest";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import { runMigration } from "../runner";

// ---------------------------------------------------------------
// Per-test database lifecycle
// ---------------------------------------------------------------
// `setupPerTestDatabase` (shared with the extension-allowlist gate
// tests at `lib/case-store/postgres/__tests__/checkExtensions.test.ts`)
// wires `beforeEach` / `afterEach` for `CREATE DATABASE
// runner_test_<rand>` + `DROP DATABASE WITH (FORCE)`. Each test
// gets a fresh empty-schema database; the runner's
// migrate-from-empty + roll-back-to-empty paths require one,
// which the harness's `BEGIN/ROLLBACK` fixture cannot supply.
//
// The shared helper installs the three required extensions
// post-CREATE-DATABASE (`pg_trgm`, `fuzzystrmatch`, `postgis`) so
// the migration runner exercises the same DDL surface in tests
// that production sees on a freshly-provisioned Cloud SQL instance
// after Phase 5 runs.

const dbHandle = setupPerTestDatabase({
	databaseNamePrefix: "runner_test_",
});

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

describe("runMigration — latest", () => {
	it("creates all four case-store tables in an empty database", async () => {
		const outcome = await runMigration(dbHandle.db, "latest");
		expect(outcome.success).toBe(true);
		expect(outcome.error).toBeUndefined();
		// Two migration files; both should run on a fresh database.
		expect(outcome.results).toHaveLength(2);
		expect(outcome.results.map((r) => r.migrationName)).toEqual([
			"0001_init",
			"0002_indices",
		]);

		// Verify the tables landed: query information_schema via the
		// raw pg.Pool because the migration runner's `Kysely<unknown>`
		// has no schema-aware builder for `information_schema`. Raw
		// SQL is the right surface for catalog probes.
		const tables = await dbHandle.pool.query<{ table_name: string }>(
			`SELECT table_name FROM information_schema.tables
			 WHERE table_schema = 'public'
			   AND table_name IN ('cases', 'case_type_schemas', 'case_indices', 'cases_quarantine')`,
		);
		const tableNames = new Set(tables.rows.map((r) => r.table_name));
		expect(tableNames).toEqual(
			new Set([
				"cases",
				"case_type_schemas",
				"case_indices",
				"cases_quarantine",
			]),
		);
	});

	it("is idempotent — second run is a no-op", async () => {
		await runMigration(dbHandle.db, "latest");
		const second = await runMigration(dbHandle.db, "latest");
		expect(second.success).toBe(true);
		// No migrations to run on the second invocation; results is
		// empty because Kysely returns only the migrations actually
		// executed.
		expect(second.results).toHaveLength(0);
	});

	it("uuidv7() is the case_id default — verifies PG 18's built-in is reachable", async () => {
		// Plan 2 locked PG 18's `uuidv7()` as the `case_id` default.
		// This test inserts a `cases` row without `case_id` and
		// verifies the returned value is a valid UUID v7. A future
		// image regression that drops to PG 17 (no `uuidv7()`) or to
		// `gen_random_uuid()` (uuidv4) surfaces here, not at runtime.
		await runMigration(dbHandle.db, "latest");

		const result = await dbHandle.pool.query<{ case_id: string }>(
			`INSERT INTO cases (app_id, case_type, properties)
			 VALUES ($1, $2, $3)
			 RETURNING case_id`,
			["app-test", "patient", JSON.stringify({})],
		);
		const caseId = result.rows[0]?.case_id;
		expect(caseId).toBeDefined();

		// Standard UUID v7 shape: 8-4-4-4-12 hex with version
		// nibble = 7 in the third group's first position. The
		// regex pins both the structural shape and the version
		// nibble in one match. (`y` per RFC 4122 §4.4 is one of
		// 8/9/a/b — the variant nibble; we pin the version
		// position only.)
		const v7Pattern =
			/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
		expect(caseId).toMatch(v7Pattern);
	});
});

describe("runMigration — down", () => {
	it("drops the most-recently-applied migration", async () => {
		// Bring to latest, then roll back one. The `0002_indices`
		// migration runs second, so down() should drop only those
		// two indexes — leaving the four tables intact.
		await runMigration(dbHandle.db, "latest");
		const outcome = await runMigration(dbHandle.db, "down");
		expect(outcome.success).toBe(true);
		expect(outcome.results).toHaveLength(1);
		expect(outcome.results[0]?.migrationName).toBe("0002_indices");
		expect(outcome.results[0]?.direction).toBe("Down");

		// Tables still present.
		const tableCheck = await dbHandle.pool.query<{ count: string }>(
			`SELECT count(*)::text AS count
			 FROM information_schema.tables
			 WHERE table_schema = 'public'
			   AND table_name IN ('cases', 'case_type_schemas', 'case_indices', 'cases_quarantine')`,
		);
		expect(tableCheck.rows[0]?.count).toBe("4");

		// Indexes from 0002 are gone (the two we created — the
		// primary-key indexes from 0001 remain).
		const indexCheck = await dbHandle.pool.query<{ indexname: string }>(
			`SELECT indexname FROM pg_indexes
			 WHERE schemaname = 'public'
			   AND tablename = 'case_indices'
			   AND indexname IN (
			     'case_indices_ancestor_id_identifier_idx',
			     'case_indices_case_id_identifier_idx'
			   )`,
		);
		expect(indexCheck.rows).toHaveLength(0);
	});

	it("rolling back twice removes the schema entirely", async () => {
		await runMigration(dbHandle.db, "latest");
		await runMigration(dbHandle.db, "down"); // rolls back 0002
		const outcome = await runMigration(dbHandle.db, "down"); // rolls back 0001
		expect(outcome.success).toBe(true);
		expect(outcome.results[0]?.migrationName).toBe("0001_init");

		// All four case-store tables are gone.
		const tableCheck = await dbHandle.pool.query<{ count: string }>(
			`SELECT count(*)::text AS count
			 FROM information_schema.tables
			 WHERE table_schema = 'public'
			   AND table_name IN ('cases', 'case_type_schemas', 'case_indices', 'cases_quarantine')`,
		);
		expect(tableCheck.rows[0]?.count).toBe("0");
	});
});

describe("runMigration — status", () => {
	it("reports every migration as NotExecuted on an empty database", async () => {
		const outcome = await runMigration(dbHandle.db, "status");
		expect(outcome.success).toBe(true);
		// Both migrations present in the folder; both NotExecuted.
		expect(outcome.results).toHaveLength(2);
		for (const result of outcome.results) {
			expect(result.status).toBe("NotExecuted");
		}
	});

	it("reports every migration as Success after migrating to latest", async () => {
		await runMigration(dbHandle.db, "latest");
		const outcome = await runMigration(dbHandle.db, "status");
		expect(outcome.success).toBe(true);
		expect(outcome.results).toHaveLength(2);
		for (const result of outcome.results) {
			expect(result.status).toBe("Success");
		}
	});

	it("does not mutate the database — running status twice yields identical results", async () => {
		// Pin that `status` is read-only. Running it before and
		// after another `status` should produce the same result;
		// any mutation would manifest as a different result on the
		// second call.
		const first = await runMigration(dbHandle.db, "status");
		const second = await runMigration(dbHandle.db, "status");
		expect(first.results).toEqual(second.results);
	});
});
