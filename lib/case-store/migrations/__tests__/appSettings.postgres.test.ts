import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { canonicalTestBlueprint } from "@/lib/db/__tests__/appStateTestDb";
import { decomposeBlueprint } from "@/lib/db/blueprintRows";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import { caseStoreMigrations } from "..";
import { up } from "../20261015030000_app_settings";

const database = setupPerTestDatabase({
	databaseNamePrefix: "app_settings_migration_",
	prepareTemplate: async (db) => {
		const result = await new Migrator({
			db,
			provider: {
				getMigrations: async () =>
					Object.fromEntries(
						Object.entries(caseStoreMigrations).filter(
							([name]) => name < "20261015030000_app_settings",
						),
					),
			},
		}).migrateToLatest();
		if (result.error !== undefined) throw result.error;
	},
});

async function seedApp(appId: string) {
	const doc = toPersistableDoc(canonicalTestBlueprint(appId, "Settings app"));
	await sql`INSERT INTO apps (id, owner, project_id, app_name, app_name_lower,
		module_count, form_count, mutation_seq, status, awaiting_input)
		VALUES (${appId}, 'owner', 'project', ${doc.appName}, ${doc.appName.toLowerCase()},
		${doc.moduleOrder.length}, ${Object.keys(doc.forms).length}, 0, 'complete', false)`.execute(
		database.db,
	);
	for (const row of decomposeBlueprint(doc)) {
		await sql`INSERT INTO blueprint_entities (app_id, uuid, kind, parent_uuid, ordinal, data)
			VALUES (${appId}, ${row.uuid}, ${row.kind}, ${row.parent_uuid}, ${row.ordinal}, ${JSON.stringify(row.data)}::jsonb)`.execute(
			database.db,
		);
	}
}

async function snapshotText(appId: string): Promise<string> {
	const result = await sql<{ snapshot: string }>`
		SELECT nova_current_app_change_fold_snapshot(${appId})::text AS snapshot
	`.execute(database.db);
	const snapshot = result.rows[0]?.snapshot;
	if (snapshot === undefined) throw new Error(`No snapshot for ${appId}.`);
	return snapshot;
}

describe("20261015030000_app_settings", () => {
	it("keeps the snapshot of an app whose column is NULL and carries a filled one", async () => {
		await seedApp("unfilled");
		await seedApp("filled");
		const unfilledBefore = await snapshotText("unfilled");
		const filledBefore = await snapshotText("filled");

		await up(database.db);

		expect(await snapshotText("unfilled")).toBe(unfilledBefore);
		const settings = { showSavedForms: true, showIncompleteForms: false };
		await sql`UPDATE apps SET app_settings = ${JSON.stringify(settings)}::jsonb
			WHERE id = 'filled'`.execute(database.db);
		expect(JSON.parse(await snapshotText("filled"))).toEqual({
			...JSON.parse(filledBefore),
			appSettings: settings,
		});
	});

	it("refuses a value that is not an object", async () => {
		await seedApp("scalar");
		await up(database.db);
		await expect(
			sql`UPDATE apps SET app_settings = 'true'::jsonb WHERE id = 'scalar'`.execute(
				database.db,
			),
		).rejects.toThrow(/check constraint/);
	});
});
