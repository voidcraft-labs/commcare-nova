// The fourth lookup-reference activation flag: `case_operations_enabled`
// admits case-operation-bearing commits (the S07 preview/runtime executor's
// vocabulary). Like its siblings it defaults false, may be switched off
// freely (the emergency-disable union), and can turn ON only at its floor
// thresholds — a v2 stream receiver would submit an operation-bearing form
// ordinary-only (silent non-execution), so activation demands the same v3
// receiver cutoff carriers require, plus the v1 runtime-reader floor every
// activation shares.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE public.lookup_reference_compatibility
			ADD COLUMN IF NOT EXISTS case_operations_enabled boolean
				NOT NULL DEFAULT false
	`.execute(db);
	await sql`
		ALTER TABLE public.lookup_reference_compatibility
			DROP CONSTRAINT IF EXISTS case_operations_activation_check
	`.execute(db);
	await sql`
		ALTER TABLE public.lookup_reference_compatibility
			ADD CONSTRAINT case_operations_activation_check CHECK (
				NOT case_operations_enabled
				OR (
					minimum_stream_receiver_version >= 3
					AND minimum_runtime_reader_version >= 1
				)
			)
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE public.lookup_reference_compatibility
			DROP CONSTRAINT IF EXISTS case_operations_activation_check
	`.execute(db);
	await sql`
		ALTER TABLE public.lookup_reference_compatibility
			DROP COLUMN IF EXISTS case_operations_enabled
	`.execute(db);
}
