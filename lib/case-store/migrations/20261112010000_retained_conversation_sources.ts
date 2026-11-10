import { type Kysely, sql } from "kysely";

/** Content is captured by the reviewed, scan-fenced maintenance command. An
 * ordinary deploy can initialize an empty database, never guess old evidence. */
export async function up(db: Kysely<unknown>): Promise<void> {
	const rows = await sql<{
		present: boolean;
	}>`SELECT EXISTS (SELECT 1 FROM thread_media_refs) OR EXISTS (SELECT 1 FROM threads WHERE selected_sources <> '[]'::jsonb) OR EXISTS (SELECT 1 FROM thread_messages WHERE coalesce(data->'metadata'->'attachments', '[]'::jsonb) <> '[]'::jsonb) AS present`.execute(
		db,
	);
	if (rows.rows[0].present)
		throw new Error(
			"Conversation sources require the reviewed source-retention cutover before deployment.",
		);
	await createRetainedSourceStorage(db);
	await sql`CREATE TABLE conversation_source_cutover (id boolean PRIMARY KEY CHECK(id), scan_digest text NOT NULL, retained_digest text NOT NULL)`.execute(
		db,
	);
}

export async function createRetainedSourceStorage(db: Kysely<unknown>) {
	await sql`CREATE TABLE thread_source_contents (
		thread_id text NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
		revision text NOT NULL CHECK (revision ~ '^[a-f0-9]{64}$'),
		content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
		digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
		PRIMARY KEY (thread_id, revision)
	)`.execute(db);
	await sql`CREATE FUNCTION nova_immutable_thread_source() RETURNS trigger LANGUAGE plpgsql AS $$
	BEGIN RAISE EXCEPTION 'Retained conversation source content is immutable'; END $$`.execute(
		db,
	);
	await sql`CREATE TRIGGER immutable_thread_source BEFORE UPDATE ON thread_source_contents
		FOR EACH ROW EXECUTE FUNCTION nova_immutable_thread_source()`.execute(db);
	await sql`CREATE TABLE thread_source_links (
		reference_key text NOT NULL,
		thread_id text NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
		message_id text NOT NULL,
		asset_id uuid NOT NULL,
		revision text,
		provenance text NOT NULL CHECK (provenance IN ('admitted', 'verified-legacy', 'migration-baseline', 'unavailable')),
		filename text NOT NULL,
		PRIMARY KEY(thread_id, reference_key),
		FOREIGN KEY(thread_id, revision) REFERENCES thread_source_contents(thread_id, revision),
		CHECK ((revision IS NULL) = (provenance = 'unavailable'))
	)`.execute(db);
	await sql`CREATE TRIGGER immutable_thread_source_link BEFORE UPDATE ON thread_source_links
  FOR EACH ROW EXECUTE FUNCTION nova_immutable_thread_source()`.execute(db);
	// This projection becomes source provenance, not a Library deletion lock.
	await sql`ALTER TABLE thread_media_refs DROP CONSTRAINT thread_media_refs_asset_id_fkey`.execute(
		db,
	);
}

export async function down(): Promise<void> {
	throw new Error(
		"Retained conversation sources cannot be discarded by a schema rollback.",
	);
}
