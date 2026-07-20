// Per-property park for values a per-row migration cannot carry into a
// property's new declaration, replacing the whole-row `cases_quarantine`
// sink (dropped below). The drop migrates nothing forward: the table had
// no production reader or non-script writer, and both production and
// local held zero rows when this shipped.
//
// `ON DELETE CASCADE` off `cases(case_id)` scopes every entry's lifetime
// to its row — sample-data replaces and case deletions clear their parks
// — and the park carries no `project_id` (reads reach tenancy by joining
// through `cases`), so re-tenanting needs no companion here.
//
// Forward-only in production; `down` exists for local/test teardown only.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`CREATE TABLE IF NOT EXISTS "parked_case_values" (
		"id" uuid NOT NULL DEFAULT uuidv7(),
		"app_id" text NOT NULL,
		"case_id" uuid NOT NULL REFERENCES "cases" ("case_id") ON DELETE CASCADE,
		"case_type" text NOT NULL,
		"property" text NOT NULL,
		"original_value" jsonb NOT NULL,
		"reason" text NOT NULL,
		"created_at" timestamptz NOT NULL DEFAULT now(),
		PRIMARY KEY ("id")
	)`.execute(db);
	// The review surface lists per app + case type; the case_id index
	// also serves the FK's cascade deletes (Postgres does not index the
	// referencing side on its own).
	await sql`CREATE INDEX IF NOT EXISTS "parked_case_values_app_id_case_type_idx" ON "parked_case_values" ("app_id", "case_type")`.execute(
		db,
	);
	await sql`CREATE INDEX IF NOT EXISTS "parked_case_values_case_id_idx" ON "parked_case_values" ("case_id")`.execute(
		db,
	);
	await sql`DROP TABLE IF EXISTS "cases_quarantine"`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DROP TABLE IF EXISTS "parked_case_values"`.execute(db);
}
