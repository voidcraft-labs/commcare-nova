/**
 * Chat thread persistence — the durable conversation store.
 *
 * A thread is one conversation about an app; it spans many runs. The chat
 * route is the ONLY writer, and it records the conversation AS THE RUN
 * PRODUCES IT — each completed unit lands when it completes, and no
 * end-of-run event is ever the thing the record depends on:
 *
 *   1. `upsertThreadTurn` — the instant a run has claimed the app. MERGES
 *      the full incoming `UIMessage[]` history (which already carries the new
 *      user turn and any answered askQuestions parts) into the stored
 *      transcript and marks the thread live (`active_stream_id` = this
 *      POST's chunk-log stream). A page refresh from this point on hydrates
 *      the user's turn and can reconnect to the stream by THREAD id. A
 *      RE-DRIVE claim also removes its dead predecessor's trailing partial
 *      assistant message — the one shape a died run can leave behind.
 *   2. `persistResponseSnapshot` — at every step barrier (the SDK fold's
 *      `finish-step` callback) and once at stream end. Merges the assembled
 *      assistant message as it grows — completed units only — and at stream
 *      end retires `active_stream_id`, guarded to THIS run's stream, so a
 *      newer claim that beat the final write keeps its own marker and turns.
 *   3. `clawBackThreadResponse` — a FAILED turn's terminal write: the turn's
 *      message reverts to its pre-run state and the marker clears, in one
 *      transaction. A partial serves nobody (no API resumes a partial turn;
 *      no surface renders one as history), so its removal is not an event.
 *
 * All writers are row-locked read-modify-writes (`withAppTx` +
 * `FOR UPDATE`), and the merge writers MERGE by message id
 * (`mergeTranscript`) rather than rewrite — a stale client or a late barrier
 * can add to a transcript, never erase it (`clawBackThreadResponse` is the
 * one deliberate, triple-guarded exception). The loaders reconcile markers
 * against actual app liveness (`reconcileDeadMarkers`), so a run that died
 * mid-turn can't strand a thread as perpetually "live".
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
import { sql, type Transaction } from "kysely";
import { holderNonceReplayDigest } from "@/lib/chat/privateHolderNonce";
import { preserveStoredThreadAttachments } from "@/lib/chat/threadAttachments";
import { log } from "@/lib/logger";
import { appHeldLive, replaceExactMediaReferencesForApp } from "./apps";
import { RunHolderLostError } from "./commitGuard";
import { LEASE_COLUMNS, leaseView } from "./leaseView";
import { MediaReferenceProjectionError } from "./mediaAssets";
import { type AppDatabase, getAppDb, withAppTx } from "./pg";
import { exactRunHolderMatches } from "./runHolderWrites";
import { runLeaseState } from "./runLiveness";
import {
	type ThreadDoc,
	type ThreadMeta,
	threadDocSchema,
	threadMetaSchema,
} from "./types";

/**
 * Loader projections carry DERIVED fields beyond the stored shape:
 *
 *  - `resume_interrupted` is true when the row holds a live-stream marker
 *    whose app is NOT held by any live run (`reconcileDeadMarkers`) — the
 *    signature of a run killed mid-turn (instance death), as opposed to a
 *    run that failed and retired its marker through its own terminal write.
 *  - `run_paused` (full loads only) is true when the app's current holder is
 *    this thread's run AND it is parked awaiting input (an askQuestions
 *    round). The recovery client keys on the ACTUAL pause posture, not
 *    transcript shape: a barrier-persisted question round whose run died
 *    before it could pause shows the card but is NOT paused — re-driving it
 *    is correct recovery — while a genuinely paused round must never
 *    re-drive.
 *
 * The loaders never clear the marker themselves: a read must not consume a
 * recovery signal another surface needs (the thread list, a heal refetch,
 * and the page load all read these rows, and only ONE of them re-drives).
 * The signal therefore stands, load after load, until an acting client's
 * RE-DRIVE claims the turn — its `upsertThreadTurn` overwrites the marker
 * with its own live stream and removes the dead run's trailing partial — so
 * a re-drive that itself dies is simply detected again. The projection still
 * strips `active_stream_id`, so nothing ever tails the dead stream.
 */
