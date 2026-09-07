import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import { caseStoreMigrations } from "..";
import { up } from "../20260802000000_case_type_schema_retirement";

const database = setupPerTestDatabase({
	databaseNamePrefix: "case_type_schema_retirement_migration_",
	prepareTemplate: async (db) => {
		const provider = {
			getMigrations: async () =>
				Object.fromEntries(
					Object.entries(caseStoreMigrations).filter(
						([name]) => name < "20260802000000_case_type_schema_retirement",
					),
				),
		};
		const result = await new Migrator({ db, provider }).migrateToLatest();
		if (result.error !== undefined) throw result.error;
	},
});

describe("case-type schema retirement migration", () => {
	it("backfills active rows and derives retirement and reactivation from their sequence", async () => {
		await sql`
			INSERT INTO public.case_type_schemas
				(app_id, case_type, schema, synced_seq)
			VALUES
				('migration-app', 'patient',
				 '{"type":"object","properties":{},"additionalProperties":false}'::jsonb,
				 7)
		`.execute(database.db);

		await up(database.db);
		const row = await sql<{
			is_active: boolean;
			retired_seq: string | null;
		}>`
			SELECT is_active, retired_seq
			FROM public.case_type_schemas
			WHERE app_id = 'migration-app' AND case_type = 'patient'
		`.execute(database.db);
		expect(row.rows).toEqual([{ is_active: true, retired_seq: null }]);
		await sql`UPDATE public.case_type_schemas SET retired_seq = synced_seq`.execute(
			database.db,
		);
		const retired = await sql<{
			is_active: boolean;
		}>`SELECT is_active FROM public.case_type_schemas`.execute(database.db);
		expect(retired.rows).toEqual([{ is_active: false }]);
		await sql`UPDATE public.case_type_schemas SET synced_seq = synced_seq + 1`.execute(
			database.db,
		);
		const restored = await sql<{
			is_active: boolean;
		}>`SELECT is_active FROM public.case_type_schemas`.execute(database.db);
		expect(restored.rows).toEqual([{ is_active: true }]);
	});

	it("fails closed and rolls back when a lifecycle column already has the wrong shape", async () => {
		await sql`
			ALTER TABLE public.case_type_schemas
				ADD COLUMN is_active boolean NOT NULL DEFAULT true
		`.execute(database.db);

		await expect(
			database.db.transaction().execute((tx) => up(tx)),
		).rejects.toThrow(/is_active|already exists/i);

		const columns = await sql<{
			column_name: string;
			data_type: string;
			generated: string;
		}>`
			SELECT attribute.attname AS column_name,
			       format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
			       attribute.attgenerated AS generated
			FROM pg_attribute AS attribute
			WHERE attribute.attrelid = 'public.case_type_schemas'::regclass
			  AND attribute.attname IN ('retired_seq', 'is_active')
			  AND NOT attribute.attisdropped
			ORDER BY attribute.attname
		`.execute(database.db);
		expect(columns.rows).toEqual([
			{ column_name: "is_active", data_type: "boolean", generated: "" },
		]);
	});
});
