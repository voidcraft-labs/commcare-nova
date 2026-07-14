/**
 * Chat thread persistence — the durable conversation store.
 *
 * A thread is one conversation about an app; it spans many runs. The chat
 * route is the ONLY writer, and it writes server-authoritatively at two
 * moments:
 *
 *   1. `upsertThreadTurn` — the instant a run has claimed the app. MERGES
 *      the full incoming `UIMessage[]` history (which already carries the new
 *      user turn and any answered askQuestions parts) into the stored
 *      transcript and marks the thread live (`active_stream_id` = this
 *      POST's durable chunk-log stream). A page refresh from this point on
 *      hydrates the user's turn and can reconnect to the stream by THREAD id.
 *   2. `appendThreadResponse` — at finalize. Merges the assistant message
 *      assembled from the chunk log and retires `active_stream_id` in the
 *      SAME write — guarded to THIS run's stream, so a newer claim that beat
 *      the finalize keeps its own marker and turns.
 *
 * Both writers are row-locked read-modify-writes (`withAppTx` +
 * `FOR UPDATE`), and both MERGE by message id (`mergeTranscript`) rather
 * than rewrite — a stale client or a late finalize can add to a transcript,
 * never erase it. The loaders reconcile markers against actual app liveness
 * (`reconcileDeadMarkers`), so a run that died before finalize can't strand
 * a thread as perpetually "live".
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
import { log } from "@/lib/logger";
import { appHeldLive } from "./apps";
import { getAppDb, withAppTx } from "./pg";
import {
	type ThreadDoc,
	type ThreadMeta,
	threadDocSchema,
	threadMetaSchema,
} from "./types";

/**
 * Loader projections carry one TRANSIENT field beyond the stored shape:
 * `resume_interrupted` is true only on the load that HEALED a dead
 * live-stream marker (`reconcileDeadMarkers`) — the signature of a run
 * killed before finalize (instance death), as opposed to a run that failed
 * and finalized cleanly (its marker was retired with the failure). The flag
 * is never persisted: it fires exactly once, which is what lets the client
 * auto-re-drive the interrupted turn without ever looping on it.
 */
export type LoadedThreadMeta = ThreadMeta & { resume_interrupted?: boolean };
export type LoadedThread = ThreadDoc & { resume_interrupted?: boolean };

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

/** The minimal message shape the merge reasons over — id identity plus a
 *  parts count for the richer-version tiebreak. */
type StoredMessage = { id?: string; parts?: unknown[] };

/**
 * Merge an incoming transcript into the stored one — the write rule that
 * keeps a stale client from durably ERASING turns other sessions added.
 *
 * Union by message id, stored order first: a message only the store knows
 * survives; a message only the incoming history knows appends (in incoming
 * order); a message both know resolves to the RICHER version (more parts —
 * a continuation-extended assistant message beats a stale copy), with the
 * incoming side winning ties (it can carry newer part STATE at equal count,
 * e.g. an askQuestions round whose outputs just arrived client-side).
 *
 * The result is what the durable row converges to; the SA still receives
 * exactly what the client sent THIS turn (it can only reason over the
 * history its user sees), and the next hydration serves the union.
 */
export function mergeTranscript(
	stored: StoredMessage[],
	incoming: StoredMessage[],
): StoredMessage[] {
	const incomingById = new Map<string, StoredMessage>();
	for (const msg of incoming) {
		if (msg.id) incomingById.set(msg.id, msg);
	}
	const merged: StoredMessage[] = stored.map((msg) => {
		const update = msg.id ? incomingById.get(msg.id) : undefined;
		if (!update) return msg;
		return (update.parts?.length ?? 0) >= (msg.parts?.length ?? 0)
			? update
			: msg;
	});
	const storedIds = new Set(stored.map((m) => m.id).filter(Boolean));
	for (const msg of incoming) {
		if (!msg.id || !storedIds.has(msg.id)) merged.push(msg);
	}
	return merged;
}

// ── Writers (chat route only) ──────────────────────────────────────

/**
 * Persist the incoming history and mark the thread live. Insert on a new
 * thread id; on an existing one, MERGE the incoming history into the stored
 * transcript (see `mergeTranscript` — a stale tab must not erase turns other
 * sessions added) under a row lock, so a concurrent finalize's append
 * serializes instead of interleaving. The row's `app_id` guards every arm —
 * a thread id under ANOTHER app writes nothing. Returns whether a row was
 * written; the route treats `false` as "this conversation will not persist"
 * (its pre-claim guard already 400s the forged-id case; this is the
 * structural backstop).
 */
export async function upsertThreadTurn(args: {
	appId: string;
	threadId: string;
	runId: string;
	streamId: string;
	threadType: "build" | "edit";
	messages: UIMessage[];
}): Promise<boolean> {
	const now = new Date().toISOString();
	return withAppTx(async (tx) => {
		const existing = await tx
			.selectFrom("threads")
			.select(["app_id", "messages"])
			.where("thread_id", "=", args.threadId)
			.forUpdate()
			.executeTakeFirst();
		if (!existing) {
			await tx
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
				.execute();
			return true;
		}
		if (existing.app_id !== args.appId) return false;
		const merged = mergeTranscript(
			(existing.messages ?? []) as StoredMessage[],
			args.messages,
		);
		await tx
			.updateTable("threads")
			.set({
				updated_at: now,
				run_id: args.runId,
				active_stream_id: args.streamId,
				messages: JSON.stringify(merged),
			})
			.where("thread_id", "=", args.threadId)
			.where("app_id", "=", args.appId)
			.execute();
		return true;
	});
}