export type LoadedThreadMeta = ThreadMeta & { resume_interrupted?: boolean };
export type LoadedThread = ThreadDoc & {
	resume_interrupted?: boolean;
	run_paused?: boolean;
};

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
 *  parts count for the richer-version tiebreak; `role` feeds only the
 *  re-drive claim's dead-partial removal. */
type StoredMessage = { id?: string; role?: string; parts?: unknown[] };

export class ThreadAttachmentUnavailableError extends Error {
	readonly name = "ThreadAttachmentUnavailableError";
	constructor() {
		super(
			"A conversation attachment is no longer available in this Project. Choose it again and retry.",
		);
	}
}

/**
 * Replace the app's complete authored media projection in the same transaction
 * as the candidate transcript. The app lock serializes every Blueprint/thread
 * writer, while shared asset locks serialize admission against metadata
 * deletion, so a committed carrier and its exact reverse edge cannot diverge.
 */
async function admitExactThreadMediaProjection(
	tx: Transaction<AppDatabase>,
	args: {
		appId: string;
		projectId: string;
		candidateMessages: readonly unknown[];
		threadId: string;
	},
): Promise<void> {
	try {
		await replaceExactMediaReferencesForApp(tx, {
			appId: args.appId,
			projectId: args.projectId,
			candidateThread: {
				threadId: args.threadId,
				messages: args.candidateMessages,
			},
		});
	} catch (error) {
		if (error instanceof MediaReferenceProjectionError) {
			throw new ThreadAttachmentUnavailableError();
		}
		throw error;
	}
}

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
		const candidate =
			(update.parts?.length ?? 0) >= (msg.parts?.length ?? 0) ? update : msg;
		return preserveStoredThreadAttachments(msg, candidate) as StoredMessage;
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
 * structural backstop). The app holder is locked and proved before the thread
 * row lock. A run that lost that proof may still merge its real incoming
 * transcript into an existing same-app thread, but it never installs or
 * clears the successor's identity/stream marker; the merge commits and then a
 * {@link RunHolderLostError} stops the stale run.
 *
 * A RE-DRIVE claim (`redrive`) re-runs a turn whose run died mid-answer, and
 * the dead run's barrier writes may have left a trailing PARTIAL assistant
 * message on the stored transcript. The client's `regenerate()` trims that
 * message from the history it sends, and the by-id merge union would keep the
 * stored copy forever — so the re-drive claim removes it explicitly: only the
 * TRAILING stored message, only an assistant one, and only when the incoming
 * history no longer carries its id. The fresh run's response is the turn's
 * only durable answer.
 */
