// Validates `media_assets_ready_media_format`, the presence check the media
// format migration added NOT VALID: every ready image, audio and video row
// records its format. The HQ round trip's platforms cutover applies this
// migration inside its fleet transaction, after its backfill gave every
// existing row its format, so the check commits validated with the fleet.
//
// A database made fresh from the migrations validates an empty or fully
// recorded table. One that still holds a ready media row without a format
// stops here with the count and what to do, rather than failing on the
// constraint's own message.

import { type Kysely, sql } from "kysely";

/** Every ready image, audio and video file records its format. */
export async function up(db: Kysely<unknown>): Promise<void> {
	const missing = await sql<{ count: string }>`
		SELECT count(*)::text AS count FROM media_assets
		WHERE status = 'ready' AND kind IN ('image', 'audio', 'video') AND media_format IS NULL
	`.execute(db);
	const count = Number(missing.rows[0]?.count ?? "0");
	if (count > 0) {
		throw new Error(
			`${count} ready image, audio or video files in this database have no recorded format, so Nova can't check where they play. Nova records a file's format when it is uploaded, and these came before it did. The one-time platforms cutover recorded the formats of the databases that existed then; for this one, make the database again from the migrations, or run that cutover over it from a commit that still has it.`,
		);
	}
	await sql`ALTER TABLE media_assets VALIDATE CONSTRAINT media_assets_ready_media_format`.execute(
		db,
	);
}

/** Forward only: the constraint holds for every row, and unvalidating it gains nothing. */
export async function down(): Promise<void> {
	throw new Error(
		"This migration is forward-only: every ready media file records its format, and nothing is gained by no longer checking it.",
	);
}
