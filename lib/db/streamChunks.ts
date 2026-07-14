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
import { log } from "@/lib/logger";
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
 * Append one batch of chunks and poke the stream's tailers.
 *
 * Idempotent per `(streamId, firstIndex)`: the writer's in-chain retry may
 * re-send a batch whose INSERT actually committed (the ack was lost, or the
 * poke below failed the first call), and `ON CONFLICT DO NOTHING` makes that
 * converge instead of raising a PK violation that would falsely mark a
 * healthy stream broken. Within one writer the content at a given index is
 * fixed, so dropping the duplicate is exact.
 *
 * The poke is advisory (tailers also poll), so a notify failure never fails
 * the append — the rows are durable either way; issued after the insert
 * resolves so a poked tailer's re-SELECT sees them.
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
		.onConflict((oc) => oc.columns(["stream_id", "first_index"]).doNothing())
		.execute();
	try {
		await notifyChatStream(append.streamId);
	} catch (err) {
		log.warn("[streamChunks] tailer poke failed (rows are durable)", {
			streamId: append.streamId,
			err: err instanceof Error ? err.message : String(err),
		});
	}
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
 * Read a stream's chunks from `fromIndex` through its current end. Two
 * PK-friendly queries: an anchor lookup (the last row starting at or before
 * the cursor — the one row a mid-batch cursor lands inside) and a forward
 * range scan from that anchor, both pure `(stream_id, first_index)` index
 * ranges. Reading from the anchor to the end always includes the terminal
 * marker row (it carries the stream's highest `first_index`, even when
 * empty), so completion is visible from any cursor.
 */
export async function readStreamChunksFrom(
	streamId: string,
	fromIndex: number,
): Promise<StreamChunkRead> {
	const db = await getAppDb();
	const anchor = await db
		.selectFrom("chat_stream_chunks")
		.select("first_index")
		.where("stream_id", "=", streamId)
		.where("first_index", "<=", fromIndex)
		.orderBy("first_index", "desc")
		.limit(1)
		.executeTakeFirst();
	const rows = await db
		.selectFrom("chat_stream_chunks")
		.select(["first_index", "chunks", "terminal"])
		.where("stream_id", "=", streamId)
		.where("first_index", ">=", anchor?.first_index ?? fromIndex)
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
