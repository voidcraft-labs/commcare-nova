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
	it("backfills existing schema rows as active and is idempotent", async () => {
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
});
