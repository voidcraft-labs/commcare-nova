import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import { setupPerTestDatabase } from "./perTestDatabase";

describe("migrated database clones", () => {
	const h = setupPerTestDatabase({
		databaseNamePrefix: "clone_contract_",
		schema: "migrated",
	});

	const databases: string[] = [];
	beforeEach(() => {
		databases.push(h.databaseName);
	});
	afterAll(async () => {
		const admin = new Client({ connectionString: inject("postgresTestUrl") });
		try {
			await admin.connect();
			const remaining = await admin.query(
				"SELECT datname FROM pg_database WHERE datname = ANY($1::text[])",
				[databases],
			);
			expect(remaining.rows).toEqual([]);
		} finally {
			await admin.end();
		}
	});

	// Both cases commit a real write. Each must start empty regardless of order.
	it.each(["first", "second"])(
		"isolates committed writes in the %s clone",
		async () => {
			const rows = await h.pool.query("SELECT id FROM apps");
			expect(rows.rows).toEqual([]);
			await h.pool.query(
				"INSERT INTO apps (id, owner, project_id, app_name, app_name_lower) VALUES ('sentinel', 'owner', 'project', 'Sentinel', 'sentinel')",
			);
			expect((await h.pool.query("SELECT id FROM apps")).rows).toEqual([
				{ id: "sentinel" },
			]);
		},
	);

	it("keeps the migrated template closed to accidental writers", async () => {
		const uri = new URL(inject("postgresTestUrl"));
		uri.pathname = `/${inject("postgresMigratedTemplate")}`;
		const client = new Client({ connectionString: uri.toString() });
		try {
			await expect(client.connect()).rejects.toMatchObject({ code: "55000" });
		} finally {
			await client.end();
		}
	});
});

describe("migration database clones", () => {
	const h = setupPerTestDatabase({ databaseNamePrefix: "empty_contract_" });
	it("installs extensions without applying application migrations", async () => {
		const result = await h.pool.query(
			"SELECT to_regclass('public.apps') AS apps, PostGIS_Version() AS postgis",
		);
		expect(result.rows[0].apps).toBeNull();
		expect(result.rows[0].postgis).toMatch(/^3\.6/);
	});
});