export async function upsertThreadTurn(args: {
	appId: string;
	threadId: string;
	runId: string;
	streamId: string;
	/** Chat passes the exact holder; optional only for old fixtures/importers. */
	holderNonce: string;
	threadType: "build" | "edit";
	messages: UIMessage[];
	/** Project captured by chat admission. */
	expectedProjectId: string;
	/** This claim re-runs a died turn — remove the dead run's trailing
	 * partial before merging. Only the owning claim path honors it. */
	redrive?: boolean;
}): Promise<boolean> {
	const now = new Date().toISOString();
	const result = await withAppTx(async (tx) => {
		// Fixed lock order: app row -> thread row. Every competing thread writer
		// queues on the thread row, so proving the holder can never deadlock
		// against another writer that already holds it.
		const app = await tx
			.selectFrom("apps")
			.select([...LEASE_COLUMNS, "project_id"])
			.where("id", "=", args.appId)
			.forUpdate()
			.executeTakeFirst();
		if (app?.project_id !== args.expectedProjectId) {
			throw new RunHolderLostError("released");
		}
		let holderLost: "superseded" | "released" | null = "released";
		if (app) {
			const lease = runLeaseState(leaseView(app));
			holderLost = exactRunHolderMatches(lease.holderIdentity, {
				mode: args.threadType,
				runId: args.runId,
				nonce: args.holderNonce,
			})
				? null
				: lease.present
					? "superseded"
					: "released";
		}
		const existing = await tx
			.selectFrom("threads")
			.select(["app_id", "messages"])
			.where("thread_id", "=", args.threadId)
			.forUpdate()
			.executeTakeFirst();
		if (holderLost !== null) {
			if (existing?.app_id === args.appId) {
				const merged = mergeTranscript(
					(existing.messages ?? []) as StoredMessage[],
					args.messages,
				);
				await admitExactThreadMediaProjection(tx, {
					appId: args.appId,
					projectId: app.project_id,
					candidateMessages: merged,
					threadId: args.threadId,
				});
				await tx
					.updateTable("threads")
					.set({ updated_at: now, messages: JSON.stringify(merged) })
					.where("thread_id", "=", args.threadId)
					.where("app_id", "=", args.appId)
					.execute();
			}
			return { holderLost } as const;
		}
		if (existing && existing.app_id !== args.appId) {
			return false;
		}
		if (!existing) {
			/* Nothing stored yet — a redrive against a fresh thread has no dead
			 * partial to remove; fall through to the plain insert. */
			await admitExactThreadMediaProjection(tx, {
				appId: args.appId,
				projectId: app.project_id,
				candidateMessages: args.messages,
				threadId: args.threadId,
			});
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
					active_holder_nonce: args.holderNonce,
					messages: JSON.stringify(args.messages),
				})
				.execute();
			return true;
		}
		let stored = (existing.messages ?? []) as StoredMessage[];
		if (args.redrive) {
			const trailing = stored.at(-1);
			if (
				trailing?.id &&
				trailing.role === "assistant" &&
				!args.messages.some((m) => m.id === trailing.id)
			) {
				stored = stored.slice(0, -1);
			}
		}
		const merged = mergeTranscript(stored, args.messages);
		await admitExactThreadMediaProjection(tx, {
			appId: args.appId,
			projectId: app.project_id,
			candidateMessages: merged,
			threadId: args.threadId,
		});
		await tx
			.updateTable("threads")
			.set({
				updated_at: now,
				run_id: args.runId,
				active_stream_id: args.streamId,
				active_holder_nonce: args.holderNonce,
				messages: JSON.stringify(merged),
			})
			.where("thread_id", "=", args.threadId)
			.where("app_id", "=", args.appId)
			.execute();
		return true;
	});
	if (typeof result === "object") {
		throw new RunHolderLostError(result.holderLost);
	}
	return result;
}

/**
 * Merge a bailed POST's incoming history into the stored transcript WITHOUT
 * touching the thread's identity or liveness (`run_id`, `active_stream_id`
 * stay exactly as the run that owns the app left them).
 *
 * The bail paths (a serialize-wait timeout or gate rejection, a superseded
 * resume) run nothing — but their HISTORY is real client state: an answered
 * askQuestions round exists only in the client's memory until a write lands,
 * and losing it forces the user to re-answer after the refresh the bail
 * error itself recommends. Merge-only and update-only: a thread under
 * another app writes nothing, and a thread id with no row (nothing ever ran,
 * so there is nothing to continue) is NOT created here.
 */
export async function mergeThreadTurnMessages(args: {
	appId: string;
	threadId: string;
	messages: UIMessage[];
	expectedProjectId: string;
}): Promise<boolean> {
	const now = new Date().toISOString();
	return await withAppTx(async (tx) => {
		const app = await tx
			.selectFrom("apps")
			.select("project_id")
			.where("id", "=", args.appId)
			.forUpdate()
			.executeTakeFirst();
		if (!app || app.project_id !== args.expectedProjectId) {
			return false;
		}
		const existing = await tx
			.selectFrom("threads")
			.select(["app_id", "messages"])
			.where("thread_id", "=", args.threadId)
			.forUpdate()
			.executeTakeFirst();
		if (!existing || existing.app_id !== args.appId) return false;
		const merged = mergeTranscript(
			(existing.messages ?? []) as StoredMessage[],
			args.messages,
		);
		await admitExactThreadMediaProjection(tx, {
			appId: args.appId,
			projectId: app.project_id,
			candidateMessages: merged,
			threadId: args.threadId,
		});
		await tx
			.updateTable("threads")
			.set({ updated_at: now, messages: JSON.stringify(merged) })
			.where("thread_id", "=", args.threadId)
			.where("app_id", "=", args.appId)
			.execute();
		return true;
	});
}

