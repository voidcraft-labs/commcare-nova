/**
 * Completeness marker for the media reverse index.
 *
 * The singleton starts incomplete. Deletion must full-scan persisted app
 * carriers until an audited backfill explicitly stamps `audited_complete_at`;
 * merely having some `media_asset_refs` rows is never proof of completeness.
 */

import { sql } from "kysely";

export async function up(db: import("kysely").Kysely<unknown>): Promise<void> {
	await sql`
		CREATE TABLE IF NOT EXISTS media_reference_index_state (
			singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
			audited_complete_at timestamptz NULL
		)
	`.execute(db);
	await sql`
		INSERT INTO media_reference_index_state (singleton, audited_complete_at)
		VALUES (true, NULL)
		ON CONFLICT (singleton) DO NOTHING
	`.execute(db);
}

export async function down(
	db: import("kysely").Kysely<unknown>,
): Promise<void> {
	await sql`DROP TABLE IF EXISTS media_reference_index_state`.execute(db);
}
