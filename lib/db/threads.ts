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
 *      end retires `active_stream_id`, the marker clear guarded to THIS
 *      run's stream, so a newer claim that beat the final write keeps its
 *      own marker (a terminal write's finished ANSWER still merges — a
 *      completed unit is the record's to keep — while mid-run barriers stop
 *      once a successor owns the thread).
 *   3. `clawBackThreadResponse` — a FAILED turn's terminal write, in one
 *      transaction: the marker clears and the id is TOMBSTONED
 *      (`clawed_back_ids`). A FRESH turn's streamed partial is KEPT in the
 *      transcript as the user-visible record (the tab that watched it fail
 *      still shows it, and a reload must not show less), with dangling tool
 *      calls closed and a cap-0 tombstone so a stale tab's copy can never
 *      grow the stored record; no API ever resumes it. A CONTINUATION
 *      reverts to its pre-run seed instead — its retry re-authors the same
 *      message id, and a kept partial would win the richer-version merge
 *      over the retry's growing fold.
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
import { type ExpressionBuilder, sql, type Transaction } from "kysely";
import { holderNonceReplayDigest } from "@/lib/chat/privateHolderNonce";
import { preserveStoredThreadAttachments } from "@/lib/chat/threadAttachments";
import { log } from "@/lib/logger";
import { DESIGN_SESSION_LEASE_COLUMNS } from "./actorGenerationGate";
import { RunHolderLostError } from "./commitGuard";
import {
	type GenerationTarget,
	generationTargetColumns,
	generationTargetFromColumns,
} from "./generationTargets";
import { LEASE_COLUMNS, type LeaseRow, leaseView } from "./leaseView";
import {
	MediaReferenceProjectionError,
	replaceExactThreadMediaReferences,
} from "./mediaAssets";
import {
	type AppDatabase,
	type ClawedBackEntry,
	getAppDb,
	withAppTx,
} from "./pg";
import { exactRunHolderMatches } from "./runHolderWrites";
import {
	type DesignSessionLease,
	type DesignSessionLeaseRow,
	designSessionLeaseState,
	type RunLease,
	runLeaseState,
} from "./runLiveness";
import { CHAT_STREAM_RETENTION_MS, streamChunkTail } from "./streamChunks";
import {
	type ThreadDoc,
	type ThreadMeta,
	threadDocSchema,
	threadMetaSchema,
} from "./types";

/** The conversation's generation target — an app, or a design session. A
 * build thread stays design-session-targeted after materialization; run
 * authority then delegates to the session's bound app (§11.6/§11.7). */
export type ThreadTarget = GenerationTarget;

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

/** Bound on the per-thread claw-back tombstone list. A thread accumulates one
 *  entry per claw-back/trim and loses one per re-authored id, so the cap only
 *  matters under pathological failure spam; oldest entries age out first. */
const CLAWED_BACK_CAP = 32;

/** The message id a tombstone entry rules on (see `ClawedBackEntry`). */
const clawedEntryId = (entry: ClawedBackEntry): string =>
	typeof entry === "string" ? entry : entry.id;

/** Add a tombstone entry — replacing any same-id entry, oldest-out past the
 *  cap. */
function withClawedBackEntry(
	entries: readonly ClawedBackEntry[],
	add: ClawedBackEntry,
): ClawedBackEntry[] {
	const next = [
		...entries.filter((entry) => clawedEntryId(entry) !== clawedEntryId(add)),
		add,
	];
	return next.length > CLAWED_BACK_CAP
		? next.slice(next.length - CLAWED_BACK_CAP)
		: next;
}

/**
 * Close a kept partial's dangling tool calls so the durable record of a
 * failed turn reads as what happened — steps that were interrupted — instead
 * of steps forever in flight (an `input-available` part renders a spinner,
 * and nothing will ever complete it). Display state only: the model-side
 * request sanitizers close dangling calls independently at request time.
 */
function closeDanglingToolParts(message: StoredMessage): StoredMessage {
	const parts = message.parts;
	if (!Array.isArray(parts)) return message;
	return {
		...message,
		parts: parts.map((part) => {
			const p = part as { type?: unknown; state?: unknown };
			if (
				typeof p.type === "string" &&
				(p.type.startsWith("tool-") || p.type === "dynamic-tool") &&
				(p.state === "input-streaming" || p.state === "input-available")
			) {
				return {
					...(part as object),
					state: "output-error",
					errorText: "This step was interrupted before it finished.",
				};
			}
			return part;
		}),
	};
}

/**
 * Filter a client-sent history down to what a HISTORY writer may add. User
 * messages pass freely. Assistant messages are refereed by the thread's
 * claw-back TOMBSTONES (`clawed_back_ids` — the ids the server deliberately
 * removed or reverted and has not re-authored since):
 *
 *  - An id the server clawed back and DELETED is refused outright: the one
 *    real source of that message is the failed turn's partial riding a stale
 *    client's send, and re-appending it would durably resurrect exactly what
 *    the claw-back removed.
 *  - An id the server clawed back and REVERTED (a continuation's seed) is
 *    capped to the stored part count: within-part state still upgrades (an
 *    answered askQuestions round), but the failed turn's appended partial
 *    parts are sliced off before the merge — a message's parts are
 *    append-only within a turn, so the stored-length prefix IS the seed.
 *  - An id the server clawed back and KEPT for display (`{ id, cap }`
 *    tombstones — a fresh failed turn's partial stays in the transcript as
 *    the user-visible record) admits a client copy only up to `cap`; at
 *    cap 0 the client copy is refused outright, because the stored partial
 *    is the one authentic copy and a stale tab's richer version is the
 *    failed turn's unpersisted tail riding a later send.
 *  - Every other assistant message merges by id as always, INCLUDING one the
 *    store doesn't know: that is the self-heal for a turn whose persistence
 *    writes all failed — the client's copy is the only surviving record, and
 *    the very next send repairs the store from it.
 */
