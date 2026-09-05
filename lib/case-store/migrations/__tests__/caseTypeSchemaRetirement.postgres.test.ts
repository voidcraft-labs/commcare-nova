import { sql } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { runCaseStoreMigrations } from "../../migrate";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import { down, up } from "../20260802000000_case_type_schema_retirement";

const database = setupPerTestDatabase({
	databaseNamePrefix: "case_type_schema_retirement_migration_",
});

beforeEach(async () => {
	await runCaseStoreMigrations(database.db);
});

describe("case-type schema retirement migration", () => {
	it("backfills existing schema rows as active", async () => {
		await down(database.db);
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
	});

	it("fails closed and rolls back when a lifecycle column already has the wrong shape", async () => {
		await down(database.db);
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
