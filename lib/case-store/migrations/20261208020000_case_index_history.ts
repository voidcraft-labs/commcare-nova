import { type Kysely, sql } from "kysely";

/** A historical missing link conveys no evidence about a previous clear.
 * An older writer that still creates a case also receives this conservative
 * default. Only a writer observing the case's creation can enroll it. */
export async function up(db: Kysely<unknown>) {
	await sql`DO $$
	DECLARE ledger regclass := coalesce(to_regclass('nova_case_runtime.cases'), to_regclass('public.cases'));
	BEGIN
		EXECUTE format('ALTER TABLE %s ADD COLUMN index_history_complete boolean NOT NULL DEFAULT false,
			ADD COLUMN cleared_index_identifiers text[] NOT NULL DEFAULT ARRAY[]::text[]', ledger);
	END $$`.execute(db);
}

export async function down(): Promise<void> {
	throw new Error("Removing case link history would lose recorded clears.");
}