function admissibleHistory(
	stored: StoredMessage[],
	incoming: UIMessage[],
	clawedBackIds: readonly ClawedBackEntry[],
	ctx: { target: ThreadTarget; threadId: string },
): UIMessage[] {
	if (clawedBackIds.length === 0) return incoming;
	const clawed = new Map(
		clawedBackIds.map((entry) => [clawedEntryId(entry), entry] as const),
	);
	const storedById = new Map(
		stored.filter((m) => m.id).map((m) => [m.id, m] as const),
	);
	let dropped = 0;
	let capped = 0;
	const admitted: UIMessage[] = [];
	for (const message of incoming) {
		const entry =
			message.role === "assistant" ? clawed.get(message.id) : undefined;
		if (entry === undefined) {
			admitted.push(message);
			continue;
		}
		/* String tombstones cap at the stored copy (the reverted seed) and
		 * refuse an id with no stored copy at all; `{ id, cap }` tombstones
		 * carry their bound explicitly, with 0 meaning never admitted. */
		const cap =
			typeof entry === "string"
				? (storedById.get(message.id)?.parts?.length ?? 0)
				: entry.cap;
		if (
			cap <= 0 &&
			(typeof entry !== "string" || !storedById.has(message.id))
		) {
			dropped += 1;
			continue;
		}
		if (message.parts.length > cap) {
			capped += 1;
			admitted.push({ ...message, parts: message.parts.slice(0, cap) });
		} else {
			admitted.push(message);
		}
	}
	if (dropped > 0 || capped > 0) {
		log.info(
			"[threads] refused client copies of clawed-back assistant messages (a failed turn's partial riding a later send)",
			{ ...ctx, dropped, capped },
		);
	}
	return admitted;
}

/**
 * Defense at both assistant-message writers: an assistant message never
 * legitimately carries `metadata.attachments` (attachments belong to user
 * messages, whose stored metadata is authoritative), so any that appears —
 * on a fold snapshot or on a claw-back's client-sent revert seed — is
 * stripped before it can become a durable reference the media projection
 * never admitted.
 */
function stripAssistantAttachmentMetadata(
	message: UIMessage,
	ctx: { target: ThreadTarget; threadId: string },
): UIMessage {
	const metadata = message.metadata as Record<string, unknown> | undefined;
	if (!metadata || !("attachments" in metadata)) return message;
	log.warn(
		"[threads] assistant message carried attachment metadata; stripped before the durable write",
		ctx,
	);
	const { attachments: _dropped, ...rest } = metadata;
	return { ...message, metadata: rest } as UIMessage;
}

export class ThreadAttachmentUnavailableError extends Error {
	readonly name = "ThreadAttachmentUnavailableError";
	constructor() {
		super(
			"A conversation attachment is no longer available in this Project. Choose it again and retry.",
		);
	}
}

/**
 * Replace THIS thread's exact conversation media reference set
 * (`thread_media_refs`) in the same transaction as the candidate transcript
 * — the split half of the media projection: Blueprint commits own
 * `media_asset_refs`, thread writes own only their thread's rows. The target
 * lock (app or design-session row) serializes every writer of this thread,
 * while shared asset locks serialize admission against metadata deletion, so
 * a committed carrier and its exact reverse edge cannot diverge.
 */
async function admitExactThreadMediaProjection(
	tx: Transaction<AppDatabase>,
	args: {
		projectId: string;
		candidateMessages: readonly unknown[];
		threadId: string;
	},
): Promise<void> {
	try {
		await replaceExactThreadMediaReferences(tx, {
			threadId: args.threadId,
			projectId: args.projectId,
			candidateMessages: args.candidateMessages,
		});
	} catch (error) {
		if (error instanceof MediaReferenceProjectionError) {
			throw new ThreadAttachmentUnavailableError();
		}
		throw error;
	}
}

// ── Target authority ───────────────────────────────────────────────

/** The locked authority row behind one thread write, whichever target kind
 * supplied it. `lease` speaks the matching liveness derivation; `holder`
 * proofs go through {@link threadTargetHolderMatches}. */
type LockedThreadAuthority =
	| {
			readonly kind: "app";
			readonly projectId: string;
			readonly lease: RunLease;
	  }
	| {
			readonly kind: "design-session";
			readonly projectId: string;
			readonly lease: DesignSessionLease;
	  };

/**
 * Lock one thread target's authority row — the first lock of every thread
 * write (fixed order: authority row → thread row → media assets).
 *
 * App target: the app row `FOR UPDATE`, exactly as before. Design-session
 * target: the session's app mapping is resolved WITHOUT a held lock first —
 * a MATERIALIZED (or completed edit) session delegates authority to its
 * bound app, whose row is then the one locked (the mapping is write-once, so
 * the unlocked read cannot go stale in the direction that matters); an
 * active pre-app session locks its own row (§11.7's lock order).
 */