/**
 * Merge the run's assembled assistant message into the stored transcript —
 * the barrier write, one row-locked read-modify-write per completed step.
 *
 * The chat route's server-side fold calls this from the SDK's own completion
 * callbacks: per `finish-step` with `clearMarker: false` (the message grows,
 * the run stays live), and once at stream end with `clearMarker: true` (the
 * final state plus marker retirement in one write). Successive snapshots are
 * cumulative, so `mergeTranscript`'s more-parts-wins converges even when a
 * barrier write failed and the next one carries both steps.
 *
 * Split guards, deliberately asymmetric:
 *  - The MERGE arm is Project-guarded: an app moved to another Project
 *    mid-run stops contributing content there (the merge is skipped).
 *  - The MARKER-CLEAR arm is guarded ONLY by `active_stream_id === streamId`
 *    — never by Project — so a completed run's marker can't strand on the
 *    destination after a move (a stranded marker reads as an instance death
 *    and re-drives a finished turn). A newer run's fresh marker is that
 *    run's to clear, never this one's to clobber.
 *
 * No media projection runs here: an assistant message carries no
 * `metadata.attachments` (stripped defensively if one ever appears) and the
 * by-id merge cannot alter stored user messages, so the app's projected
 * attachment set is unchanged by construction. `responseMessage` null (or an
 * empty-parts message, normalized to null) means there is nothing to merge;
 * the marker arm still applies.
 */
export async function persistResponseSnapshot(args: {
	appId: string;
	threadId: string;
	streamId: string;
	/** Project captured by chat admission — guards the MERGE arm only. */
	expectedProjectId: string;
	responseMessage: UIMessage | null;
	/** True only at stream end; barrier writes leave the run's marker live. */
	clearMarker: boolean;
	/** A paused askQuestions round keeps its generation for the answer POST;
	 * every terminal/unpaused finish clears it with the exact stream marker. */
	retainHolderNonce?: boolean;
}): Promise<void> {
	const now = new Date().toISOString();
	await withAppTx(async (tx) => {
		const app = await tx
			.selectFrom("apps")
			.select(["id", "project_id"])
			.where("id", "=", args.appId)
			.forUpdate()
			.executeTakeFirst();
		if (!app) return;
		const row = await tx
			.selectFrom("threads")
			.select(["messages", "active_stream_id", "active_holder_nonce"])
			.where("thread_id", "=", args.threadId)
			.where("app_id", "=", args.appId)
			.forUpdate()
			.executeTakeFirst();
		if (!row) return;
		const clearMarker =
			args.clearMarker && row.active_stream_id === args.streamId;
		let responseMessage =
			args.responseMessage && args.responseMessage.parts.length > 0
				? args.responseMessage
				: null;
		if (responseMessage && app.project_id !== args.expectedProjectId) {
			// The app moved Projects mid-run: only the marker arm may proceed.
			responseMessage = null;
		}
		const metadata = responseMessage?.metadata as
			| Record<string, unknown>
			| undefined;
		if (responseMessage && metadata && "attachments" in metadata) {
			log.warn(
				"[threads] assistant snapshot carried attachment metadata; stripped before merge",
				{ appId: args.appId, threadId: args.threadId },
			);
			const { attachments: _dropped, ...rest } = metadata;
			responseMessage = { ...responseMessage, metadata: rest } as UIMessage;
		}
		if (!responseMessage && !clearMarker) return;
		const merged = responseMessage
			? mergeTranscript((row.messages ?? []) as StoredMessage[], [
					responseMessage,
				])
			: undefined;
		await tx
			.updateTable("threads")
			.set({
				updated_at: now,
				...(clearMarker ? { active_stream_id: null } : {}),
				...(clearMarker && !args.retainHolderNonce
					? { active_holder_nonce: null }
					: {}),
				...(merged ? { messages: JSON.stringify(merged) } : {}),
			})
			.where("thread_id", "=", args.threadId)
			.where("app_id", "=", args.appId)
			.execute();
	});
}

