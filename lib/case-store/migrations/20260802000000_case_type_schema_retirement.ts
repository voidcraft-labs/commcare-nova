// Give each materialized case-type schema an explicit lifecycle state.
//
// Retiring a case type is not data deletion: retained case rows still need the
// last active JSON Schema if the type is later restored. `retired_seq` is the
// durable retirement watermark; `is_active` is generated from the sequence
// relation so a previous application revision that advances `synced_seq`
// beyond the watermark still performs a valid reactivation without knowing
// about either new column.
//
// Existing rows have no retirement watermark and are active by definition.
// Both columns are additive; previous revisions ignore them, and their normal
// monotone schema UPSERTs automatically update the generated lifecycle state.
//
// Forward-only in production; `down` exists for local/test teardown only.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE public.case_type_schemas
			ADD COLUMN retired_seq bigint
	`.execute(db);
	await sql`
		ALTER TABLE public.case_type_schemas
			ADD COLUMN is_active boolean
			GENERATED ALWAYS AS (
				retired_seq IS NULL OR synced_seq > retired_seq
			) STORED
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE public.case_type_schemas
			DROP COLUMN IF EXISTS is_active
	`.execute(db);
	await sql`
		ALTER TABLE public.case_type_schemas
			DROP COLUMN IF EXISTS retired_seq
	`.execute(db);
}
