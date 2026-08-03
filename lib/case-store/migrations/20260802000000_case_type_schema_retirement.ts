// Give each materialized case-type schema an explicit lifecycle state.
//
// Retiring a case type is not data deletion: retained case rows still need the
// last active JSON Schema if the type is later restored. Keeping that contract
// on the same row also preserves `synced_seq` as the retirement watermark, so
// a delayed pre-retirement schema sync cannot recreate an active schema.
//
// Existing rows are active by definition. The constant default makes this an
// additive, backwards-compatible rollout: the old revision ignores the column
// and the new revision sees every pre-cutover schema as active.
//
// Forward-only in production; `down` exists for local/test teardown only.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE public.case_type_schemas
			ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE public.case_type_schemas
			DROP COLUMN IF EXISTS is_active
	`.execute(db);
}