async function lockThreadTargetAuthority(
	tx: Transaction<AppDatabase>,
	target: ThreadTarget,
): Promise<LockedThreadAuthority | null> {
	if (target.kind === "app") {
		const app = await tx
			.selectFrom("apps")
			.select([...LEASE_COLUMNS, "project_id"])
			.where("id", "=", target.appId)
			.forUpdate()
			.executeTakeFirst();
		if (!app) return null;
		return {
			kind: "app",
			projectId: app.project_id,
			lease: runLeaseState(leaseView(app)),
		};
	}
	const mapping = await tx
		.selectFrom("design_sessions")
		.select(["app_id"])
		.where("id", "=", target.designSessionId)
		.executeTakeFirst();
	if (!mapping) return null;
	if (mapping.app_id !== null) {
		const app = await tx
			.selectFrom("apps")
			.select([...LEASE_COLUMNS, "project_id"])
			.where("id", "=", mapping.app_id)
			.forUpdate()
			.executeTakeFirst();
		if (!app) return null;
		return {
			kind: "app",
			projectId: app.project_id,
			lease: runLeaseState(leaseView(app)),
		};
	}
	const session = await tx
		.selectFrom("design_sessions")
		.select([...DESIGN_SESSION_LEASE_COLUMNS, "project_id"])
		.where("id", "=", target.designSessionId)
		.forUpdate()
		.executeTakeFirst();
	if (!session) return null;
	return {
		kind: "design-session",
		projectId: session.project_id,
		lease: designSessionLeaseState(session),
	};
}

/** Prove the admitted holder against the locked authority row — the app
 * arm's `(mode, runId, nonce)` capability, or the session arm's
 * `(build, runId, nonce)`. */
function threadTargetHolderMatches(
	authority: LockedThreadAuthority,
	holder: { mode: "build" | "edit"; runId: string; nonce: string },
): boolean {
	return exactRunHolderMatches(authority.lease.holderIdentity, holder);
}

/** Whether a thread row belongs to `target` — the structural guard that
 * keeps a forged/stale thread id from writing across targets. */
function threadRowMatchesTarget(
	row: { app_id: string | null; design_session_id: string | null },
	target: ThreadTarget,
): boolean {
	return target.kind === "app"
		? row.app_id === target.appId
		: row.design_session_id === target.designSessionId;
}

/** An UPDATE builder pre-guarded by thread id + exact target columns. */
function threadTargetUpdate(
	tx: Transaction<AppDatabase>,
	target: ThreadTarget,
	threadId: string,
) {
	const base = tx.updateTable("threads").where("thread_id", "=", threadId);
	return target.kind === "app"
		? base.where("app_id", "=", target.appId)
		: base.where("design_session_id", "=", target.designSessionId);
}

/** A SELECT builder pre-guarded by thread id + exact target columns. */
function threadTargetSelect(
	db: Pick<Transaction<AppDatabase>, "selectFrom">,
	target: ThreadTarget,
	threadId: string,
) {
	const base = db.selectFrom("threads").where("thread_id", "=", threadId);
	return target.kind === "app"
		? base.where("app_id", "=", target.appId)
		: base.where("design_session_id", "=", target.designSessionId);
}

/** The READ-side widening of an app target's thread scope: an app's
 * conversations include the SESSION-targeted threads of its bound
 * materialized design session — a build thread stays session-targeted for
 * its whole life, and the app page is where the user finds it after
 * materialization. Reads only: every WRITE stays guarded by the row's exact
 * target columns (`threadRowMatchesTarget` / `threadTargetUpdate`), and run
 * authority for those rows already delegates to the app
 * (`lockThreadTargetAuthority`). */
