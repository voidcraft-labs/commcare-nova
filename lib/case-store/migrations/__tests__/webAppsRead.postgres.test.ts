import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { canonicalTestBlueprint } from "@/lib/db/__tests__/appStateTestDb";
import { decomposeBlueprint } from "@/lib/db/blueprintRows";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import { caseStoreMigrations } from "..";
import {
	down,
	up,
} from "../20261101000000_hq_round_trip_platforms_web_apps_read";

const MIGRATION = "20261101000000_hq_round_trip_platforms_web_apps_read";

/* The stack's prefix: every migration before this one, so the column the
 * deployment ledger added is there with a row holding it. */
const database = setupPerTestDatabase({
	databaseNamePrefix: "web_apps_read_migration_",
	prepareTemplate: async (db) => {
		const result = await new Migrator({
			db,
			provider: {
				getMigrations: async () =>
					Object.fromEntries(
						Object.entries(caseStoreMigrations).filter(
							([name]) => name < MIGRATION,
						),
					),
			},
		}).migrateToLatest();
		if (result.error !== undefined) throw result.error;
	},
});

const DEPLOYMENT = "01992000-0000-7000-8000-000000000011";

async function seedDeployment(webAppsEnabled: boolean | null): Promise<void> {
	const doc = toPersistableDoc(canonicalTestBlueprint("app", "Published app"));
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
	const phases = {
		upload: { status: "succeeded", at: "2026-10-01T00:00:00Z" },
	};
	await sql`INSERT INTO app_deployments
		(id, app_id, project_id, server, domain, state, resume_phase, phases, created_by,
			target_web_apps_enabled)
		VALUES (${DEPLOYMENT}::uuid, 'app', 'project', 'production', 'clinic', 'uploaded',
			NULL, ${JSON.stringify(phases)}::jsonb, 'owner', ${webAppsEnabled})`.execute(
		database.db,
	);
}

async function column(): Promise<
	{ readonly dataType: string; readonly nullable: string } | undefined
> {
	const result = await sql<{ data_type: string; is_nullable: string }>`
		SELECT data_type, is_nullable FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'app_deployments'
			AND column_name = 'target_web_apps_enabled'
	`.execute(database.db);
	const row = result.rows[0];
	return row === undefined
		? undefined
		: { dataType: row.data_type, nullable: row.is_nullable };
}

describe(MIGRATION, () => {
	it("drops the stored Web Apps read from a deployment that holds one, keeping the row", async () => {
		await seedDeployment(true);
		expect(await column()).toEqual({ dataType: "boolean", nullable: "YES" });

		await up(database.db);

		expect(await column()).toBeUndefined();
		const rows = await sql<{ id: string; domain: string }>`
			SELECT id::text AS id, domain FROM app_deployments
		`.execute(database.db);
		expect(rows.rows).toEqual([{ id: DEPLOYMENT, domain: "clinic" }]);
	});

	it("adds the column back nullable on the way down, holding nothing", async () => {
		await seedDeployment(false);
		await up(database.db);

		await down(database.db);

		expect(await column()).toEqual({ dataType: "boolean", nullable: "YES" });
		const rows = await sql<{ value: boolean | null }>`
			SELECT target_web_apps_enabled AS value FROM app_deployments
		`.execute(database.db);
		expect(rows.rows).toEqual([{ value: null }]);
	});
});
