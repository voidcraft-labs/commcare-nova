import {
	convertToModelMessages,
	createUIMessageStream,
	createUIMessageStreamResponse,
	type InferAgentUIMessage,
	isTextUIPart,
	type UIMessage,
	type UIMessageStreamWriter,
	validateUIMessages,
} from "ai";
import {
	buildAppStateMessage,
	buildTurnRetryContinuation,
	type ClassifiedError,
	classifyError,
	countDocumentsNeedingRead,
	createSolutionsArchitect,
	type ErrorType,
	GenerationContext,
	MESSAGES,
	markStablePrefixBoundary,
	resolveAttachments,
	shouldRetryTurn,
	TURN_RETRY_MESSAGE,
	turnRetryDelayMs,
} from "@/lib/agent";
import { runBuildOrchestration } from "@/lib/agent/build/orchestrator";
import {
	appendOrchestrationEvent,
	completeBuildOrchestration,
	readOrchestrationHead,
} from "@/lib/agent/build/orchestratorState";
import { CHAT_REQUEST_MAX_BYTES, declaredBodyTooLarge } from "@/lib/apiError";
import { resolveOpenAIKey } from "@/lib/auth-utils";
import { withSchemaContext } from "@/lib/case-store";
import {
	isOpenAICompactionChunk,
	projectCompatibleCompactedHistory,
} from "@/lib/chat/compaction";
import { DurableStreamWriter } from "@/lib/chat/durableStreamWriter";
import { SEED_STEPS_CHUNK_TYPE } from "@/lib/chat/hydratedStepFilter";
import { MAX_CHAT_MESSAGE_CHARS } from "@/lib/chat/limits";
import { sanitizeHistoricalReasoningParts } from "@/lib/chat/sanitizeReasoningParts";
import { sanitizeHistoricalToolParts } from "@/lib/chat/sanitizeToolParts";
import { createOpenPartTracker } from "@/lib/chat/streamPartClosure";
import { validateChatMessages } from "@/lib/chat/validateMessages";
import {
	AppAccessError,
	resolveAuthorizedAppSnapshot,
	resolveProjectAccess,
} from "@/lib/db/appAccess";
import {
	type ClaimedRun,
	ClaimModeStaleError,
	claimAndReserveRun,
	clearRunLock,
	clearRunLockAndSettle,
	failApp,
	GenerationInProgressError,
	loadApp,
	loadAppHolder,
	type ReacquireOutcome,
	RunConflictError,
	reacquireLease,
	setAwaitingInput,
} from "@/lib/db/apps";
import {
	AppProjectChangedError,
	CommitReauthError,
	RunHolderLostError,
} from "@/lib/db/commitGuard";
import { COST_BACKSTOP_USD, chargeAmount } from "@/lib/db/creditPolicy";
import {
	getCurrentCreditBalance,
	OutOfCreditsError,
	type Reservation,
	settleAndRelease,
} from "@/lib/db/credits";
import {
	claimAndReserveDesignSessionRun,
	createAndClaimDesignSessionRun,
	type DesignSessionDoc,
	DesignSessionStateError,
	failAndRefundDesignSessionRun,
	loadDesignSession,
	loadMaterializedSessionForApp,
	reacquireDesignSessionLease,
} from "@/lib/db/designSessions";
import type { GenerationTarget } from "@/lib/db/generationTargets";
import { materializeCaseStoreSchemas } from "@/lib/db/materializeCaseStoreSchemas";
import { pruneChatStreamChunks } from "@/lib/db/streamChunks";
import {
	clawBackThreadResponse,
	mergeThreadTurnMessages,
	persistResponseSnapshot,
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
import {
	DESIGN_AUTHOR_MODEL,
	MODEL_CONTEXT_VERSION,
	SA_BUILD_MODEL,
	SA_EDIT_MODEL,
} from "@/lib/models";
import { creditGateDecision } from "./creditGate";
import { chatRequestSchema, chatRunIdSchema } from "./schema";
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

/* Opportunistic chunk-log retention sweep: at most one fire-and-forget prune
 * per instance per interval, piggybacked on POST traffic (the same
 * no-dedicated-cron pattern as the run reapers). */
const CHUNK_PRUNE_INTERVAL_MS = 10 * 60 * 1000;
let lastChunkPruneAt = 0;

/** The refusal for a non-`complete` app with no bound design session: a
 * pre-pipeline row the one-off lifecycle repair converges to `complete`
 * (a valid app at rest), so the route never guesses a deleted build
 * method. */
const LEGACY_BUILD_REPAIR_MESSAGE =
	"This app's build predates Nova's design pipeline and is being repaired. It will open as an editable app shortly; if this persists, contact support.";

/** Resolve an app-target BUILD turn's orchestration scope: the bound
 * materialized design session, or null for a legacy pre-pipeline row. */
async function resolveBoundBuildSession(appId: string): Promise<{
	designSessionId: string;
	proposedAppId: string;
	materialized: true;
} | null> {
	const bound = await loadMaterializedSessionForApp(appId);
	return bound === null
		? null
		: { designSessionId: bound.id, proposedAppId: appId, materialized: true };
}

// ── Route Handler ──────────────────────────────────────────────────────

export async function POST(req: Request) {
	// Bound the UNauthenticated parse ahead of `resolveOpenAIKey` below. The
	// cap is generous enough for the largest real request (blueprint + bounded
	// message history); the message/attachment/text limits stay as the secondary,
	// post-parse controls. Enforced on BOTH the declared size (cheap, pre-buffer)
	// AND the actual byte length: a chunked request omits Content-Length, so the
	// declared-size check alone would wave a headerless stream into the full
	// parse. Buffering is bounded by Cloud Run's ~32 MB inbound limit.
	const tooLarge = () =>
		Response.json(
			{
				error:
					"That request is too large to process. Start a fresh conversation, the history has grown past what one request can send.",
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
	// NOT re-parse the SDK-owned message `parts`: that shape is the SDK's contract.
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
	if (
		!parsed.data.appId &&
		!parsed.data.designSessionId &&
		!parsed.data.expectedProjectId
	) {
		return Response.json(
			{
				error:
					"This new-app page is missing its Project scope. Reload the page and try again.",
				type: "invalid_request",
			},
			{ status: 400 },
		);
	}

	// Reject an over-length typed message: defense in depth behind the
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
					error: `That message is ${typedLength.toLocaleString()} characters, over the ${MAX_CHAT_MESSAGE_CHARS.toLocaleString()}-character limit. Trim it, or attach long content as a file, and send again.`,
					type: "message_too_long",
				},
				{ status: 400 },
			);
		}
	}

	// Require authenticated session + server API key
	const keyResult = await resolveOpenAIKey(req);
	if (!keyResult.ok) {
		return new Response(JSON.stringify({ error: keyResult.error }), {
			status: keyResult.status,
		});
	}

	const userId = keyResult.session.user.id;

	/* The credit-gate decision for this POST. Computed from the RAW `messages`
	 * array. The last message's ROLE is the charge signal (a fresh instruction
	 * ends with `user`; an answered-askQuestions auto-resend ends with
	 * `assistant` and rides free), so any future transform of the history the
	 * SA receives must not feed back into this read. (`validateChatMessages`
	 * only validates + types the array; it does not reorder or trim, so
	 * `messages` here is still the raw history.)
	 *
	 * `preflightCost` feeds only the advisory fast-fail balance read below:
	 * the build rate for a new build (checked before `createApp` can mint an
	 * orphan app), the cheapest chargeable amount for an existing app whose
	 * real mode isn't loaded yet. The authoritative charge is derived from
	 * the app row's own status once the app is created/loaded (`appReady` /
	 * `cost` below) and re-checked inside the claim transaction. */
	const { chargeable, preflightCost } = creditGateDecision({
		rawMessages: messages,
		existingApp: parsed.data.appId !== undefined,
		redrive: parsed.data.redrive,
	});
	/* A holder nonce is a per-CLAIM capability, never thread attribution. A
	 * chargeable instruction/redrive always gets a fresh server value even if a
	 * stale or malicious client supplied one. Only a free askQuestions
	 * continuation may echo the nonce Nova previously issued. */
	const presentedHolderNonce = parsed.data.holderNonce ?? null;
	/* A presented nonce is client-supplied and therefore unproven here. Give
	 * request-local collaborators a non-authoritative placeholder until the
	 * app-locked resume resolves (or replaces) the stored capability; no tool,
	 * heartbeat, lifecycle write, or client emission uses it before then. */
	let holderNonce = chargeable
		? crypto.randomUUID()
		: (presentedHolderNonce ?? crypto.randomUUID());

	/* Credit gate: fast-fail read. Sits where the dollar cap used to, at the top
	 * of the handler, and FAILS CLOSED: any database read error rejects with 503
	 * rather than letting an ungated/uncharged generation through. This is the
	 * cheap pre-flight read; the transactional reservation that actually books
	 * the charge runs later, after every pre-stream rejection point.
	 *
	 * Two independent checks:
	 *   (a) Actual-$ backstop: runs on EVERY POST (continuations included), so a
	 *       user hammering a broken app on free continuations still trips it. The
	 *       dollar threshold is never surfaced to the user (the message must not
	 *       leak the figure).
	 *   (b) Credit balance: only on CHARGEABLE POSTs. A continuation never
	 *       reserves, so it has no balance to check; gating it here would also
	 *       create an orphan app in the common out-of-credits case. */
	try {
		const usage = await getMonthlyUsage(userId);
		const monthlySpend = usage?.cost_estimate ?? 0;
		if (monthlySpend >= COST_BACKSTOP_USD) {
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
			if (balance < preflightCost) {
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

	const { runId } = parsed.data;
	/* A turn without a thread id starts a fresh server-minted thread (see the
	 * schema): the conversation persists either way. */
	const threadId = parsed.data.threadId ?? crypto.randomUUID();

	/* Stable public thread/run attribution. Every event envelope (mutation or
	 * conversation) carries this value, and the client echoes it across the
	 * thread's follow-up POSTs. It is deliberately NOT holder authority; multiple
	 * claims may share it, which is why `holderNonce` is separate. Minted before
	 * persistence so failure paths below can still surface it if needed. */
	const effectiveRunId = chatRunIdSchema.parse(runId ?? crypto.randomUUID());

	/* A pre-app design session is owner-private even inside a shared Project.
	 * Resolve and authorize a presented session BEFORE consulting any thread
	 * identity: otherwise the thread target/run guards become an oracle that
	 * distinguishes another owner's private session from an ordinary miss.
	 * The admitted row and role are reused below, so one request never reasons
	 * from two different session snapshots. */
	let presentedDesignSession: DesignSessionDoc | undefined;
	let presentedDesignSessionRole: string | undefined;
	const presentedSessionId = parsed.data.designSessionId;
	if (presentedSessionId !== undefined) {
		let session: DesignSessionDoc | null;
		try {
			session = await loadDesignSession(presentedSessionId);
		} catch (err) {
			log.error("[chat] design-session read failed", err);
			return Response.json(
				{
					error: "Couldn't load this design. Please try again shortly.",
					type: "internal",
				},
				{ status: 503 },
			);
		}
		if (
			session === null ||
			(session.app_id === null && session.owner_user_id !== userId)
		) {
			return Response.json(
				{ error: "App not found", type: "not_found" },
				{ status: 404 },
			);
		}
		try {
			const access = await resolveProjectAccess(
				userId,
				session.project_id,
				"edit",
			);
			presentedDesignSession = session;
			presentedDesignSessionRole = access.role;
		} catch (err) {
			if (err instanceof AppAccessError) {
				return Response.json(
					{ error: "App not found", type: "not_found" },
					{ status: 404 },
				);
			}
			throw err;
		}
	}

	/* Thread-identity guard: BEFORE any persistence work (a rejection here
	 * must not mint an orphan session). `threadId` is client-minted, so an id
	 * that already exists must belong to THIS turn's target: an app-target
	 * turn's thread must name that app, a design turn's thread must name that
	 * session — and a fresh build (neither id) can have no thread yet. The
	 * write path re-enforces this structurally (`upsertThreadTurn` guards the
	 * target); this read just turns the failure into a clean 400. Fails
	 * CLOSED on a read error: proceeding unguarded would let the later
	 * guarded write silently drop the conversation instead. */
	let existingThread: Awaited<ReturnType<typeof resolveThreadStream>> = null;
	try {
		existingThread = await resolveThreadStream(threadId);
		const threadMatchesTarget =
			existingThread === null ||
			(existingThread.target.kind === "app"
				? existingThread.target.appId === parsed.data.appId
				: existingThread.target.designSessionId ===
					parsed.data.designSessionId);
		if (!threadMatchesTarget) {
			return Response.json(
				{
					error:
						"That conversation belongs to a different app. Reload the page to pick up the right conversation list.",
					type: "invalid_request",
				},
				{ status: 400 },
			);
		}
		if (
			!chargeable &&
			(existingThread === null || existingThread.runId !== effectiveRunId)
		) {
			return Response.json(
				{
					error:
						"This answer round was superseded. Refresh to continue from the current conversation.",
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

	/* This POST's durable-stream identity: fresh per POST (a run spans many
	 * POSTs; resume cursors are per-POST chunk counts). Returned in the
	 * `x-workflow-run-id` response header, which is the handle the client's
	 * WorkflowChatTransport reconnects with (`/api/chat/{streamId}/stream`)
	 * when this response breaks without a `finish` chunk. */
	const streamId = crypto.randomUUID();

	/* Retention sweep for the chunk log: throttled per instance, never blocks
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
	 * lock: a second concurrent request will see this row in the in-transaction
	 * concurrency scan
	 * and reject. Without this ordering, two simultaneous requests could both
	 * pass the check before either writes a doc (classic TOCTOU).
	 */
	/* A presented design session is the authoritative scope: it knows its own
	 * app binding (or lack of one), so a stray `appId` beside it is ignored
	 * rather than raced against the session's state. */
	let appId =
		parsed.data.designSessionId !== undefined ? undefined : parsed.data.appId;
	/* The design-session scope this turn RUNS THE ORCHESTRATOR under — set for
	 * a fresh chat build (a session is created + claimed in one gated
	 * transaction), a presented `designSessionId` continuation still building,
	 * and an app-target BUILD claim whose app has a bound materialized session
	 * (a re-drive of an interrupted design build). `materialized` decides
	 * which authority row the run holds: the session pre-app, the app after.
	 * Undefined for an EDIT turn — including the edit continuation of a
	 * materialized session's thread, whose lineage rides
	 * `designLineageSessionId` below instead. */
	let designSessionRun:
		| {
				designSessionId: string;
				proposedAppId: string;
				materialized: boolean;
		  }
		| undefined;
	/* The thread-lineage binding: set whenever this turn belongs to a design
	 * session's conversation — every `designSessionRun` case PLUS the edit
	 * continuation of a session that already materialized and completed. A
	 * build thread stays design-session-targeted for its whole life
	 * (`lib/db/threads.ts` guards rows by exact target), so the turn's
	 * generation target derives from THIS binding, not from whether the
	 * orchestrator runs. */
	let designLineageSessionId: string | undefined;
	/* The credit reservation this run booked: set atomically with the claim
	 * (`claimAndReserveRun` / `createAndClaimDesignSessionRun`) pre-stream on
	 * the free / first-claim paths, or inside `execute` after the
	 * serialize-with-wait poll loop. Threaded into the accumulator so a failed
	 * or no-op run refunds the exact charge against the exact month. */
	let reservation: Reservation | undefined;
	/* The persisted app doc for an EXISTING-app request: captured off the
	 * authorization read below so the SA's working doc seeds from the saved
	 * blueprint with no extra load. Undefined for a design turn, which owns no
	 * document — the executor's change-set workspace does. */
	let loadedApp:
		| Awaited<ReturnType<typeof resolveAuthorizedAppSnapshot>>["app"]
		| undefined;
	/* The app's Project: the media tenant. Set in BOTH branches below (the
	 * page-bound expected Project for a new build, the app's Project for an existing one) and
	 * used to scope chat-attachment resolution (`resolveAttachments`) to the
	 * Project the documents live in. */
	let projectId: string | undefined;
	/** Role captured by the same admission as `projectId`; lookup tools pass
	 * the exact authorized scope into the Project data boundary. */
	let projectRole: string | undefined;
	/* Set when this POST claimed an existing app's run window
	 * (`claimAndReserveRun`: a build flipped to `generating`, or an edit's
	 * `run_lock`: with the credit debit in the SAME transaction). There is no
	 * prior-state snapshot to carry: every claim rejection (busy, concurrency,
	 * out-of-credits, infrastructure) is a transaction rollback that held
	 * nothing, so there is nothing to restore. Set either pre-stream (the free
	 * / first-claim path) or inside `execute` (after the serialize-with-wait
	 * poll loop). */
	let claimedRun: ClaimedRun | undefined;
	/* Set when the pre-stream claim CONFLICTED: another run holds the app. The
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
	 * before running, or bail: the paused run's lease can lapse while the user
	 * answers and be REAPED, freeing the app for another run. Done inside `execute`
	 * (needs `ctx`), uniform across both paused shapes via `reacquireLease`. */
	let resumeMustCheckSupersede = false;
	/* Build-vs-edit, derived SERVER-SIDE from the app row and nothing else: a
	 * new build and any app not at `complete` (a `generating` build, a paused
	 * askQuestions round, a reaped build being re-driven) run as BUILD; only a
	 * `complete` app runs as EDIT. A RE-DRIVE of a died turn on a `complete`
	 * app is therefore edit-shaped too, deliberately: the one claim shape
	 * that neither flips a committed app back to `generating` nor points the
	 * creation prompt at an existing document. This one binding drives the charge, the
	 * claim mode, the resume mode, the SA prompt/effort, and the lease
	 * heartbeat. It first derives from the admission snapshot, and because a
	 * serialize-wait can hold that read stale for minutes, every chargeable
	 * claim passes `requireModeMatchesStatus`: a claim whose mode no longer
	 * matches the LOCKED row rejects with the row's own mode
	 * (`ClaimModeStaleError`) and this binding re-derives before retrying, so
	 * a won claim and the run it starts cannot disagree. The client still
	 * sends its own `appReady` for its UI, but it is advisory here: trusting
	 * it once let a paused build's answer resume as an EDIT against the BUILD
	 * holder, which rejected every answer as superseded (the storm behind the
	 * `paused_timeout` reap this fixes). */
	let appReady = false;
	/* The authoritative charge for a chargeable POST, set in both admission
	 * branches below once `appReady` is known; `preflightCost` above remains
	 * the advisory fast-fail figure. */
	let cost = 0;
	/* The ONE spelling of the chargeable mode binding. Every site that
	 * (re)derives the claim mode for a chargeable existing-app turn routes
	 * through here, so the charge, the claim mode, and everything downstream
	 * keyed on `appReady` (the SA prompt/model, the run summary, the lease
	 * heartbeat) can never disagree about which mode this POST is booking.
	 * Returns the bound mode so a call site can hold it in a definite local
	 * (the mutable optional `claimMode` binding doesn't narrow). */
	const bindChargeableMode = (ready: boolean): "build" | "edit" => {
		appReady = ready;
		cost = chargeAmount(ready);
		claimMode = ready ? "edit" : "build";
		return claimMode;
	};
	if (!appId) {
		/* A chat build has NO app until its first meaningful workflow
		 * materializes. The turn's durable scope is a DESIGN SESSION: a
		 * presented `designSessionId` continues one (chargeable turns
		 * re-claim it; an answered-question continuation re-acquires the
		 * paused holder inside `execute`), and a fresh build creates and
		 * claims one in a single gated transaction — creation, cross-target
		 * concurrency, affordability, reservation, and holder commit together
		 * or nothing does, so a rejected first turn leaves no orphan. */
		if (presentedSessionId !== undefined) {
			const session = presentedDesignSession;
			if (session === undefined || presentedDesignSessionRole === undefined) {
				throw new Error(
					"[chat] compiler invariant: a presented design session was not admitted",
				);
			}
			projectId = session.project_id;
			projectRole = presentedDesignSessionRole;
			designLineageSessionId = session.id;
			if (session.state === "materialized" && session.app_id !== null) {
				/* The design already became an app; this turn continues against
				 * it (the thread stays session-targeted, the app row is the run
				 * authority). Falls through to the app admission below. */
				appId = session.app_id;
			} else if (session.state !== "active") {
				return Response.json(
					{
						error:
							"This design was discarded, so it can't continue. Start a new app to build again.",
						type: "invalid_request",
					},
					{ status: 400 },
				);
			} else if (session.proposed_app_id === null) {
				throw new Error(
					"[chat] compiler invariant: an active build session carries no proposed app id",
				);
			} else {
				designSessionRun = {
					designSessionId: session.id,
					proposedAppId: session.proposed_app_id,
					materialized: false,
				};
				cost = chargeable ? chargeAmount(false) : 0;
				if (chargeable) {
					try {
						const claimed = await claimAndReserveDesignSessionRun(
							session.id,
							effectiveRunId,
							userId,
							cost,
							projectId,
							holderNonce,
						);
						reservation = claimed.reservation;
						holderNonce = claimed.holderNonce;
					} catch (err) {
						if (err instanceof RunConflictError) {
							/* A design session is single-author scope: the conflicting
							 * holder is this user's own live run in another tab, so a
							 * pre-stream 429 is honest — nothing to serialize behind. */
							return Response.json(
								{
									error: MESSAGES.generation_in_progress,
									type: "generation_in_progress",
								},
								{ status: 429 },
							);
						}
						if (err instanceof GenerationInProgressError) {
							return Response.json(
								{
									error: MESSAGES.generation_in_progress,
									type: "generation_in_progress",
								},
								{ status: 429 },
							);
						}
						if (err instanceof OutOfCreditsError) {
							return Response.json(
								{ error: MESSAGES.out_of_credits, type: "out_of_credits" },
								{ status: 429 },
							);
						}
						if (
							err instanceof DesignSessionStateError ||
							err instanceof AppProjectChangedError ||
							err instanceof CommitReauthError
						) {
							return Response.json(
								{ error: "App not found", type: "not_found" },
								{ status: 404 },
							);
						}
						log.error("[chat] design-session claim failed", err);
						return Response.json(
							{
								error: "Unable to start this run. Please try again shortly.",
								type: "internal",
							},
							{ status: 503 },
						);
					}
				} else {
					/* A free answered-question continuation re-acquires the paused
					 * SESSION holder inside `execute`, exactly like the app path. */
					resumeMustCheckSupersede = true;
				}
			}
		}
		if (!appId && designSessionRun === undefined) {
			const expectedProjectId = parsed.data.expectedProjectId;
			if (expectedProjectId === undefined) {
				return Response.json(
					{
						error:
							"This new-app page is missing its Project scope. Reload the page and try again.",
						type: "invalid_request",
					},
					{ status: 400 },
				);
			}
			if (!chargeable) {
				/* An answered round always names its design session; a free
				 * continuation with neither target is a stale tab. */
				return Response.json(
					{
						error:
							"This answer round was superseded. Refresh to continue from the current conversation.",
						type: "invalid_request",
					},
					{ status: 400 },
				);
			}
			/* `/build/new` captured this Project in its server-rendered access
			 * tuple. Another tab may have switched the session's active Project
			 * since then; bind creation to the captured id and freshly authorize
			 * it at EDIT instead of re-reading mutable session state. */
			try {
				projectId = expectedProjectId;
				const access = await resolveProjectAccess(userId, projectId, "edit");
				projectRole = access.role;
			} catch (err) {
				if (err instanceof AppAccessError) {
					return Response.json(
						{
							error:
								"You don't have permission to create apps in this Project.",
							type: "forbidden",
						},
						{ status: 403 },
					);
				}
				log.error("[chat] expected-Project authorization failed", err);
				return Response.json(
					{
						error: "Unable to start this design. Please try again shortly.",
						type: "internal",
					},
					{ status: 503 },
				);
			}
			cost = chargeAmount(false);
			try {
				const created = await createAndClaimDesignSessionRun({
					projectId,
					actorUserId: userId,
					runId: effectiveRunId,
					cost,
					holderNonce,
				});
				designSessionRun = {
					designSessionId: created.designSessionId,
					proposedAppId: created.proposedAppId,
					materialized: false,
				};
				designLineageSessionId = created.designSessionId;
				reservation = created.reservation;
				holderNonce = created.holderNonce;
			} catch (err) {
				if (err instanceof GenerationInProgressError) {
					return Response.json(
						{
							error: MESSAGES.generation_in_progress,
							type: "generation_in_progress",
						},
						{ status: 429 },
					);
				}
				if (err instanceof OutOfCreditsError) {
					return Response.json(
						{ error: MESSAGES.out_of_credits, type: "out_of_credits" },
						{ status: 429 },
					);
				}
				if (err instanceof CommitReauthError) {
					return Response.json(
						{
							error:
								"You don't have permission to create apps in this Project.",
							type: "forbidden",
						},
						{ status: 403 },
					);
				}
				log.error("[chat] design-session creation failed", err);
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
	}
	if (appId) {
		/* Project-membership gate (edit): apps are a root-level collection, so
		 * the path doesn't scope writes; without this a crafted request with
		 * another Project's appId could drive a build against it. Authorization,
		 * Project scope, the persisted blueprint, and its mutation cursor come
		 * from ONE locked snapshot. The SA therefore never seeds from an app row,
		 * entity set, or membership decision taken on different sides of a move or
		 * membership write. */
		try {
			const snapshot = await resolveAuthorizedAppSnapshot(
				appId,
				userId,
				"edit",
			);
			loadedApp = snapshot.app;
			projectId = snapshot.projectId;
			projectRole = snapshot.role;
		} catch (err) {
			if (err instanceof AppAccessError) {
				return Response.json(
					{ error: "App not found", type: "not_found" },
					{ status: 404 },
				);
			}
			throw err;
		}
		/* The authoritative mode read: only a `complete` app is EDIT-shaped. A
		 * `generating` app (live or paused mid-build) and an `error` app (a
		 * reaped build awaiting re-drive; a failed edit never flips its app to
		 * `error`) both continue as BUILDS, so a paused build's answer resumes
		 * against the build holder and a re-drive re-claims at the build rate. */
		appReady = loadedApp.status === "complete";
		cost = chargeable ? chargeAmount(appReady) : 0;
		if (!!parsed.data.appReady !== appReady) {
			/* Not an error: the request proceeds on the derived mode. The warn is
			 * the visibility into clients whose own phase read disagrees (the bug
			 * this derivation retired: a `/build/new` tab answering a paused
			 * build's questions as an edit) and into stale pre-fix tabs. */
			log.warn("[chat] client appReady disagrees with app status", {
				appId,
				clientAppReady: !!parsed.data.appReady,
				derivedAppReady: appReady,
				appStatus: loadedApp.status,
			});
		}
		if (!appReady) {
			/* An app-target BUILD turn is always the continuation of a design
			 * build (a re-drive of an interrupted materialized session, or the
			 * answer to its paused question round): the bound session is the
			 * orchestration scope the run resumes. An app with no bound session
			 * predates the design pipeline; its rows are repaired by the one-off
			 * lifecycle scan (a valid app at rest is `complete`), so the route
			 * refuses rather than guessing a build method that no longer
			 * exists. */
			const bound = await resolveBoundBuildSession(appId);
			if (bound === null) {
				return Response.json(
					{ error: LEGACY_BUILD_REPAIR_MESSAGE, type: "invalid_request" },
					{ status: 409 },
				);
			}
			designSessionRun = bound;
			designLineageSessionId = bound.designSessionId;
		}
		/* Deliberately NO second advisory balance read at the derived rate. On
		 * the direct path the claim transaction's own affordability check
		 * rejects pre-stream with the same 429, so a read here would only add
		 * a roundtrip. On a conflict the derived rate is not necessarily the
		 * rate this turn ends at: the serialize-wait re-derives the mode at
		 * the winning poll, and a turn that derived BUILD because the app was
		 * mid-build usually wins as a 5-credit EDIT once that build completes,
		 * so a hard reject at the build rate here would falsely turn away an
		 * affordable turn. The floor read above plus the in-transaction check
		 * cover both paths. */
		if (chargeable) {
			/* EVERY chargeable POST against an existing app claims the run window
			 * AND reserves its credits in ONE transaction: a BUILD-mode
			 * instruction (`!appReady`) flips the row to `generating`; an EDIT
			 * (`appReady`) takes a `run_lock` without touching status. The claim is
			 * the per-app serialization lock, across BOTH modes (a build waits on a
			 * live edit-lock and vice versa, and on ANOTHER actor's PAUSED run of
			 * either mode: this user's own paused run is superseded by the claim
			 * instead, so an abandoned askQuestions round never locks them out);
			 * the cross-app concurrency cap and the affordability check run INSIDE
			 * the same transaction, so every rejection below is a rollback that
			 * held nothing.
			 *
			 * On a CONFLICT the route does not 429: it defers the whole
			 * claim+reserve sequence into `execute` behind a poll-wait
			 * (`waitForClaim`), so a second collaborator's request serializes
			 * behind the holder instead of bouncing.
			 *
			 * `requireModeMatchesStatus` makes the derived mode airtight: it was
			 * read off an unlocked snapshot, so the claim re-checks it against
			 * the LOCKED row and rejects with the row's own mode instead of
			 * booking a stale one; the retry below adopts that mode. A flip per
			 * attempt needs another actor's full claim cycle in between, so the
			 * bounded retries only give way to the serialize-wait, never spin. */
			let directClaimMode = bindChargeableMode(appReady);
			try {
				for (let attempt = 0; ; attempt++) {
					try {
						claimedRun = await claimAndReserveRun(
							appId,
							directClaimMode,
							effectiveRunId,
							userId,
							cost,
							projectId,
							holderNonce,
							{ requireModeMatchesStatus: true },
						);
						reservation = claimedRun.reservation;
						holderNonce = claimedRun.holderNonce;
						break;
					} catch (err) {
						if (err instanceof ClaimModeStaleError && attempt < 2) {
							/* The flip PROVES the app row changed since the unlocked
							 * admission read, so re-admit from a fresh authorized
							 * snapshot rather than patching the mode alone: the SA
							 * seeds its working doc from `loadedApp`, and an adopted
							 * EDIT run must edit the document the completed build
							 * actually committed, not the mid-build capture. Mode +
							 * rate re-derive from that same snapshot; a further flip
							 * rejects again at the locked claim and consumes the next
							 * bounded attempt. */
							try {
								const readmitted = await resolveAuthorizedAppSnapshot(
									appId,
									userId,
									"edit",
								);
								loadedApp = readmitted.app;
								projectId = readmitted.projectId;
								projectRole = readmitted.role;
							} catch (readmitErr) {
								if (readmitErr instanceof AppAccessError) {
									return Response.json(
										{ error: "App not found", type: "not_found" },
										{ status: 404 },
									);
								}
								throw readmitErr;
							}
							directClaimMode = bindChargeableMode(
								loadedApp.status === "complete",
							);
							/* A flip INTO build shape needs the build's orchestration
							 * scope: the bound materialized session (the same resolution
							 * the admission read performs on a non-complete app). */
							if (
								directClaimMode === "build" &&
								designSessionRun === undefined
							) {
								const bound = await resolveBoundBuildSession(appId);
								if (bound === null) {
									return Response.json(
										{
											error: LEGACY_BUILD_REPAIR_MESSAGE,
											type: "invalid_request",
										},
										{ status: 409 },
									);
								}
								designSessionRun = bound;
								/* `designLineageSessionId` stays as admission derived it:
								 * the thread this turn continues keeps its own target. */
							}
							continue;
						}
						if (err instanceof ClaimModeStaleError) {
							/* Three flips in a row means live contention: serialize
							 * behind it like any other conflict. */
							throw new RunConflictError();
						}
						throw err;
					}
				}
			} catch (err) {
				if (err instanceof RunConflictError) {
					/* The app is held: wait inside the stream (below), don't reject. */
					waitForClaim = true;
				} else if (err instanceof AppProjectChangedError) {
					return Response.json(
						{ error: MESSAGES.app_changed, type: "app_changed" },
						{ status: 409 },
					);
				} else if (err instanceof CommitReauthError) {
					return Response.json(
						{ error: "App not found", type: "not_found" },
						{ status: 404 },
					);
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
			 * proceeding: a paused run's lease lapses while the user answers (no
			 * heartbeat during a pause), so it may have been REAPED and the freed app
			 * claimed by another run; resuming blindly would start a second SA loop on
			 * an app this POST no longer owns. The re-acquire (uniform across both
			 * shapes via `reacquireLease`) runs inside `execute` where `ctx` can emit
			 * the bail; on success it renews the lease + clears the pause flag in one
			 * txn: a superseded resume touches nothing (a pre-stream clear would
			 * unflag / re-pause an app this POST no longer owns). */
			resumeMustCheckSupersede = true;
		}
	}
	if (projectId === undefined || projectRole === undefined) {
		throw new Error(
			"[chat] compiler invariant: app admission completed without a Project scope",
		);
	}
	/* One definite app-id binding for every downstream consumer. A design
	 * turn's is the session's PROPOSED app id — the exact id materialization
	 * mints, so the LogWriter's pre-app breadcrumbs become the app's admin
	 * history at birth, and every post-materialization write (settle, fail,
	 * heartbeat) already names the real row. */
	if (appId === undefined) {
		if (designSessionRun === undefined) {
			throw new Error(
				"[chat] compiler invariant: admission completed with neither an app nor a design session",
			);
		}
		appId = designSessionRun.proposedAppId;
	}

	/* The paused-run resume's pause-flag clear does NOT happen pre-stream, it
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
	 * (`appReady` derived from the app row's status, the
	 * authorization read's module count) and re-written via
	 * `usage.configureRun()` inside the execute block at their authoritative
	 * moment. The seed must be REAL, not placeholder: `prompt_mode` /
	 * `app_ready` are PINNED on the summary row by its first write, and a POST
	 * that dies before `configureRun` (a serialize-wait timeout) still flushes:
	 * a placeholder seed there would pin an edit thread's summary as a
	 * zero-module build. */
	/* Chat-surface writer: every event out of this route is stamped
	 * `source: "chat"`. The MCP endpoint constructs its own LogWriter
	 * with `source: "mcp"`; the writer is the single authority on the
	 * surface tag so the two cannot drift. */
	const logWriter = new LogWriter(appId, "chat");
	/* The run's ONE generation target, hoisted so every consumer below —
	 * usage, the durable stream writer, all thread writers — books against
	 * the same value. A design build's thread, stream, and summaries stay
	 * SESSION-targeted for the thread's whole life — through materialization
	 * AND the edit turns that follow completion (one transcript lineage; the
	 * target resolver delegates authority to the bound app), which is why
	 * this keys on the LINEAGE binding, not on whether the orchestrator
	 * runs. */
	const target: GenerationTarget = designLineageSessionId
		? {
				kind: "design-session",
				designSessionId: designLineageSessionId,
			}
		: { kind: "app", appId };
	const usage = new UsageAccumulator({
		target,
		userId,
		runId: effectiveRunId,
		holderNonce,
		// Must match the model `createSolutionsArchitect` picks off the same
		// signal (one model today; the constants stay separate so the roles
		// can diverge again).
		model: appReady ? SA_EDIT_MODEL : SA_BUILD_MODEL,
		promptMode: appReady ? "edit" : "build",
		appReady,
		moduleCount: loadedApp?.module_count ?? 0,
		/* Reservation context for the refund branch in `flush()`. All three travel
		 * together (a chargeable turn that reserved) or all absent (a free
		 * continuation, which never reserves). On the NON-conflict path
		 * `reservation` is already set (the claim reserved atomically pre-stream),
		 * so seed it here. On the serialize-with-wait path the reservation lands
		 * INSIDE `execute` (the poll loop winning `claimAndReserveRun`), so seed
		 * nothing now and set all three via `usage.configureRun` there, seeding a
		 * `didReserve` with no `chargePeriod` would leave the flush's refund gate
		 * half-armed. */
		didReserve: waitForClaim ? undefined : chargeable,
		reservedAmount: waitForClaim ? undefined : chargeable ? cost : undefined,
		chargePeriod: waitForClaim ? undefined : reservation?.period,
	});

	/* Mirror of the execute-local `finalized` latch, readable by execute's
	 * prelude-throw net (its `finally` sits outside the block `finalized` is
	 * scoped to). Set true whenever `finalizeRun` runs to completion; the net's
	 * stranded-lock release fires ONLY when this stayed false: i.e. the
	 * prelude threw before any `finalizeRun`. A run that DID finalize (clean /
	 * failed / paused) already made the correct lock decision (a paused edit
	 * deliberately KEEPS its lock), so the net must not second-guess it. */
	let finalizeRan = false;

	/* No `req.signal` disconnect handling: the run is no longer tied to the
	 * browser connection. The agent loop is drained server-side (see the execute
	 * block), so a closed tab neither cancels the run nor finalizes it, `flush()`
	 * runs once on the run's true terminal state regardless of whether anyone is
	 * still reading. A run the process can't finish (hard kill) is settled by the
	 * stale-`generating` reaper.
	 *
	 * The same rule bans `onEnd`/`onFinish` on this stream: the SDK fires them
	 * through the response stream's `cancel()` hook too, so a mid-run refresh
	 * would run that teardown while the agent is still streaming, sealing the
	 * chunk log and flushing a zero-usage accumulator against a live run, which
	 * refunds the charge, blinds the resume path, and no-ops the real finalize.
	 * Post-settle cleanup lives in execute's own `finally`, which by
	 * construction cannot run before the body settles.
	 *
	 * The BARRIER FOLD inside execute is the sanctioned home for those
	 * callbacks: a second, server-internal `createUIMessageStream` that no
	 * client ever holds. The route itself drains it, and only `finalizeRun`
	 * (or the prelude-throw net) closes it, so its `onStepEnd`/`onFinish` are
	 * driven by the run's true progress — never by a client's pull or cancel. */
	const stream = createUIMessageStream({
		execute: async ({ writer: rawWriter }) => {
			/* Set once `upsertThreadTurn` persisted this POST's history onto the
			 * thread row (which also marked it live via `active_stream_id`).
			 * Gates every barrier write and the fold's terminal directive: a
			 * POST that bailed before owning the run (serialize-wait timeout,
			 * lost resume) wrote no thread state and must not touch the row the
			 * true holder owns. Declared here — outside the main try — because
			 * the fold callbacks below close over it. */
			let threadPersisted = false;

			/* ── The barrier fold: durable-transcript writes at SDK barriers ──
			 *
			 * The record of this turn is written AS THE RUN PRODUCES IT: the
			 * SDK's own fold of the chunk sequence reports each completed step
			 * through `onStepEnd`, and that callback — not any Nova
			 * interpretation of chunks — is what lands in `threads`. Finalize
			 * is bookkeeping; no end-of-run assembly exists.
			 *
			 * `foldOutcome` is the terminal directive `finalizeRun` sets before
			 * closing the fold: `completed`/`paused` merge the final state and
			 * retire the marker; `failed`/`aborted` CLAW BACK the turn's
			 * message to its pre-run state (a partial serves nobody — the
			 * record holds completed units only, on every turn end,
			 * uniformly); `skip` (prelude throws, every bail path) touches
			 * nothing, because those POSTs never owned the thread. `aborted`
			 * is defined for uniformity — the route has no server-side stop
			 * path today, so it is unreachable until one exists. */
			let foldOutcome: "completed" | "paused" | "failed" | "aborted" | "skip" =
				"skip";
			/* The one definition of which outcomes CLAW BACK, shared by the
			 * fold's terminal callback and finalize's fallback so the two can
			 * never disagree. (Also defeats assignment narrowing: the
			 * derivation never produces "aborted" today — no server-side stop
			 * path — but the rule is uniform, not derived from what currently
			 * happens to be reachable.) */
			const outcomeClawsBack = (
				outcome: "completed" | "paused" | "failed" | "aborted" | "skip",
			): boolean => outcome === "failed" || outcome === "aborted";
			/* True once the fold's own terminal write committed; finalize's
			 * fallback covers the run when it stayed false. */
			let foldSettled = false;
			/* The message id the fold owns, latched at the first barrier (and at
			 * the terminal callback): finalize's fallback needs it to RETRY a
			 * failed turn's claw-back — without the id, the fallback could only
			 * clear the marker and would leave the partial as durable history no
			 * writer may ever trim. Null until a barrier fires; a zero-step
			 * failure persisted nothing, so a marker clear alone is the complete
			 * claw-back for it. */
			let foldMessageId: string | null = null;
			/* The pre-run seed of a CONTINUATION turn (an answered askQuestions
			 * round): the raw incoming trailing assistant message, exactly as
			 * the client sent it — the fold grows it, and a claw-back restores
			 * it. Raw, not the sanitized `validated` copy: the sanitizers strip
			 * load-bearing reasoning `providerMetadata` that must survive in
			 * the stored transcript. */
			const trailingIncoming = messages.at(-1);
			const foldSeed =
				trailingIncoming?.role === "assistant" ? trailingIncoming : undefined;
			/* The turn's response message id, minted HERE for a fresh turn (a
			 * continuation reuses its seed's id — the SDK prefers the trailing
			 * assistant id wherever this is offered). Passed to the SA stream as
			 * `generateMessageId` so the `start` chunk carries it BEFORE the
			 * choke-point tee: the chunk log, the barrier fold, and the live
			 * client all then adopt ONE id. Without it, the SA-level `start` has
			 * no id on fresh turns and the fold and the client-facing stream each
			 * stamp their own generated id downstream of the tee — the durable
			 * transcript and the client's rendered message then name the same
			 * answer differently, which breaks every by-id contract downstream
			 * (history admission, continuation seeding, the resume window). */
			const responseMessageId = foldSeed?.id ?? crypto.randomUUID();
			/* The final assembled message, latched at every barrier and at the
			 * terminal callback, so finalize's fallback can retry the CONTENT
			 * write — not just the marker clear — when the fold's own terminal
			 * write failed. Null only when no barrier ever assembled anything
			 * (a zero-step failure), where a marker clear IS the whole write. */
			let foldFinalMessage: UIMessage | null = null;
			let foldWriter!: UIMessageStreamWriter;
			let releaseFold: () => void = () => {};
			const foldClosed = new Promise<void>((resolve) => {
				releaseFold = resolve;
			});
			const foldStream = createUIMessageStream({
				/* Seeds the fold's message state from the trailing assistant
				 * message (the SDK ignores a trailing user message), so a
				 * continuation's snapshots grow the SAME message id the client
				 * grows. */
				originalMessages: messages,
				/* The fold's producer is the tee in `DurableStreamWriter`; this
				 * execute only parks the writer and holds the stream open until
				 * finalize resolves `foldClosed`. */
				execute: ({ writer: w }) => {
					foldWriter = w;
					return foldClosed;
				},
				onStepEnd: async ({ responseMessage }) => {
					if (!threadPersisted || responseMessage.parts.length === 0) return;
					foldMessageId = responseMessage.id;
					foldFinalMessage = responseMessage;
					/* Log-before-barrier ordering: the step's `finish-step` chunk
					 * must be durable in the chunk log BEFORE its barrier commits,
					 * so a persisted barrier N implies log ≥ step N and a resume
					 * replay windowed on the hydrated transcript can never
					 * re-deliver content it already holds. A BROKEN log therefore
					 * suspends barrier writes (resumability is already lost; a
					 * barrier that outran the truncated log would come back as
					 * duplicated parts on the next replay) — the fold's terminal
					 * write still lands, so the final record never depends on the
					 * log's health. */
					if (!(await writer.flushNow())) return;
					await persistResponseSnapshot({
						target,
						threadId,
						streamId,
						expectedProjectId: projectId,
						responseMessage,
						clearMarker: false,
					});
				},
				onFinish: async ({ responseMessage }) => {
					if (foldOutcome === "skip") return;
					foldMessageId = responseMessage.id;
					foldFinalMessage = responseMessage;
					if (outcomeClawsBack(foldOutcome)) {
						await clawBackThreadResponse({
							target,
							threadId,
							streamId,
							messageId: responseMessage.id,
							revertTo: foldSeed,
						});
						foldSettled = true;
						return;
					}
					await persistResponseSnapshot({
						target,
						threadId,
						streamId,
						expectedProjectId: projectId,
						responseMessage,
						clearMarker: true,
						retainHolderNonce: foldOutcome === "paused",
					});
					foldSettled = true;
				},
				/* Barrier-write throws land here (the SDK catches `onStepEnd`):
				 * logged and self-healing — snapshots are cumulative, so the
				 * next barrier carries everything a failed one dropped, and the
				 * finalize fallback covers a fold that never settled. */
				onError: (error) => {
					log.error("[chat] barrier fold error", error, { appId, streamId });
					return error instanceof Error ? error.message : String(error);
				},
			});
			/* The fold's callbacks fire as its stream is CONSUMED; the route is
			 * its only consumer. Never awaited before finalize — the drain runs
			 * for the life of the run and settles when finalize (or the
			 * prelude-throw net) resolves `foldClosed`. */
			const foldDrained = (async () => {
				const reader = foldStream.getReader();
				try {
					for (;;) {
						const { done } = await reader.read();
						if (done) break;
					}
				} finally {
					reader.releaseLock();
				}
			})().catch((err) => {
				log.error("[chat] barrier fold drain failed", err, {
					appId,
					streamId,
				});
			});

			/* The one write choke point: every chunk out of this request, SDK
			 * parts forwarded from the SA stream AND the route's own `data-*`
			 * events: rides this wrapper, which appends it to the durable chunk
			 * log (resume replays it), forwards it to the live response
			 * (best-effort; a dead client stops forwarding, never logging), and
			 * tees it into the barrier fold above. Closed by `finalizeRun` so
			 * the terminal row is durable before the response stream ends. */
			const writer = new DurableStreamWriter({
				streamId,
				target,
				runId: effectiveRunId,
				threadId,
				inner: rawWriter,
				fold: foldWriter,
			});
			try {
				/* First chunk of every stream: how many steps of the turn's message
				 * PRECEDE this stream (the fold seed's `step-start` count — nonzero
				 * only for an answered-askQuestions continuation, whose stream grows
				 * a message earlier streams started). A cold resume replays this
				 * stream from chunk 0 and the client's hydrated-step filter needs
				 * this offset to map its transcript's step count onto THIS stream's
				 * steps; the chunk is transient (never a message part) and inert to
				 * every other consumer. */
				writer.write({
					type: SEED_STEPS_CHUNK_TYPE,
					data: {
						steps: foldSeed
							? foldSeed.parts.filter((p) => p.type === "step-start").length
							: 0,
					},
					transient: true,
				});
				// Send runId to client so it can send it back on subsequent requests
				writer.write({
					type: "data-run-id",
					data: { runId: effectiveRunId },
					transient: true,
				});
				/* Announce the turn's design-session scope to the client exactly
				 * once per stream (replayed by reconnect): the id the client
				 * echoes on continuations, and the signal that no app exists yet.
				 * The app-creation receipt is no longer an early frame — the
				 * strict `data-app-materialized` receipt lands only when the
				 * first meaningful workflow commits. */
				if (designLineageSessionId !== undefined) {
					writer.write({
						type: "data-design-session",
						data: {
							designSessionId: designLineageSessionId,
							/* Null exactly while no app row exists; the id once the
							 * session materialized (whether this turn builds or edits). */
							materializedAppId:
								designSessionRun === undefined || designSessionRun.materialized
									? appId
									: null,
						},
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
					projectId,
					projectRole,
					holderNonce,
					/* An EDIT run (chargeable claim OR free-continuation resume) holds a
					 * `run_lock`, so it heartbeats the lease off SA activity. A BUILD holds
					 * via `status` (no lock) → no heartbeat. `appReady` is the build-vs-edit
					 * signal. */
					editLease: appReady,
					conversionImpact: async (args) =>
						(await withSchemaContext()).conversionImpact({ appId, ...args }),
				});

				/* Latch so the refund toast fires at most once per run. */
				let refundSignalled = false;
				/* Finalize-once guard: see `finalizeRun`. */
				let finalized = false;

				/**
				 * The single authoritative finalization: the fold's terminal
				 * directive, then the charge-vs-refund credit decision — run exactly
				 * once on the run's TRUE terminal state. Finalize is BOOKKEEPING:
				 * the durable transcript was written unit-by-unit at the fold's
				 * barriers, so nothing here is a durability event beyond the fold's
				 * own final marker retirement.
				 *
				 * Driven by the agent drain completing (below), NOT by an SDK callback: a
				 * model error surfaces as a UIMessage error chunk rather than a thrown
				 * rejection, and a zero-step error fires no agent callback at all, so
				 * keying finalize on the drain is what guarantees it runs (and the request
				 * never hangs waiting on a callback that never fires). A failed run marks
				 * itself failed and FLUSHES (handing the reservation back; actual $ still
				 * accrues so the backstop sees retry-spam), and only THEN flips the app to
				 * `error`, and only if the refund actually committed, so a stranded refund
				 * leaves the build `generating` for the reaper to retry. Idempotent via this
				 * guard and the accumulator's own `_finalized` latch.
				 *
				 * Settle/release is threaded on `paused` (`ctx.pausedOnInput()`): a run
				 * that PAUSED on `askQuestions` is alive (a later POST resumes it), so its
				 * kept charge must NOT be settled and an edit's `run_lock` must NOT be
				 * released, its marker is a live hold the resume's failure funnel may
				 * still refund. A clean, non-paused completion settles the kept charge (so
				 * the status-agnostic edit reaper can't claw it back) and releases an
				 * edit's lock (so the next serialize-with-wait waiter proceeds). A FAILED
				 * run releases the edit lock UNCONDITIONALLY (a failed edit routes here
				 * without entering the clean editing arm, so gating release on clean
				 * completion would strand the lock): except a paused hold, which never
				 * reaches the failure funnel from a pause.
				 */
				const finalizeRun = async (
					failure?: ClassifiedError,
					opts?: {
						paused?: boolean;
						heldApp?: boolean;
						failureSource?: string;
						/** The TURN finished — its answer streamed to completion and
						 * every unit it narrates committed — and `failure` is
						 * post-drain BOOKKEEPING (schema materialization, the
						 * settle). The transcript keeps the completed answer; only
						 * the run's credit/status outcome is failed. Without this,
						 * a transient settle fault would claw back a finished,
						 * fully-delivered answer. */
						turnComplete?: boolean;
					},
				): Promise<void> => {
					if (finalized) return;
					finalized = true;
					finalizeRan = true;
					/* Stop the wall-clock lease heartbeat the moment the run reaches a
					 * terminal state: the run is no longer live, so it must stop extending
					 * its own liveness horizon (a clean edit is about to release the lock; a
					 * paused run deliberately lets its horizon ride until resume, the
					 * heartbeat MUST stop here or an abandoned pause would never lapse for
					 * the reapers). Idempotent. Clearing the interval here is what keeps it
					 * from leaking. */
					ctx.stopRunLeaseHeartbeat();
					const paused = opts?.paused ?? false;

					/* Retire the transcript FIRST, before any settle/flush work: set
					 * the fold's terminal directive, close it, and wait for its final
					 * write. Every completed unit is already durable from its own
					 * barrier; this final write only merges the last state and
					 * clears the marker (or claws back a failed turn), so the window
					 * where a process death strands the marker on a finished run is
					 * milliseconds of plain awaits — not the heavy assembly that once
					 * sat here. A POST that never owned the thread
					 * (`!threadPersisted`) skips; a failure or lost holder claws
					 * back (the record keeps completed-unit turns only, and the
					 * claw-back's stream guard makes it a no-op once a successor
					 * owns the thread) — UNLESS the turn itself completed
					 * (`turnComplete`): a bookkeeping fault after a clean drain
					 * must not delete the finished answer the user watched
					 * stream. */
					foldOutcome = !threadPersisted
						? "skip"
						: (failure !== undefined || opts?.heldApp === false) &&
								opts?.turnComplete !== true
							? "failed"
							: paused
								? "paused"
								: "completed";
					releaseFold();
					await foldDrained;
					if (foldOutcome !== "skip" && !foldSettled) {
						/* The fold errored before its terminal write committed. Retry
						 * the SAME terminal write the directive called for — with
						 * backoff, since the first failure was likely a transient DB
						 * fault that outlives an immediate retry:
						 *
						 *  - `failed`/`aborted` with a persisted barrier: the
						 *    claw-back (partial removal + marker clear, one
						 *    transaction). A marker-only clear here would retire the
						 *    recovery signal while leaving the failed turn's partial
						 *    as durable history NO writer may ever trim. If every
						 *    attempt fails, the marker deliberately STAYS: the next
						 *    load reads it as an interruption and the re-drive claim
						 *    removes the partial — degraded recovery over permanent
						 *    corruption.
						 *  - `completed`/`paused`: the FULL terminal write — the
						 *    latched final message plus the marker clear — so the
						 *    finished, already-charged answer gets the whole retry
						 *    ladder, not just its marker. (A zero-barrier failure
						 *    latched nothing; its marker clear IS the whole write.) */
						const clawBack =
							outcomeClawsBack(foldOutcome) && foldMessageId !== null;
						const backoffMs = [0, 250, 1_000];
						let terminalWritten = false;
						for (const delay of backoffMs) {
							if (terminalWritten) break;
							if (delay > 0) await new Promise((r) => setTimeout(r, delay));
							try {
								if (clawBack && foldMessageId !== null) {
									await clawBackThreadResponse({
										target,
										threadId,
										streamId,
										messageId: foldMessageId,
										revertTo: foldSeed,
									});
								} else {
									await persistResponseSnapshot({
										target,
										threadId,
										streamId,
										expectedProjectId: projectId,
										responseMessage: foldFinalMessage,
										clearMarker: true,
										retainHolderNonce: paused,
									});
								}
								terminalWritten = true;
							} catch (err) {
								log.error(
									clawBack
										? "[chat] failed-turn claw-back retry failed; if none lands, the marker stays so the re-drive claim can remove the partial"
										: "[chat] terminal transcript write failed; if none lands, the stranded marker reads as a finished run off the sealed log and the last barrier's snapshot stands as the answer",
									err,
									{ appId, threadId },
								);
							}
						}
					}
					/* Whether THIS POST owns the run holding the app. False only on the
					 * serialize-with-wait early returns (a timed-out waiter, or a
					 * post-claim gate bail that already released the claim): such a POST
					 * holds nothing: the app is still held by ANOTHER run, so it must
					 * NOT touch the reservation marker or `run_lock` (settling/clearing
					 * would break the true holder's refund + strand its lock). It still
					 * flushes usage + drains the log (below), both no-ops for a POST that
					 * reserved nothing. Every other terminal path: the drain-end finally,
					 * `failRun`, the paused arm: is a POST that owns or continues the
					 * holding run, so it defaults true. */
					let heldApp = opts?.heldApp ?? true;
					if (failure) usage.markRunFailed();
					await usage.flush();
					if (failure && heldApp) {
						/* Failed-run terminal write: refund + settle the marker AND (for an
						 * EDIT) release the `run_lock`, ATOMICALLY (`settleAndRelease`). `flush`
						 * above already refunded a hold THIS POST booked; this settles a hold an
						 * EARLIER POST booked (askQuestions: an earlier chargeable POST reserves,
						 * a free continuation fails here): it reads the hold off the marker, so
						 * it settles whichever POST booked it. Idempotent when flush already
						 * settled it. The atomicity is load-bearing: the `run_lock` is
						 * released ONLY inside the same commit that settles the marker, so
						 * "lock cleared + marker unsettled" (the state that stranded credits) is
						 * impossible: if the txn throws NOTHING changed (the lock stays for the
						 * reaper) and `settled` reports `false`. The explicit mode is part of
						 * the holder token (a build has no lock). A failure never reaches here
						 * paused. */
						let refundSettled = false;
						let settleOutcome: ReacquireOutcome | "failed" = "failed";
						try {
							({ settled: refundSettled, outcome: settleOutcome } =
								await settleAndRelease(appId, effectiveRunId, holderNonce, {
									mode: appReady ? "edit" : "build",
								}));
						} catch (err) {
							log.error("[chat] failed-run settle+release failed", err, {
								appId,
							});
						}
						if (settleOutcome === "owned") {
							ctx.emitError(failure, opts?.failureSource ?? "route:failure");
							if (chargeable && refundSettled && !refundSignalled) {
								refundSignalled = true;
								writer.write({
									type: "data-credit-refund",
									data: { amount: cost, userId },
									transient: true,
								});
							}
						} else if (settleOutcome !== "failed") {
							const holderLost = new RunHolderLostError(settleOutcome);
							ctx.latchRunHolderLost(holderLost);
							ctx.emitError(
								classifyError(holderLost),
								"route:failed-run-holder-lost",
							);
							heldApp = false;
						} else {
							/* Infrastructure uncertainty is not proof of holder loss. Surface the
							 * original failure, but make no refund claim; the exact-holder reaper
							 * remains the settlement backstop. */
							ctx.emitError(failure, opts?.failureSource ?? "route:failure");
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
						if (settleOutcome === "owned" && refundSettled && !appReady) {
							await failApp(appId, effectiveRunId, holderNonce, failure.type);
						}
					} else if (!failure && !paused && heldApp && appReady) {
						/* Clean, non-paused EDIT completion: release the `run_lock` AND
						 * settle the kept charge in ONE transaction (`clearRunLockAndSettle`).
						 * The atomicity is load-bearing: clearing the lock is what makes the
						 * edit claimable, so settling in the same commit closes the window
						 * where a run landing between a separate release + settle would see
						 * the still-unsettled marker and (per the unconditional leftover
						 * refund) claw back this edit's KEPT charge. Settles whatever hold is
						 * on the marker (the askQuestions flow is multi-POST). Best-effort: a
						 * failure logs and the reaper stays the backstop.
						 *
						 * A clean BUILD completion is NOT handled here: `completeAndSettleRun`
						 * in the drain-end build-finalize block already flipped status→complete
						 * AND settled atomically (a build has no `run_lock` to release), for the
						 * same window-closing reason. */
						try {
							const releaseOutcome = await clearRunLockAndSettle(
								appId,
								effectiveRunId,
								holderNonce,
							);
							if (releaseOutcome !== "owned") {
								const holderLost = new RunHolderLostError(releaseOutcome);
								ctx.latchRunHolderLost(holderLost);
								ctx.emitError(
									classifyError(holderLost),
									"route:edit-finalize-holder-lost",
								);
								heldApp = false;
							}
						} catch (err) {
							log.error("[chat] edit clean release+settle failed", err, {
								appId,
							});
						}
					}
					await logWriter.flush();
					/* Terminate the durable chunk log LAST: every user-visible write on
					 * every terminal path (the failure funnel's error event + refund
					 * toast, the clean build's `data-done`) precedes its path's
					 * `finalizeRun` call, so the terminal row seals a complete stream. A
					 * resuming client then always reaches the synthetic/real `finish`
					 * instead of tailing a dead run until the liveness fallback. The
					 * seal carries `foldOutcome`: the dead-marker reconciler reads it to
					 * retire a finished run's stranded marker instead of re-driving it,
					 * while an UNSEALED stream (process death, broken log) keeps reading
					 * as a mid-turn interruption. Awaited: execute must not resolve
					 * (closing the response) before the terminal row is durable. */
					await writer.close(foldOutcome);
				};

				/**
				 * Classify + surface a generation error, then finalize the run as failed:
				 * the single failure funnel for both an init/build throw and a streamed
				 * model error. Finalization first proves the exact holder and settles its
				 * refund; only then does it emit the classified error and, for a chargeable
				 * run, the authoritative `data-credit-refund` toast. A lost holder emits the
				 * existing superseded/released error and never claims a refund.
				 */
				const failRun = async (
					error: unknown,
					source: string,
					opts?: {
						turnComplete?: boolean;
						classified?: ClassifiedError;
					},
				): Promise<void> => {
					const classified = opts?.classified ?? classifyError(error);
					if (error instanceof RunHolderLostError) {
						ctx.latchRunHolderLost(error);
						ctx.emitError(classified, source);
						await finalizeRun(undefined, {
							heldApp: false,
							turnComplete: opts?.turnComplete,
						});
						return;
					}
					await finalizeRun(classified, {
						failureSource: source,
						turnComplete: opts?.turnComplete,
					});
				};

				/**
				 * Persist a BAILED POST's incoming history before it closes. A bail
				 * (a serialize-wait gate rejection or timeout, a superseded resume)
				 * runs nothing and must not claim the thread, but its history is
				 * real client state: an answered askQuestions round exists only in
				 * the client's memory until a write lands, and every bail message
				 * tells the user to refresh, which would erase it. Merge-only: the
				 * thread's `run_id` / live-stream marker belong to the run that owns
				 * the app and are not touched. (The RE-DRIVE bail deliberately skips
				 * this, its history is the same unanswered turn the winning
				 * re-drive already persisted when it claimed.)
				 */
				const persistBailedHistory = async (): Promise<void> => {
					try {
						await mergeThreadTurnMessages({
							target,
							threadId,
							messages,
							expectedProjectId: projectId,
						});
					} catch (err) {
						log.error("[chat] bail-path history merge failed", err, {
							appId,
							threadId,
						});
					}
				};

				/* Serialize-with-wait: the pre-stream claim CONFLICTED (another run
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
					 * RE-RUN the same turn: a second charge for a duplicate response.
					 * The clean close (the durable writer seals a terminal `finish`)
					 * ends the client's send; its post-close heal re-fetches the
					 * thread and attaches to whatever the winner is streaming. */
					if (parsed.data.redrive) {
						log.info("[chat] re-drive lost the claim race. Bailing clean", {
							appId,
							threadId,
						});
						await finalizeRun(undefined, { heldApp: false });
						return;
					}
					/* A same-actor conflict is real (the requester's OWN still-running
					 * request from another tab, or one whose tab they closed: a closed
					 * tab neither cancels nor finalizes a run), and naming the user to
					 * themselves reads as a phantom collaborator. Their own PAUSED run
					 * never reaches here: the claim supersedes it. Re-resolved per
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
					 * a warning, not an error: the request hasn't failed, it's queued
					 * behind the holder. (A `data-phase` pulse was tried here but no client
					 * reducer renders it: this conversation event IS the busy signal.) */
					ctx.emitError(
						{
							type: "generation_in_progress",
							message: `Waiting: ${await holderLabel()} is still running on this app. Only one request runs at a time; this one will start automatically when it finishes.`,
							recoverable: true,
						},
						"route:serialize-wait",
					);

					const deadline = Date.now() + CLAIM_WAIT_MAX_MS;
					let claimError: unknown;
					/* A gate rejection from a WON poll (concurrency cap / out of credits):
					 * terminal for this POST, and it held nothing (the claim+reserve
					 * transaction rolled back). */
					let gateBail:
						| {
								type:
									| "generation_in_progress"
									| "out_of_credits"
									| "access_revoked"
									| "app_changed"
									| "internal";
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
								projectId,
								holderNonce,
								{ requireModeMatchesStatus: true },
							);
							reservation = claimedRun.reservation;
							holderNonce = claimedRun.holderNonce;
							break;
						} catch (err) {
							if (err instanceof RunConflictError) continue; // still held: keep waiting
							if (err instanceof ClaimModeStaleError) {
								/* The awaited holder finished and changed the app's shape
								 * (a build the waiter queued behind completed → this turn
								 * is now an edit of a complete app, or the reverse). Adopt
								 * the locked row's mode + rate and re-poll: everything
								 * downstream (`editing`, the heartbeat, the thread type,
								 * `usage.configureRun`) reads these same bindings, so the
								 * won claim and the run it starts cannot disagree. */
								const adopted = bindChargeableMode(err.statusMode === "edit");
								/* A flip INTO build shape needs the build's orchestration
								 * scope — the bound materialized session, exactly as the
								 * admission read resolves it. A sessionless non-complete
								 * app is a legacy row awaiting the one-off repair. */
								if (adopted === "build" && designSessionRun === undefined) {
									const bound = await resolveBoundBuildSession(appId);
									if (bound === null) {
										gateBail = {
											type: "internal",
											message: LEGACY_BUILD_REPAIR_MESSAGE,
										};
										break;
									}
									designSessionRun = bound;
									/* The thread this turn continues keeps its own target;
									 * lineage is an admission-time binding. */
								}
								continue;
							}
							if (err instanceof AppProjectChangedError) {
								gateBail = {
									type: "app_changed",
									message: MESSAGES.app_changed,
								};
								break;
							}
							if (err instanceof CommitReauthError) {
								gateBail = {
									type: "access_revoked",
									message: MESSAGES.access_revoked,
								};
								break;
							}
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
						 * friendly close and end: nothing was claimed or reserved, so
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
									: `Still busy: ${await holderLabel()} is taking a while. Please try again in a moment.`,
								recoverable: false,
							},
							"route:serialize-wait-timeout",
						);
						/* Held nothing (never won the claim): flush + log only, and do NOT
						 * touch the marker/lock (the app is still held by the OTHER run). */
						await persistBailedHistory();
						await finalizeRun(undefined, { heldApp: false });
						return;
					}

					/* Won the claim after waiting: the win arrived fully gated and
					 * reserved (the claim+reserve transaction is atomic). Tell the
					 * accumulator so the flush-time refund/settle targets the right
					 * period (the seed left these unset for the wait path). A free
					 * continuation never reaches here (it doesn't claim), so `chargeable`
					 * is the didReserve signal. The mode fields ride along because a
					 * stale-mode adoption in the poll loop may have won under the OTHER
					 * mode than the pre-wait seed pinned: a run that dies between this
					 * win and the SA-construction `configureRun` still flushes a summary,
					 * and it must describe the mode the claim actually booked. */
					const wonEdit = claimedRun.mode === "edit";
					usage.configureRun({
						didReserve: chargeable,
						...(chargeable ? { reservedAmount: cost } : {}),
						...(reservation ? { chargePeriod: reservation.period } : {}),
						promptMode: claimedRun.mode,
						appReady: wonEdit,
						model: wonEdit ? SA_EDIT_MODEL : SA_BUILD_MODEL,
					});
					/* The context was built with the PRE-WAIT mode, and a stale-mode
					 * adoption above may have won under the other one. Everything
					 * mode-keyed inside it — the `(mode, runId, nonce)` holder
					 * capability every commit presents, the lease-heartbeat
					 * refresher — must follow the mode the claim actually booked, or
					 * the first guarded batch dies `RunHolderLostError` and the
					 * `heldApp: false` bail strands the real lock this POST took. */
					ctx.setRunMode(claimedRun.mode);

					/* A held app may have advanced while we waited (the prior holder
					 * committed batches), so re-read one authorized persisted snapshot for
					 * the SA's seed rather than trusting the pre-wait `loadedApp`. This
					 * admission happens AFTER this POST owns the claim + reservation. It
					 * therefore fails through the normal run failure funnel: refund/settle
					 * and exact-holder release happen before the stream closes, and the SA
					 * never starts on an unknown or cross-Project document. */
					try {
						const fresh = await resolveAuthorizedAppSnapshot(
							appId,
							userId,
							"edit",
						);
						if (fresh.projectId !== projectId) {
							throw new AppProjectChangedError();
						}
						loadedApp = fresh.app;
						/* The seed pinned the PRE-WAIT snapshot's module count, stale by
						 * definition when the awaited holder was committing modules. The
						 * mode restatement above could not fix it (the fresh count only
						 * exists once this snapshot resolves), so restate it here: a run
						 * that dies between this point and the SA-construction
						 * `configureRun` flushes the count of the document it actually
						 * ran against. A death at the snapshot read itself still flushes
						 * the seed value; no fresher count exists on that path. */
						usage.configureRun({ moduleCount: fresh.app.module_count });
					} catch (err) {
						const failure =
							err instanceof AppAccessError
								? new CommitReauthError(
										"You no longer have edit access to this app's Project.",
									)
								: err;
						if (
							!(failure instanceof CommitReauthError) &&
							!(failure instanceof AppProjectChangedError)
						) {
							log.error(
								"[chat] serialize-wait authorized snapshot reload failed",
								failure,
								{ appId },
							);
						}
						await persistBailedHistory();
						await failRun(failure, "route:serialize-wait-snapshot");
						return;
					}
				}

				/* Paused-run resume re-acquire: UNIFORM across both modes. A
				 * free-continuation resume of a paused run (build OR edit) must still OWN
				 * that run AND renew its liveness horizon before proceeding: a paused run's
				 * lease lapses while the user answers (no heartbeat during a pause), so it
				 * may have been REAPED and the freed app claimed by another run.
				 * `reacquireLease` does BOTH atomically: asserts ownership
				 * (`runLeaseState().ownedByResume`, keyed on the resume's own mode), and on
				 * success re-establishes the mode's horizon (edit → renew
				 * `run_lock.expireAt`; build → re-arm `updated_at`) AND clears
				 * `awaiting_input` in the SAME transaction, so a resume RENEWS its lease
				 * rather than proceeding on an already-lapsed one and being reaped mid-run.
				 * If superseded or released, it touched NOTHING and we BAIL gracefully
				 * rather than start a second SA loop on an app it no longer owns.
				 * Nothing was claimed/reserved on this free continuation, so
				 * `heldApp: false` keeps the finalize from touching the holder's state.
				 * Authorization, Project-scope, and infrastructure failures all fail CLOSED:
				 * the route emits one terminal error and never starts the SA. */
				if (resumeMustCheckSupersede) {
					/* The server-derived mode: a paused build resumes as a BUILD even
					 * when the answering tab's own phase read drifted (the exact drift
					 * that once resumed answers as edits and bounced every one). A
					 * PRE-APP design resume re-acquires the SESSION's paused holder —
					 * the same protocol, the session row as authority. */
					const resumeMode = appReady ? "edit" : "build";
					let reacquire:
						| ReacquireOutcome
						| "refresh_required"
						| "access_revoked"
						| "app_changed"
						| "failed" = "failed";
					try {
						const result =
							designSessionRun !== undefined && !designSessionRun.materialized
								? await reacquireDesignSessionLease(
										designSessionRun.designSessionId,
										effectiveRunId,
										presentedHolderNonce,
										userId,
										projectId,
									)
								: await reacquireLease(
										appId,
										effectiveRunId,
										presentedHolderNonce,
										resumeMode,
										userId,
										projectId,
									);
						reacquire = result.outcome;
						if (result.outcome === "owned") {
							holderNonce = result.holderNonce;
							ctx.setReacquiredHolderNonce(holderNonce);
							usage.configureRun({ holderNonce });
						}
					} catch (err) {
						if (err instanceof CommitReauthError) {
							reacquire = "access_revoked";
						} else if (err instanceof AppProjectChangedError) {
							reacquire = "app_changed";
						} else {
							log.error("[chat] resume reacquire failed", err, { appId });
						}
					}
					if (reacquire !== "owned") {
						if (
							reacquire === "access_revoked" ||
							reacquire === "app_changed" ||
							reacquire === "failed"
						) {
							const failure =
								reacquire === "access_revoked"
									? {
											type: "access_revoked" as const,
											message: MESSAGES.access_revoked,
										}
									: reacquire === "app_changed"
										? {
												type: "app_changed" as const,
												message: MESSAGES.app_changed,
											}
										: {
												type: "internal" as const,
												message: MESSAGES.internal,
											};
							ctx.emitError(
								{
									...failure,
									recoverable: false,
								},
								`route:resume-${reacquire}`,
							);
							await persistBailedHistory();
							await finalizeRun(undefined, { heldApp: false });
							return;
						}
						/* The lost shapes read very differently to the person answering, so
						 * tell the truth per shape: "superseded" means another run actually
						 * holds the app now: the requester's OWN newer request (a paused
						 * round the same actor's claim superseded) or a co-member's;
						 * "released" means the run simply timed out waiting and a scan
						 * reaped it (refund + free) with no re-claim. The holder read is a
						 * best-effort projection for the message only. */
						if (reacquire === "refresh_required") {
							ctx.emitError(
								{
									type: "run_released",
									message:
										"This tab predates Nova's updated run protection and can no longer resume this answer safely. Refresh to load the current conversation, then send your answer again.",
									recoverable: false,
								},
								"route:resume-refresh-required",
							);
							await persistBailedHistory();
							await finalizeRun(undefined, { heldApp: false });
							return;
						}
						let superseded: { type: ErrorType; message: string } | undefined;
						if (reacquire === "superseded") {
							/* Before materialization a design session is owner-private, so a
							 * successor holder can only be this same user. There is no app row
							 * to inspect yet: `appId` is merely the proposed identity. */
							const preAppDesign =
								designSessionRun !== undefined &&
								!designSessionRun.materialized;
							const holder = preAppDesign ? null : await loadAppHolder(appId);
							superseded = {
								type: "generation_in_progress",
								message:
									preAppDesign || holder?.userId === userId
										? "You started a newer request for this design, so this answer round was superseded. Continue from your newer conversation."
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
				 * serialize-wait win, or re-acquired resume): persist the turn onto
				 * its thread NOW: the full incoming history (already carrying the new
				 * user turn / answered askQuestions parts) plus the live-stream marker
				 * (`active_stream_id` = this POST's chunk-log stream). From this write
				 * on, a page refresh hydrates the user's turn and reconnects to the
				 * run by THREAD id. Rejection paths above never CLAIM the thread:
				 * `run_id` and the live-stream marker stay the owning run's, but
				 * they do merge the incoming messages (`persistBailedHistory`) so an
				 * answered question round survives the refresh their bail messages
				 * recommend.
				 * `false` means the id belongs to another app (the pre-stream guard
				 * catches this before any claim; this is the structural backstop):
				 * surfaced as a failed run rather than silently streaming a
				 * conversation that will never persist. A holder lost between claim
				 * and this write throws after preserving any mergeable transcript; it
				 * must terminate before publishing a stale continuation capability. */
				try {
					threadPersisted = await upsertThreadTurn({
						target,
						threadId,
						runId: effectiveRunId,
						streamId,
						holderNonce,
						threadType: appReady ? "edit" : "build",
						messages,
						expectedProjectId: projectId,
						/* A re-drive claim removes its dead predecessor's trailing
						 * partial assistant message — the death-case claw-back (the
						 * client's regenerate() already trimmed it from this
						 * history, and the by-id merge would otherwise keep the
						 * stored copy forever). */
						redrive: parsed.data.redrive === true,
					});
				} catch (err) {
					if (err instanceof RunHolderLostError) {
						await failRun(err, "route:thread-marker-holder-lost");
						return;
					}
					await failRun(err, "route:thread-turn-upsert-failed");
					return;
				}
				if (!threadPersisted) {
					await failRun(
						new Error(
							"The conversation thread does not belong to the claimed app.",
						),
						"route:thread-turn-not-persisted",
					);
					return;
				}
				/* Dedicated operational capability: forward the real value only to
				 * this authenticated POST caller. The durable stream stores an inert,
				 * count-preserving marker; reconnect resolves it from the actor-bound
				 * active thread/app holder, so a Project viewer can replay shared chat
				 * without gaining another actor's continuation authority. Emit only
				 * after the authoritative claim/reacquire and thread binding. */
				writer.writePrivateHolderNonce(holderNonce);

				/* ── The design-build turn ─────────────────────────────────────
				 *
				 * A design-session run never mounts the SA: the server-owned
				 * BUILD ORCHESTRATOR is the whole method — source package →
				 * bounded design pipeline → slice executor → materialization →
				 * later slices — and this branch owns its terminal mapping onto
				 * the run/credit machinery. It returns before the SA seed below;
				 * edit-shaped turns continue on the SA path unchanged — including
				 * a serialize-wait that admitted as BUILD but won its claim as an
				 * EDIT after the awaited build completed (`bindChargeableMode`
				 * flipped `appReady`; the session binding survives only as thread
				 * lineage there). */
				if (designSessionRun !== undefined && !appReady) {
					const design = designSessionRun;
					/* The orchestration's cancellation seam. The run deliberately
					 * ignores browser disconnects (it drains server-side), so
					 * nothing fires this mid-run; aborting when the branch settles
					 * cancels any model call a throw left in flight, and the
					 * orchestrator's own step/slice budgets remain the primary
					 * runaway bound. */
					const orchestrationAbort = new AbortController();
					try {
						const outcome = await runBuildOrchestration({
							designSessionId: design.designSessionId,
							proposedAppId: design.proposedAppId,
							projectId,
							projectRole,
							actorUserId: userId,
							runId: effectiveRunId,
							holderNonce,
							threadId,
							messages,
							responseMessageId,
							writer,
							apiKey: keyResult.apiKey,
							meter: usage,
							signal: orchestrationAbort.signal,
							materializedAppId: design.materialized ? appId : null,
							finalizeCompletion: async ({
								appId,
								expectedSeq,
								expectedHead,
							}) => {
								const finalApp = await loadApp(appId);
								if (
									finalApp === null ||
									finalApp.mutation_seq !== expectedSeq
								) {
									throw new RunHolderLostError("superseded");
								}
								await materializeCaseStoreSchemas({
									appId,
									blueprint: finalApp.blueprint,
									syncedSeq: expectedSeq,
								});
								const head = await completeBuildOrchestration({
									designSessionId: design.designSessionId,
									runId: effectiveRunId,
									holderNonce,
									actorUserId: userId,
									expectedProjectId: projectId,
									appId,
									expectedSeq,
									expectedHead,
								});
								return { blueprint: finalApp.blueprint, head };
							},
							deps: {
								logCommittedStages: (receipt, envelopes) => {
									for (const envelope of envelopes) {
										try {
											ctx.emitConversation({
												type: "assistant-text",
												text: `Committed ${envelope.toolName}${envelope.stageName ? ` (${envelope.stageName})` : ""} at sequence ${receipt.seq}.`,
											});
										} catch {
											/* Event logging never fails the run. */
										}
									}
								},
								/* The design agent's step fan-out: per-step usage on the
								 * accumulator (steps count as steps), tool-call/result and
								 * reasoning-summary conversation events, all through the
								 * same handler the SA rides. */
								onAgentStep: (step) =>
									ctx.handleAgentStep(
										step,
										"Design agent",
										DESIGN_AUTHOR_MODEL,
										"design-author",
									),
								/* Reasoning summaries from the calls that never touch a
								 * thread (the independent reviewer, executor steps) land
								 * beside the run's other events, joined to artifacts by
								 * run id. Never fatal. */
								onReasoningSummary: (text) => {
									try {
										ctx.emitConversation({
											type: "assistant-reasoning",
											text,
										});
									} catch {
										/* Event logging never fails the run. */
									}
								},
								onDesignToolOutcome: (event) => {
									try {
										ctx.emitConversation({
											type: "design-tool-outcome",
											...event,
										});
									} catch {
										/* Event logging never fails the run. */
									}
								},
								onExecutorToolOutcome: (event) => {
									try {
										ctx.emitConversation({
											type: "executor-tool-outcome",
											...event,
										});
									} catch {
										/* Event logging never fails the run. */
									}
								},
								/* A transient design-turn fault being redriven renders as
								 * a RECOVERABLE warning with the real classified type, the
								 * same admin-inspect breadcrumb as an SA turn retry. */
								onRecoverableRetry: (classified) => {
									ctx.emitError(
										{
											...classified,
											message: TURN_RETRY_MESSAGE,
											recoverable: true,
										},
										"route:design-turn-retry",
										{ runContinues: true },
									);
								},
							},
						});
						if (outcome.kind === "completed") {
							/* The orchestrator persisted `finished` only after the route's
							 * schema convergence and exact-head lifecycle CAS above. */
							ctx.emit("data-done", {
								doc: outcome.finalBlueprint,
								seq: outcome.finalSeq,
								success: true,
							});
							await finalizeRun();
						} else if (outcome.kind === "awaiting-input") {
							if (!outcome.pauseOwned) {
								ctx.emitError(
									{
										type: "run_released",
										message:
											"This design's question round could not pause safely. Refresh to get the latest state, then continue.",
										recoverable: false,
									},
									"route:design-pause-lost",
								);
								await finalizeRun(undefined, { heldApp: false });
							} else {
								await finalizeRun(undefined, { paused: true });
							}
						} else {
							/* Failed. Pre-app: settle+refund the SESSION's hold and end
							 * honestly (no app exists; the session stays active and
							 * recoverable). Post-materialization: the ordinary app
							 * failure funnel — the transferred holder is on the app. */
							if (design.materialized || outcome.appId !== null) {
								/* Orchestration already classified this terminal outcome and
								 * translated it for the person. Re-wrapping the message in Error
								 * would run it through the generic classifier, lose `recoverable`,
								 * and replace a useful design-adjustment instruction with
								 * "Something went wrong." Preserve the typed outcome while using
								 * the same atomic app failure/refund funnel. */
								await finalizeRun(
									{
										type: "internal",
										message: outcome.message,
										recoverable: outcome.recoverable,
									},
									{ failureSource: "route:design-build" },
								);
							} else {
								usage.markRunFailed();
								let refunded = false;
								try {
									({ settled: refunded } = await failAndRefundDesignSessionRun(
										design.designSessionId,
										effectiveRunId,
										holderNonce,
										outcome.errorType,
									));
								} catch (err) {
									log.error("[chat] design-session fail settle failed", err, {
										designSessionId: design.designSessionId,
									});
								}
								ctx.emitError(
									{
										type: "internal",
										message: outcome.message,
										recoverable: outcome.recoverable,
									},
									"route:design-build",
								);
								if (chargeable && refunded && !refundSignalled) {
									refundSignalled = true;
									writer.write({
										type: "data-credit-refund",
										data: { amount: cost, userId },
										transient: true,
									});
								}
								await finalizeRun(undefined, { heldApp: false });
							}
						}
					} catch (error) {
						/* An orchestration throw: infrastructure or lost scope. The
						 * settle must target whichever row holds the run NOW — a throw
						 * AFTER this run materialized (a later-slice fault on a fresh
						 * build) has already transferred the holder + reservation to
						 * the APP row, so the admission-time `design.materialized`
						 * binding is stale; settling the session there is a no-op that
						 * strands the app `generating` with an unsettled charge until
						 * the reaper. Re-read the session's authoritative state to
						 * pick the funnel; a failed re-read fails toward the app
						 * funnel (failRun's writers are exact-holder gated, so a wrong
						 * guess touches nothing). */
						let materializedNow = design.materialized;
						if (!materializedNow) {
							try {
								const fresh = await loadDesignSession(design.designSessionId);
								materializedNow = fresh?.state === "materialized";
							} catch (err) {
								log.error(
									"[chat] design-session state re-read failed after throw",
									err,
									{ designSessionId: design.designSessionId },
								);
								materializedNow = true;
							}
						}
						if (materializedNow) {
							const classified = classifyError(error);
							const recoverableInfrastructureFault = ![
								"run_released",
								"generation_in_progress",
								"access_revoked",
								"app_changed",
							].includes(classified.type);
							if (recoverableInfrastructureFault) {
								/* Preserve an exact-plan continuation in durable orchestration
								 * state before the generic failure funnel releases the app holder.
								 * A storage failure here is itself fail-closed: the cold-load page
								 * also treats an error app with a nonterminal head as interrupted. */
								try {
									const currentHead = await readOrchestrationHead(
										design.designSessionId,
									);
									if (
										currentHead?.state.kind !== "finished" &&
										currentHead?.state.kind !== "accepted-partial" &&
										currentHead?.state.kind !== "failed"
									) {
										await appendOrchestrationEvent({
											designSessionId: design.designSessionId,
											runId: effectiveRunId,
											holderNonce,
											actorUserId: userId,
											expectedProjectId: projectId,
											state: {
												kind: "failed",
												failureId: crypto.randomUUID(),
												recoverable: true,
												errorType: classified.type,
											},
											expectedHead: currentHead,
										});
									}
								} catch (err) {
									log.error(
										"[chat] recoverable build interruption stamp failed",
										err,
										{ designSessionId: design.designSessionId },
									);
								}
							}
							await failRun(error, "route:design-build-throw", {
								classified: recoverableInfrastructureFault
									? { ...classified, recoverable: true }
									: classified,
							});
						} else {
							usage.markRunFailed();
							let refunded = false;
							try {
								({ settled: refunded } = await failAndRefundDesignSessionRun(
									design.designSessionId,
									effectiveRunId,
									holderNonce,
									classifyError(error).type,
								));
							} catch (err) {
								log.error("[chat] design-session throw settle failed", err, {
									designSessionId: design.designSessionId,
								});
							}
							ctx.emitError(classifyError(error), "route:design-build-throw");
							/* Same reassurance as the failed-outcome arm: the refund is
							 * already durable server-side, so tell the person they were
							 * not charged for the turn that threw. */
							if (chargeable && refunded && !refundSignalled) {
								refundSignalled = true;
								writer.write({
									type: "data-credit-refund",
									data: { amount: cost, userId },
									transient: true,
								});
							}
							await finalizeRun(undefined, { heldApp: false });
						}
					} finally {
						orchestrationAbort.abort();
					}
					return;
				}

				/* Build the SA's working doc: the SAVED blueprint
				 * (`loadedApp.blueprint`, the persistable slice with no
				 * `fieldParent`), loaded off the authorization read above, never
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
				 * one case that could outrun the auto-save and need a flush. */
				const persistedSessionBlueprint = loadedApp?.blueprint;
				if (!persistedSessionBlueprint) {
					throw new Error(
						"Chat session has no authorized app snapshot to edit.",
					);
				}
				const sessionDoc: BlueprintDoc = hydratePersistedBlueprint(
					persistedSessionBlueprint as PersistableDoc,
				);
				/* Hydrate the reference index alongside: the SA's tool layer
				 * answers "who references / declares X" through it (retirement
				 * planning, rename verdicts, the rename cascade) from the first
				 * tool call. */
				ensureReferenceIndex(sessionDoc);

				/* Persist the current request's user message as the first
				 * conversation event of the run. Emitting through the context
				 * (rather than directly via `logWriter.logEvent`) keeps seq
				 * management inside a single counter: the context owns seq,
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
					 * failed user-message log is non-fatal to the request: log it and
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
					 * results produced by live steps, and askQuestions has no execute:
					 * its result exists only in this incoming history, so this is the
					 * one place the answers can be logged. Paired to the original
					 * tool-call event by toolCallId.
					 *
					 * Only the FINAL step's parts are new this turn: consecutive
					 * question rounds append to the same trailing assistant message
					 * (`toUIMessageStream({ originalMessages })` continues it), so an
					 * earlier round's answered part is still `output-available` here:
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
						/* Defensive: a trailing assistant message should be an answered
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
					/* Every SA turn is EDIT-shaped after the design-pipeline cutover:
					 * app-target build turns route to the orchestrator branch above,
					 * so an app that reaches the SA is `complete` by admission. */
					if (!appReady) {
						throw new Error(
							"[chat] compiler invariant: an app-target SA turn reached the executor without edit shape",
						);
					}
					const saModel = SA_EDIT_MODEL;

					/* Backfill the accumulator seed now that we know the real
					 * editing signals. These fields land on the per-run
					 * summary doc via `usage.flush()`: replaces the deleted
					 * `logger.logConfig` call (ConfigEvent removed in T3). */
					usage.configureRun({
						promptMode: "edit",
						appReady: true,
						model: saModel,
						moduleCount: sessionDoc.moduleOrder.length,
					});

					const sa = createSolutionsArchitect(ctx, sessionDoc);

					/* Start the wall-clock run-lease heartbeat now the run is live, an
					 * edit refreshes its `run_lock` lease, a build re-arms its `updated_at`
					 * staleness clock. It guarantees a run that sits in a single long model
					 * turn (or a long no-commit stretch) with no intermediate step-finish
					 * still refreshes its liveness horizon, so a LIVE run can't lapse and
					 * be reaped mid-run. Stopped in `finalizeRun` (the finally always runs
					 * it: a paused run must stop beating so an abandoned pause lapses for
					 * the reapers); the timer is `.unref()`ed so it never keeps the process
					 * alive. */
					ctx.startRunLeaseHeartbeat();

					/* The SA receives the FULL conversation history, every turn. The old
					 * expired-cache one-shot trim (edit + lapsed prompt cache → last user
					 * message only) is retired: threads resume across page loads and
					 * days now, and a resumed conversation the SA can't see isn't a
					 * conversation. A cold-cache turn pays one cache re-write: the
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
					 * signal grid can show a "reading documents" status, but ONLY when a
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
						// The app's Project scopes attachment resolution: a chat document
						// lives in the Project it was uploaded under (the composer stamps
						// it). Set in both the new-build + existing-app branches above;
						// `loadedApp.project_id` is the existing-app fallback.
						projectId ?? loadedApp?.project_id ?? "",
						ctx,
						// Pulse the signal grid with real read progress while a
						// not-yet-extracted document is read here. `transient` keeps these
						// frequent parts off the persisted thread + event log: they're
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
					 * provider would reject the whole request: "tool not found in
					 * tools array") AND parts whose recorded input the current
					 * schema no longer parses (a deploy that narrowed a `.strict()`
					 * tool input: `validateUIMessages` below would throw,
					 * fail+refund the run, and re-poison every retry with the same
					 * history). The full contract, the drop semantics, and the
					 * validation mirror live on `sanitizeHistoricalToolParts`. The
					 * repair runs on EVERY turn: every request sends full history,
					 * and resumed threads routinely carry parts recorded under
					 * earlier deploys, or under the OTHER tool set entirely (an
					 * edit turn continuing a build thread drops the generation-tool
					 * parts; the dialogue survives). Keyed on `sa.tools` so
					 * the filter never drifts from the active set. */
					const sanitizedMessages = await sanitizeHistoricalToolParts(
						preparedMessages,
						sa.tools,
					);

					/* Apply the reasoning-part wire contract AFTER the tool repair
					 * (what pairing survives depends on which tool parts did):
					 * historical assistant messages drop their reasoning parts:
					 * prior-turn reasoning is ignored server-side, bills as input
					 * every turn, and is model-bound (one model change would 400
					 * every old thread), while a trailing answered-askQuestions
					 * continuation keeps its reasoning (the wire REQUIRES it beside
					 * the function call whose output this turn submits) unless the
					 * pause crossed a model change, in which case the round rides as
					 * plain dialogue text. Contract + sources on the module. */
					const reasoningSafeMessages = sanitizeHistoricalReasoningParts(
						sanitizedMessages,
						saModel,
					);
					const effectiveMessages = projectCompatibleCompactedHistory(
						reasoningSafeMessages,
						saModel,
					);

					/* Every turn delivers the CURRENT blueprint summary as a per-turn
					 * message at the END of the prompt, not inside the system prompt:
					 * the summary changes on every doc mutation and provider caching
					 * is exact-prefix, so a volatile summary in the prompt would
					 * re-bill the static tail + the tool rendering + the history on
					 * every doc-mutating turn. Appended after the full history, the
					 * cached prefix survives through the previous user turn; the
					 * re-billed suffix is the prior turn's response, which replay
					 * re-bills regardless, since history drops its reasoning items:
					 * plus this snapshot. Rendered from the same doc the SA booted
					 * with, so it reflects builder-side and co-member edits the
					 * conversation never saw. Ephemeral by construction: a
					 * ModelMessage appended past `validated` never reaches the thread
					 * transcript, so each turn carries exactly one fresh snapshot. */
					const appStateMessage = buildAppStateMessage(sessionDoc);

					/* Record the input-context composition for the per-run finalize
					 * log: how many messages were actually sent (after the sanitizer's
					 * drops + the resolve, plus the app-state message) and their
					 * serialized size. The system prompt is static, so this is the
					 * variable part of the per-request input cost: the lever the
					 * cost investigation needs visibility into. */
					usage.configureRun({
						sentMessageCount:
							effectiveMessages.length + (appStateMessage ? 1 : 0),
						sentMessageChars:
							JSON.stringify(effectiveMessages).length +
							(appStateMessage ? JSON.stringify(appStateMessage).length : 0),
					});

					/* Run the agent to completion SERVER-SIDE, decoupled from the browser.
					 * We use `agent.stream` + its primitives rather than `createAgentUIStream`
					 * so we hold the `StreamTextResult`: `consumeStream()` drains the tool
					 * loop to its terminal state even with no reader, so a closed tab no
					 * longer stalls the build via response backpressure and finalization keys
					 * off the drain rather than the browser connection. The UIMessage handling
					 * replicates `createAgentUIStream` exactly: validate against the SA's
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
					/* The request-local marker writes a reusable entry before the
					 * volatile app-state tail. It changes no transcript token and does
					 * not mutate the durable UI history. */
					const baseModelMessages = markStablePrefixBoundary(
						await convertToModelMessages(validated, {
							tools: sa.tools,
						}),
					);
					/* The full per-turn prompt: converted history, then the app-state
					 * snapshot. A retry/redrive attempt REPLACES the
					 * snapshot with the turn-retry continuation below: the
					 * continuation embeds its own, fresher committed-state summary,
					 * and the model must see exactly one authoritative snapshot (a
					 * stale summary beside the fresh one invites re-planning against
					 * the wrong state). */
					const promptMessages = appStateMessage
						? [...baseModelMessages, appStateMessage]
						: baseModelMessages;

					/* The turn runs inside a bounded TRANSIENT-failure re-run loop: a
					 * provider fault mid-generation (a 500 halfway through a step, a
					 * dropped provider connection) re-drives the SAME turn: same POST,
					 * same claim + lease + charge, same open stream: instead of failing
					 * the run and making the user retry by hand. This is safe because it
					 * IS the manual retry, performed early: every tool batch committed
					 * inline before the failure (nothing is lost or replayed), the SA
					 * continues against that committed doc, and the validity gate rejects
					 * duplicate structural work at commit: the same guarantees a user's
					 * own re-send has always relied on. Non-transient failures
					 * (`shouldRetryTurn`) and deauthorized runs never loop. Each retry
					 * appends ONE continuation message carrying the committed-state
					 * summary to the UNCHANGED base prompt (cache-friendly; never
					 * stacked), and surfaces on the wire + event log as a RECOVERABLE
					 * conversation event: visible in admin inspect, invisible as a
					 * failure to the user. */
					let pendingError: unknown;
					let sawFatalError = false;
					let turnRetries = 0;
					/* Mirrors the client's part-lifetime state over the forwarded chunks
					 * so a retried attempt can CLOSE the aborted attempt's dangling parts
					 * (`closures()` below): the client accumulates the whole response
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
						 * finish chunks on one response: the client finalizes on the
						 * first. Written through on every non-retry exit, so a clean turn's
						 * wire is byte-identical to before. */
						let heldFinish: Parameters<typeof writer.write>[0] | undefined;

						/* A RE-DRIVE gets the retry continuation on its FIRST attempt too:
						 * the dead run's committed work is already in the doc (its tool
						 * transcript died with it), so without the committed-state message
						 * the SA re-plans from the conversation and burns its early calls
						 * re-creating work the validity gate then rejects. Same recovery
						 * shape as the in-route retry: attempt-N's retry continuation
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
								: promptMessages,
						});

						/* Drive the drain UN-awaited so the loop advances to its terminal state
						 * even when the forward loop below stalls (client gone). Awaiting it
						 * before forwarding would buffer the whole run and kill live streaming.
						 * Swallow its rejection: a failure surfaces as the UI error chunk below,
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
						 * live forward internally and keeps appending to the chunk log, which
						 * is exactly what a later resume replays, so this loop runs to the
						 * stream's end either way (the catch is a last-resort guard). */
						let contextActivityActive = false;
						for await (const chunk of result.toUIMessageStream({
							originalMessages: validated,
							/* One identity for the turn's answer: stamps
							 * `responseMessageId` onto the `start` chunk HERE, upstream
							 * of the choke-point tee, so the chunk log, the barrier
							 * fold, and the live client all name the message the same
							 * (a continuation still reuses its seed's id — the SDK
							 * prefers the trailing assistant id over this). Without it,
							 * the fold and the client-facing stream would each stamp
							 * their own generated id downstream of the tee, splitting
							 * the durable id from the rendered one. Stable across retry
							 * attempts (their duplicate `start` is dropped below). */
							generateMessageId: () => responseMessageId,
							/* Stamp the producing model on the assistant message (rides the
							 * `start` chunk into the client, the chunk log, and the thread
							 * transcript). `sanitizeHistoricalReasoningParts` reads it on
							 * later turns to decide whether a paused round's reasoning is
							 * still replayable: encrypted reasoning is model-bound. */
							messageMetadata: ({ part }) =>
								part.type === "start"
									? { model: saModel, contextVersion: MODEL_CONTEXT_VERSION }
									: undefined,
							onError: (error) => {
								pendingError = error;
								return error instanceof Error ? error.message : String(error);
							},
						})) {
							if (isOpenAICompactionChunk(chunk)) {
								contextActivityActive = true;
								writer.write({
									type: "data-context-activity",
									data: { phase: "start" },
									transient: true,
								});
							} else if (
								contextActivityActive &&
								(chunk.type === "reasoning-start" ||
									chunk.type === "text-start" ||
									chunk.type === "tool-input-start")
							) {
								contextActivityActive = false;
								writer.write({
									type: "data-context-activity",
									data: { phase: "done" },
									transient: true,
								});
							}
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
							 * fresh `start`: carrying a new message id that would strand
							 * the first attempt's content under the old id: is dropped;
							 * everything else appends after the closures written below. */
							if (chunk.type === "start" && turnRetries > 0) continue;
							openParts.observe(chunk);
							try {
								writer.write(chunk);
							} catch {
								break;
							}
						}
						if (contextActivityActive) {
							writer.write({
								type: "data-context-activity",
								data: { phase: "done" },
								transient: true,
							});
						}

						/* Block on the drain so finalization runs on the run's TRUE terminal
						 * state even if forwarding broke off early when the client left. */
						await drained;

						/* Clean, paused, or deauthorized: the post-loop arms own all three.
						 * A deauthorized run must never re-drive (the retry would run more
						 * gated commits as an actor who lost access), and neither must a
						 * PAUSED one: `pausedOnInput` is a one-way latch, so an
						 * askQuestions round that completed before a trailing transient
						 * error must keep today's semantics (the failure funnel) rather
						 * than carry a stale pause latch into a retried attempt: a clean
						 * attempt 2 would then wrongly park a finished run as
						 * awaiting-input. */
						if (
							!sawFatalError ||
							ctx.holderLostError() ||
							ctx.reauthError() ||
							ctx.projectChangedError() ||
							ctx.pausedOnInput()
						) {
							if (heldFinish !== undefined) writer.write(heldFinish);
							break;
						}
						const classified = classifyError(
							pendingError ??
								new Error("The generation stream ended in an error."),
						);
						if (!shouldRetryTurn(classified, turnRetries)) {
							/* Exhausted or non-transient: the failure funnel takes it from
							 * here. Restore the held finish first so the failing wire matches
							 * the pre-retry-loop encoding exactly. */
							if (heldFinish !== undefined) writer.write(heldFinish);
							break;
						}
						turnRetries += 1;
						/* Close the aborted attempt's dangling parts BEFORE anything else
						 * lands on the wire: the transcript then reads as a step that
						 * stopped cleanly, followed by the retried step: nothing stuck
						 * in a streaming state, live or on replay. (The held finish is
						 * deliberately discarded: the message is not done.) */
						for (const closure of openParts.closures()) {
							writer.write(closure);
						}
						/* Recoverable, not fatal: renders as a warning in the signal panel
						 * and lands in the event log with the REAL classified type, the
						 * admin-inspect breadcrumb for diagnosing in-flight provider
						 * faults. The user-facing message says work is preserved. */
						ctx.emitError(
							{ ...classified, message: TURN_RETRY_MESSAGE, recoverable: true },
							"route:turn-retry",
							{ runContinues: true },
						);
						await new Promise((r) =>
							setTimeout(r, turnRetryDelayMs(turnRetries)),
						);
					}

					/* A guarded commit that observed revoked access or a moved Project is
					 * a FATAL run failure that must take
					 * precedence over the clean-completion writers (`completeAndSettleRun` / `clearRunLockAndSettle`) / `awaiting_input` / the edit arm, a
					 * stale-scope run must refund and end in `error`, never report
					 * success and keep its charge. The AI SDK turns the tool `execute()`
					 * throw into a NON-fatal chunk (so `sawFatalError` stays false), which
					 * is why the context flag, not the stream, carries the signal. */
					const holderErr = ctx.holderLostError();
					const scopeErr = ctx.reauthError() ?? ctx.projectChangedError();
					if (holderErr) {
						await failRun(holderErr, "route:holder-lost");
					} else if (sawFatalError || scopeErr) {
						await failRun(
							scopeErr ??
								pendingError ??
								new Error("The generation stream ended in an error."),
							scopeErr ? "route:scope-change" : "route:stream",
						);
					} else if (ctx.pausedOnInput()) {
						/* The run paused on an `askQuestions` round (awaiting the user's
						 * answer) rather than finishing. Stamp `awaiting_input` only while this
						 * exact run still owns the app. A durable `"owned"` leaves the live hold
						 * paused for the answer POST. A reaped/replaced outcome is terminal for
						 * THIS stream: tell the truth, finalize as non-owning/non-paused, and never
						 * leave a resumable question claim on the successor. Infrastructure faults
						 * are not ownership answers, so they take the ordinary failure funnel. */
						let pauseOutcome: ReacquireOutcome | "failed" = "failed";
						try {
							pauseOutcome = await setAwaitingInput(
								appId,
								effectiveRunId,
								holderNonce,
								"edit",
								true,
								userId,
								projectId,
							);
						} catch (error) {
							await failRun(error, "route:pause-stamp");
						}
						if (pauseOutcome === "superseded" || pauseOutcome === "released") {
							ctx.emitError(
								pauseOutcome === "superseded"
									? {
											type: "generation_in_progress",
											message:
												"A newer request took over this app before this question round could pause. Refresh to pick up its changes, then continue there.",
											recoverable: false,
										}
									: {
											type: "run_released",
											message:
												"This run was released before its question round could pause. Refresh to get the latest state, then send your answer again.",
											recoverable: false,
										},
								`route:pause-${pauseOutcome}`,
							);
							await finalizeRun(undefined, {
								heldApp: false,
								paused: false,
							});
						}
					} else {
						/* Clean EDIT completion — the only SA shape after the design
						 * cutover (a chat build finalizes in the orchestrator branch
						 * above). Tripwire, not a gate: with every committed batch gated
						 * against introducing findings, an edit run that ends with a NEW
						 * completeness finding is unreachable except through a bug; the
						 * warn is how one would surface in production. */
						ctx.warnIfEditRunIncomplete();
						/* An edit run can land case-type records (`generateSchema`
						 * declaring a new type), and the chat surface's inline guarded
						 * commits never touch Postgres, so sync the case-store schemas
						 * here, the same "any case-store action after a commit sees a
						 * synced schema" contract the build arm holds. Idempotent upsert;
						 * `materializeCaseStoreSchemas` swallows a TRANSIENT blip and
						 * RETHROWS a DETERMINISTIC fault. Unlike the build arm, an edit
						 * does NOT fail the run on that throw: the edit's blueprint already
						 * committed (awaited, durable) and its 5-credit charge stands, so a
						 * deterministic schema fault is logged at `error` (Sentry-visible)
						 * but the run stays successful: the case-store consumers self-heal
						 * a MISSING (`SchemaNotSyncedError`) / STALE-drift
						 * (`CasePropertiesValidationError` with `additionalProperty`) row at
						 * the point of use (`withSchemaHeal`). */
						const editDoc = ctx.latestPersistedDoc();
						if (editDoc) {
							// Every commit was awaited inline through `commitGuardedBatch`,
							// so `latestPersistedDoc()` is already durable: no save chain
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
					}
				} catch (error) {
					/* Init/build error around the stream setup (a bad message shape, an
					 * SA-construction throw, an attachment-resolution failure). Same funnel
					 * as a streamed failure. */
					await failRun(error, "route:init");
				} finally {
					/* The single finalize call for the CLEAN path (the charge stands;
					 * `flush()` still refunds a zero-cost run on its own gating). On a failed
					 * run this is a no-op: `failRun` already finalized. Awaited so the
					 * response can't resolve before persistence lands; Cloud Run can kill the
					 * container the instant the final byte is written.
					 *
					 * Thread `paused`: a run that paused on `askQuestions` is alive (a later
					 * POST resumes it), so its kept charge must NOT settle and its edit
					 * `run_lock` must NOT release here, its marker is a live hold the
					 * resume's failure funnel may still refund, and its lock is held for the
					 * resume. `ctx.pausedOnInput()` is the same signal the paused arm above
					 * keys on. */
					await finalizeRun(undefined, { paused: ctx.pausedOnInput() });
				}
			} finally {
				/* Last-resort safety net for a throw in the execute PRELUDE (before
				 * the main try) that skips `finalizeRun`: e.g. the serialize-wait /
				 * reacquire / thread-upsert / seed-build stretch. It lives in
				 * execute's OWN `finally`: never an SDK `onEnd`/`onFinish`, which
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
				 * run until the reconnect endpoint's liveness fallback. Idempotent.
				 * `foldOutcome` here is still "skip" on the prelude-throw path — a
				 * POST that never owned the thread seals an outcome no reconciler
				 * consults (its stream never became a thread's marker). */
				await writer.close(foldOutcome).catch(() => {});
				/* Close the barrier fold if `finalizeRun` never did (a prelude
				 * throw): `foldOutcome` is still "skip", so the fold's terminal
				 * write is a no-op — a POST that never owned the run must not
				 * clear markers or append assistant shells to threads other runs
				 * own. Idempotent after a finalize that already closed it. */
				releaseFold();
				await foldDrained;
				/* Flush next: a prelude-throw edit's `flush()` refunds+SETTLES its
				 * marker (zero-cost run), so the run-lock release below never leaves the
				 * app lock-absent-while-unsettled: the same "clear the lock only once
				 * the marker is settled" invariant the failure funnel upholds. Awaited
				 * (not fire-and-forget) so the settle precedes the clear. */
				await usage.flush().catch(() => {});
				void logWriter.flush();
				/* A prelude throw AFTER an EDIT claimed the `run_lock` would otherwise
				 * strand that lock until its 15-min lease: locking the whole shared app
				 * for every other member (RunConflictError → the 120s wait → "still
				 * busy"). Release it, but ONLY when `finalizeRun` never ran (the
				 * prelude-throw case): a run that DID finalize already made the right
				 * lock decision, and a PAUSED edit deliberately keeps its lock. Also
				 * exact-holder gated on this run's `runId` INSIDE the app-row-locked
				 * clear: a superseded/taken-over app now carries a co-member's lock this
				 * must not touch. Gated on `claimedRun.mode === "edit"` so a build or a
				 * lock-less run pays no extra transaction. The flush above already settled
				 * the marker, so this release can't strand the hold. */
				if (!finalizeRan && claimedRun?.mode === "edit") {
					await clearRunLock(appId, effectiveRunId, holderNonce);
				}
			}
		},
		onError: (error) => {
			// Safety net: a model error is surfaced to the user as an error
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
