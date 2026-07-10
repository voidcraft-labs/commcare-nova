// Add the `external_id` scalar column to `cases`.
//
// CommCare's standard case-list vocabulary includes `external_id` /
// `external-id` — case metadata living beside `case_name` / `status` /
// `opened_on`, not inside the authored property document. The AST→SQL
// compilers resolve every standard name onto its scalar column
// (`lib/case-store/sql/dataTypeTokens.ts::RESERVED_SCALAR_COLUMN_BY_PROPERTY`),
// and `external_id` was the one standard name with no column to land on.
// Nullable with no default: nothing writes it today (HQ-import /
// cross-system traceability populate it later), and a filter against it
// honestly matches nothing until something does.
//
// Metadata-only `ADD COLUMN` (nullable, no default) — catalog-only on
// modern Postgres, safe while the old revision serves. NO INDEX — the
// column is a preview-scale filter target, same sequential-scan budget
// as the other untyped scalar reads.
//
// Dual-sourced with the `external_id` field on `CasesTable` in
// `lib/case-store/sql/database.ts` (added in the same change).
//
// Forward-only in production; `down` exists for local/test teardown only.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "external_id" text`.execute(
		db,
	);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE "cases" DROP COLUMN IF EXISTS "external_id"`.execute(
		db,
	);
}
