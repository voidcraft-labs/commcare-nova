// Add the required `case_name` column to `cases` (and the nullable mirror to
// `cases_quarantine`).
//
// Converted verbatim from the original Atlas-generated migration
// `20260506022302_add_case_name_column.sql` during the Atlas → Kysely
// migrator move. Forward-only in production; `down` exists for local/test
// teardown only.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE "cases" ADD CONSTRAINT "cases_case_name_check" CHECK (length(case_name) > 0), ADD COLUMN "case_name" text NOT NULL`.execute(
		db,
	);
	await sql`ALTER TABLE "cases_quarantine" ADD COLUMN "case_name" text NULL`.execute(
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
