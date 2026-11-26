import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { Migrator } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import { caseStoreMigrationProvider } from "..";

const previous = "20261202000000_hq_bring_in_project_data";
const migration = "20261203000000_lookup_xml_names";

async function migrateTo(db: Kysely<unknown>, target: string) {
	const result = await new Migrator({
		db,
		provider: caseStoreMigrationProvider,
	}).migrateTo(target);
	if (result.error !== undefined) throw result.error;
}

const database = setupPerTestDatabase({
	databaseNamePrefix: "lookup_xml_names_",
	establishLocalMigrationAuthority: true,
	prepareTemplate: (db) => migrateTo(db, previous),
});

function insertTable(
	tag: string,
	schema = "public",
	project = "lookup-project",
) {
	return sql<{ id: string }>`
		INSERT INTO ${sql.id(schema, "lookup_tables")}
			(project_id, name, tag, definition_revision, rows_revision,
			 column_count, created_by, updated_by)
		VALUES (${project}, 'Facilities', ${tag}, 5, 8, 1, 'editor', 'editor')
		RETURNING id
	`.execute(database.db);
}

function insertColumn(tableId: string, wireName: string) {
	return sql<{ id: string }>`
		INSERT INTO public.lookup_columns
			(project_id, table_id, wire_name, label, data_type, order_key)
		VALUES ('lookup-project', ${tableId}::uuid, ${wireName}, 'Facility', 'text', 'V')
		RETURNING id
	`.execute(database.db);
}

describe(migration, () => {
	it("preserves exact old identities and admits distinct XML names through the Project and App Test checks", async () => {
		const db = database.db;
		const legacy = (await insertTable("Team-codes")).rows[0];
		if (!legacy) throw new Error("Missing seeded table.");
		const column = (await insertColumn(legacy.id, "Export_Name")).rows[0];
		if (!column) throw new Error("Missing seeded column.");

		await migrateTo(db, migration);
		const retained = await sql<{
			tag: string;
			wire_name: string;
			definition_revision: string;
			rows_revision: string;
		}>`
			SELECT t.tag, c.wire_name, t.definition_revision, t.rows_revision
			FROM public.lookup_tables t JOIN public.lookup_columns c
				ON (c.project_id, c.table_id) = (t.project_id, t.id)
			WHERE t.id = ${legacy.id}::uuid AND c.id = ${column.id}::uuid
		`.execute(db);
		expect(retained.rows).toEqual([
			{
				tag: "Team-codes",
				wire_name: "Export_Name",
				definition_revision: "5",
				rows_revision: "8",
			},
		]);

		for (const name of ["n.m", "N.M", "é", "e\u0301", "村", "𐐀".repeat(32)]) {
			await insertTable(name);
			await insertColumn(legacy.id, name);
		}
		await insertColumn(legacy.id, "𐐀".repeat(255));
		await expect(insertTable("é")).rejects.toMatchObject({ code: "23505" });
		await insertTable("é", "public", "another-project");
		await expect(insertColumn(legacy.id, "é")).rejects.toMatchObject({
			code: "23505",
		});
		for (const name of [
			".starts",
			"xml名",
			"p:q",
			"\u0301a",
			"a\u037Eb",
			"a\u{F0000}",
			"end\n",
		]) {
			await expect(insertTable(name)).rejects.toMatchObject({ code: "23514" });
			await expect(insertColumn(legacy.id, name)).rejects.toMatchObject({
				code: "23514",
			});
		}
		await expect(insertTable("𐐀".repeat(33))).rejects.toMatchObject({
			code: "23514",
		});
		await expect(
			insertColumn(legacy.id, "𐐀".repeat(256)),
		).rejects.toMatchObject({ code: "23514" });

		const created = await sql<{ namespace: string }>`
			SELECT public.nova_create_app_test_namespace(${randomUUID()}::uuid) AS namespace
		`.execute(db);
		const namespace = created.rows[0]?.namespace;
		if (!namespace) throw new Error("Missing App Test namespace.");
		await insertTable("local.é", namespace);
	});

	it("keeps both wider checks when rollback would strand data and restores the preceding admission after recovery", async () => {
		const db = database.db;
		await migrateTo(db, migration);
		const table = (await insertTable("地域")).rows[0];
		if (!table) throw new Error("Missing seeded table.");
		await insertColumn(table.id, "start.date");
		await expect(migrateTo(db, previous)).rejects.toThrow(
			"1 table tags and 1 column names",
		);
		await insertColumn(table.id, "end.date");

		await sql`DELETE FROM public.lookup_tables WHERE id = ${table.id}::uuid`.execute(
			db,
		);
		await migrateTo(db, previous);
		await expect(insertTable("地域")).rejects.toMatchObject({ code: "23514" });
		const restored = (await insertTable("Team-codes")).rows[0];
		if (!restored) throw new Error("Missing restored table.");
		await insertColumn(restored.id, "XMLcode");
		await expect(insertColumn(restored.id, "start.date")).rejects.toMatchObject(
			{ code: "23514" },
		);
		await migrateTo(db, migration);
		await insertColumn(restored.id, "start.date");
	});
});
