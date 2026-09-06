import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { proseText } from "@/lib/domain/prose";
import { createLookupTable } from "@/lib/lookup/service";
import { scanPersistedLookupReferences } from "../lib/persistedLookupReferenceScan";

const h = setupAppStateTestDb("persisted_lookup_scan_");
const PROJECT = "lookup-scan-project";
const OWNER = "lookup-scan-owner";

async function seedLookupApp(id: string) {
	await h.seedProjectMember(OWNER, PROJECT, "owner");
	const table = await createLookupTable(
		{ projectId: PROJECT, actorId: OWNER, role: "owner" },
		{
			name: `Choices ${id}`,
			tag: `choices_${id}`,
			columns: [{ wireName: "name", label: "Name", dataType: "text" }],
		},
	);
	const field = f({
		uuid: testUuid(`field-${id}`),
		kind: "single_select",
		id: "choice",
		label: proseText("Choice"),
		optionsSource: {
			kind: "lookup",
			tableId: table.id,
			valueColumnId: table.columns[0].id,
			labelColumnId: table.columns[0].id,
		},
	});
	await h.seedAppWithBlueprint(
		buildDoc({
			appName: `App ${id}`,
			modules: [
				{
					name: "Module",
					forms: [{ name: "Form", type: "survey", fields: [field] }],
				},
			],
		}),
		{ id, owner: OWNER, projectId: PROJECT },
	);
	// Seed independent exact persisted targets, without using the structural extractor.
	await h
		.db()
		.insertInto("lookup_table_references")
		.values({ app_id: id, project_id: PROJECT, table_id: table.id })
		.execute();
	await h
		.db()
		.insertInto("lookup_column_references")
		.values({
			app_id: id,
			project_id: PROJECT,
			table_id: table.id,
			column_id: table.columns[0].id,
		})
		.execute();
	return { table, field };
}

async function persistedState() {
	return {
		apps: await h.db().selectFrom("apps").selectAll().orderBy("id").execute(),
		entities: await h
			.db()
			.selectFrom("blueprint_entities")
			.selectAll()
			.orderBy("uuid")
			.execute(),
		tables: await h
			.db()
			.selectFrom("lookup_table_references")
			.selectAll()
			.orderBy("app_id")
			.orderBy("table_id")
			.execute(),
		columns: await h
			.db()
			.selectFrom("lookup_column_references")
			.selectAll()
			.orderBy("app_id")
			.orderBy("column_id")
			.execute(),
	};
}

describe("persisted lookup reference audit", () => {
	it("compares nonempty targets, retains trashed apps and reports missing columns plus extra tables without writes", async () => {
		const live = await seedLookupApp("z_live");
		const trashed = await seedLookupApp("a_trashed");
		const deletedAt = new Date("2026-08-01T12:00:00Z");
		await h
			.db()
			.updateTable("apps")
			.set({ deleted_at: deletedAt })
			.where("id", "=", "a_trashed")
			.execute();
		const cleanState = await persistedState();
		expect(await scanPersistedLookupReferences(h.db())).toMatchObject({
			scannedApps: 2,
			comparedApps: 2,
			cleanApps: 2,
			exitCode: 0,
		});
		expect(await persistedState()).toEqual(cleanState);

		await h
			.db()
			.deleteFrom("lookup_column_references")
			.where("app_id", "=", "a_trashed")
			.execute();
		await h
			.db()
			.insertInto("lookup_table_references")
			.values({
				app_id: "a_trashed",
				project_id: PROJECT,
				table_id: live.table.id,
			})
			.execute();
		const mismatchedState = await persistedState();
		expect(await scanPersistedLookupReferences(h.db())).toEqual({
			scannedApps: 2,
			comparedApps: 2,
			cleanApps: 1,
			mismatches: [
				{
					appId: "a_trashed",
					projectId: PROJECT,
					appName: "App a_trashed",
					deletedAt: deletedAt.toISOString(),
					structuralOnly: {
						tableIds: [],
						columnTargets: [
							{
								tableId: trashed.table.id,
								columnId: trashed.table.columns[0].id,
							},
						],
					},
					storedOnly: { tableIds: [live.table.id], columnTargets: [] },
				},
			],
			unassemblableApps: [],
			operationalErrors: [],
			structuralOnlyApps: 1,
			storedOnlyApps: 1,
			structuralOnlyTargets: 1,
			storedOnlyTargets: 1,
			exitCode: 1,
		});
		expect(await persistedState()).toEqual(mismatchedState);
	});

	it("continues past an unassemblable app to compare the remaining persisted apps", async () => {
		const broken = await seedLookupApp("a_broken");
		await seedLookupApp("z_good");
		expect((await scanPersistedLookupReferences(h.db())).exitCode).toBe(0);
		const corrupted =
			await sql`UPDATE blueprint_entities SET data = jsonb_set(data, '{kind}', '"unreadable-field-kind"'::jsonb)
			WHERE app_id = 'a_broken' AND uuid = ${broken.field.uuid} RETURNING uuid`.execute(
				h.db(),
			);
		expect(corrupted.rows).toEqual([{ uuid: broken.field.uuid }]);
		const before = await persistedState();
		const report = await scanPersistedLookupReferences(h.db());
		expect(report).toMatchObject({
			scannedApps: 2,
			comparedApps: 1,
			cleanApps: 1,
			exitCode: 1,
			mismatches: [],
			operationalErrors: [],
		});
		expect(report.unassemblableApps).toMatchObject([
			{ appId: "a_broken", stage: "assemble-blueprint" },
		]);
		expect(report.unassemblableApps).toHaveLength(1);
		expect(await persistedState()).toEqual(before);
	});

	it("reports a real stored-edge read failure without claiming a clean comparison", async () => {
		await seedLookupApp("unreadable_edges");
		expect((await scanPersistedLookupReferences(h.db())).exitCode).toBe(0);
		await h.db().schema.dropTable("lookup_column_references").execute();
		const report = await scanPersistedLookupReferences(h.db());
		expect(report).toMatchObject({
			scannedApps: 1,
			comparedApps: 0,
			cleanApps: 0,
			exitCode: 1,
			unassemblableApps: [],
			mismatches: [],
		});
		expect(report.operationalErrors).toMatchObject([
			{ appId: "unreadable_edges", stage: "read-stored-targets" },
		]);
		expect(report.operationalErrors).toHaveLength(1);
	});
});
