/**
 * Durable successful outcomes for browser upload attempts that deduplicate to
 * a different ready asset row.
 *
 * The pending `media_assets` row is deleted when confirm canonicalizes it to an
 * existing Project/hash sibling. A client that loses that successful response
 * still retries by the original asset id, so the attempt id must outlive its
 * pending row long enough to replay the exact authoritative result.
 */

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE TABLE IF NOT EXISTS media_upload_aliases (
			attempt_asset_id text PRIMARY KEY,
			project_id text NOT NULL,
			content_hash text NOT NULL,
			canonical_asset_id text NOT NULL
				REFERENCES media_assets(id) ON DELETE CASCADE,
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			expires_at timestamptz(3) NOT NULL
				DEFAULT (now() + interval '1 day'),
			CHECK (attempt_asset_id <> canonical_asset_id),
			CHECK (expires_at > created_at)
		)
	`.execute(db);
	await sql`
		CREATE INDEX IF NOT EXISTS media_upload_aliases_expiry
		ON media_upload_aliases (expires_at, attempt_asset_id)
	`.execute(db);
	await sql`
		CREATE INDEX IF NOT EXISTS media_upload_aliases_canonical
		ON media_upload_aliases (canonical_asset_id)
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DROP TABLE IF EXISTS media_upload_aliases`.execute(db);
}
