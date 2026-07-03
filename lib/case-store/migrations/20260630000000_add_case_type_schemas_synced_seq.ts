// Add the `synced_seq` monotone guard column to `case_type_schemas`
// (multiplayer schema-sync convergence).
//
// `synced_seq` records the `mutation_seq` a schema row was last synced from.
// `applySchemaChange` UPSERTs the incoming seq guarded by
// `WHERE excluded.synced_seq >= case_type_schemas.synced_seq`, so a stale
// lower-seq sync no-ops and two concurrent additive case-type edits both
// materialize instead of one clobbering the other.
//
// Metadata-only `ADD COLUMN ... DEFAULT 0`: `bigint` (seqs are int64) NOT NULL
// with a constant default is a catalog-only change on modern Postgres (no
// table rewrite, no long `ACCESS EXCLUSIVE`), safe to run while the old
// revision serves. NO INDEX — the column is read inside the per-(app, case_type)
// UPSERT already keyed by the composite PK, never scanned on its own.
//
// Dual-sourced with the `synced_seq` field on `CaseTypeSchemasTable` in
// `lib/case-store/sql/database.ts` (added in the same change); the compile-only
// `sql/__tests__/database.test.ts` and the harness smoke tests guard the two
// against drift.
//
// Forward-only in production; `down` exists for local/test teardown only.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE "case_type_schemas" ADD COLUMN IF NOT EXISTS "synced_seq" bigint NOT NULL DEFAULT 0`.execute(
		db,
	);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE "case_type_schemas" DROP COLUMN IF EXISTS "synced_seq"`.execute(
		db,
	);
}