/**
 * Persist the run's assembled assistant message and retire this run's
 * live-stream marker — one row-locked read-modify-write.
 *
 * The response merges by id (`mergeTranscript`): a continuation of an
 * answered askQuestions round REPLACES its trailing same-id message exactly
 * as the client merges it, and turns a newer claim persisted while this
 * finalize was still sealing (the app releases before finalize completes)
 * survive untouched. `streamId` guards the marker: it clears ONLY while it
 * still names THIS run's stream — a newer run's fresh marker is that run's
 * to clear, never this one's to clobber (a clobbered marker would make the
 * newer run's refresh-resume read as "nothing in flight").
 *
 * `responseMessage` null means the run produced nothing worth keeping (a
 * zero-step failure); the marker guard still applies.
 */
export async function appendThreadResponse(args: {
	appId: string;
	threadId: string;
	streamId: string;
	responseMessage: UIMessage | null;
}): Promise<void> {
	const now = new Date().toISOString();
	await withAppTx(async (tx) => {
		const row = await tx
			.selectFrom("threads")
			.select(["messages", "active_stream_id"])
			.where("thread_id", "=", args.threadId)
			.where("app_id", "=", args.appId)
			.forUpdate()
			.executeTakeFirst();
		if (!row) return;
		const clearMarker = row.active_stream_id === args.streamId;
		if (!args.responseMessage && !clearMarker) return;
		const merged = args.responseMessage
			? mergeTranscript((row.messages ?? []) as StoredMessage[], [
					args.responseMessage,
				])
			: undefined;
		await tx
			.updateTable("threads")
			.set({
				updated_at: now,
				...(clearMarker ? { active_stream_id: null } : {}),
				...(merged ? { messages: JSON.stringify(merged) } : {}),
			})
			.where("thread_id", "=", args.threadId)
			.where("app_id", "=", args.appId)
			.execute();
	});
}

// ── Loaders ────────────────────────────────────────────────────────

/**
 * Reconcile loaded rows' live-stream markers against ACTUAL app liveness.
 * `active_stream_id` is cleared by finalize — a run whose process died
 * (instance kill, OOM) never finalizes, stranding the marker: a perpetual
 * LIVE badge and a phantom resume on every open. The app-level lease is the
 * truth (`appHeldLive` — no live run means no live stream), so a marker on
 * an idle app reads as dead: stripped from the returned values and cleared
 * on the rows best-effort. Fails OPEN on a liveness read fault (a transient
 * blip must not hide a genuinely live run from the resume path).
 *
 * A healed row comes back stamped `resume_interrupted: true` — the one-shot
 * instance-death signal the client's auto-re-drive keys on (see
 * `LoadedThread`).
 */
async function reconcileDeadMarkers<
	T extends { thread_id: string; active_stream_id: string | null },
>(appId: string, rows: T[]): Promise<(T & { resume_interrupted?: boolean })[]> {
	const marked = rows.filter((row) => row.active_stream_id !== null);
	if (marked.length === 0) return rows;
	try {
		if (await appHeldLive(appId)) return rows;
	} catch {
		return rows;
	}
	const db = await getAppDb();
	for (const row of marked) {
		/* Guarded on the exact stream seen dead — a run that claimed between
		 * the liveness read and this write owns a FRESH marker this heal must
		 * not clobber. Best-effort: the stripped return value already tells
		 * the caller the truth; the next load re-derives regardless. */
		await db
			.updateTable("threads")
			.set({ active_stream_id: null })
			.where("app_id", "=", appId)
			.where("thread_id", "=", row.thread_id)
			.where("active_stream_id", "=", row.active_stream_id)
			.execute()
			.catch(() => {});
		/* The event-log breadcrumb for an instance death: a run claimed this
		 * thread's turn and never finalized. The client re-drives off the
		 * returned flag; this line is how an operator finds the death. */
		log.warn("[threads] healed a dead live-stream marker", {
			appId,
			threadId: row.thread_id,
			streamId: row.active_stream_id,
		});
	}
	return rows.map((row) =>
		row.active_stream_id === null
			? row
			: { ...row, active_stream_id: null, resume_interrupted: true },
	);
}

/**
 * Thread-list projection for an app, most recently active first. No
 * transcripts — the list stays cheap however long conversations get.
 */
export async function listThreadMetas(
	appId: string,
): Promise<LoadedThreadMeta[]> {
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
	const reconciled = await reconcileDeadMarkers(appId, rows);
	return reconciled.map((row) => {
		const meta = threadMetaSchema.parse({
			...row,
			message_count: Number(row.message_count),
		});
		// Transient, deliberately outside the stored-shape schema — see
		// `LoadedThreadMeta`.
		return row.resume_interrupted
			? { ...meta, resume_interrupted: true }
			: meta;
	});
}

/** One full thread (meta + transcript), or null. `appId` scopes the read. */
export async function loadThread(
	appId: string,
	threadId: string,
): Promise<LoadedThread | null> {
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
	const [reconciled] = await reconcileDeadMarkers(appId, [row]);
	const doc = threadDocSchema.parse(reconciled);
	// Transient, deliberately outside the stored-shape schema — see
	// `LoadedThread`.
	return reconciled.resume_interrupted
		? { ...doc, resume_interrupted: true }
		: doc;
}

/**
 * Resolve a thread id to its app + live stream. Two consumers: the
 * reconnect endpoint (when a GET's id isn't a stream id) and the chat
 * route's pre-claim guard (a thread id under a different app 400s before
 * anything is charged). UNSCOPED BY DESIGN (neither caller has an app id
 * yet); the caller MUST authorize against the returned `appId` before
 * serving or writing anything.
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
