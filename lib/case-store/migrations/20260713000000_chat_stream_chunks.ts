// The durable chat-stream chunk log — what makes a chat run's UI stream
// RESUMABLE (`app/api/chat/[streamId]/stream`).
//
// Every chunk the chat route writes to a run's UI message stream is appended
// here (batched rows, in write order) by the route's durable stream writer,
// alongside its best-effort delivery to the live POST response. A client whose
// connection broke — a network blip, a mid-run deploy hiccup, Cloud Run's
// 60-minute request cap — reconnects with a chunk cursor and replays exactly
// the chunks it missed, then tails the rest live (poked over
// `nova_chat_stream`).
//
//  - `stream_id` identifies ONE POST's stream (a conversation run spans many
//    POSTs; each mints a fresh stream id and returns it in the
//    `x-workflow-run-id` response header per the WorkflowChatTransport
//    contract).
//  - `(stream_id, first_index)` is the primary key; `first_index` is the
//    stream-wide index of `chunks[0]`, so replay-from-cursor is one ordered
//    range scan and the tail index derives from the last row.
//  - `terminal` marks the stream's LAST row: the writer sets it when the
//    route's execute block ends, whatever the outcome — every stream is
//    guaranteed to end (the writer appends a synthetic `finish` chunk when the
//    run's own stream never produced one), so a resuming client always
//    reaches a close instead of tailing forever.
//  - Rows are short-lived operational state, NOT history (the event log and
//    `threads` own durable conversation history): the chat route prunes rows
//    past `CHAT_STREAM_RETENTION_MS` opportunistically on each POST, hence the
//    `created_at` index.
//
// Dual-sourced with `ChatStreamChunksTable` in `lib/db/pg.ts` (same change).
//
// Forward-only in production; `down` exists for local/test teardown only.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE TABLE IF NOT EXISTS chat_stream_chunks (
			stream_id text NOT NULL,
			first_index integer NOT NULL,
			app_id text NOT NULL,
			run_id text NOT NULL,
			chunks jsonb NOT NULL,
			terminal boolean NOT NULL DEFAULT false,
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			PRIMARY KEY (stream_id, first_index)
		)
	`.execute(db);
	await sql`
		CREATE INDEX IF NOT EXISTS chat_stream_chunks_created_at
			ON chat_stream_chunks (created_at)
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DROP TABLE IF EXISTS chat_stream_chunks`.execute(db);
}
