// Two recovery breadcrumbs for barrier-persisted chat turns:
//
//  - `threads.clawed_back_ids` — assistant message ids the server deliberately
//    removed or reverted (a failed turn's claw-back, a re-drive claim's
//    dead-partial trim) and has not re-authored. The history-admission gate
//    refuses to let a stale client's copy resurrect them, while everything
//    else self-heals by id.
//  - `chat_stream_chunks.terminal_outcome` — the run's fold outcome, stamped
//    on the stream's terminal row by the writer's close. The dead-marker
//    reconciler reads it to tell a FINISHED turn whose marker-clear write was
//    lost (retire, never re-drive) from a run that died mid-turn (interrupt).

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE public.threads
			ADD COLUMN IF NOT EXISTS clawed_back_ids jsonb NOT NULL DEFAULT '[]'::jsonb
	`.execute(db);
	await sql`
		ALTER TABLE public.chat_stream_chunks
			ADD COLUMN IF NOT EXISTS terminal_outcome text
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE public.threads DROP COLUMN IF EXISTS clawed_back_ids
	`.execute(db);
	await sql`
		ALTER TABLE public.chat_stream_chunks DROP COLUMN IF EXISTS terminal_outcome
	`.execute(db);
}
