import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import { caseStoreMigrations } from "..";
import { up } from "../20261111000000_retire_case_expression_indexes";

const database = setupPerTestDatabase({
	databaseNamePrefix: "retire_case_expression_indexes_",
	prepareTemplate: async (db) => {
		const result = await new Migrator({
			db,
			provider: {
				getMigrations: async () =>
					Object.fromEntries(
						Object.entries(caseStoreMigrations).filter(
							([name]) =>
								name < "20261111000000_retire_case_expression_indexes",
						),
					),
			},
		}).migrateToLatest();
		if (result.error !== undefined) throw result.error;
	},
});

async function remainingMetadata() {
	return (
		await sql<{ deletion_table: string | null; columns: string[] }>`
		SELECT to_regclass('public.case_schema_index_deletions')::text AS deletion_table,
			ARRAY(SELECT attname::text FROM pg_attribute
				WHERE attrelid = 'public.case_type_schemas'::regclass
				AND attname IN ('index_pending_seq', 'index_synced_seq') AND NOT attisdropped
				ORDER BY attname) AS columns
	`.execute(database.db)
	).rows[0];
}

describe("case expression-index retirement migration", () => {
	it("refuses residual expression indexes before touching lifecycle metadata", async () => {
		await sql`CREATE INDEX legacy_expression_probe ON public.cases ((properties->>'probe'))`.execute(
			database.db,
		);
		await expect(database.db.transaction().execute(up)).rejects.toThrow(
			"Case expression indexes remain",
		);
		expect(await remainingMetadata()).toEqual({
			deletion_table: "case_schema_index_deletions",
			columns: ["index_pending_seq", "index_synced_seq"],
		});
		await sql`DROP INDEX public.legacy_expression_probe`.execute(database.db);
		await database.db.transaction().execute(up);
		expect(await remainingMetadata()).toEqual({
			deletion_table: null,
			columns: [],
		});
	});

	it("preserves case schemas and creates disposable test namespaces without retired metadata", async () => {
		await sql`INSERT INTO public.apps (id, owner, project_id, app_name, app_name_lower)
			VALUES ('index-retirement-app', 'owner', 'project', 'Retirement', 'retirement')`.execute(
			database.db,
		);
		await sql`INSERT INTO public.case_type_schemas (app_id, case_type, schema, synced_seq, retired_seq)
			VALUES ('index-retirement-app', 'patient', '{"type":"object","properties":{},"additionalProperties":false}'::jsonb, 3, 3)`.execute(
			database.db,
		);
		const before = (
			await sql`SELECT app_id, case_type, schema, synced_seq, retired_seq, is_active FROM public.case_type_schemas`.execute(
				database.db,
			)
		).rows;
		await database.db.transaction().execute(up);
		expect(
			(
				await sql`SELECT app_id, case_type, schema, synced_seq, retired_seq, is_active FROM public.case_type_schemas`.execute(
					database.db,
				)
			).rows,
		).toEqual(before);
		const testId = "e03d4d83-78ae-4872-87fb-9c0f01f329cc";
		const created = await sql<{
			namespace: string;
		}>`SELECT public.nova_create_app_test_namespace(${testId}::uuid) AS namespace`.execute(
			database.db,
		);
		const namespace = created.rows[0]?.namespace;
		expect(namespace).toBe("nova_app_test_e03d4d8378ae487287fb9c0f01f329cc");
		const tables = await sql<{
			name: string;
		}>`SELECT tablename AS name FROM pg_tables WHERE schemaname = ${namespace}`.execute(
			database.db,
		);
		expect(tables.rows.map((row) => row.name)).toContain("cases");
		expect(tables.rows.map((row) => row.name)).toContain("lookup_tables");
		expect(tables.rows.map((row) => row.name)).not.toContain(
			"case_schema_index_deletions",
		);
		await sql`SELECT public.nova_drop_app_test_namespace(${testId}::uuid)`.execute(
			database.db,
		);
	});
});
