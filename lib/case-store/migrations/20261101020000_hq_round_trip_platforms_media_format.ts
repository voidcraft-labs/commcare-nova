// The media variant a ready asset's bytes are (`lib/domain/multimedia.ts::
// MEDIA_FORMATS`), or `unplayable` for stored bytes no variant admits.
//
// Two checks. `media_assets_media_format_known` is the value domain, valid at
// once: every existing row is NULL, a document and a pending row stay NULL,
// and a key outside its kind's variants is refused, so a reader that names the
// wrong kind fails loudly. `media_assets_ready_media_format` holds every ready
// image, audio and video row to a format, and is added NOT VALID: it skips the
// rows the backfill has not reached yet and holds every insert and update from
// the moment it commits, so it must never commit while an image that writes
// ready rows without a format serves. The HQ round trip's platforms cutover
// applies this migration inside its fleet transaction, before its backfill,
// and validates the check after it.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE media_assets ADD COLUMN media_format text`.execute(db);
	await sql`
		ALTER TABLE media_assets ADD CONSTRAINT media_assets_media_format_known CHECK (
			media_format IS NULL
			OR (kind = 'image' AND media_format IN ('png','jpeg','gif','webp','bmp','ico','avif','unplayable'))
			OR (kind = 'audio' AND media_format IN ('mp3','wav-pcm','m4a','flac','ogg-vorbis','ogg-opus','aac-adts','amr','midi','unplayable'))
			OR (kind = 'video' AND media_format IN ('mp4-h264-baseline','mp4-h264-main','mp4-h264-high','mp4-hevc','mp4-mpeg4-part2','webm-vp8','webm-vp9','mkv','unplayable'))
		)
	`.execute(db);
	await sql`
		ALTER TABLE media_assets ADD CONSTRAINT media_assets_ready_media_format CHECK (
			status <> 'ready' OR kind NOT IN ('image','audio','video') OR media_format IS NOT NULL
		) NOT VALID
	`.execute(db);
}
