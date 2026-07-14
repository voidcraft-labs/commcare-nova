/**
 * Chat thread persistence — the durable conversation store.
 *
 * A thread is one conversation about an app; it spans many runs. The chat
 * route is the ONLY writer, and it writes server-authoritatively at two
 * moments:
 *
 *   1. `upsertThreadTurn` — the instant a run has claimed the app. Persists
 *      the full incoming `UIMessage[]` history (which already carries the new
 *      user turn and any answered askQuestions parts) and marks the thread
 *      live (`active_stream_id` = this POST's durable chunk-log stream).
 *      A page refresh from this point on hydrates the user's turn and can
 *      reconnect to the stream by THREAD id.
 *   2. `appendThreadResponse` — at finalize. Appends the assistant message
 *      assembled from the chunk log and clears `active_stream_id` in the
 *      SAME write, so a loader observes either "no response yet + live
 *      stream" (resume replays the whole response) or "response persisted +
 *      no stream" (nothing to resume) — never both.
 *
 * AUTHORIZATION IS THE CALLER'S JOB. Loaders take an `appId` the caller has
 * already resolved through `resolveAppScope` (Project membership); the
 * writers guard `app_id` structurally so a forged thread id can never write
 * across apps. Server-side by import discipline like the rest of `lib/db`
 * (no `server-only` marker — the read-only inspect scripts import this
 * under plain tsx, where the marker throws); nothing here is a Server
 * Action, so no client-callable RPC surface exists.
 */
import type { UIMessage } from "ai";
import { sql } from "kysely";
import { getAppDb } from "./pg";
import {
	type ThreadDoc,
	type ThreadMeta,
	threadMessageSchema,
	threadMetaSchema,
} from "./types";

/** First user text in the incoming history, truncated for the thread list. */
const SUMMARY_MAX_LENGTH = 200;

function summarize(messages: UIMessage[]): string {
	for (const msg of messages) {
		if (msg.role !== "user") continue;
		for (const part of msg.parts) {
			if (part.type === "text" && part.text.trim()) {
				return part.text.trim().slice(0, SUMMARY_MAX_LENGTH);
			}
		}
	}
	return "New conversation";
}

// ── Writers (chat route only) ──────────────────────────────────────

/**
 * Persist the incoming history and mark the thread live, in one write.
 * Insert-or-update keyed on `thread_id`; the update arm is guarded on this
 * app's ownership, so a thread id that belongs to ANOTHER app matches zero
 * rows. Returns whether a row was written — the route treats `false` as
 * "this conversation will not persist" (its pre-claim guard already 400s
 * the forged-id case; this is the structural backstop).
 */
export async function upsertThreadTurn(args: {
	appId: string;
	threadId: string;
	runId: string;
	streamId: string;
	threadType: "build" | "edit";
	messages: UIMessage[];
}): Promise<boolean> {
	const db = await getAppDb();
	const now = new Date().toISOString();
	const result = await db
		.insertInto("threads")
		.values({
			thread_id: args.threadId,
			app_id: args.appId,
			created_at: now,
			updated_at: now,
			thread_type: args.threadType,
			summary: summarize(args.messages),
			run_id: args.runId,
			active_stream_id: args.streamId,
			messages: JSON.stringify(args.messages),
		})
		.onConflict((oc) =>
			oc
				.column("thread_id")
				.doUpdateSet({
					updated_at: now,
					run_id: args.runId,
					active_stream_id: args.streamId,
					messages: JSON.stringify(args.messages),
				})
				.where("threads.app_id", "=", args.appId),
		)
		.executeTakeFirst();
	return Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
}

/**
 * Persist the run's assembled assistant message and close the live-stream
 * marker — one UPDATE. A response whose id matches the trailing stored
 * message REPLACES it (a continuation of an answered askQuestions round —
 * the client merges those into ONE message, and the store must mirror it);
 * anything else appends. `responseMessage` null means the run produced
 * nothing worth keeping (a zero-step failure); the stream marker still
 * clears so a later load doesn't chase a dead stream.
 *
 * The read-modify-write is single-writer by construction: only the chat
 * route writes threads, and the run holds the app until this finalize
 * completes — no concurrent turn can interleave on the same thread.
 */