/**
 * Revert a FAILED turn's message to its pre-run state and clear the run's
 * marker — one transaction. The uniform turn-end rule: the record holds
 * completed units only, and a failed turn's partial is not a unit anyone can
 * use, so it comes back out.
 *
 * This is the one writer allowed to SHRINK a transcript, so it stacks three
 * guards: the route calls it only under the failed/aborted directive, it
 * touches only the exact message id the run's fold owns, and it acts only
 * while `active_stream_id` still names this run's stream (a successor that
 * claimed the thread owns everything — this write then does nothing at all).
 * A misfire is bounded to that one message in that one thread.
 *
 * `revertTo` is the continuation case's pre-run seed (the raw incoming
 * trailing assistant message of an answered askQuestions round): the message
 * returns to exactly what the client sent. Absent, the run's message was
 * fresh and is deleted outright. The holder nonce always clears — a failed
 * run has no answer POST to keep it for.
 */
export async function clawBackThreadResponse(args: {
	appId: string;
	threadId: string;
	streamId: string;
	/** The message id the run's fold owns — the only id this write may touch. */
	messageId: string;
	/** Pre-run seed for a continuation; absent means delete the message. */
	revertTo?: UIMessage;
}): Promise<void> {
	const now = new Date().toISOString();
	await withAppTx(async (tx) => {
		const app = await tx
			.selectFrom("apps")
			.select("id")
			.where("id", "=", args.appId)
			.forUpdate()
			.executeTakeFirst();
		if (!app) return;
		const row = await tx
			.selectFrom("threads")
			.select(["messages", "active_stream_id"])
			.where("thread_id", "=", args.threadId)
			.where("app_id", "=", args.appId)
			.forUpdate()
			.executeTakeFirst();
		if (!row) return;
		if (row.active_stream_id !== args.streamId) return;
		const stored = (row.messages ?? []) as StoredMessage[];
		const reverted = stored.flatMap((msg) => {
			if (msg.id !== args.messageId) return [msg];
			return args.revertTo && args.revertTo.id === args.messageId
				? [args.revertTo as StoredMessage]
				: [];
		});
		await tx
			.updateTable("threads")
			.set({
				updated_at: now,
				active_stream_id: null,
				active_holder_nonce: null,
				messages: JSON.stringify(reverted),
			})
			.where("thread_id", "=", args.threadId)
			.where("app_id", "=", args.appId)
			.execute();
	});
}

// ── Loaders ────────────────────────────────────────────────────────

