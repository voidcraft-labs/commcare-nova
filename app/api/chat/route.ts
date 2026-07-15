import {
	convertToModelMessages,
	createUIMessageStream,
	createUIMessageStreamResponse,
	type InferAgentUIMessage,
	isTextUIPart,
	validateUIMessages,
} from "ai";
import {
	buildTurnRetryContinuation,
	classifyError,
	countDocumentsNeedingRead,
	createSolutionsArchitect,
	type ErrorType,
	GenerationContext,
	MESSAGES,
	resolveAttachments,
	shouldRetryTurn,
	TURN_RETRY_MESSAGE,
	turnRetryDelayMs,
} from "@/lib/agent";
import { CHAT_REQUEST_MAX_BYTES, declaredBodyTooLarge } from "@/lib/apiError";
import { resolveActiveProjectId, resolveGatewayKey } from "@/lib/auth-utils";
import { assembleResponseMessage } from "@/lib/chat/assembleResponseMessage";
import { DurableStreamWriter } from "@/lib/chat/durableStreamWriter";
import { MAX_CHAT_MESSAGE_CHARS } from "@/lib/chat/limits";
import { sanitizeHistoricalReasoningParts } from "@/lib/chat/sanitizeReasoningParts";
import { sanitizeHistoricalToolParts } from "@/lib/chat/sanitizeToolParts";
import { createOpenPartTracker } from "@/lib/chat/streamPartClosure";
import { validateChatMessages } from "@/lib/chat/validateMessages";
import {
	AppAccessError,
	resolveAppAccess,
	resolveProjectAccess,
} from "@/lib/db/appAccess";
import {
	type ClaimedRun,
	claimAndReserveRun,
	clearRunLock,
	clearRunLockAndSettle,
	completeAndSettleRun,
	createApp,
	editRunLockHeldBy,
	failApp,
	GenerationInProgressError,
	loadApp,
	loadAppHolder,
	type ReacquireOutcome,
	RunConflictError,
	reacquireLease,
	reserveForNewBuild,
	setAwaitingInput,
} from "@/lib/db/apps";
import { ACTUAL_COST_BACKSTOP_USD } from "@/lib/db/creditPolicy";
import {
	getCurrentCreditBalance,
	OutOfCreditsError,
	type Reservation,
	settleAndRelease,
} from "@/lib/db/credits";
import { materializeCaseStoreSchemas } from "@/lib/db/materializeCaseStoreSchemas";
import { pruneChatStreamChunks } from "@/lib/db/streamChunks";
import {
	appendThreadResponse,
	mergeThreadTurnMessages,
	resolveThreadStream,
	upsertThreadTurn,
} from "@/lib/db/threads";
import { getMonthlyUsage, UsageAccumulator } from "@/lib/db/usage";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { ensureReferenceIndex } from "@/lib/doc/referenceIndex";
import type { BlueprintDoc, PersistableDoc } from "@/lib/domain";
import { LogWriter } from "@/lib/log/writer";
import { log } from "@/lib/logger";
import { SA_BUILD_MODEL, SA_EDIT_MODEL } from "@/lib/models";
import { creditGateDecision } from "./creditGate";
import { chatRequestSchema } from "./schema";
import { isFatalStreamErrorChunk } from "./streamFailure";

/* Advisory only. The real per-request ceiling is the Cloud Run service's
 * `timeoutSeconds` (3600s); on the Next `standalone` server this export is a
 * Vercel-platform hint the runtime does not enforce. Kept so the value isn't
 * misread as a 5-minute cap that does not exist here. */
export const maxDuration = 300;

/* Serialize-with-wait poll cadence + ceiling. A conflicting SA request opens
 * its SSE stream and polls `claimRun` every `CLAIM_WAIT_POLL_MS` until the
 * holder releases, up to `CLAIM_WAIT_MAX_MS`; past that it emits a friendly
 * "still busy" and ends (the user retries). The ceiling is well under Cloud
 * Run's per-request timeout so a waiter never itself trips the platform kill. */
const CLAIM_WAIT_POLL_MS = 750;
const CLAIM_WAIT_MAX_MS = 120_000;

/* Opportunistic chunk-log retention sweep — at most one fire-and-forget prune
 * per instance per interval, piggybacked on POST traffic (the same
 * no-dedicated-cron pattern as the run reapers). */
const CHUNK_PRUNE_INTERVAL_MS = 10 * 60 * 1000;
let lastChunkPruneAt = 0;

// ── Route Handler ──────────────────────────────────────────────────────

