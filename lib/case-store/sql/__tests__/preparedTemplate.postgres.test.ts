import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { postgresTestUrl, setupPerTestDatabase } from "./perTestDatabase";

const created: string[] = [];
let preparationCount = 0;
let templateUri = "";

// Parent teardown runs after the nested fixture's teardown, including its template.
afterAll(async () => {
	const admin = new Client({ connectionString: postgresTestUrl() });
	try {
		await admin.connect();
		const remaining = await admin.query(
			"SELECT datname FROM pg_database WHERE datname = ANY($1::text[])",
			[created],
		);
		expect(remaining.rows).toEqual([]);
	} finally {
		await admin.end();
	}
});

describe("prepared migration preconditions", () => {
	const h = setupPerTestDatabase({
		databaseNamePrefix: "prepared_contract_",
		prepareTemplate: async (_db, pool) => {
			preparationCount += 1;
			const database = await pool.query<{ name: string }>(
				"SELECT current_database() AS name",
			);
			created.push(database.rows[0].name);
			const uri = new URL(postgresTestUrl());
			uri.pathname = `/${database.rows[0].name}`;
			templateUri = uri.toString();
			await pool.query("CREATE TABLE legacy_input (value text NOT NULL)");
			await pool.query("INSERT INTO legacy_input VALUES ('before migration')");
		},
	});
	beforeEach(() => {
		created.push(h.databaseName);
	});

	it.each(["first", "second"])(
		"isolates the %s migration's committed writes",
		async (label) => {
			expect(preparationCount).toBe(1);
			expect(
				(await h.pool.query("SELECT value FROM legacy_input")).rows,
			).toEqual([{ value: "before migration" }]);
			await h.pool.query("UPDATE legacy_input SET value = $1", [label]);
			expect(
				(await h.pool.query("SELECT value FROM legacy_input")).rows,
			).toEqual([{ value: label }]);
			const template = new Client({ connectionString: templateUri });
			try {
				await expect(template.connect()).rejects.toMatchObject({
					code: "55000",
				});
			} finally {
				await template.end();
			}
		},
	);
});