/**
 * Reconcile loaded rows' live-stream markers against ACTUAL app liveness —
 * REPORT-ONLY. `active_stream_id` is cleared by finalize; a run whose
 * process died (instance kill, OOM) never finalizes, stranding the marker.
 * The app-level lease is the truth (`appHeldLive` — no live run means no
 * live stream), so a marker on an idle app reads as dead: stripped from the
 * returned PROJECTION (no perpetual LIVE badge, no phantom resume) and
 * stamped `resume_interrupted: true` for the re-drive.
 *
 * The row itself is deliberately untouched. Clearing it here would make the
 * recovery signal one-shot-per-READ: whichever loader happens to run first
 * (the thread list, a heal refetch, a page load over a different thread)
 * would consume it, and the one client positioned to re-drive would never
 * see it — stranding the turn and, for a reaped build, bricking the app
 * behind the `error`-status redirect. Only an acting re-drive retires the
 * marker (its claim's `upsertThreadTurn` overwrites it; its finalize clears
 * it), so the signal is level-triggered: it stands until recovery actually
 * happens. Fails OPEN on a liveness read fault (a transient blip must not
 * hide a genuinely live run from the resume path).
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
	for (const row of marked) {
		/* The event-log breadcrumb for an instance death: a run claimed this
		 * thread's turn and never finalized. Fires on every read until a
		 * re-drive retires the marker — bounded by page loads, and the
		 * repetition is itself the "still unrecovered" signal. */
		log.warn("[threads] detected a dead live-stream marker", {
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
	actorUserId?: string,
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
			"active_holder_nonce",
			"messages",
		])
		.where("app_id", "=", appId)
		.where("thread_id", "=", threadId)
		.executeTakeFirst();
	if (!row) return null;
	const [reconciled] = await reconcileDeadMarkers(appId, [row]);
	const { active_holder_nonce: storedHolderNonce, ...publicRow } = reconciled;
	const doc = threadDocSchema.parse(publicRow);
	/* One fresh lease read powers two projections. `run_paused` reports the
	 * app's ACTUAL awaiting-input posture for this thread's run (see
	 * `LoadedThread`) and needs no actor. The continuation nonce is projected
	 * only to the actor who owns the run — the paused round's answering
	 * actor, or a LIVE run's holding actor (a rewound tail replay starts past
	 * the chunk that carried the nonce marker, so the owner re-seeds it from
	 * here at activation). A co-member who can view the same transcript
	 * receives no nonce. */
	let holderNonce: string | undefined;
	let runPaused = false;
	const app = await db
		.selectFrom("apps")
		.select(LEASE_COLUMNS)
		.where("id", "=", appId)
		.executeTakeFirst();
	if (app) {
		const lease = runLeaseState(leaseView(app));
		const identity = lease.holderIdentity;
		const threadRunHoldsApp = identity?.runId === doc.run_id;
		runPaused = lease.paused && threadRunHoldsApp;
		if (
			actorUserId !== undefined &&
			identity &&
			threadRunHoldsApp &&
			identity.nonce !== null &&
			storedHolderNonce === identity.nonce
		) {
			const holderActor =
				lease.mode === "edit"
					? app.lock_actor_user_id
					: lease.mode === "build"
						? (app.res_user_id ?? app.owner)
						: null;
			if (
				(lease.paused && lease.pausedBy(actorUserId)) ||
				(lease.live && holderActor === actorUserId)
			) {
				holderNonce = identity.nonce;
			}
		}
	}
	const projected =
		holderNonce === undefined ? doc : { ...doc, holder_nonce: holderNonce };
	// Transient, deliberately outside the stored-shape schema — see
	// `LoadedThread`.
	return {
		...projected,
		...(reconciled.resume_interrupted ? { resume_interrupted: true } : {}),
		...(runPaused ? { run_paused: true } : {}),
	};
}

/**
 * Resolve the private holder capability represented by one durable-stream
 * marker. The chunk log stores only a thread id + irreversible nonce digest;
 * this projection re-reads that thread's retained nonce and the app's current
 * holder, then returns the nonce only when the digest, run, generation, and
 * authenticated actor all still match. It remains valid after a PAUSED
 * finalize clears `active_stream_id`, but an old same-run stream cannot receive
 * a successor generation. Completed, superseded, reaped, mismatched, and
 * co-member replays receive `null`.
 */
export async function loadHolderNonceForReplayMarker(args: {
	appId: string;
	threadId: string;
	holderDigest: string;
	actorUserId: string;
}): Promise<string | null> {
	const db = await getAppDb();
	const thread = await db
		.selectFrom("threads")
		.select(["run_id", "active_holder_nonce"])
		.where("app_id", "=", args.appId)
		.where("thread_id", "=", args.threadId)
		.executeTakeFirst();
	if (!thread?.active_holder_nonce) return null;
	if (
		holderNonceReplayDigest(thread.active_holder_nonce) !== args.holderDigest
	) {
		return null;
	}

	const app = await db
		.selectFrom("apps")
		.select(LEASE_COLUMNS)
		.where("id", "=", args.appId)
		.executeTakeFirst();
	if (!app) return null;
	const lease = runLeaseState(leaseView(app));
	const holderActor =
		lease.mode === "edit"
			? app.lock_actor_user_id
			: lease.mode === "build"
				? (app.res_user_id ?? app.owner)
				: null;
	return lease.holderIdentity?.runId === thread.run_id &&
		lease.holderIdentity.nonce === thread.active_holder_nonce &&
		holderActor === args.actorUserId
		? thread.active_holder_nonce
		: null;
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
	runId: string;
} | null> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("threads")
		.select(["app_id", "active_stream_id", "run_id"])
		.where("thread_id", "=", threadId)
		.executeTakeFirst();
	if (!row) return null;
	return {
		appId: row.app_id,
		activeStreamId: row.active_stream_id,
		runId: row.run_id,
	};
}
