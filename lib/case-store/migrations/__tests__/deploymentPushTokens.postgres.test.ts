import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { canonicalTestBlueprint } from "@/lib/db/__tests__/appStateTestDb";
import { decomposeBlueprint } from "@/lib/db/blueprintRows";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import { caseStoreMigrations } from "..";
import { up } from "../20260906000000_deployment_push_tokens";

const database = setupPerTestDatabase({
	databaseNamePrefix: "deployment_push_token_migration_",
	prepareTemplate: async (db) => {
		const result = await new Migrator({
			db,
			provider: {
				getMigrations: async () =>
					Object.fromEntries(
						Object.entries(caseStoreMigrations).filter(
							([name]) => name < "20260906000000_deployment_push_tokens",
						),
					),
			},
		}).migrateToLatest();
		if (result.error !== undefined) throw result.error;
	},
});

async function seedExistingMappings() {
	const doc = toPersistableDoc(
		canonicalTestBlueprint("app", "Existing publication"),
	);
	await sql`INSERT INTO apps (id, owner, project_id, app_name, app_name_lower,
		module_count, form_count, mutation_seq, status, awaiting_input)
		VALUES ('app', 'owner', 'project', ${doc.appName}, ${doc.appName.toLowerCase()},
		${doc.moduleOrder.length}, ${Object.keys(doc.forms).length}, 0, 'complete', false)`.execute(
		database.db,
	);
	for (const row of decomposeBlueprint(doc)) {
		await sql`INSERT INTO blueprint_entities (app_id, uuid, kind, parent_uuid, ordinal, data)
			VALUES ('app', ${row.uuid}, ${row.kind}, ${row.parent_uuid}, ${row.ordinal}, ${JSON.stringify(row.data)}::jsonb)`.execute(
			database.db,
		);
	}
	await sql`INSERT INTO app_deployments (id, app_id, project_id, server, domain, state, created_by)
		VALUES ('01992000-0000-7000-8000-000000000001', 'app', 'project', 'production', 'acme', 'uploaded', 'owner')`.execute(
		database.db,
	);
	await sql`INSERT INTO app_deployment_resources
		(deployment_id, kind, nova_resource_id, remote_id, ownership, pushed_at, pushed_revision, superseded_at)
		VALUES
		('01992000-0000-7000-8000-000000000001', 'app', 'app', 'hq-old', 'nova-created', '2026-09-06T00:00:00Z', 0, '2026-09-06T00:00:00Z'),
		('01992000-0000-7000-8000-000000000001', 'app', 'app', 'hq-current', 'nova-created', '2026-09-06T00:00:00Z', 0, NULL)`.execute(
		database.db,
	);
}

async function mappings() {
	return (
		await sql<{ remote_id: string; row: Record<string, unknown> }>`
		SELECT remote_id, to_jsonb(r) AS row FROM app_deployment_resources r ORDER BY remote_id`.execute(
			database.db,
		)
	).rows;
}

async function token() {
	const result = await sql<{
		push_token: string;
	}>`SELECT push_token FROM app_deployment_resources WHERE remote_id = 'hq-current'`.execute(
		database.db,
	);
	return result.rows[0].push_token;
}

describe("deployment push identity migration", () => {
	it("backfills distinct UUIDs without changing either historical or active mappings", async () => {
		await seedExistingMappings();
		const before = await mappings();
		expect(before).toHaveLength(2);
		expect(before.every(({ row }) => !("push_token" in row))).toBe(true);
		await database.db.transaction().execute(up);
		const after = await mappings();
		expect(
			after.map(({ remote_id, row: { push_token, ...row } }) => ({
				remote_id,
				row,
			})),
		).toEqual(before);
		const tokens = after.map(({ row }) => row.push_token);
		for (const value of tokens)
			expect(value).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			);
		expect(new Set(tokens).size).toBe(2);
		// The database enforces the non-null identity, independently of typed writers.
		await expect(
			sql`UPDATE app_deployment_resources SET push_token = NULL`.execute(
				database.db,
			),
		).rejects.toMatchObject({ code: "23502", column: "push_token" });
		expect(await mappings()).toEqual(after);
	});

	it("rotates on same-value legacy push updates but preserves identity through observations and supersession", async () => {
		await seedExistingMappings();
		await database.db.transaction().execute(up);
		const first = await token();
		await sql`UPDATE app_deployment_resources SET pushed_at = pushed_at, pushed_revision = pushed_revision,
			remote_id = remote_id WHERE remote_id = 'hq-current'`.execute(
			database.db,
		);
		const second = await token();
		expect(second).not.toBe(first);
		await sql`UPDATE app_deployment_resources SET remote_revision = 5, remote_observed_at = now()
			WHERE remote_id = 'hq-current'`.execute(database.db);
		expect(await token()).toBe(second);
		await sql`UPDATE app_deployment_resources SET superseded_at = now() WHERE remote_id = 'hq-current'`.execute(
			database.db,
		);
		expect(await token()).toBe(second);
		await sql`INSERT INTO app_deployment_resources (deployment_id, kind, nova_resource_id, remote_id, ownership)
			VALUES ('01992000-0000-7000-8000-000000000001', 'app', 'app', 'hq-next', 'nova-created')`.execute(
			database.db,
		);
		const all = await mappings();
		expect(all).toHaveLength(3);
		expect(new Set(all.map(({ row }) => row.push_token)).size).toBe(3);
	});
});