export async function appendThreadResponse(args: {
	appId: string;
	threadId: string;
	responseMessage: UIMessage | null;
}): Promise<void> {
	const db = await getAppDb();
	const now = new Date().toISOString();
	if (!args.responseMessage) {
		await db
			.updateTable("threads")
			.set({ active_stream_id: null, updated_at: now })
			.where("thread_id", "=", args.threadId)
			.where("app_id", "=", args.appId)
			.execute();
		return;
	}
	const row = await db
		.selectFrom("threads")
		.select(["messages"])
		.where("thread_id", "=", args.threadId)
		.where("app_id", "=", args.appId)
		.executeTakeFirst();
	if (!row) return;
	const stored = (row.messages ?? []) as { id?: string }[];
	const last = stored.at(-1);
	const next =
		last?.id === args.responseMessage.id
			? [...stored.slice(0, -1), args.responseMessage]
			: [...stored, args.responseMessage];
	await db
		.updateTable("threads")
		.set({
			active_stream_id: null,
			updated_at: now,
			messages: JSON.stringify(next),
		})
		.where("thread_id", "=", args.threadId)
		.where("app_id", "=", args.appId)
		.execute();
}

// ── Loaders ────────────────────────────────────────────────────────

/**
 * Thread-list projection for an app, most recently active first. No
 * transcripts — the list stays cheap however long conversations get.
 */
export async function listThreadMetas(appId: string): Promise<ThreadMeta[]> {
	const db = await getAppDb();
	const rows = await db
		.selectFrom("threads")
		.select([
			"thread_id",
			"created_at",
			"updated_at",
			"thread_type",
			"summary",
			"run_id",
			"active_stream_id",
			sql<number>`jsonb_array_length(messages)`.as("message_count"),
		])
		.where("app_id", "=", appId)
		/* `thread_id` tiebreaks a same-millisecond `updated_at` (ISO text has
		 * ms precision) so the order — and "the most recent thread" a page
		 * load opens — can't flap between reads. */
		.orderBy("updated_at", "desc")
		.orderBy("thread_id", "asc")
		.execute();
	return rows.map((row) =>
		threadMetaSchema.parse({
			...row,
			message_count: Number(row.message_count),
		}),
	);
}

/** One full thread (meta + transcript), or null. `appId` scopes the read. */
export async function loadThread(
	appId: string,
	threadId: string,
): Promise<ThreadDoc | null> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("threads")
		.select([
			"thread_id",
			"created_at",
			"updated_at",
			"thread_type",
			"summary",
			"run_id",
			"active_stream_id",
			"messages",
		])
		.where("app_id", "=", appId)
		.where("thread_id", "=", threadId)
		.executeTakeFirst();
	if (!row) return null;
	const { messages, ...meta } = row;
	return {
		...threadMetaSchema.omit({ message_count: true }).parse(meta),
		messages: threadMessageSchema.array().parse(messages),
	};
}

/** The most recently active thread for an app, or null — what a page load
 *  opens into. */
export async function loadLatestThread(
	appId: string,
): Promise<ThreadDoc | null> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("threads")
		.select(["thread_id"])
		.where("app_id", "=", appId)
		.orderBy("updated_at", "desc")
		.orderBy("thread_id", "asc")
		.limit(1)
		.executeTakeFirst();
	if (!row) return null;
	return loadThread(appId, row.thread_id);
}

/**
 * Resolve a thread id to its app + live stream — the reconnect endpoint's
 * lookup when a GET's id isn't a stream id. UNSCOPED BY DESIGN (the URL
 * carries no app id); the caller MUST authorize against the returned
 * `appId` before serving anything.
 */
export async function resolveThreadStream(threadId: string): Promise<{
	appId: string;
	activeStreamId: string | null;
} | null> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("threads")
		.select(["app_id", "active_stream_id"])
		.where("thread_id", "=", threadId)
		.executeTakeFirst();
	if (!row) return null;
	return { appId: row.app_id, activeStreamId: row.active_stream_id };
}

/**
 * Guard read for the chat route: does this thread id already exist, and if
 * so under which app? Lets the route 400 a thread id that belongs to a
 * different app BEFORE claiming/charging anything.
 */
export async function threadAppId(threadId: string): Promise<string | null> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("threads")
		.select(["app_id"])
		.where("thread_id", "=", threadId)
		.executeTakeFirst();
	return row?.app_id ?? null;
}
