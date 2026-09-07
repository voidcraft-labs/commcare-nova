// Real extension/schema access and rollback isolation of the shared SQL fixture.
import { Client } from "pg";
import { afterAll, describe, inject } from "vitest";
import { expect, makeCaseRow, test } from "./setup";

afterAll(async () => {
	const observer = new Client({ connectionString: inject("postgresTestUrl") });
	try {
		await observer.connect();
		const remaining = await observer.query(
			"SELECT case_id FROM cases WHERE case_id = ANY($1::text[])",
			[
				[
					"11111111-1111-1111-1111-111111111111",
					"22222222-2222-2222-2222-222222222222",
				],
			],
		);
		expect(remaining.rows).toEqual([]);
	} finally {
		await observer.end();
	}
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
});

// -- Schema ---------------------------------------------------------

describe("case-store harness — schema", () => {
	test("seeds the four case-store tables with the expected columns", async ({
		pgClient,
	}) => {
		// `information_schema.columns` is the portable inspector for
		// table shape. Pulling all columns for our four tables in
		// one query keeps the test focused on shape, not on
		// per-column reachability — the type-level reachability
		// tests live next door in `database.test.ts`. This test
		// catches DDL drift that would prevent every other live-DB
		// test from running.
		//
		// `parked_case_values` is the per-property park the
		// `applySchemaChange` migrations write to — one row per VALUE a
		// migration could not carry into a property's new declaration.
		const result = await pgClient.query<{
			table_name: string;
			column_name: string;
		}>(
			`SELECT table_name, column_name
			 FROM information_schema.columns
			 WHERE table_schema = 'public'
			   AND table_name IN ('cases', 'case_type_schemas', 'case_indices', 'parked_case_values')`,
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

		// `case_name` is a top-level scalar column on `cases` (the
		// CCHQ-platform-required display name that lives outside the
		// JSONB property document).
		expect(columnsByTable.get("cases")).toEqual(
			new Set([
				"case_id",
				"app_id",
				"case_type",
				"project_id",
				"owner_id",
				"status",
				"opened_on",
				"modified_on",
				"closed_on",
				"case_name",
				"external_id",
				"parent_case_id",
				"properties",
			]),
		);
		expect(columnsByTable.get("case_type_schemas")).toEqual(
			new Set([
				"app_id",
				"case_type",
				"is_active",
				"retired_seq",
				"schema",
				"synced_seq",
				"index_pending_seq",
				"index_synced_seq",
			]),
		);
		expect(columnsByTable.get("case_indices")).toEqual(
			new Set([
				"case_id",
				"ancestor_id",
				"target_case_type",
				"identifier",
				"relationship",
				"depth",
			]),
		);
		expect(columnsByTable.get("parked_case_values")).toEqual(
			new Set([
				"id",
				"app_id",
				"case_id",
				"case_type",
				"property",
				"original_value",
				"reason",
				"from_type",
				"to_type",
				"dismissed_at",
				"created_at",
			]),
		);
	});
});

// -- Round-trip + isolation ----------------------------------------

describe("case-store harness — INSERT/SELECT round-trip", () => {
	test("checks the composite app/Project foreign key before the test can assert success", async ({
		db,
	}) => {
		await expect(
			db
				.insertInto("cases")
				.values(
					makeCaseRow({
						app_id: "missing-app",
						project_id: "missing-project",
					}),
				)
				.execute(),
		).rejects.toMatchObject({ code: "23503" });
	});

	test("inserts a case via Kysely and reads it back", async ({ db }) => {
		// Pin the case_id locally so the SELECT-side WHERE clause has
		// a concrete `string` to compare against. `makeCaseRow`'s
		// `case_id` is `Insertable<CasesTable>['case_id']` which is
		// `string | undefined` (the database-generated `uuidv7()`
		// default makes the column optional on insert), and TS widens
		// the field through the override merge. The explicit local
		// keeps the test type clean without a non-null assertion.
		const caseId = "11111111-1111-1111-1111-111111111111";
		const caseRow = makeCaseRow({
			case_id: caseId,
			properties: JSON.stringify({ name: "Alice", age: 30 }),
		});

		await db.insertInto("cases").values(caseRow).execute();

		const fetched = await db
			.selectFrom("cases")
			.selectAll()
			.where("case_id", "=", caseId)
			.executeTakeFirstOrThrow();

		expect(fetched.app_id).toBe("app-test");
		expect(fetched.case_type).toBe("patient");
		expect(fetched.status).toBe("open");
		// `properties` round-trips as a JSON object (the column is
		// JSONB; Kysely deserializes via `JSONColumnType`'s read
		// arm).
		expect(fetched.properties).toEqual({ name: "Alice", age: 30 });
	});

	test("Kysely and the raw client observe the same uncommitted transaction", async ({
		db,
		pgClient,
	}) => {
		// Insert a row through Kysely, then verify a raw
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
