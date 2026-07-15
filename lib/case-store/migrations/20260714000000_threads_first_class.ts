/**
 * Threads become first-class conversations.
 *
 * The old `threads` table was a display-only archive: one row per run
 * (`thread_id` = run id, PK `(app_id, thread_id)`), holding a LOSSY
 * message projection (`StoredThreadMessage`: user/assistant text plus
 * flattened askQuestions Q&A) that could render history but never
 * resume it.
 *
 * The new shape makes a thread the durable unit of conversation:
 *
 *   - `thread_id` is the PRIMARY KEY (client-minted uuid, one per
 *     conversation; a thread now spans many runs);
 *   - `updated_at` orders the thread list (refresh lands on the most
 *     recently active thread);
 *   - `active_stream_id` points at the live POST's durable chunk-log
 *     stream while a run is in flight (the page-refresh resume handle),
 *     cleared at finalize;
 *   - `messages` holds the FULL `UIMessage[]` transcript — enough to
 *     rehydrate `useChat` and to send the whole conversation back to
 *     the SA on resume.
 *
 * Existing rows migrate in place: each lossy message becomes a
 * text-parts-only `UIMessage` (askQuestions rounds flatten to a
 * readable Q/A text part), so historical threads hydrate and resume as
 * plain-dialogue conversations. Timestamps stay ISO-8601 text — the
 * table's existing convention.
 *
 * The same migration drops `run_summaries.fresh_edit` /
 * `cache_expired`: the expired-cache one-shot message trim they
 * observed is retired (a resumed conversation always sends its full
 * history), so the signals are meaningless for new runs.
 */
import { type Kysely, sql } from "kysely";

// ── Old-shape message projection (frozen here; the live types are gone) ──

interface OldStoredPart {
	type: "text" | "askQuestions";
	text?: string;
	header?: string;
	questions?: { question: string; answer: string }[];
	toolCallId?: string;
}

interface OldStoredMessage {
	id: string;
	role: "user" | "assistant";
	parts: OldStoredPart[];
	attachments?: unknown[];
}

/**
 * One lossy stored message → one text-parts-only UIMessage. Exported for
 * the migration's unit test; pure.
 */
export function storedMessageToUIMessage(msg: OldStoredMessage): {
	id: string;
	role: "user" | "assistant";
	parts: { type: "text"; text: string }[];
	metadata?: { attachments: unknown[] };
} {
	const parts: { type: "text"; text: string }[] = [];
	for (const part of msg.parts ?? []) {
		if (part.type === "text" && part.text) {
			parts.push({ type: "text", text: part.text });
		} else if (part.type === "askQuestions" && part.questions?.length) {
			/* Flatten the interactive round into readable dialogue — the shape
			 * both the chat UI and the SA can consume as plain history. */
			const lines = part.questions.map((q) =>
				q.answer ? `${q.question}\n→ ${q.answer}` : q.question,
			);
			const header = part.header ? `${part.header}\n\n` : "";
			parts.push({ type: "text", text: `${header}${lines.join("\n\n")}` });
		}
	}
	return {
		id: msg.id,
		role: msg.role,
		parts,
		...(msg.attachments?.length
			? { metadata: { attachments: msg.attachments } }
			: {}),
	};
}

export async function up(db: Kysely<unknown>): Promise<void> {
	/* Idempotent throughout — the ledger-less adoption path (see
	 * `migrate.test.ts`) replays EVERY migration against an already-migrated
	 * schema, so each step must no-op cleanly when its work is done. */
	await sql`ALTER TABLE threads ADD COLUMN IF NOT EXISTS updated_at text`.execute(
		db,
	);
	await sql`ALTER TABLE threads ADD COLUMN IF NOT EXISTS active_stream_id text`.execute(
		db,
	);

	/* Backfill: updated_at = created_at; messages → full-UIMessage shape.
	 * The transform runs in TS (nested jsonb reshaping is miserable in SQL);
	 * thread counts are small (one row per historical run). A NULL
	 * `updated_at` is the old-shape marker, so a replay transforms nothing. */
	const rows = (await sql`
		SELECT thread_id, app_id, messages FROM threads WHERE updated_at IS NULL
	`.execute(db)) as unknown as {
		rows: {
			thread_id: string;
			app_id: string;
			messages: OldStoredMessage[];
		}[];
	};
	for (const row of rows.rows) {
		const converted = (row.messages ?? []).map(storedMessageToUIMessage);
		await sql`
			UPDATE threads
			SET messages = ${JSON.stringify(converted)}::jsonb,
			    updated_at = created_at
			WHERE thread_id = ${row.thread_id} AND app_id = ${row.app_id}
		`.execute(db);
	}
	await sql`ALTER TABLE threads ALTER COLUMN updated_at SET NOT NULL`.execute(
		db,
	);

	/* PK swap: thread_id alone. Old ids are run uuids — globally unique —
	 * but guard loudly rather than corrupt on a collision. Skipped when the
	 * PK is already single-column (a replay). */
	const pk = (await sql`
		SELECT count(*) AS cols FROM information_schema.key_column_usage
		WHERE table_name = 'threads' AND constraint_name = 'threads_pkey'
	`.execute(db)) as unknown as { rows: { cols: string | number }[] };
	if (Number(pk.rows[0]?.cols ?? 0) > 1) {
		const dupes = (await sql`
			SELECT thread_id FROM threads GROUP BY thread_id HAVING count(*) > 1
		`.execute(db)) as unknown as { rows: { thread_id: string }[] };
		if (dupes.rows.length > 0) {
			throw new Error(
				`threads migration found ${dupes.rows.length} thread_id value(s) shared across apps (e.g. ${dupes.rows[0].thread_id}); ` +
					"thread_id must be globally unique to become the primary key. Deduplicate those rows, then re-run.",
			);
		}
		await sql`ALTER TABLE threads DROP CONSTRAINT threads_pkey`.execute(db);
		await sql`ALTER TABLE threads ADD PRIMARY KEY (thread_id)`.execute(db);
	}
	await sql`CREATE INDEX IF NOT EXISTS threads_app_updated ON threads (app_id, updated_at DESC)`.execute(
		db,
	);

	await sql`ALTER TABLE run_summaries DROP COLUMN IF EXISTS fresh_edit`.execute(
		db,
	);
	await sql`ALTER TABLE run_summaries DROP COLUMN IF EXISTS cache_expired`.execute(
		db,
	);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	/* Teardown-only: restores the old columns/keys; the message transform is
	 * not reversed (the full-fidelity shape is a superset the old reader
	 * tolerates only for text parts). */
	await sql`ALTER TABLE run_summaries ADD COLUMN IF NOT EXISTS fresh_edit boolean NOT NULL DEFAULT false`.execute(
		db,
	);
	await sql`ALTER TABLE run_summaries ADD COLUMN IF NOT EXISTS cache_expired boolean NOT NULL DEFAULT false`.execute(
		db,
	);
	await sql`DROP INDEX IF EXISTS threads_app_updated`.execute(db);
	await sql`ALTER TABLE threads DROP CONSTRAINT IF EXISTS threads_pkey`.execute(
		db,
	);
	await sql`ALTER TABLE threads ADD PRIMARY KEY (app_id, thread_id)`.execute(
		db,
	);
	await sql`ALTER TABLE threads DROP COLUMN IF EXISTS active_stream_id`.execute(
		db,
	);
	await sql`ALTER TABLE threads DROP COLUMN IF EXISTS updated_at`.execute(db);
}