function appScopeThreadFilter(appId: string) {
	return (eb: ExpressionBuilder<AppDatabase, "threads">) =>
		eb.or([
			eb("app_id", "=", appId),
			eb(
				"design_session_id",
				"in",
				eb
					.selectFrom("design_sessions")
					.select("design_sessions.id")
					.where("design_sessions.app_id", "=", appId)
					.where("design_sessions.state", "=", "materialized"),
			),
		]);
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
 * TRAILING stored message, only an assistant one, only when the incoming
 * history no longer carries its id, and only while the row STILL holds a
 * live-stream marker (the standing proof of an unrecovered interruption —
 * without it, the client flag alone could delete an answer a completed
 * successor already finished). The fresh run's response is the turn's only
 * durable answer.
 *
 * Incoming history is ADMITTED, not trusted (`admissibleHistory`): a client
 * copy of a message the server clawed back is refused (deleted ids) or capped
 * to its stored seed (reverted ids), so a stale tab cannot resurrect a failed
 * turn's partial — while an id the store has simply lost merges freely, the
 * self-heal for a turn whose persistence writes all failed. A FRESH thread
 * admits no assistant messages at all: no server run has ever written to it,
 * so no client-sent assistant content on it can be authentic.
 */
export async function upsertThreadTurn(args: {
	target: ThreadTarget;
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
	const logCtx = { target: args.target, threadId: args.threadId };
	const result = await withAppTx(async (tx) => {
		// Fixed lock order: authority row (app or design session) -> thread
		// row. Every competing thread writer queues on the thread row, so
		// proving the holder can never deadlock against another writer that
		// already holds it.
		const authority = await lockThreadTargetAuthority(tx, args.target);
		if (!authority || authority.projectId !== args.expectedProjectId) {
			throw new RunHolderLostError("released");
		}
		const holderLost: "superseded" | "released" | null =
			threadTargetHolderMatches(authority, {
				mode: args.threadType,
				runId: args.runId,
				nonce: args.holderNonce,
			})
				? null
				: authority.lease.present
					? "superseded"
					: "released";
		const existing = await tx
			.selectFrom("threads")
			.select([
				"app_id",
				"design_session_id",
				"messages",
				"active_stream_id",
				"clawed_back_ids",
			])
			.where("thread_id", "=", args.threadId)
			.forUpdate()
			.executeTakeFirst();
		const existingMatchesTarget =
			existing !== undefined && threadRowMatchesTarget(existing, args.target);
		if (holderLost !== null) {
			if (existingMatchesTarget) {
				const stored = (existing.messages ?? []) as StoredMessage[];
				const merged = mergeTranscript(
					stored,
					admissibleHistory(stored, args.messages, existing.clawed_back_ids, {
						...logCtx,
					}),
				);
				await threadTargetUpdate(tx, args.target, args.threadId)
					.set({ updated_at: now, messages: JSON.stringify(merged) })
					.execute();
				await admitExactThreadMediaProjection(tx, {
					projectId: authority.projectId,
					candidateMessages: merged,
					threadId: args.threadId,
				});
			}
			return { holderLost } as const;
		}
		if (existing && !existingMatchesTarget) {
			return false;
		}
		if (!existing) {
			/* Nothing stored yet — a redrive against a fresh thread has no dead
			 * partial to remove; fall through to the plain insert. A fresh
			 * thread admits NO assistant messages: no server run has ever
			 * written to this thread id, so any assistant content in the
			 * incoming history is a stale or forged client's — never the fold
			 * writers', which are the only legitimate authors. */
			const insertable = args.messages.filter((m) => m.role !== "assistant");
			if (insertable.length !== args.messages.length) {
				log.warn(
					"[threads] dropped assistant messages from a fresh thread's incoming history (no run has ever written to this thread, so no client copy is authentic)",
					{
						...logCtx,
						dropped: args.messages.length - insertable.length,
					},
				);
			}
			await tx
				.insertInto("threads")
				.values({
					thread_id: args.threadId,
					...generationTargetColumns(args.target),
					created_at: now,
					updated_at: now,
					thread_type: args.threadType,
					summary: summarize(insertable),
					run_id: args.runId,
					active_stream_id: args.streamId,
					active_holder_nonce: args.holderNonce,
					messages: JSON.stringify(insertable),
				})
				.execute();
			/* Row first, then the reference projection: `thread_media_refs`
			 * rows are children of this thread row, and a validation failure
			 * still rolls the whole insert back. */
			await admitExactThreadMediaProjection(tx, {
				projectId: authority.projectId,
				candidateMessages: insertable,
				threadId: args.threadId,
			});
			return true;
		}
		let stored = (existing.messages ?? []) as StoredMessage[];
		let clawedBackIds = existing.clawed_back_ids ?? [];
		/* The re-drive trim requires the row to STILL carry a marker: an
		 * interrupted run's marker stands until recovery (the loaders never
		 * clear it), so its absence proves the turn was NOT left interrupted —
		 * a completed successor already retired it — and the client's
		 * `redrive` flag alone must not let a stale tab delete that
		 * successor's finished answer. (This claim won the app, so any marker
		 * present belongs to a DEAD run, never a live one.) The trimmed id is
		 * TOMBSTONED: a tab still holding the dead partial must not merge it
		 * back on a later send. */
		if (args.redrive && existing.active_stream_id !== null) {
			const trailing = stored.at(-1);
			if (
				trailing?.id &&
				trailing.role === "assistant" &&
				!args.messages.some((m) => m.id === trailing.id)
			) {
				/* Removal (not display-keeping) is deliberate here: the client's
				 * own `regenerate()` already trimmed this partial from the view
				 * the user is watching, so keeping it durably would make a later
				 * reload show a message the live recovery never did. */
				stored = stored.slice(0, -1);
				clawedBackIds = withClawedBackEntry(clawedBackIds, trailing.id);
			}
		}
		const merged = mergeTranscript(
			stored,
			admissibleHistory(stored, args.messages, clawedBackIds, { ...logCtx }),
		);
		await threadTargetUpdate(tx, args.target, args.threadId)
			.set({
				updated_at: now,
				run_id: args.runId,
				active_stream_id: args.streamId,
				active_holder_nonce: args.holderNonce,
				messages: JSON.stringify(merged),
				clawed_back_ids: JSON.stringify(clawedBackIds),
			})
			.execute();
		await admitExactThreadMediaProjection(tx, {
			projectId: authority.projectId,
			candidateMessages: merged,
			threadId: args.threadId,
		});
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
	target: ThreadTarget;
	threadId: string;
	messages: UIMessage[];
	expectedProjectId: string;
}): Promise<boolean> {
	const now = new Date().toISOString();
	return await withAppTx(async (tx) => {
		const authority = await lockThreadTargetAuthority(tx, args.target);
		if (!authority || authority.projectId !== args.expectedProjectId) {
			return false;
		}
		const existing = await tx
			.selectFrom("threads")
			.select(["app_id", "design_session_id", "messages", "clawed_back_ids"])
			.where("thread_id", "=", args.threadId)
			.forUpdate()
			.executeTakeFirst();
		if (!existing || !threadRowMatchesTarget(existing, args.target)) {
			return false;
		}
		const stored = (existing.messages ?? []) as StoredMessage[];
		const merged = mergeTranscript(
			stored,
			admissibleHistory(stored, args.messages, existing.clawed_back_ids, {
				target: args.target,
				threadId: args.threadId,
			}),
		);
		await threadTargetUpdate(tx, args.target, args.threadId)
			.set({ updated_at: now, messages: JSON.stringify(merged) })
			.execute();
		await admitExactThreadMediaProjection(tx, {
			projectId: authority.projectId,
			candidateMessages: merged,
			threadId: args.threadId,
		});
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
 *  - A BARRIER write's merge (`clearMarker: false`) requires the thread's
 *    live marker to still name THIS run's stream: a falsely-reaped run that
 *    keeps streaming must not deposit MID-RUN snapshots into a thread its
 *    successor now owns — the successor's claim may have just REMOVED this
 *    run's partial, and two live runs' barriers interleaving on one message
 *    id would corrupt it.
 *  - A TERMINAL write's merge (`clearMarker: true`) is NOT marker-guarded: a
 *    completed answer is a finished unit and the record keeps finished
 *    units, even when a successor claimed the thread mid-write (the false
 *    reap the successor recovered from does not un-happen this run's real,
 *    charged answer — the user may have watched it finish). Both merges stay
 *    Project-guarded (an app moved to another Project mid-run stops
 *    contributing content there).
 *  - The MARKER-CLEAR arm is guarded ONLY by `active_stream_id === streamId`
 *    — never by Project — so a completed run's marker can't strand on the
 *    destination after a move (a stranded marker reads as an instance death
 *    and re-drives a finished turn). A newer run's fresh marker is that
 *    run's to clear, never this one's to clobber.
 *
 * A merge that lands also CLEARS its message id's claw-back tombstone: this
 * writer is the fold's own voice, so the id is re-authored server-side and
 * client copies of it are ordinary history again.
 *
 * No media projection runs here: an assistant message carries no
 * `metadata.attachments` (stripped defensively if one ever appears) and the
 * by-id merge cannot alter stored user messages, so the app's projected
 * attachment set is unchanged by construction. `responseMessage` null (or an
 * empty-parts message, normalized to null) means there is nothing to merge;
 * the marker arm still applies.
 */
export async function persistResponseSnapshot(args: {
	target: ThreadTarget;
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
		const authority = await lockThreadTargetAuthority(tx, args.target);
		if (!authority) return;
		/* Inline `selectFrom` + row lock (not the shared target-select helper):
		 * the row-lock privilege scanner must statically prove the locked
		 * table, and a builder returned from a helper has no provable target. */
		const rowQuery = tx
			.selectFrom("threads")
			.select([
				"messages",
				"active_stream_id",
				"active_holder_nonce",
				"clawed_back_ids",
			])
			.where("thread_id", "=", args.threadId)
			.forUpdate();
		const row = await (args.target.kind === "app"
			? rowQuery.where("app_id", "=", args.target.appId)
			: rowQuery.where("design_session_id", "=", args.target.designSessionId)
		).executeTakeFirst();
		if (!row) return;
		const clearMarker =
			args.clearMarker && row.active_stream_id === args.streamId;
		let responseMessage =
			args.responseMessage && args.responseMessage.parts.length > 0
				? args.responseMessage
				: null;
		if (
			responseMessage &&
			!args.clearMarker &&
			row.active_stream_id !== args.streamId
		) {
			/* A BARRIER snapshot whose thread marker no longer names this run's
			 * stream: a successor claimed the turn (a falsely-reaped run's
			 * zombie barriers land here), or the run's own terminal write
			 * already retired it. A mid-run partial is not this thread's
			 * present to keep — but a TERMINAL write's completed answer is,
			 * so only barrier merges stop here. */
			responseMessage = null;
		}
		if (responseMessage && authority.projectId !== args.expectedProjectId) {
			// The app moved Projects mid-run: only the marker arm may proceed.
			responseMessage = null;
		}
		if (responseMessage) {
			responseMessage = stripAssistantAttachmentMetadata(responseMessage, {
				target: args.target,
				threadId: args.threadId,
			});
		}
		if (!responseMessage && !clearMarker) return;
		const merged = responseMessage
			? mergeTranscript((row.messages ?? []) as StoredMessage[], [
					responseMessage,
				])
			: undefined;
		/* A landed merge re-authors its id: client copies of it are ordinary
		 * history again, so the claw-back tombstone (if any) comes off. */
		const mergedId = responseMessage?.id;
		const tombstones = row.clawed_back_ids ?? [];
		const clearedTombstones =
			mergedId !== undefined &&
			tombstones.some((entry) => clawedEntryId(entry) === mergedId)
				? tombstones.filter((entry) => clawedEntryId(entry) !== mergedId)
				: undefined;
		await threadTargetUpdate(tx, args.target, args.threadId)
			.set({
				updated_at: now,
				...(clearMarker ? { active_stream_id: null } : {}),
				...(clearMarker && !args.retainHolderNonce
					? { active_holder_nonce: null }
					: {}),
				...(merged ? { messages: JSON.stringify(merged) } : {}),
				...(clearedTombstones
					? { clawed_back_ids: JSON.stringify(clearedTombstones) }
					: {}),
			})
			.execute();
	});
}

/**
 * A FAILED turn's terminal thread write: clear the run's marker, tombstone
 * the message id, and settle what the transcript keeps — one transaction.
 * A FRESH turn's streamed partial STAYS, as the user-visible record of what
 * they watched happen (dangling tool calls closed so nothing renders as
 * forever in flight); a CONTINUATION reverts to its pre-run seed, because
 * its retry re-authors the same message id and a kept partial would win the
 * richer-version merge over the retry's growing fold.
 *
 * This is the one writer allowed to SHRINK a transcript (the continuation
 * arm), so it stacks three guards: the route calls it only under the
 * failed/aborted directive, it touches only the exact message id the run's
 * fold owns, and it acts only while `active_stream_id` still names this
 * run's stream (a successor that claimed the thread owns everything — this
 * write then does nothing at all). A misfire is bounded to that one message
 * in that one thread.
 *
 * `revertTo` is the continuation case's pre-run seed (the raw incoming
 * trailing assistant message of an answered askQuestions round): the message
 * returns to exactly what the client sent — minus any `metadata.attachments`,
 * which no assistant message legitimately carries and which this one path
 * (the only writer that puts a client-sent message into the durable
 * transcript verbatim) must not smuggle past the media projection. Absent,
 * the run's message was fresh and is deleted outright. The holder nonce
 * always clears — a failed run has no answer POST to keep it for.
 *
 * The clawed id is TOMBSTONED (`clawed_back_ids`): the tab that watched the
 * failure still holds the partial under this id, and its next send would
 * otherwise merge it right back (richer-version-wins cannot tell a failed
 * turn's partial from a legitimate continuation). The tombstone stands until
 * a fold snapshot re-authors the id.
 */
export async function clawBackThreadResponse(args: {
	target: ThreadTarget;
	threadId: string;
	streamId: string;
	/** The message id the run's fold owns — the only id this write may touch. */
	messageId: string;
	/** Pre-run seed for a continuation; absent means delete the message. */
	revertTo?: UIMessage;
}): Promise<void> {
	const now = new Date().toISOString();
	await withAppTx(async (tx) => {
		const authority = await lockThreadTargetAuthority(tx, args.target);
		if (!authority) return;
		/* Inline for the row-lock scanner, as above. */
		const rowQuery = tx
			.selectFrom("threads")
			.select(["messages", "active_stream_id", "clawed_back_ids"])
			.where("thread_id", "=", args.threadId)
			.forUpdate();
		const row = await (args.target.kind === "app"
			? rowQuery.where("app_id", "=", args.target.appId)
			: rowQuery.where("design_session_id", "=", args.target.designSessionId)
		).executeTakeFirst();
		if (!row) return;
		if (row.active_stream_id !== args.streamId) return;
		const revertTo =
			args.revertTo && args.revertTo.id === args.messageId
				? stripAssistantAttachmentMetadata(args.revertTo, {
						target: args.target,
						threadId: args.threadId,
					})
				: undefined;
		const stored = (row.messages ?? []) as StoredMessage[];
		/* The CONTINUATION arm (`revertTo`) reverts to the pre-run seed: the
		 * retry re-authors this very message id, and a kept partial would win
		 * the richer-version merge over the retry's growing fold. The FRESH
		 * arm KEEPS the streamed partial for display — the tab that watched it
		 * still shows it, and a reload must not show less than the live view
		 * did — with its dangling tool calls closed so nothing spins forever.
		 * A fresh retry mints a new message id, so nothing ever collides with
		 * the kept copy; its cap-0 tombstone keeps stale client versions of it
		 * from growing the stored record. */
		const reverted = stored.flatMap((msg) => {
			if (msg.id !== args.messageId) return [msg];
			return revertTo
				? [revertTo as StoredMessage]
				: [closeDanglingToolParts(msg)];
		});
		await threadTargetUpdate(tx, args.target, args.threadId)
			.set({
				updated_at: now,
				active_stream_id: null,
				active_holder_nonce: null,
				messages: JSON.stringify(reverted),
				clawed_back_ids: JSON.stringify(
					withClawedBackEntry(
						row.clawed_back_ids ?? [],
						revertTo ? args.messageId : { id: args.messageId, cap: 0 },
					),
				),
			})
			.execute();
	});
}

// ── Loaders ────────────────────────────────────────────────────────

/**
 * Reconcile loaded rows' live-stream markers against ACTUAL app liveness —
 * REPORT-ONLY. `active_stream_id` is cleared by finalize; a run whose
 * process died (instance kill, OOM) never finalizes, stranding the marker.
 * The app-level lease is the truth (no live run means no live stream), so a
 * marker on an idle app reads as dead: stripped from the
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
 *
 * The FINISHED-vs-DIED call reads the chunk log's SEAL: the stream writer's
 * close — called only by finalize, which a dead process never reaches —
 * stamps the run's fold outcome on the terminal row. A stranded marker whose
 * stream is sealed `completed`/`paused` belongs to a FINISHED turn that only
 * lost its marker-clear write (build or edit alike): it projects retired,
 * with no interruption stamp, so the finished answer is neither destroyed
 * nor re-charged by an auto-re-drive. A sealed `failed` stream is a failed
 * turn whose claw-back never landed — the interruption stamp stands so the
 * re-drive claim can remove the partial (the deliberate degraded-recovery
 * path). An UNSEALED stream (rows but no terminal row, or no rows on a
 * recent marker) is a mid-turn death — the interruption stamp is the whole
 * point. A marker older than the chunk-log retention with NO rows left has
 * outlived its evidence: it projects retired, because the destructive arm
 * (auto-re-drive deletes the trailing answer and re-charges) must never run
 * on guesswork.
 */
async function reconcileDeadMarkers<
	T extends {
		thread_id: string;
		active_stream_id: string | null;
		updated_at: string;
	},
>(
	target: ThreadTarget,
	rows: T[],
	/** The caller's own fresh holder read, when it has one (`loadThread`
	 * shares a single snapshot between this reconcile and its
	 * `run_paused`/nonce projection, so the two stamps can never disagree
	 * about one moment). `null` means the target row is missing. */
	preReadHolder?: TargetHolderProjection | null,
): Promise<(T & { resume_interrupted?: boolean })[]> {
	const marked = rows.filter((row) => row.active_stream_id !== null);
	if (marked.length === 0) return rows;
	if (preReadHolder !== undefined) {
		if (preReadHolder?.live) return rows;
	} else {
		try {
			const projection = await readTargetHolderProjection(target);
			if (projection?.live) return rows;
		} catch {
			return rows;
		}
	}
	return Promise.all(
		rows.map(async (row) => {
			if (row.active_stream_id === null) return row;
			let tail: Awaited<ReturnType<typeof streamChunkTail>>;
			try {
				tail = await streamChunkTail(row.active_stream_id);
			} catch {
				/* Fail OPEN, like the holder read: a transient blip must not
				 * stamp the destructive re-drive arm. The marker stays in the
				 * projection; the reconnect endpoint's liveness fallback closes
				 * any tail attempt, and the next load re-reads. */
				return row;
			}
			const sealedFinished =
				tail?.terminal === true &&
				(tail.terminalOutcome === "completed" ||
					tail.terminalOutcome === "paused");
			const evidenceExpired =
				tail === null &&
				Date.now() - Date.parse(row.updated_at) >= CHAT_STREAM_RETENTION_MS;
			if (sealedFinished || evidenceExpired) {
				log.warn(
					sealedFinished
						? "[threads] stranded marker on a finished run (sealed stream); projecting it retired instead of interrupted"
						: "[threads] stranded marker outlived its chunk-log evidence; projecting it retired instead of interrupted",
					{ target, threadId: row.thread_id, streamId: row.active_stream_id },
				);
				return { ...row, active_stream_id: null };
			}
			/* The event-log breadcrumb for an instance death: a run claimed this
			 * thread's turn and never finalized. Fires on every read until a
			 * re-drive retires the marker — bounded by page loads, and the
			 * repetition is itself the "still unrecovered" signal. */
			log.warn("[threads] detected a dead live-stream marker", {
				target,
				threadId: row.thread_id,
				streamId: row.active_stream_id,
			});
			return { ...row, active_stream_id: null, resume_interrupted: true };
		}),
	);
}

/** The unlocked holder posture of one thread target — the loaders' shared
 * projection input (`resume_interrupted`, `run_paused`, and the actor-bound
 * continuation nonce all derive from ONE of these per load). A
 * design-session target with a bound app (materialized) reads the APP's
 * holder — run authority delegated exactly as the writers delegate it. */
interface TargetHolderProjection {
	live: boolean;
	paused: boolean;
	holderIdentity: import("./runLiveness").RunHolderIdentity | null;
	/** The holding actor, per the refund-actor rule (edit lock actor; build
	 * marker actor falling back to owner). Null when no holder. */
	holderActor: string | null;
	pausedBy: (actorUserId: string) => boolean;
}

async function readTargetHolderProjection(
	target: ThreadTarget,
): Promise<TargetHolderProjection | null> {
	const db = await getAppDb();
	if (target.kind === "app") {
		const app = await db
			.selectFrom("apps")
			.select([...LEASE_COLUMNS])
			.where("id", "=", target.appId)
			.executeTakeFirst();
		if (!app) return null;
		const lease = runLeaseState(leaseView(app as LeaseRow));
		const holderActor =
			lease.mode === "edit"
				? app.lock_actor_user_id
				: lease.mode === "build"
					? (app.res_user_id ?? app.owner)
					: null;
		return {
			live: lease.live,
			paused: lease.paused,
			holderIdentity: lease.holderIdentity,
			holderActor,
			pausedBy: lease.pausedBy,
		};
	}
	const mapping = await db
		.selectFrom("design_sessions")
		.select(["app_id"])
		.where("id", "=", target.designSessionId)
		.executeTakeFirst();
	if (!mapping) return null;
	if (mapping.app_id !== null) {
		return readTargetHolderProjection({ kind: "app", appId: mapping.app_id });
	}
	const session = await db
		.selectFrom("design_sessions")
		.select([...DESIGN_SESSION_LEASE_COLUMNS])
		.where("id", "=", target.designSessionId)
		.executeTakeFirst();
	if (!session) return null;
	const lease = designSessionLeaseState(session as DesignSessionLeaseRow);
	return {
		live: lease.live,
		paused: lease.paused,
		holderIdentity: lease.holderIdentity,
		holderActor:
			lease.holderIdentity !== null
				? (session.run_actor_user_id ?? session.owner_user_id)
				: null,
		pausedBy: lease.pausedBy,
	};
}

/**
 * Thread-list projection for one generation target, most recently active
 * first. No transcripts — the list stays cheap however long conversations
 * get. Authorization is the caller's job (the target resolver).
 */
export async function listThreadMetas(
	target: ThreadTarget,
): Promise<LoadedThreadMeta[]> {
	const db = await getAppDb();
	let query = db
		.selectFrom("threads")
		.select([
			"thread_id",
			"created_at",
			"updated_at",
			"thread_type",
			"summary",
			"run_id",
			"active_stream_id",
			"design_session_id",
			sql<number>`jsonb_array_length(messages)`.as("message_count"),
		]);
	query =
		target.kind === "app"
			? query.where(appScopeThreadFilter(target.appId))
			: query.where("design_session_id", "=", target.designSessionId);
	const rows = await query
		/* `thread_id` tiebreaks a same-millisecond `updated_at` (ISO text has
		 * ms precision) so the order — and "the most recent thread" a page
		 * load opens — can't flap between reads. */
		.orderBy("updated_at", "desc")
		.orderBy("thread_id", "asc")
		.execute();
	const reconciled = await reconcileDeadMarkers(target, rows);
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

/** One full thread (meta + transcript), or null. `target` scopes the read. */
export async function loadThread(
	target: ThreadTarget,
	threadId: string,
	actorUserId?: string,
): Promise<LoadedThread | null> {
	const db = await getAppDb();
	const base = db.selectFrom("threads").where("thread_id", "=", threadId);
	const scoped =
		target.kind === "app"
			? base.where(appScopeThreadFilter(target.appId))
			: base.where("design_session_id", "=", target.designSessionId);
	const row = await scoped
		.select([
			"thread_id",
			"created_at",
			"updated_at",
			"thread_type",
			"summary",
			"run_id",
			"active_stream_id",
			"active_holder_nonce",
			"design_session_id",
			"messages",
		])
		.executeTakeFirst();
	if (!row) return null;
	/* ONE fresh holder read powers the dead-marker reconcile AND both
	 * projections below, so `resume_interrupted` and `run_paused` always
	 * derive from the same snapshot — a claim or pause landing between two
	 * separate reads would otherwise hand the client stamps that never
	 * coexisted. `run_paused` reports the target's ACTUAL awaiting-input
	 * posture for this thread's run (see `LoadedThread`) and needs no actor.
	 * The continuation nonce is projected only to the actor who owns the run —
	 * the paused round's answering actor, or a LIVE run's holding actor (a
	 * cold-resume replay redacts the chunk that carried the nonce marker for
	 * every other viewer, so the owner re-seeds it from here at activation).
	 * A co-member who can view the same transcript receives no nonce. */
	const holder = await readTargetHolderProjection(target);
	const [reconciled] = await reconcileDeadMarkers(target, [row], holder);
	const { active_holder_nonce: storedHolderNonce, ...publicRow } = reconciled;
	const doc = threadDocSchema.parse(publicRow);
	let holderNonce: string | undefined;
	let runPaused = false;
	if (holder) {
		const identity = holder.holderIdentity;
		const threadRunHoldsTarget = identity?.runId === doc.run_id;
		runPaused = holder.paused && threadRunHoldsTarget;
		if (
			actorUserId !== undefined &&
			identity &&
			threadRunHoldsTarget &&
			identity.nonce !== null &&
			storedHolderNonce === identity.nonce
		) {
			if (
				(holder.paused && holder.pausedBy(actorUserId)) ||
				(holder.live && holder.holderActor === actorUserId)
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
	target: ThreadTarget;
	threadId: string;
	holderDigest: string;
	actorUserId: string;
}): Promise<string | null> {
	const db = await getAppDb();
	const thread = await threadTargetSelect(db, args.target, args.threadId)
		.select(["run_id", "active_holder_nonce"])
		.executeTakeFirst();
	if (!thread?.active_holder_nonce) return null;
	if (
		holderNonceReplayDigest(thread.active_holder_nonce) !== args.holderDigest
	) {
		return null;
	}

	const holder = await readTargetHolderProjection(args.target);
	if (!holder) return null;
	return holder.holderIdentity?.runId === thread.run_id &&
		holder.holderIdentity.nonce === thread.active_holder_nonce &&
		holder.holderActor === args.actorUserId
		? thread.active_holder_nonce
		: null;
}

/**
 * Resolve a thread id to its generation target + live stream. Two consumers:
 * the reconnect endpoint (when a GET's id isn't a stream id) and the chat
 * route's pre-claim guard (a thread id under a different app 400s before
 * anything is charged). UNSCOPED BY DESIGN (neither caller has a target
 * yet); the caller MUST authorize against the returned target before
 * serving or writing anything.
 */
export async function resolveThreadStream(threadId: string): Promise<{
	target: ThreadTarget;
	activeStreamId: string | null;
	runId: string;
} | null> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("threads")
		.select(["app_id", "design_session_id", "active_stream_id", "run_id"])
		.where("thread_id", "=", threadId)
		.executeTakeFirst();
	if (!row) return null;
	return {
		target: generationTargetFromColumns(row),
		activeStreamId: row.active_stream_id,
		runId: row.run_id,
	};
}
