// Add the required `case_name` column to `cases` (and the nullable mirror to
// `cases_quarantine`).
//
// Converted from the original Atlas-generated migration
// `20260506022302_add_case_name_column.sql` during the Atlas → Kysely migrator
// move, and made IDEMPOTENT as the second *adoption baseline* (see the baseline
// module's header): it must replay as a no-op on the Atlas-migrated schema where
// the column + constraint already exist, while still adding them on a fresh
// database or a volume created in the brief window when only the first baseline
// had run. `ADD COLUMN` takes `IF NOT EXISTS`; `ADD CONSTRAINT` has no such form
// (Postgres 18), so the CHECK is guarded on `pg_constraint`. The column is added
// before the constraint so the CHECK's reference resolves on a fresh table.
//
// Forward-only in production; `down` exists for local/test teardown only.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "case_name" text NOT NULL`.execute(
		db,
	);
	await sql`DO $$ BEGIN
		IF NOT EXISTS (
			SELECT 1 FROM pg_constraint
			WHERE conname = 'cases_case_name_check'
			  AND conrelid = 'cases'::regclass
		) THEN
			ALTER TABLE "cases" ADD CONSTRAINT "cases_case_name_check" CHECK (length(case_name) > 0);
		END IF;
	END $$;`.execute(db);
	await sql`ALTER TABLE "cases_quarantine" ADD COLUMN IF NOT EXISTS "case_name" text NULL`.execute(
		db,
	);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE "cases_quarantine" DROP COLUMN IF EXISTS "case_name"`.execute(
		db,
	);
	await sql`ALTER TABLE "cases" DROP CONSTRAINT IF EXISTS "cases_case_name_check", DROP COLUMN IF EXISTS "case_name"`.execute(
		db,
	);
}