export async function POST(req: Request) {
	// Bound the UNauthenticated parse ahead of `resolveGatewayKey` below. The
	// cap is generous enough for the largest real request (blueprint + bounded
	// message history); the message/attachment/text limits stay as the secondary,
	// post-parse controls. Enforced on BOTH the declared size (cheap, pre-buffer)
	// AND the actual byte length — a chunked request omits Content-Length, so the
	// declared-size check alone would wave a headerless stream into the full
	// parse. Buffering is bounded by Cloud Run's ~32 MB inbound limit.
	const tooLarge = () =>
		Response.json(
			{
				error:
					"That request is too large to process. Start a fresh conversation — the history has grown past what one request can send.",
				type: "invalid_request",
			},
			{ status: 413 },
		);
	if (declaredBodyTooLarge(req, CHAT_REQUEST_MAX_BYTES)) return tooLarge();
	const rawBody = await req.arrayBuffer();
	if (rawBody.byteLength > CHAT_REQUEST_MAX_BYTES) return tooLarge();
	let body: { messages?: unknown; [k: string]: unknown };
	try {
		body = JSON.parse(new TextDecoder().decode(rawBody));
	} catch {
		// Malformed-but-within-cap JSON: a clean 4xx, not an opaque 500 (matches
		// the structured 413 above and the 400s below).
		return Response.json(
			{ error: "Invalid request body", type: "invalid_request" },
			{ status: 400 },
		);
	}

	// Messages come from the AI SDK's useChat. The route owns the SECURITY gate on
	// them: the untrusted attachment metadata is re-resolved every turn (each ref
	// → an asset-row load + a GCS/extract read) and persisted into the event log,
	// so `validateChatMessages` bounds the message count + the request-wide
	// attachment total and enforces the per-ref field caps. It deliberately does
	// NOT re-parse the SDK-owned message `parts` — that shape is the SDK's contract.
	const messagesResult = validateChatMessages(body.messages);
	if (!messagesResult.ok) {
		return Response.json(
			{ error: messagesResult.error, type: "invalid_request" },
			{ status: 400 },
		);
	}
	const messages = messagesResult.messages;

	// Validate our fields (apiKey, blueprint, etc.)
	const parsed = chatRequestSchema.safeParse(body);
	if (!parsed.success) {
		return new Response(JSON.stringify({ error: "Invalid request body" }), {
			status: 400,
		});
	}

	// Reject an over-length typed message — defense in depth behind the
	// composer's own send gate (both read MAX_CHAT_MESSAGE_CHARS, so they can't
	// disagree). Only the new turn's typed text counts; attachments ride as
	// metadata refs, not inline text, so they're never part of this length.
	const newTurn = messages.at(-1);
	if (newTurn?.role === "user") {
		const typedLength = newTurn.parts
			.filter(isTextUIPart)
			.reduce((n, p) => n + p.text.length, 0);
		if (typedLength > MAX_CHAT_MESSAGE_CHARS) {
			return Response.json(
				{
					error: `That message is ${typedLength.toLocaleString()} characters, over the ${MAX_CHAT_MESSAGE_CHARS.toLocaleString()}-character limit. Trim it — or attach long content as a file — and send again.`,
					type: "message_too_long",
				},
				{ status: 400 },
			);
		}
	}

	// Require authenticated session + server API key
	const keyResult = await resolveGatewayKey(req);
	if (!keyResult.ok) {
		return new Response(JSON.stringify({ error: keyResult.error }), {
			status: keyResult.status,
		});
	}

	const userId = keyResult.session.user.id;

	/* The credit-gate decision for this POST. Computed from the RAW `messages`
	 * array and the raw `body.appReady`. The last message's ROLE is the charge
	 * signal (a fresh instruction ends with `user`; an answered-askQuestions
	 * auto-resend ends with `assistant` and rides free), so any future
	 * transform of the history the SA receives must not feed back into this
	 * read. (`validateChatMessages` only validates + types the array; it does
	 * not reorder or trim, so `messages` here is still the raw history.) */
	const { chargeable, cost } = creditGateDecision({
		rawMessages: messages,
		appReady: !!body.appReady,
	});

	/* Credit gate — fast-fail read. Sits where the dollar cap used to, at the top
	 * of the handler, and FAILS CLOSED: any database read error rejects with 503
	 * rather than letting an ungated/uncharged generation through. This is the
	 * cheap pre-flight read; the transactional reservation that actually books
	 * the charge runs later, after every pre-stream rejection point.
	 *
	 * Two independent checks:
	 *   (a) Actual-$ backstop — runs on EVERY POST (continuations included), so a
	 *       user hammering a broken app on free continuations still trips it. The
	 *       dollar threshold is never surfaced to the user (the message must not
	 *       leak the figure).
	 *   (b) Credit balance — only on CHARGEABLE POSTs. A continuation never
	 *       reserves, so it has no balance to check; gating it here would also
	 *       create an orphan app in the common out-of-credits case. */
	try {
		const usage = await getMonthlyUsage(userId);
		const monthlySpend = Math.max(
			usage?.cost_estimate ?? 0,
			usage?.actual_cost ?? 0,
		);
		if (monthlySpend >= ACTUAL_COST_BACKSTOP_USD) {
			return Response.json(
				{
					error:
						"You've reached your monthly usage limit. It resets on the 1st.",
					type: "out_of_credits",
				},
				{ status: 429 },
			);
		}

		if (chargeable) {
			const balance = await getCurrentCreditBalance(userId);
			if (balance < cost) {
				return Response.json(
					{ error: MESSAGES.out_of_credits, type: "out_of_credits" },
					{ status: 429 },
				);
			}
		}
	} catch (err) {
		log.error("[chat] credit gate read failed", err);
		return Response.json(
			{
				error:
					"Unable to verify your credit balance. Please try again shortly.",
				type: "internal",
			},
			{ status: 503 },
		);
	}

	const { runId, appReady } = parsed.data;
	/* A turn without a thread id starts a fresh server-minted thread (see the
	 * schema): the conversation persists either way. */
	const threadId = parsed.data.threadId ?? crypto.randomUUID();

	/* Stable per-request run identifier. Every event envelope (mutation or
	 * conversation) carries this value; the client echoes it back on follow-up
	 * requests so threads stay aligned across turns. Minted here — before any
	 * persistence work — so failure paths below can still surface it if needed. */
	const effectiveRunId = runId ?? crypto.randomUUID();

	/* Thread-identity guard — BEFORE any persistence work (a rejection here
	 * must not mint an orphan app). `threadId` is client-minted, so an id that
	 * already exists must belong to THIS app: on a new build no thread can
	 * exist yet, and on an existing app a mismatch means a forged or stale id.
	 * The write path re-enforces this structurally (`upsertThreadTurn` guards
	 * `app_id`); this read just turns the failure into a clean 400. Fails
	 * CLOSED on a read error — proceeding unguarded would let the later
	 * guarded write silently drop the conversation instead. */
	try {
		const existingThread = await resolveThreadStream(threadId);
		if (
			existingThread !== null &&
			(!parsed.data.appId || existingThread.appId !== parsed.data.appId)
		) {
			return Response.json(
				{
					error:
						"That conversation belongs to a different app. Reload the page to pick up the right conversation list.",
					type: "invalid_request",
				},
				{ status: 400 },
			);
		}
	} catch (err) {
		log.error("[chat] thread-identity read failed", err);
		return Response.json(
			{
				error: "Couldn't load this conversation. Please try again shortly.",
				type: "internal",
			},
			{ status: 503 },
		);
	}

	/* This POST's durable-stream identity — fresh per POST (a run spans many
	 * POSTs; resume cursors are per-POST chunk counts). Returned in the
	 * `x-workflow-run-id` response header, which is the handle the client's
	 * WorkflowChatTransport reconnects with (`/api/chat/{streamId}/stream`)
	 * when this response breaks without a `finish` chunk. */
	const streamId = crypto.randomUUID();

	/* Retention sweep for the chunk log — throttled per instance, never blocks
	 * or fails the request. */
	if (Date.now() - lastChunkPruneAt > CHUNK_PRUNE_INTERVAL_MS) {
		lastChunkPruneAt = Date.now();
		pruneChatStreamChunks().catch((err) => {
			log.warn("[chat] chunk-log prune failed", {
				err: err instanceof Error ? err.message : String(err),
			});
		});
	}

	/*
	 * Resolve appId for authenticated users. Existing apps already have
	 * an ID from the client. New builds create a real app row
	 * (status: 'generating') so log events have an app to live under from the start.
	 *
	 * The app doc is created BEFORE the concurrency check so it acts as a
	 * lock — a second concurrent request will see this row in the in-transaction
	 * concurrency scan
	 * and reject. Without this ordering, two simultaneous requests could both
	 * pass the check before either writes a doc (classic TOCTOU).
	 */
	let appId = parsed.data.appId;
	let appCreated = false;
	/* The credit reservation this run booked — set atomically with the claim
	 * (`claimAndReserveRun` / `reserveForNewBuild`) pre-stream on the free /
	 * first-claim paths, or inside `execute` after the serialize-with-wait poll
	 * loop. Threaded into the accumulator so a failed or no-op run refunds the
	 * exact charge against the exact month. */
	let reservation: Reservation | undefined;
	/* The persisted app doc for an EXISTING-app request — captured off the
	 * authorization read below so the SA's working doc seeds from the saved
	 * blueprint with no extra load. Undefined for a new build (no
	 * app exists yet); the seed falls back to the empty doc there. */
	let loadedApp:
		| Awaited<ReturnType<typeof resolveAppAccess>>["app"]
		| undefined;
	/* The app's Project — the media tenant. Set in BOTH branches below (the
	 * active Project for a new build, the app's Project for an existing one) and
	 * used to scope chat-attachment resolution (`resolveAttachments`) to the
	 * Project the documents live in. */
	let projectId: string | undefined;
	/* Set when this POST claimed an existing app's run window
	 * (`claimAndReserveRun` — a build flipped to `generating`, or an edit's
	 * `run_lock` — with the credit debit in the SAME transaction). There is no
	 * prior-state snapshot to carry: every claim rejection (busy, concurrency,
	 * out-of-credits, infrastructure) is a transaction rollback that held
	 * nothing, so there is nothing to restore. Set either pre-stream (the free
	 * / first-claim path) or inside `execute` (after the serialize-with-wait
	 * poll loop). */
	let claimedRun: ClaimedRun | undefined;
	/* Set when the pre-stream claim CONFLICTED — another run holds the app. The
	 * route does NOT 429; it opens the SSE stream and, inside `execute`, emits a
	 * "busy" conversation event, polls until the holder releases, then claims +
	 * gates + runs. A conversation event / stream write can only happen inside
	 * `execute`, which is why the whole post-`claimRun` sequence moves there on a
	 * conflict. The non-conflict path keeps its pre-stream gating unchanged. */
	let waitForClaim = false;
	/* The SA mode this chargeable POST claims as: `build` (no app yet / a
	 * build-mode instruction) flips `status`; `edit` (an existing built app)
	 * takes a `run_lock`. Only set for a chargeable existing-app claim. */
	let claimMode: "build" | "edit" | undefined;
	/* Set when this POST is a free-continuation resume (build OR edit): it must
	 * re-acquire (confirm ownership + renew the lease) the paused run it's resuming
	 * before running, or bail — the paused run's lease can lapse while the user
	 * answers and be REAPED, freeing the app for another run. Done inside `execute`
	 * (needs `ctx`), uniform across both paused shapes via `reacquireLease`. */
	let resumeMustCheckSupersede = false;
	if (!appId) {
		/* New builds land in the caller's active Project (shared resolver: the
		 * session's stamped activeOrganizationId, self-healing to the personal
		 * Project for pre-Projects sessions). Creating an app is a WRITE, so the
		 * caller must hold the active Project at EDIT — a viewer in a shared
		 * Project must not create apps there (resolveActiveProjectId only proves
		 * membership). An AppAccessError is a permission denial (403), not a save
		 * failure. */
		try {
			projectId = await resolveActiveProjectId(keyResult.session);
			await resolveProjectAccess(userId, projectId, "edit");
		} catch (err) {
			if (err instanceof AppAccessError) {
				return Response.json(
					{
						error: "You don't have permission to create apps in this Project.",
						type: "forbidden",
					},
					{ status: 403 },
				);
			}
			log.error("[chat] active-Project resolution failed", err);
			return Response.json(
				{
					error: "Unable to save app. Please try again shortly.",
					type: "internal",
				},
				{ status: 503 },
			);
		}
		try {
			appId = await createApp(userId, projectId, effectiveRunId);
			appCreated = true;
		} catch (err) {
			log.error("[chat] app creation failed", err);
			return Response.json(
				{
					error: "Unable to save app. Please try again shortly.",
					type: "internal",
				},
				{ status: 503 },
			);
		}
		/* Reserve the new build's credits — one transaction over the app row the
		 * create just wrote (the row itself is the claim: `createApp` writes it
		 * `generating` BEFORE this, so a second concurrent new build sees it in
		 * the in-transaction concurrency scan). Every rejection is a rollback:
		 * the concurrency cap and the out-of-credits arms fail the just-created
		 * doc; an infrastructure fault leaves the row `generating` for the
		 * reaper to refund-and-flip. */
		if (chargeable) {
			try {
				reservation = await reserveForNewBuild(
					appId,
					userId,
					cost,
					effectiveRunId,
				);
			} catch (err) {
				if (err instanceof GenerationInProgressError) {
					/* Awaited: the reserve rolled back, so this fresh `generating` row
					 * carries no marker — until it flips to `error` it reads as the
					 * user's own live build and blocks their next POST. */
					await failApp(appId, "generation_in_progress");
					return Response.json(
						{
							error: MESSAGES.generation_in_progress,
							type: "generation_in_progress",
						},
						{ status: 429 },
					);
				}
				if (err instanceof OutOfCreditsError) {
					await failApp(appId, "out_of_credits");
					return Response.json(
						{ error: MESSAGES.out_of_credits, type: "out_of_credits" },
						{ status: 429 },
					);
				}
				log.error("[chat] credit reservation failed", err);
				/* Infrastructure, not a balance problem — the message must not send
				 * the user chasing their allowance, and it asserts nothing about the
				 * charge (the transaction rolled back). */
				return Response.json(
					{
						error:
							"That message didn't go through. Please try again in a moment.",
						type: "internal",
					},
					{ status: 503 },
				);
			}
		}
	} else {
		/* Project-membership gate (edit) — apps are a root-level collection, so
		 * the path doesn't scope writes; without this a crafted request with
		 * another Project's appId could drive a build against it. The same
		 * authorization read yields the persisted app doc, so the SA's working
		 * doc seeds from `loadedApp.blueprint` below without a second fetch. */
		try {
			const access = await resolveAppAccess(appId, userId, "edit");
			loadedApp = access.app;
			projectId = access.projectId;
		} catch (err) {
			if (err instanceof AppAccessError) {
				return Response.json(
					{ error: "App not found", type: "not_found" },
					{ status: 404 },
				);
			}
			throw err;
		}
		if (chargeable) {
			/* EVERY chargeable POST against an existing app claims the run window
			 * AND reserves its credits in ONE transaction — a BUILD-mode
			 * instruction (`!appReady`) flips the row to `generating`; an EDIT
			 * (`appReady`) takes a `run_lock` without touching status. The claim is
			 * the per-app serialization lock, across BOTH modes (a build waits on a
			 * live edit-lock and vice versa, and on ANOTHER actor's PAUSED run of
			 * either mode — this user's own paused run is superseded by the claim
			 * instead, so an abandoned askQuestions round never locks them out);
			 * the cross-app concurrency cap and the affordability check run INSIDE
			 * the same transaction, so every rejection below is a rollback that
			 * held nothing.
			 *
			 * On a CONFLICT the route does not 429 — it defers the whole
			 * claim+reserve sequence into `execute` behind a poll-wait
			 * (`waitForClaim`), so a second collaborator's request serializes
			 * behind the holder instead of bouncing. */
			claimMode = parsed.data.appReady ? "edit" : "build";
			try {
				claimedRun = await claimAndReserveRun(
					appId,
					claimMode,
					effectiveRunId,
					userId,
					cost,
				);
				reservation = claimedRun.reservation;
			} catch (err) {
				if (err instanceof RunConflictError) {
					/* The app is held — wait inside the stream (below), don't reject. */
					waitForClaim = true;
				} else if (err instanceof GenerationInProgressError) {
					return Response.json(
						{
							error: MESSAGES.generation_in_progress,
							type: "generation_in_progress",
						},
						{ status: 429 },
					);
				} else if (err instanceof OutOfCreditsError) {
					return Response.json(
						{ error: MESSAGES.out_of_credits, type: "out_of_credits" },
						{ status: 429 },
					);
				} else {
					log.error("[chat] run claim failed", err, { appId });
					return Response.json(
						{
							error: "Unable to start this run. Please try again shortly.",
							type: "internal",
						},
						{ status: 503 },
					);
				}
			}
		} else {
			/* A free continuation (an answered-`askQuestions` auto-resend) resuming a
			 * PAUSED run (build OR edit). It must re-acquire that run before
			 * proceeding — a paused run's lease lapses while the user answers (no
			 * heartbeat during a pause), so it may have been REAPED and the freed app
			 * claimed by another run; resuming blindly would start a second SA loop on
			 * an app this POST no longer owns. The re-acquire (uniform across both
			 * shapes via `reacquireLease`) runs inside `execute` where `ctx` can emit
			 * the bail; on success it renews the lease + clears the pause flag in one
			 * txn — a superseded resume touches nothing (a pre-stream clear would
			 * unflag / re-pause an app this POST no longer owns). */
			resumeMustCheckSupersede = true;
		}
	}

	/* The paused-run resume's pause-flag clear does NOT happen pre-stream — it
	 * moves INSIDE `execute`, folded into `reacquireLease`'s success transaction,
	 * for BOTH modes. A SUPERSEDED resume (of either shape) must touch NOTHING on
	 * an app a co-member now owns: clearing `awaiting_input` there could flip the
	 * co-member's own live pause into a blocking lock, or unflag a run this POST
	 * doesn't own. `reacquireLease` clears the flag only on the owns-it branch, in
	 * the same txn that renews the lease. */

	/* Two collaborators:
	 *
	 *  - `logWriter` batches durable event envelopes into the events table (one
	 *    row per mutation/conversation event). Failures never throw.
	 *  - `usage` accumulates per-call token counts for the actual-$ ledger and
	 *    the per-run summary row, and carries this run's credit reservation
	 *    so a failed or no-op run can refund it. Flushed on every terminal path.
	 *
	 * The run-shape fields are seeded from what this POST already knows
	 * (`appReady` from the request, the
	 * authorization read's module count) and re-written via
	 * `usage.configureRun()` inside the execute block at their authoritative
	 * moment. The seed must be REAL, not placeholder: `prompt_mode` /
	 * `app_ready` are PINNED on the summary row by its first write, and a POST
	 * that dies before `configureRun` (a serialize-wait timeout) still flushes —
	 * a placeholder seed there would pin an edit thread's summary as a
	 * zero-module build. */
	/* Chat-surface writer — every event out of this route is stamped
	 * `source: "chat"`. The MCP endpoint constructs its own LogWriter
	 * with `source: "mcp"`; the writer is the single authority on the
	 * surface tag so the two cannot drift. */
	const logWriter = new LogWriter(appId, "chat");
	const usage = new UsageAccumulator({
		appId,
		userId,
		runId: effectiveRunId,
		// Must match the model `createSolutionsArchitect` picks off the same
		// signal (one model today; the constants stay separate so the roles
		// can diverge again).
		model: appReady ? SA_EDIT_MODEL : SA_BUILD_MODEL,
		promptMode: appReady ? "edit" : "build",
		appReady: !!appReady,
		moduleCount: loadedApp?.module_count ?? 0,
		/* Reservation context for the refund branch in `flush()`. All three travel
		 * together (a chargeable turn that reserved) or all absent (a free
		 * continuation, which never reserves). On the NON-conflict path
		 * `reservation` is already set (the claim reserved atomically pre-stream),
		 * so seed it here. On the serialize-with-wait path the reservation lands
		 * INSIDE `execute` (the poll loop winning `claimAndReserveRun`), so seed
		 * nothing now and set all three via `usage.configureRun` there — seeding a
		 * `didReserve` with no `chargePeriod` would leave the flush's refund gate
		 * half-armed. */
		didReserve: waitForClaim ? undefined : chargeable,
		reservedAmount: waitForClaim ? undefined : chargeable ? cost : undefined,
		chargePeriod: waitForClaim ? undefined : reservation?.period,
	});

	/* Mirror of the execute-local `finalized` latch, readable by execute's
	 * prelude-throw net (its `finally` sits outside the block `finalized` is
	 * scoped to). Set true whenever `finalizeRun` runs to completion; the net's
	 * stranded-lock release fires ONLY when this stayed false — i.e. the
	 * prelude threw before any `finalizeRun`. A run that DID finalize (clean /
	 * failed / paused) already made the correct lock decision (a paused edit
	 * deliberately KEEPS its lock), so the net must not second-guess it. */
	let finalizeRan = false;

	/* No `req.signal` disconnect handling: the run is no longer tied to the
	 * browser connection. The agent loop is drained server-side (see the execute
	 * block), so a closed tab neither cancels the run nor finalizes it — `flush()`
	 * runs once on the run's true terminal state regardless of whether anyone is
	 * still reading. A run the process can't finish (hard kill) is settled by the
	 * stale-`generating` reaper.
	 *
	 * The same rule bans `onEnd`/`onFinish` on this stream: the SDK fires them
	 * through the response stream's `cancel()` hook too, so a mid-run refresh
	 * would run that teardown while the agent is still streaming — sealing the
	 * chunk log and flushing a zero-usage accumulator against a live run, which
	 * refunds the charge, blinds the resume path, and no-ops the real finalize.
	 * Post-settle cleanup lives in execute's own `finally`, which by
	 * construction cannot run before the body settles. */
	const stream = createUIMessageStream({
		execute: async ({ writer: rawWriter }) => {
			/* The one write choke point: every chunk out of this request — SDK
			 * parts forwarded from the SA stream AND the route's own `data-*`
			 * events — rides this wrapper, which appends it to the durable chunk
			 * log (resume replays it) and forwards it to the live response
			 * (best-effort; a dead client stops forwarding, never logging).
			 * Closed by `finalizeRun` so the terminal row is durable before the
			 * response stream ends. */
			const writer = new DurableStreamWriter({
				streamId,
				appId,
				runId: effectiveRunId,
				inner: rawWriter,
			});
			try {
				// Send runId to client so it can send it back on subsequent requests
				writer.write({
					type: "data-run-id",
					data: { runId: effectiveRunId },
					transient: true,
				});

				/* Announce the freshly-minted appId to the client exactly once, on
				 * the request that created it, so a new build can promote its URL
				 * from `/build/new` to `/build/{appId}`. The client's handler for
				 * this event unconditionally rewrites the URL to `/build/{appId}`;
				 * emitting on edit requests would clobber any form/field selection
				 * segments (e.g. `/build/{id}/{formUuid}/{fieldUuid}`) that the
				 * user has already navigated into. This is a one-shot identity
				 * signal, not a save receipt — per-mutation persistence happens
				 * silently server-side inside the mutation tool handlers. */
				if (appCreated) {
					writer.write({
						type: "data-app-id",
						data: { appId },
						transient: true,
					});
				}

				const ctx = new GenerationContext({
					apiKey: keyResult.apiKey,
					writer,
					logWriter,
					usage,
					session: keyResult.session,
					appId,
					/* An EDIT run (chargeable claim OR free-continuation resume) holds a
					 * `run_lock`, so it heartbeats the lease off SA activity. A BUILD holds
					 * via `status` (no lock) → no heartbeat. `appReady` is the build-vs-edit
					 * signal. */
					editLease: !!appReady,
				});

				/* Latch so the refund toast fires at most once per run. */
				let refundSignalled = false;
				/* Finalize-once guard — see `finalizeRun`. */
				let finalized = false;
				/* Set once `upsertThreadTurn` persisted this POST's history onto the
				 * thread row (which also marked it live via `active_stream_id`).
				 * Gates the finalize-time response append + stream-marker clear:
				 * a POST that bailed before owning the run (serialize-wait timeout,
				 * lost resume) wrote no thread state and must not touch the row the
				 * true holder owns. */
				let threadPersisted = false;

				/**
				 * The single authoritative finalization — the charge-vs-refund credit
				 * decision plus persistence — run exactly once on the run's TRUE terminal
				 * state.
				 *
				 * Driven by the agent drain completing (below), NOT by an SDK callback: a
				 * model error surfaces as a UIMessage error chunk rather than a thrown
				 * rejection, and a zero-step error fires no agent callback at all, so
				 * keying finalize on the drain is what guarantees it runs (and the request
				 * never hangs waiting on a callback that never fires). A failed run marks
				 * itself failed and FLUSHES (handing the reservation back; actual $ still
				 * accrues so the backstop sees retry-spam), and only THEN flips the app to
				 * `error` — and only if the refund actually committed, so a stranded refund
				 * leaves the build `generating` for the reaper to retry. Idempotent via this
				 * guard and the accumulator's own `_finalized` latch.
				 *
				 * Settle/release is threaded on `paused` (`ctx.pausedOnInput()`): a run
				 * that PAUSED on `askQuestions` is alive (a later POST resumes it), so its
				 * kept charge must NOT be settled and an edit's `run_lock` must NOT be
				 * released — its marker is a live hold the resume's failure funnel may
				 * still refund. A clean, non-paused completion settles the kept charge (so
				 * the status-agnostic edit reaper can't claw it back) and releases an
				 * edit's lock (so the next serialize-with-wait waiter proceeds). A FAILED
				 * run releases the edit lock UNCONDITIONALLY (a failed edit routes here
				 * without entering the clean editing arm, so gating release on clean
				 * completion would strand the lock) — except a paused hold, which never
				 * reaches the failure funnel from a pause.
				 */
				const finalizeRun = async (
					failure?: { type: ErrorType },
					opts?: { paused?: boolean; heldApp?: boolean },
				): Promise<void> => {
					if (finalized) return;
					finalized = true;
					finalizeRan = true;
					/* Stop the wall-clock lease heartbeat the moment the run reaches a
					 * terminal state — the run is no longer live, so it must stop extending
					 * its own liveness horizon (a clean edit is about to release the lock; a
					 * paused run deliberately lets its horizon ride until resume — the
					 * heartbeat MUST stop here or an abandoned pause would never lapse for
					 * the reapers). Idempotent. Clearing the interval here is what keeps it
					 * from leaking. */
					ctx.stopRunLeaseHeartbeat();
					const paused = opts?.paused ?? false;
					/* Whether THIS POST owns the run holding the app. False only on the
					 * serialize-with-wait early returns (a timed-out waiter, or a
					 * post-claim gate bail that already released the claim): such a POST
					 * holds nothing — the app is still held by ANOTHER run — so it must
					 * NOT touch the reservation marker or `run_lock` (settling/clearing
					 * would break the true holder's refund + strand its lock). It still
					 * flushes usage + drains the log (below), both no-ops for a POST that
					 * reserved nothing. Every other terminal path — the drain-end finally,
					 * `failRun`, the paused arm — is a POST that owns or continues the
					 * holding run, so it defaults true. */
					const heldApp = opts?.heldApp ?? true;
					if (failure) usage.markRunFailed();
					await usage.flush();
					await logWriter.flush();
					if (failure && heldApp) {
						/* Failed-run terminal write — refund + settle the marker AND (for an
						 * EDIT) release the `run_lock`, ATOMICALLY (`settleAndRelease`). `flush`
						 * above already refunded a hold THIS POST booked; this settles a hold an
						 * EARLIER POST booked (askQuestions: an earlier chargeable POST reserves,
						 * a free continuation fails here) — it reads the hold off the marker, so
						 * it settles whichever POST booked it. Idempotent when flush already
						 * settled it. The atomicity is load-bearing: the `run_lock` is
						 * released ONLY inside the same commit that settles the marker, so
						 * "lock cleared + marker unsettled" (the state that stranded credits) is
						 * impossible — if the txn throws NOTHING changed (the lock stays for the
						 * reaper) and `settled` reports `false`. A build passes `releaseLock:
						 * false` (it has no lock). A failure never reaches here paused. */
						let refundSettled = true;
						try {
							({ settled: refundSettled } = await settleAndRelease(
								appId,
								effectiveRunId,
								{ releaseLock: !!appReady },
							));
						} catch (err) {
							refundSettled = false;
							log.error("[chat] failed-run settle+release failed", err, {
								appId,
							});
						}
						/* Flip to `error` only for a BUILD (the app is `generating`). A failed
						 * EDIT must NOT flip its already-`complete` app to `error`: that would
						 * brick a working app over a transient model error (the build page
						 * redirects non-`complete` apps; the list hides the open-link for
						 * `error`), leaving the user no path back to a blueprint that is fine on
						 * disk. The failed edit's hold is settled + lock released above; the
						 * error surfaces via the conversation event (`failRun`); the app stays
						 * open. `refundSettled` gates the build flip: an uncommitted settle
						 * leaves the build `generating` for the reaper to retry (mirroring
						 * `reapStaleGenerating`'s refund-before-flip). */
						if (refundSettled && !appReady) {
							failApp(appId, failure.type);
						}
					} else if (!failure && !paused && heldApp && appReady) {
						/* Clean, non-paused EDIT completion — release the `run_lock` AND
						 * settle the kept charge in ONE transaction (`clearRunLockAndSettle`).
						 * The atomicity is load-bearing: clearing the lock is what makes the
						 * edit claimable, so settling in the same commit closes the window
						 * where a run landing between a separate release + settle would see
						 * the still-unsettled marker and (per the unconditional leftover
						 * refund) claw back this edit's KEPT charge. Settles whatever hold is
						 * on the marker (the askQuestions flow is multi-POST). Best-effort: a
						 * failure logs and the reaper stays the backstop.
						 *
						 * A clean BUILD completion is NOT handled here — `completeAndSettleRun`
						 * in the drain-end build-finalize block already flipped status→complete
						 * AND settled atomically (a build has no `run_lock` to release), for the
						 * same window-closing reason. */
						try {
							await clearRunLockAndSettle(appId, effectiveRunId);
						} catch (err) {
							log.error("[chat] edit clean release+settle failed", err, {
								appId,
							});
						}
					}
					/* Terminate the durable chunk log LAST — every user-visible write on
					 * every terminal path (the failure funnel's error event + refund
					 * toast, the clean build's `data-done`) precedes its path's
					 * `finalizeRun` call, so the terminal row seals a complete stream. A
					 * resuming client then always reaches the synthetic/real `finish`
					 * instead of tailing a dead run until the liveness fallback. Awaited:
					 * execute must not resolve (closing the response) before the terminal
					 * row is durable. */
					await writer.close();

					/* Durable conversation history — append the assistant message this
					 * run streamed and clear the thread's live-stream marker, in one
					 * write. Assembled from the now-sealed chunk log (the single source
					 * of truth for what streamed, including retry closures), so the
					 * persisted message is byte-for-byte what a live client assembled.
					 * AFTER `writer.close()`: the log must be fully flushed to read it
					 * back. A paused (askQuestions) run appends its question round with
					 * the tool part still `input-available` — exactly what a refreshed
					 * page needs to re-render the interactive card. Best-effort: history
					 * persistence must never take down run finalization (the failure is
					 * error-logged; the thread converges on the next turn's upsert). */
					if (threadPersisted) {
						/* A history ending in an ASSISTANT message (an answered
						 * askQuestions round) streams its response as a CONTINUATION of
						 * that message — seed the assembly with it so the persisted
						 * transcript keeps ONE merged message, exactly as the client
						 * does. `streamId` scopes the marker clear to THIS run: the app
						 * was released above, so a competing POST may already own a
						 * fresh claim on this thread — its marker and turns must survive
						 * this late write (the append merges; it never rewrites). */
						const trailing = messages.at(-1);
						const responseMessage = await assembleResponseMessage(
							streamId,
							trailing?.role === "assistant" ? trailing : undefined,
						);
						/* One retry, then a marker-only fallback. The response text is
						 * best-effort history — but the MARKER must not survive a
						 * finalized run: a stranded `active_stream_id` on an at-rest app
						 * reads as an instance death on the next load, and the client
						 * auto-RE-DRIVES (re-claims, RE-CHARGES) a turn that already
						 * completed. The fallback clears just the marker (null response,
						 * same `streamId` guard) — the smallest write that closes that
						 * hole; if even that fails, the log line names the consequence
						 * for the operator. */
						let appended = false;
						for (let attempt = 0; attempt < 2 && !appended; attempt++) {
							try {
								await appendThreadResponse({
									appId,
									threadId,
									streamId,
									responseMessage,
								});
								appended = true;
							} catch (err) {
								log.error("[chat] thread response append failed", err, {
									appId,
									threadId,
									attempt,
								});
							}
						}
						if (!appended) {
							try {
								await appendThreadResponse({
									appId,
									threadId,
									streamId,
									responseMessage: null,
								});
							} catch (err) {
								log.error(
									"[chat] thread marker clear failed — a stranded marker will read as an instance death and re-drive this completed turn on the next open",
									err,
									{ appId, threadId },
								);
							}
						}
					}
				};

				/**
				 * Classify + surface a generation error, then finalize the run as failed —
				 * the single failure funnel for both an init/build throw and a streamed
				 * model error. Emits the classified error as a conversation event and, on a
				 * chargeable run, the optimistic `data-credit-refund` toast (the
				 * authoritative decrement lands in `flush()` inside `finalizeRun`).
				 */
				const failRun = async (
					error: unknown,
					source: string,
				): Promise<void> => {
					const classified = classifyError(error);
					ctx.emitError(classified, source);
					if (chargeable && !refundSignalled) {
						refundSignalled = true;
						/* `userId` names the CHARGED actor — a co-member replaying this
						 * run's stream (a shared thread's refresh-resume) must not be
						 * told THEIR credits were refunded. */
						writer.write({
							type: "data-credit-refund",
							data: { amount: cost, userId },
							transient: true,
						});
					}
					await finalizeRun(classified);
				};

				/**
				 * Persist a BAILED POST's incoming history before it closes. A bail
				 * (a serialize-wait gate rejection or timeout, a superseded resume)
				 * runs nothing and must not claim the thread — but its history is
				 * real client state: an answered askQuestions round exists only in
				 * the client's memory until a write lands, and every bail message
				 * tells the user to refresh, which would erase it. Merge-only: the
				 * thread's `run_id` / live-stream marker belong to the run that owns
				 * the app and are not touched. (The RE-DRIVE bail deliberately skips
				 * this — its history is the same unanswered turn the winning
				 * re-drive already persisted when it claimed.)
				 */
				const persistBailedHistory = async (): Promise<void> => {
					try {
						await mergeThreadTurnMessages({ appId, threadId, messages });
					} catch (err) {
						log.error("[chat] bail-path history merge failed", err, {
							appId,
							threadId,
						});
					}
				};

				/* Serialize-with-wait — the pre-stream claim CONFLICTED (another run
				 * holds this app). Rather than 429, poll `claimAndReserveRun` until the
				 * holder releases (or the wait times out). Each poll attempt is the
				 * whole atomic claim+reserve, so a win arrives fully gated (concurrency
				 * + affordability) and a rejection held nothing. This lives inside the
				 * stream (a conversation event / error can only be written here). A
				 * successful claim sets `claimedRun` + `reservation`, so the rest of
				 * `execute` runs exactly as the non-conflict path does. */
				if (waitForClaim && claimMode) {
					/* A RE-DRIVE that lost the claim race bails instead of queueing:
					 * the conflict means another session already re-drove this turn
					 * (or a real run holds the app), and a serialize-wait winner would
					 * RE-RUN the same turn — a second charge for a duplicate response.
					 * The clean close (the durable writer seals a terminal `finish`)
					 * ends the client's send; its post-close heal re-fetches the
					 * thread and attaches to whatever the winner is streaming. */
					if (parsed.data.redrive) {
						log.info("[chat] re-drive lost the claim race — bailing clean", {
							appId,
							threadId,
						});
						await finalizeRun(undefined, { heldApp: false });
						return;
					}
					/* A same-actor conflict is real (the requester's OWN still-running
					 * request from another tab, or one whose tab they closed — a closed
					 * tab neither cancels nor finalizes a run), and naming the user to
					 * themselves reads as a phantom collaborator. Their own PAUSED run
					 * never reaches here — the claim supersedes it. Re-resolved per
					 * message rather than captured once: the holder can change while we
					 * wait (a release + another claim), and the timeout toast two
					 * minutes in must not name a long-gone holder. */
					const holderLabel = async (): Promise<string> => {
						const holder = await loadAppHolder(appId);
						return holder.userId === userId
							? "your previous request"
							: `${holder.name}'s request`;
					};
					/* User-visible busy indicator: a non-fatal (recoverable) conversation
					 * event the client toasts + shows in the signal panel, so the waiter
					 * sees WHY nothing is happening yet. `recoverable: true` renders it as
					 * a warning, not an error — the request hasn't failed, it's queued
					 * behind the holder. (A `data-phase` pulse was tried here but no client
					 * reducer renders it — this conversation event IS the busy signal.) */
					ctx.emitError(
						{
							type: "generation_in_progress",
							message: `Waiting — ${await holderLabel()} is still running on this app. Only one request runs at a time; this one will start automatically when it finishes.`,
							recoverable: true,
						},
						"route:serialize-wait",
					);

					const deadline = Date.now() + CLAIM_WAIT_MAX_MS;
					let claimError: unknown;
					/* A gate rejection from a WON poll (concurrency cap / out of credits)
					 * — terminal for this POST, and it held nothing (the claim+reserve
					 * transaction rolled back). */
					let gateBail:
						| {
								type: "generation_in_progress" | "out_of_credits";
								message: string;
						  }
						| undefined;
					while (Date.now() < deadline) {
						await new Promise((r) => setTimeout(r, CLAIM_WAIT_POLL_MS));
						try {
							claimedRun = await claimAndReserveRun(
								appId,
								claimMode,
								effectiveRunId,
								userId,
								cost,
							);
							reservation = claimedRun.reservation;
							break;
						} catch (err) {
							if (err instanceof RunConflictError) continue; // still held — keep waiting
							if (err instanceof GenerationInProgressError) {
								gateBail = {
									type: "generation_in_progress",
									message: MESSAGES.generation_in_progress,
								};
								break;
							}
							if (err instanceof OutOfCreditsError) {
								gateBail = {
									type: "out_of_credits",
									message: MESSAGES.out_of_credits,
								};
								break;
							}
							claimError = err;
							break;
						}
					}

					if (gateBail) {
						ctx.emitError(
							{
								type: gateBail.type,
								message: gateBail.message,
								recoverable: false,
							},
							"route:serialize-wait-gate",
						);
						await persistBailedHistory();
						await finalizeRun(undefined, { heldApp: false });
						return;
					}

					if (!claimedRun) {
						/* Timed out still-busy, or the claim write itself faulted. Emit a
						 * friendly close and end — nothing was claimed or reserved, so
						 * there is no window to restore and no charge to refund. The
						 * `finally` still flushes (a no-op refund) + drains the log. */
						if (claimError) {
							log.error(
								"[chat] serialize-wait claim write failed",
								claimError,
								{
									appId,
								},
							);
						}
						ctx.emitError(
							{
								type: claimError ? "internal" : "generation_in_progress",
								message: claimError
									? "Couldn't start your request just now. Please try again shortly."
									: `Still busy — ${await holderLabel()} is taking a while. Please try again in a moment.`,
								recoverable: false,
							},
							"route:serialize-wait-timeout",
						);
						/* Held nothing (never won the claim) — flush + log only, and do NOT
						 * touch the marker/lock (the app is still held by the OTHER run). */
						await persistBailedHistory();
						await finalizeRun(undefined, { heldApp: false });
						return;
					}

					/* Won the claim after waiting — the win arrived fully gated and
					 * reserved (the claim+reserve transaction is atomic). Tell the
					 * accumulator so the flush-time refund/settle targets the right
					 * period (the seed left these unset for the wait path). A free
					 * continuation never reaches here (it doesn't claim), so `chargeable`
					 * is the didReserve signal. */
					usage.configureRun({
						didReserve: chargeable,
						...(chargeable ? { reservedAmount: cost } : {}),
						...(reservation ? { chargePeriod: reservation.period } : {}),
					});

					/* A held app may have advanced while we waited (the prior holder
					 * committed batches), so re-read the persisted blueprint for the SA's
					 * seed rather than trusting the pre-wait `loadedApp`. */
					try {
						const fresh = await loadApp(appId);
						if (fresh) loadedApp = fresh;
					} catch (err) {
						log.error("[chat] serialize-wait blueprint reload failed", err, {
							appId,
						});
					}
				}

				/* Paused-run resume re-acquire — UNIFORM across both modes. A
				 * free-continuation resume of a paused run (build OR edit) must still OWN
				 * that run AND renew its liveness horizon before proceeding: a paused run's
				 * lease lapses while the user answers (no heartbeat during a pause), so it
				 * may have been REAPED and the freed app claimed by another run.
				 * `reacquireLease` does BOTH atomically — asserts ownership
				 * (`runLeaseState().ownedByResume`, keyed on the resume's own mode), and on
				 * success re-establishes the mode's horizon (edit → renew
				 * `run_lock.expireAt`; build → re-arm `updated_at`) AND clears
				 * `awaiting_input` in the SAME transaction, so a resume RENEWS its lease
				 * rather than proceeding on an already-lapsed one and being reaped mid-run.
				 * If superseded (returns `false`), it touched NOTHING and we BAIL gracefully
				 * rather than start a second SA loop on an app it no longer owns.
				 * Nothing was claimed/reserved on this free continuation, so
				 * `heldApp: false` keeps the finalize from touching the holder's state. A
				 * transient failure fails OPEN (proceed): the solo-editor resume is the
				 * common case, and the guarded per-commit writer stays the backstop. */
				if (resumeMustCheckSupersede) {
					const resumeMode = appReady ? "edit" : "build";
					let reacquire: ReacquireOutcome = "owned";
					try {
						reacquire = await reacquireLease(appId, effectiveRunId, resumeMode);
					} catch (err) {
						log.error("[chat] resume reacquire failed", err, { appId });
					}
					if (reacquire !== "owned") {
						/* The lost shapes read very differently to the person answering, so
						 * tell the truth per shape: "superseded" means another run actually
						 * holds the app now — the requester's OWN newer request (a paused
						 * round the same actor's claim superseded) or a co-member's;
						 * "released" means the run simply timed out waiting and a scan
						 * reaped it (refund + free) with no re-claim. The holder read is a
						 * best-effort projection for the message only. */
						let superseded: { type: ErrorType; message: string } | undefined;
						if (reacquire === "superseded") {
							const holder = await loadAppHolder(appId);
							superseded = {
								type: "generation_in_progress",
								message:
									holder.userId === userId
										? "You started a newer request on this app, so this answer round was superseded. Continue from your newer conversation."
										: "Someone else started working on this app while you were answering, so this request was superseded. Refresh to pick up their changes, then try again.",
							};
						}
						ctx.emitError(
							superseded
								? { ...superseded, recoverable: false }
								: {
										type: "run_released",
										message:
											"This run waited for your answer longer than its window allows, so it was released and its hold was refunded. Refresh to get the latest state, then send your answer again.",
										recoverable: false,
									},
							superseded ? "route:resume-superseded" : "route:resume-released",
						);
						await persistBailedHistory();
						await finalizeRun(undefined, { heldApp: false });
						return;
					}
					/* `reacquireLease` already cleared `awaiting_input` + renewed the lease
					 * in its transaction (only when ownership held), so a superseded resume
					 * never touched the app a co-member now owns. No separate pause-clear. */
				}

				/* Every path past this point OWNS the run (pre-stream claim,
				 * serialize-wait win, or re-acquired resume) — persist the turn onto
				 * its thread NOW: the full incoming history (already carrying the new
				 * user turn / answered askQuestions parts) plus the live-stream marker
				 * (`active_stream_id` = this POST's chunk-log stream). From this write
				 * on, a page refresh hydrates the user's turn and reconnects to the
				 * run by THREAD id. Rejection paths above never CLAIM the thread —
				 * `run_id` and the live-stream marker stay the owning run's — but
				 * they do merge the incoming messages (`persistBailedHistory`) so an
				 * answered question round survives the refresh their bail messages
				 * recommend.
				 * `false` means the id belongs to another app (the pre-stream guard
				 * catches this before any claim; this is the structural backstop) —
				 * surfaced as a failed run rather than silently streaming a
				 * conversation that will never persist. */
				try {
					threadPersisted = await upsertThreadTurn({
						appId,
						threadId,
						runId: effectiveRunId,
						streamId,
						threadType: appReady ? "edit" : "build",
						messages,
					});
				} catch (err) {
					log.error("[chat] thread turn upsert failed", err, {
						appId,
						threadId,
					});
				}
				if (!threadPersisted) {
					/* A run whose conversation can't persist still runs — the doc
					 * commits inline and the event log records everything — but say so
					 * where an admin will find it. (The cross-app forgery case never
					 * reaches here; the 400 guard handled it pre-claim.) */
					log.warn("[chat] thread row not persisted; history will not resume", {
						appId,
						threadId,
					});
				}

				/* Build the SA's working doc. For an existing app the seed is the
				 * SAVED blueprint (`loadedApp.blueprint`, the persistable slice with
				 * no `fieldParent`), loaded off the authorization read above — never
				 * shipped per-turn from the client. We deep-clone so in-flight
				 * mutations never touch the loaded doc, then rebuild the
				 * reverse-parent index the SA's mutation helpers rely on.
				 *
				 * Freshness: the saved blueprint is current at send time without any
				 * flush primitive. The mutation-only auto-save persists builder edits
				 * within ~1.3s of the edit settling, and a chat send follows
				 * message-typing (longer than that), so a typed send always reads a
				 * settled doc. A code path that fires a chat turn programmatically
				 * IMMEDIATELY after an edit (with no typing in between) would be the
				 * one case that could outrun the auto-save and need a flush.
				 *
				 * Brand-new builds get the empty doc stamped with the
				 * `appId` that `createApp` just minted. */
				const sessionDoc: BlueprintDoc = hydratePersistedBlueprint(
					loadedApp
						? (loadedApp.blueprint as PersistableDoc)
						: {
								appId,
								appName: "",
								connectType: null,
								caseTypes: null,
								modules: {},
								forms: {},
								fields: {},
								moduleOrder: [],
								formOrder: {},
								fieldOrder: {},
							},
				);
				/* Hydrate the reference index alongside — the SA's tool layer
				 * answers "who references / declares X" through it (retirement
				 * planning, rename verdicts, the rename cascade) from the first
				 * tool call. */
				ensureReferenceIndex(sessionDoc);

				/* Persist the current request's user message as the first
				 * conversation event of the run. Emitting through the context
				 * (rather than directly via `logWriter.logEvent`) keeps seq
				 * management inside a single counter — the context owns seq,
				 * and every subsequent event (mutations, assistant text, tool
				 * calls) naturally follows from seq=1.
				 *
				 * `isTextUIPart` is the AI SDK's own type guard over `UIMessage.parts`,
				 * which narrows each part to `TextUIPart` (with `text: string`
				 * required, not optional). Using the guard replaces inline
				 * structural types with a single source of truth that tracks
				 * SDK updates automatically.
				 *
				 * Log the user's TYPED text + the attachment manifest from the ORIGINAL
				 * message (pre-resolve): the resolved extract bodies are large and live
				 * durably on the asset, so re-inlining them in the log adds bloat, not
				 * value. */
				const lastMessage = messages.at(-1);
				if (lastMessage?.role === "user") {
					const text = lastMessage.parts
						.filter(isTextUIPart)
						.map((p) => p.text)
						.join("\n");
					const attachments = lastMessage.metadata?.attachments;
					/* Guarded the way `GenerationContext.emitError` guards its own
					 * conversation write: this call runs BEFORE the main try below, so an
					 * escaping throw would skip the `finally` and leak the credit
					 * reservation (no flush → no refund of a run that never started). A
					 * failed user-message log is non-fatal to the request — log it and
					 * proceed; the SA still runs and the reservation still finalizes. */
					try {
						ctx.emitConversation({
							type: "user-message",
							text,
							...(attachments && attachments.length > 0 ? { attachments } : {}),
						});
					} catch (err) {
						log.error("[chat] user-message conversation event failed", err);
					}
				} else if (lastMessage) {
					/* The answered-askQuestions auto-resend: the last message is the
					 * ASSISTANT message whose askQuestions tool part now carries the
					 * user's answers as its output. The SA's own step handler only logs
					 * results produced by live steps, and askQuestions has no execute —
					 * its result exists only in this incoming history — so this is the
					 * one place the answers can be logged. Paired to the original
					 * tool-call event by toolCallId.
					 *
					 * Only the FINAL step's parts are new this turn: consecutive
					 * question rounds append to the same trailing assistant message
					 * (`toUIMessageStream({ originalMessages })` continues it), so an
					 * earlier round's answered part is still `output-available` here —
					 * but it was harvested on the POST that answered IT. askQuestions
					 * stalls its run, so an answered round always sits after the
					 * message's last `step-start`; scoping to that suffix logs each
					 * round exactly once. Guarded like the user-message write above:
					 * a failed log is non-fatal. */
					const lastStepStart = lastMessage.parts.reduce(
						(idx, part, i) => (part.type === "step-start" ? i : idx),
						-1,
					);
					let answeredQuestions = 0;
					for (const part of lastMessage.parts.slice(lastStepStart + 1)) {
						if (
							part.type === "tool-askQuestions" &&
							"state" in part &&
							part.state === "output-available"
						) {
							answeredQuestions++;
							try {
								ctx.emitConversation({
									type: "tool-result",
									toolCallId: part.toolCallId,
									toolName: "askQuestions",
									output: part.output ?? null,
								});
							} catch (err) {
								log.error(
									"[chat] askQuestions answer conversation event failed",
									err,
								);
							}
						}
					}
					if (answeredQuestions === 0) {
						/* Defensive — a trailing assistant message should be an answered
						 * question round; a caller bypassing the client could send a
						 * malformed history that would silently drop its event. Warn so
						 * the skip is visible; the request still proceeds. */
						log.warn(
							"[chat] trailing assistant message carries no answered askQuestions round; no conversation event",
							{
								role: lastMessage.role,
							},
						);
					}
				}

				try {
					/* Editing vs. build — determined by appReady alone. If the app
					 * exists (builder phase Ready/Completed), the SA gets the editing
					 * prompt + medium reasoning effort; a build gets the build prompt
					 * at the xhigh ceiling. This holds for the entire edit session,
					 * including follow-up requests after askQuestions rounds. appReady
					 * is false during initial generation even after modules exist, so
					 * a build's follow-up turns keep build mode mid-build. */
					const editing = !!appReady;
					const saModel = editing ? SA_EDIT_MODEL : SA_BUILD_MODEL;

					/* Backfill the accumulator seed now that we know the real
					 * editing signals. These fields land on the per-run
					 * summary doc via `usage.flush()` — replaces the deleted
					 * `logger.logConfig` call (ConfigEvent removed in T3). */
					usage.configureRun({
						promptMode: editing ? "edit" : "build",
						appReady: editing,
						moduleCount: sessionDoc.moduleOrder.length,
					});

					const sa = createSolutionsArchitect(ctx, sessionDoc, editing);

					/* Start the wall-clock run-lease heartbeat now the run is live — an
					 * edit refreshes its `run_lock` lease, a build re-arms its `updated_at`
					 * staleness clock. It guarantees a run that sits in a single long model
					 * turn (or a long no-commit stretch) with no intermediate step-finish
					 * still refreshes its liveness horizon, so a LIVE run can't lapse and
					 * be reaped mid-run. Stopped in `finalizeRun` (the finally always runs
					 * it — a paused run must stop beating so an abandoned pause lapses for
					 * the reapers); the timer is `.unref()`ed so it never keeps the process
					 * alive. */
					ctx.startRunLeaseHeartbeat();

					/* The SA receives the FULL conversation history, every turn. The old
					 * expired-cache one-shot trim (edit + lapsed prompt cache → last user
					 * message only) is retired: threads resume across page loads and
					 * days now, and a resumed conversation the SA can't see isn't a
					 * conversation. A cold-cache turn pays one cache re-write — the
					 * price of the chat behaving like a chat. */
					const messagesToSend = messages;

					/* Resolve attachment references into model-ready content BEFORE the SA.
					 * The composer sends asset-id refs in message metadata; this appends,
					 * per ref, the stored requirements extract (documents, read once at
					 * upload and reused every turn) or the image bytes (vision). The lazy
					 * backstop extracts through `ctx` (usage-tracked) when a referenced
					 * document has no current extract yet. Kept INSIDE this try so a
					 * resolution failure funnels through `failRun` (refunding the
					 * reservation) rather than escaping as an unhandled stream error.
					 *
					 * Bracket the resolve with `attachment-prep` lifecycle events so the
					 * signal grid can show a "reading documents" status — but ONLY when a
					 * document still needs reading: an already-extracted doc resolves from
					 * its stored extract instantly and must not flash the status (an image /
					 * doc-free turn does no narrate-worthy work either). The events also land
					 * in the run log as run annotations, not chat-visible content. */
					const docsToReadCount = countDocumentsNeedingRead(messagesToSend);
					if (docsToReadCount > 0) {
						ctx.emitConversation({
							type: "attachment-prep",
							phase: "start",
							count: docsToReadCount,
						});
					}
					const preparedMessages = await resolveAttachments(
						messagesToSend,
						// The app's Project scopes attachment resolution — a chat document
						// lives in the Project it was uploaded under (the composer stamps
						// it). Set in both the new-build + existing-app branches above;
						// `loadedApp.project_id` is the existing-app fallback.
						projectId ?? loadedApp?.project_id ?? "",
						ctx,
						// Pulse the signal grid with real read progress while a
						// not-yet-extracted document is read here. `transient` keeps these
						// frequent parts off the persisted thread + event log — they're
						// energy, not content. Fires only when the backstop actually runs the
						// model (a reused eager extraction emits nothing); the "Reading your
						// documents" status still shows either way.
						(delta) =>
							writer.write({
								type: "data-extract-progress",
								data: { delta },
								transient: true,
							}),
					);
					if (docsToReadCount > 0) {
						ctx.emitConversation({ type: "attachment-prep", phase: "done" });
					}

					/* Repair deploy-crossing histories BEFORE validation: drop tool
					 * parts naming a tool absent from THIS request's tool set (the
					 * provider would reject the whole request — "tool not found in
					 * tools array") AND parts whose recorded input the current
					 * schema no longer parses (a deploy that narrowed a `.strict()`
					 * tool input — `validateUIMessages` below would throw,
					 * fail+refund the run, and re-poison every retry with the same
					 * history). The full contract, the drop semantics, and the
					 * validation mirror live on `sanitizeHistoricalToolParts`. The
					 * repair runs on EVERY turn: every request sends full history,
					 * and resumed threads routinely carry parts recorded under
					 * earlier deploys — or under the OTHER tool set entirely (an
					 * edit turn continuing a build thread drops the generation-tool
					 * parts; the dialogue survives). Keyed on `sa.tools` so
					 * the filter never drifts from the active set. */
					const sanitizedMessages = await sanitizeHistoricalToolParts(
						preparedMessages,
						sa.tools,
					);

					/* Apply the reasoning-part wire contract AFTER the tool repair
					 * (what pairing survives depends on which tool parts did):
					 * historical assistant messages drop their reasoning parts —
					 * prior-turn reasoning is ignored server-side, bills as input
					 * every turn, and is model-bound (one model change would 400
					 * every old thread) — while a trailing answered-askQuestions
					 * continuation keeps its reasoning (the wire REQUIRES it beside
					 * the function call whose output this turn submits) unless the
					 * pause crossed a model change, in which case the round rides as
					 * plain dialogue text. Contract + sources on the module. */
					const effectiveMessages = sanitizeHistoricalReasoningParts(
						sanitizedMessages,
						saModel,
					);

					/* Record the input-context composition for the per-run finalize
					 * log: how many messages were actually sent (after the sanitizer's
					 * drops + the resolve) and their serialized size. The
					 * system prompt is ~constant, so this is the variable part of the
					 * per-request input cost — the lever the cost investigation needs
					 * visibility into. */
					usage.configureRun({
						sentMessageCount: effectiveMessages.length,
						sentMessageChars: JSON.stringify(effectiveMessages).length,
					});

					/* Run the agent to completion SERVER-SIDE, decoupled from the browser.
					 * We use `agent.stream` + its primitives rather than `createAgentUIStream`
					 * so we hold the `StreamTextResult`: `consumeStream()` drains the tool
					 * loop to its terminal state even with no reader, so a closed tab no
					 * longer stalls the build via response backpressure and finalization keys
					 * off the drain rather than the browser connection. The UIMessage handling
					 * replicates `createAgentUIStream` exactly — validate against the SA's
					 * tools, convert to ModelMessages, and thread the validated set back as
					 * `originalMessages` (the response-message-id continuity the client
					 * relies on). */
					// The explicit `InferAgentUIMessage<typeof sa>` type arg is what
					// `createAgentUIStream` gets for free from being generic over the
					// agent's tools: it gives `validateUIMessages` the SA's exact tool
					// set (incl. client-side tools with no `execute`, like
					// `askQuestions`), which the route's base `UIMessage[]` doesn't carry.
					const validated = await validateUIMessages<
						InferAgentUIMessage<typeof sa>
					>({
						messages: effectiveMessages,
						tools: sa.tools,
					});
					const baseModelMessages = await convertToModelMessages(validated, {
						tools: sa.tools,
					});

					/* The turn runs inside a bounded TRANSIENT-failure re-run loop: a
					 * provider fault mid-generation (a 500 halfway through a step, a
					 * dropped provider connection) re-drives the SAME turn — same POST,
					 * same claim + lease + charge, same open stream — instead of failing
					 * the run and making the user retry by hand. This is safe because it
					 * IS the manual retry, performed early: every tool batch committed
					 * inline before the failure (nothing is lost or replayed), the SA
					 * continues against that committed doc, and the validity gate rejects
					 * duplicate structural work at commit — the same guarantees a user's
					 * own re-send has always relied on. Non-transient failures
					 * (`shouldRetryTurn`) and deauthorized runs never loop. Each retry
					 * appends ONE continuation message carrying the committed-state
					 * summary to the UNCHANGED base prompt (cache-friendly; never
					 * stacked), and surfaces on the wire + event log as a RECOVERABLE
					 * conversation event — visible in admin inspect, invisible as a
					 * failure to the user. */
					let pendingError: unknown;
					let sawFatalError = false;
					let turnRetries = 0;
					/* Mirrors the client's part-lifetime state over the forwarded chunks
					 * so a retried attempt can CLOSE the aborted attempt's dangling parts
					 * (`closures()` below) — the client accumulates the whole response
					 * into one assistant message, so without explicit closure a text
					 * part interrupted mid-stream renders stuck-streaming above the
					 * retried answer, live and on every replay. */
					const openParts = createOpenPartTracker();
					for (;;) {
						pendingError = undefined;
						sawFatalError = false;
						/* The attempt's `finish` chunk, held back until the retry decision:
						 * whether an errored stream emits one is SDK-internal, and
						 * forwarding attempt N's finish before re-running would put TWO
						 * finish chunks on one response — the client finalizes on the
						 * first. Written through on every non-retry exit, so a clean turn's
						 * wire is byte-identical to before. */
						let heldFinish: Parameters<typeof writer.write>[0] | undefined;

						/* A RE-DRIVE gets the retry continuation on its FIRST attempt too:
						 * the dead run's committed work is already in the doc (its tool
						 * transcript died with it), so without the committed-state message
						 * the SA re-plans from the conversation and burns its early calls
						 * re-creating work the validity gate then rejects. Same recovery
						 * shape as the in-route retry — attempt-N's retry continuation
						 * (built from the run's own latest commit) supersedes it. */
						const continuation =
							turnRetries > 0
								? (() => {
										const committed = ctx.latestPersistedDoc();
										return committed
											? buildTurnRetryContinuation(committed)
											: null;
									})()
								: parsed.data.redrive
									? buildTurnRetryContinuation(sessionDoc, "redrive")
									: null;
						const result = await sa.stream({
							prompt: continuation
								? [...baseModelMessages, continuation]
								: baseModelMessages,
						});

						/* Drive the drain UN-awaited so the loop advances to its terminal state
						 * even when the forward loop below stalls (client gone). Awaiting it
						 * before forwarding would buffer the whole run and kill live streaming.
						 * Swallow its rejection — a failure surfaces as the UI error chunk below,
						 * not as a thrown drain. */
						const drained = Promise.resolve(result.consumeStream()).catch(
							() => {},
						);

						/* Forward model chunks to the client AND detect a FATAL run failure in
						 * one pass. A model/stream error arrives as a `{ type: "error" }` chunk
						 * (never a throw), so the failure signal is THAT chunk, not merely
						 * `onError` firing. `onError` also fires for `tool-input-error` /
						 * `tool-output-error` chunks (a bad tool call, or a tool `execute()` throw)
						 * that the SA loop recovers from and the run completes past, so keying
						 * failure on any `onError` would wrongly fail a successful run (see
						 * `isFatalStreamErrorChunk`). We stash the latest `onError` value, then
						 * commit it as the fatal error only when the terminal `"error"` chunk
						 * arrives. Nova surfaces the error via `ctx.emitError`, so the raw fatal
						 * chunk is dropped; tool-error chunks forward like any other. A gone
						 * client never surfaces here: the durable writer absorbs the failed
						 * live forward internally and keeps appending to the chunk log — which
						 * is exactly what a later resume replays — so this loop runs to the
						 * stream's end either way (the catch is a last-resort guard). */
						for await (const chunk of result.toUIMessageStream({
							originalMessages: validated,
							/* Stamp the producing model on the assistant message (rides the
							 * `start` chunk into the client, the chunk log, and the thread
							 * transcript). `sanitizeHistoricalReasoningParts` reads it on
							 * later turns to decide whether a paused round's reasoning is
							 * still replayable — encrypted reasoning is model-bound. */
							messageMetadata: ({ part }) =>
								part.type === "start" ? { model: saModel } : undefined,
							onError: (error) => {
								pendingError = error;
								return error instanceof Error ? error.message : String(error);
							},
						})) {
							if (isFatalStreamErrorChunk(chunk.type)) {
								sawFatalError = true;
								continue;
							}
							if (chunk.type === "finish") {
								heldFinish = chunk;
								continue;
							}
							/* A retried attempt continues the SAME assistant message (the
							 * client keeps one accumulating message per response), so its
							 * fresh `start` — carrying a new message id that would strand
							 * the first attempt's content under the old id — is dropped;
							 * everything else appends after the closures written below. */
							if (chunk.type === "start" && turnRetries > 0) continue;
							openParts.observe(chunk);
							try {
								writer.write(chunk);
							} catch {
								break;
							}
						}

						/* Block on the drain so finalization runs on the run's TRUE terminal
						 * state even if forwarding broke off early when the client left. */
						await drained;

						/* Clean, paused, or deauthorized — the post-loop arms own all three.
						 * A deauthorized run must never re-drive (the retry would run more
						 * gated commits as an actor who lost access), and neither must a
						 * PAUSED one: `pausedOnInput` is a one-way latch, so an
						 * askQuestions round that completed before a trailing transient
						 * error must keep today's semantics (the failure funnel) rather
						 * than carry a stale pause latch into a retried attempt — a clean
						 * attempt 2 would then wrongly park a finished run as
						 * awaiting-input. */
						if (!sawFatalError || ctx.reauthError() || ctx.pausedOnInput()) {
							if (heldFinish !== undefined) writer.write(heldFinish);
							break;
						}
						const classified = classifyError(
							pendingError ??
								new Error("The generation stream ended in an error."),
						);
						if (!shouldRetryTurn(classified, turnRetries)) {
							/* Exhausted or non-transient — the failure funnel takes it from
							 * here. Restore the held finish first so the failing wire matches
							 * the pre-retry-loop encoding exactly. */
							if (heldFinish !== undefined) writer.write(heldFinish);
							break;
						}
						turnRetries += 1;
						/* Close the aborted attempt's dangling parts BEFORE anything else
						 * lands on the wire: the transcript then reads as a step that
						 * stopped cleanly, followed by the retried step — nothing stuck
						 * in a streaming state, live or on replay. (The held finish is
						 * deliberately discarded — the message is not done.) */
						for (const closure of openParts.closures()) {
							writer.write(closure);
						}
						/* Recoverable, not fatal: renders as a warning in the signal panel
						 * and lands in the event log with the REAL classified type — the
						 * admin-inspect breadcrumb for diagnosing in-flight provider
						 * faults. The user-facing message says work is preserved. */
						ctx.emitError(
							{ ...classified, message: TURN_RETRY_MESSAGE, recoverable: true },
							"route:turn-retry",
						);
						await new Promise((r) =>
							setTimeout(r, turnRetryDelayMs(turnRetries)),
						);
					}

					/* A guarded commit that threw `CommitReauthError` (the actor lost
					 * edit access mid-run) is a FATAL run failure that must take
					 * precedence over the clean-completion writers (`completeAndSettleRun` / `clearRunLockAndSettle`) / `awaiting_input` / the edit arm — a
					 * deauthorized run must refund and end in `error`, never report
					 * success and keep its charge. The AI SDK turns the tool `execute()`
					 * throw into a NON-fatal chunk (so `sawFatalError` stays false), which
					 * is why the context flag, not the stream, carries the signal. */
					const reauthErr = ctx.reauthError();
					if (sawFatalError || reauthErr) {
						await failRun(
							reauthErr ??
								pendingError ??
								new Error("The generation stream ended in an error."),
							reauthErr ? "route:reauth" : "route:stream",
						);
					} else if (ctx.pausedOnInput()) {
						/* The run paused on an `askQuestions` round (awaiting the user's
						 * answer) rather than finishing. Mark the build `awaiting_input` so the
						 * staleness reaper skips it — it's alive, not hard-killed, and a later
						 * POST will resume it. The charge stands (the clean finally's
						 * `finalizeRun()` flushes it); the flag is cleared when that POST
						 * resumes the run. */
						await setAwaitingInput(appId, true);
					} else if (editing) {
						/* Tripwire, not a gate: with every committed batch gated against
						 * introducing findings, an edit run that ends with a NEW
						 * completeness finding is unreachable except through a bug — the
						 * warn is how one would surface in production. */
						ctx.warnIfEditRunIncomplete();
						/* An edit run can land case-type records (`generateSchema`
						 * declaring a new type), and the chat surface's inline guarded
						 * commits never touch Postgres — so sync the case-store schemas
						 * here, the same "any case-store action after a commit sees a
						 * synced schema" contract the build arm holds. Idempotent upsert;
						 * `materializeCaseStoreSchemas` swallows a TRANSIENT blip and
						 * RETHROWS a DETERMINISTIC fault. Unlike the build arm, an edit
						 * does NOT fail the run on that throw: the edit's blueprint already
						 * committed (awaited, durable) and its 5-credit charge stands, so a
						 * deterministic schema fault is logged at `error` (Sentry-visible)
						 * but the run stays successful — the case-store consumers self-heal
						 * a MISSING (`SchemaNotSyncedError`) / STALE-drift
						 * (`CasePropertiesValidationError` with `additionalProperty`) row at
						 * the point of use (`withSchemaHeal`). */
						const editDoc = ctx.latestPersistedDoc();
						if (editDoc) {
							// Every commit was awaited inline through `commitGuardedBatch`,
							// so `latestPersistedDoc()` is already durable — no save chain
							// to drain. `syncedSeq` is the committed seq of THAT doc (feeds
							// the monotone `synced_seq` gate, so a concurrent additive sync
							// converges rather than clobbers).
							const editSeq = ctx.latestCommittedSeq();
							try {
								await materializeCaseStoreSchemas({
									appId,
									blueprint: toPersistableDoc(editDoc),
									...(editSeq !== undefined && { syncedSeq: editSeq }),
								});
							} catch (error) {
								log.error("[chat] edit-run case-store sync failed", error, {
									appId,
								});
							}
						}
					} else {
						/* BUILD finalization — the drain ended cleanly, so the run is
						 * done and the app is at rest. There is no finishing tool: the
						 * route owns the two finishing moves, in this order.
						 *
						 *  1. Materialize the case-store schemas for whatever the run
						 *     persisted (awaited) — a user-initiated case-store action
						 *     sub-second after the celebration (sample-data populate,
						 *     form submit, live preview) must see a synced Postgres
						 *     schema. The case-store consumers don't gate on status, so
						 *     this MUST precede `data-done`. Every commit was awaited
						 *     inline through `commitGuardedBatch`, so the stored blueprint
						 *     is already the run's final snapshot — no save chain to drain.
						 *  2. Flip `generating → complete` AND settle the kept charge in
						 *     ONE transaction (`completeAndSettleRun`), then emit `data-done`,
						 *     the celebration + doc-reconciliation signal. The atomicity is
						 *     load-bearing: status→complete is what makes the build claimable,
						 *     so settling in the same commit closes the window where an edit
						 *     POST landing between a separate flip + settle would claw back the
						 *     build's KEPT charge via the unconditional leftover refund. The
						 *     flip is still status-only for the blueprint (already persisted by
						 *     the guarded commits), so it can't blind-overwrite a concurrent
						 *     editor.
						 *
						 * A run that persisted nothing (a purely conversational build
						 * turn) still flips to complete — an empty app is at rest and
						 * valid, and status never feeds gating — but emits no
						 * `data-done`: nothing was built, so there is nothing to
						 * celebrate or reconcile.
						 *
						 * A throw out of any step funnels through `failRun` — the same
						 * infrastructure arm a mid-run fault takes (the app flips to
						 * `error`, the reservation refunds, the user sees the classified
						 * error). */
						try {
							const finalDoc = ctx.latestPersistedDoc();
							const finalSeq = ctx.latestCommittedSeq();
							if (finalDoc) {
								// `syncedSeq` is the committed seq of THIS doc — feeds the
								// monotone `synced_seq` gate so a concurrent additive sync
								// converges. `materializeCaseStoreSchemas` swallows a
								// TRANSIENT per-type blip (`warn`; the point-of-use
								// `withSchemaHeal` closes the gap) but RETHROWS a
								// DETERMINISTIC fault — that throw funnels through the
								// `failRun` below, so a build never completes-and-charges
								// over a permanently-unusable schema.
								await materializeCaseStoreSchemas({
									appId,
									blueprint: toPersistableDoc(finalDoc),
									...(finalSeq !== undefined && { syncedSeq: finalSeq }),
								});
							}
							await completeAndSettleRun(appId, effectiveRunId);
							if (finalDoc) {
								ctx.emit("data-done", {
									doc: toPersistableDoc(finalDoc),
									seq: finalSeq,
									success: true,
								});
							}
						} catch (error) {
							await failRun(error, "route:finalize");
						}
					}
				} catch (error) {
					/* Init/build error around the stream setup (a bad message shape, an
					 * SA-construction throw, an attachment-resolution failure). Same funnel
					 * as a streamed failure. */
					await failRun(error, "route:init");
				} finally {
					/* The single finalize call for the CLEAN path (the charge stands;
					 * `flush()` still refunds a zero-cost run on its own gating). On a failed
					 * run this is a no-op — `failRun` already finalized. Awaited so the
					 * response can't resolve before persistence lands; Cloud Run can kill the
					 * container the instant the final byte is written.
					 *
					 * Thread `paused`: a run that paused on `askQuestions` is alive (a later
					 * POST resumes it), so its kept charge must NOT settle and its edit
					 * `run_lock` must NOT release here — its marker is a live hold the
					 * resume's failure funnel may still refund, and its lock is held for the
					 * resume. `ctx.pausedOnInput()` is the same signal the paused arm above
					 * keys on. */
					await finalizeRun(undefined, { paused: ctx.pausedOnInput() });
				}
			} finally {
				/* Last-resort safety net for a throw in the execute PRELUDE (before
				 * the main try) that skips `finalizeRun` — e.g. the serialize-wait /
				 * reacquire / thread-upsert / seed-build stretch. It lives in
				 * execute's OWN `finally` — never an SDK `onEnd`/`onFinish`, which
				 * also fire on client cancel and would run this teardown against a
				 * live run mid-refresh (see the disconnect-handling note above the
				 * stream). On every path that DID finalize it degrades to no-ops:
				 * idempotent close, latched flush, the `finalizeRan` gate. (The
				 * lease heartbeat is started only AFTER the prelude, inside the main
				 * try whose `finally` always runs `finalizeRun` →
				 * `stopRunLeaseHeartbeat`, so a prelude throw never leaves a timer
				 * running.) */
				/* Seal the chunk log FIRST if `finalizeRun` never did: an
				 * unterminated stream would leave a resuming client tailing a dead
				 * run until the reconnect endpoint's liveness fallback. Idempotent. */
				await writer.close().catch(() => {});
				/* Flush next: a prelude-throw edit's `flush()` refunds+SETTLES its
				 * marker (zero-cost run), so the run-lock release below never leaves the
				 * app lock-absent-while-unsettled — the same "clear the lock only once
				 * the marker is settled" invariant the failure funnel upholds. Awaited
				 * (not fire-and-forget) so the settle precedes the clear. */
				await usage.flush().catch(() => {});
				void logWriter.flush();
				/* A prelude throw AFTER an EDIT claimed the `run_lock` would otherwise
				 * strand that lock until its 15-min lease — locking the whole shared app
				 * for every other member (RunConflictError → the 120s wait → "still
				 * busy"). Release it, but ONLY when `finalizeRun` never ran (the
				 * prelude-throw case) — a run that DID finalize already made the right
				 * lock decision, and a PAUSED edit deliberately keeps its lock. Also
				 * gated on this run STILL holding the lock (its `runId`): a
				 * superseded/taken-over app now carries a co-member's lock this must not
				 * touch. Gated on `claimedRun.mode === "edit"` so a build or a lock-less
				 * run pays no extra read. The flush above already settled the marker, so
				 * this release can't strand the hold. */
				if (!finalizeRan && claimedRun?.mode === "edit") {
					try {
						if (await editRunLockHeldBy(appId, effectiveRunId)) {
							void clearRunLock(appId);
						}
					} catch (err) {
						log.error("[chat] prelude-net run-lock release check failed", err, {
							appId,
						});
					}
				}
			}
		},
		onError: (error) => {
			// Safety net — a model error is surfaced to the user as an error
			// conversation event via `ctx.emitError` in the execute block; this only
			// catches an unexpected throw out of `execute` itself.
			log.error("[chat] stream error", error);
			return error instanceof Error ? error.message : String(error);
		},
	});

	/* `x-workflow-run-id` is the WorkflowChatTransport resume contract: the
	 * client stores it off this response and, if the stream ends without a
	 * `finish` chunk (network blip, Cloud Run's request cap, a closed laptop),
	 * reconnects to `/api/chat/{streamId}/stream?startIndex=<chunks received>`
	 * and replays the difference from the durable chunk log. */
	return createUIMessageStreamResponse({
		stream,
		headers: { "x-workflow-run-id": streamId },
	});
}
