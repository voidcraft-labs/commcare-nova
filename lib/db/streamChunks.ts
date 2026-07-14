/**
 * Durable chat-stream chunk log — the Postgres half of resumable chat streams.
 *
 * The chat route's `DurableStreamWriter` appends every UI message chunk it
 * writes (batched rows, in write order); the resumable-stream endpoint
 * (`app/api/chat/[streamId]/stream`) reads them back from a client-supplied
 * cursor and tails live via the `nova_chat_stream` poke. One `stream_id` is
 * ONE POST's stream — a conversation run spans many POSTs, each with a fresh
 * stream id.
 *
 * Chunks are opaque here (`unknown` on the read side): this layer stores and
 * slices them; only the AI SDK client interprets them. Rows are short-lived
 * operational state — `pruneChatStreamChunks` drops them past the retention
 * window (conversation HISTORY lives in `threads` + the event log, never
 * here).
 */

import { sql } from "kysely";
import { getAppDb, notifyChatStream } from "./pg";

/**
 * How long a stream's chunk rows stay readable after they were written. A
 * resume targets a LIVE (or just-ended) stream — a network blip, a page
 * refresh, Cloud Run's 60-minute request cap — so hours of slack is already
 * generous; the window exists so a reconnect can never miss rows that a
 * too-eager prune removed mid-run (prune is by row age, and the oldest row of
 * a stream is as old as its run).
 */
export const CHAT_STREAM_RETENTION_MS = 24 * 60 * 60 * 1000;

/** One batched append — `chunks[0]` sits at `firstIndex` within the stream. */
export interface StreamChunkAppend {
	streamId: string;
	appId: string;
	runId: string;
	firstIndex: number;
	chunks: unknown[];
	/** Marks the stream's LAST row; `chunks` may be empty on a pure marker. */
	terminal: boolean;
}

/**
 * Append one batch of chunks and poke the stream's tailers. The poke is
 * issued after the insert resolves so a tailer's re-SELECT sees the rows.
 */
export async function appendStreamChunks(
	append: StreamChunkAppend,
): Promise<void> {
	const db = await getAppDb();
	await db
		.insertInto("chat_stream_chunks")
		.values({
			stream_id: append.streamId,
			app_id: append.appId,
			run_id: append.runId,
			first_index: append.firstIndex,
			chunks: JSON.stringify(append.chunks),
			terminal: append.terminal,
		})
		.execute();
	await notifyChatStream(append.streamId);
}

/** Everything a tailer needs from one cursor read. */
export interface StreamChunkRead {
	/** The stream's chunks from `fromIndex` through its current end. */
	chunks: unknown[];
	/** `fromIndex + chunks.length` — the caller's next cursor. */
	endIndex: number;
	/** A terminal row exists: the stream is complete once `chunks` is consumed. */
	terminal: boolean;
}

/**
 * Read a stream's chunks from `fromIndex` through its current end. Rows are
 * range-scanned on the `(stream_id, first_index)` key; the terminal marker row
 * is included even when empty so completion is visible from any cursor.
 */
export async function readStreamChunksFrom(
	streamId: string,
	fromIndex: number,
): Promise<StreamChunkRead> {
	const db = await getAppDb();
	const rows = await db
		.selectFrom("chat_stream_chunks")
		.select(["first_index", "chunks", "terminal"])
		.where("stream_id", "=", streamId)
		.where((eb) =>
			eb.or([
				sql<boolean>`first_index + jsonb_array_length(chunks) > ${fromIndex}`,
				eb("terminal", "=", true),
			]),
		)
		.orderBy("first_index", "asc")
		.execute();

	const chunks: unknown[] = [];
	let endIndex = fromIndex;
	let terminal = false;
	for (const row of rows) {
		if (row.terminal) terminal = true;
		const skip = Math.max(0, fromIndex - row.first_index);
		if (skip >= row.chunks.length) continue;
		chunks.push(...row.chunks.slice(skip));
		endIndex = row.first_index + row.chunks.length;
	}
	return { chunks, endIndex, terminal };
}

/** A stream's current extent — for resolving negative resume cursors. */
export interface StreamChunkTail {
	/** Total chunks appended so far (the next `firstIndex`). */
	total: number;
	terminal: boolean;
}

/** Read a stream's total chunk count + completion without loading chunks. */
export async function streamChunkTail(
	streamId: string,
): Promise<StreamChunkTail | null> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("chat_stream_chunks")
		.select([
			sql<number>`first_index + jsonb_array_length(chunks)`.as("total"),
			"terminal",
		])
		.where("stream_id", "=", streamId)
		.orderBy("first_index", "desc")
		.limit(1)
		.executeTakeFirst();
	if (row === undefined) return null;
	return { total: row.total, terminal: row.terminal };
}

/** The stream's owning app + run — the reconnect endpoint's auth anchor. */
export async function streamChunkMeta(
	streamId: string,
): Promise<{ appId: string; runId: string } | null> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("chat_stream_chunks")
		.select(["app_id", "run_id"])
		.where("stream_id", "=", streamId)
		.limit(1)
		.executeTakeFirst();
	if (row === undefined) return null;
	return { appId: row.app_id, runId: row.run_id };
}

/**
 * Drop chunk rows older than the retention window. Fired opportunistically
 * (fire-and-forget) from the chat route; the `created_at` index makes it one
 * cheap range delete, and deleting a LIVE stream's rows is impossible within
 * retention because a row is at most as old as its run.
 */
export async function pruneChatStreamChunks(
	now: number = Date.now(),
): Promise<void> {
	const db = await getAppDb();
	await db
		.deleteFrom("chat_stream_chunks")
		.where("created_at", "<", new Date(now - CHAT_STREAM_RETENTION_MS))
		.execute();
}
