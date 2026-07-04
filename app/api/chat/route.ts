import {
	convertToModelMessages,
	createUIMessageStream,
	createUIMessageStreamResponse,
	type InferAgentUIMessage,
	isTextUIPart,
	validateUIMessages,
} from "ai";
import {
	classifyError,
	countDocumentsNeedingRead,
	createSolutionsArchitect,
	type ErrorType,
	GenerationContext,
	MESSAGES,
	resolveAttachments,
} from "@/lib/agent";
import { CHAT_REQUEST_MAX_BYTES, declaredBodyTooLarge } from "@/lib/apiError";
import { resolveActiveProjectId, resolveAnthropicKey } from "@/lib/auth-utils";
import type { NovaUIMessage } from "@/lib/chat/attachmentRefs";
import { MAX_CHAT_MESSAGE_CHARS } from "@/lib/chat/limits";
import { selectMessagesToSend } from "@/lib/chat/messageStrategy";
import { validateChatMessages } from "@/lib/chat/validateMessages";
import {
	AppAccessError,
	resolveAppAccess,
	resolveProjectAccess,
} from "@/lib/db/appAccess";
import {
	type ClaimedRun,
	claimRun,
	clearRunLock,
	clearRunLockAndSettle,
	completeAndSettleRun,
	createApp,
	editRunLockHeldBy,
	failApp,
	hasActiveGeneration,
	loadApp,
	loadAppHolderName,
	type ReacquireOutcome,
	RunConflictError,
	reacquireLease,
	restoreRunState,
	setAwaitingInput,
} from "@/lib/db/apps";
import { ACTUAL_COST_BACKSTOP_USD } from "@/lib/db/creditPolicy";
import {
	getCurrentCreditBalance,
	OutOfCreditsError,
	type Reservation,
	reserveCredits,
	settleAndRelease,
} from "@/lib/db/credits";
import { materializeCaseStoreSchemas } from "@/lib/db/materializeCaseStoreSchemas";
import { getMonthlyUsage, UsageAccumulator } from "@/lib/db/usage";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { ensureReferenceIndex } from "@/lib/doc/referenceIndex";
import type { BlueprintDoc, PersistableDoc } from "@/lib/domain";
import { LogWriter } from "@/lib/log/writer";
import { log } from "@/lib/logger";
import { SA_MODEL } from "@/lib/models";
import { creditGateDecision } from "./creditGate";
import { CACHE_TTL_MS, chatRequestSchema } from "./schema";
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

// ── Route Handler ──────────────────────────────────────────────────────

export async function POST(req: Request) {
	// Bound the UNauthenticated parse ahead of `resolveAnthropicKey` below. The
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
	// → a Firestore load + a GCS/extract read) and persisted into the event log,
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
	const keyResult = await resolveAnthropicKey(req);
	if (!keyResult.ok) {
		return new Response(JSON.stringify({ error: keyResult.error }), {
			status: keyResult.status,
		});
	}

	const userId = keyResult.session.user.id;

	/* The credit-gate decision for this POST. Computed from the RAW `messages`
	 * array (the validated-but-untransformed history) and the raw `body.appReady`
	 * — BEFORE the message-strategy transform further down (the `editing &&
	 * cacheExpired` last-user-message-only path). That transform leaves a `user`
	 * message last on every POST, so reading the transformed array here would
	 * charge every clarification round-trip and break the free-continuation
	 * property. (`validateChatMessages` only validates + types the array; it does
	 * not reorder or trim, so `messages` here is still the raw history.) */
	const { chargeable, cost } = creditGateDecision({
		rawMessages: messages,
		appReady: !!body.appReady,
	});

	/* Credit gate — fast-fail read. Sits where the dollar cap used to, at the top
	 * of the handler, and FAILS CLOSED: any Firestore read error rejects with 503
	 * rather than letting an ungated/uncharged generation through. This is the
	 * cheap pre-flight read; the transactional reservation that actually books
	 * the charge runs later, after every pre-stream rejection point.
	 *
	 * Two independent checks:
	 *   (a) Actual-$ backstop — runs on EVERY POST (continuations included), so a
	 *       user hammering a broken app on free continuations still trips it. The
	 *       dollar threshold is never surfaced to the user (the message must not
	 *       leak "$50").
	 *   (b) Credit balance — only on CHARGEABLE POSTs. A continuation never
	 *       reserves, so it has no balance to check; gating it here would also
	 *       create an orphan app in the common out-of-credits case. */
	try {
		const usage = await getMonthlyUsage(userId);
		if ((usage?.cost_estimate ?? 0) >= ACTUAL_COST_BACKSTOP_USD) {
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

	const { runId, lastResponseAt, appReady } = parsed.data;

	/* Stable per-request run identifier. Every event envelope (mutation or
	 * conversation) carries this value; the client echoes it back on follow-up
	 * requests so threads stay aligned across turns. Minted here — before any
	 * Firestore work — so failure paths below can still surface it if needed. */
	const effectiveRunId = runId ?? crypto.randomUUID();

	/*
	 * Resolve appId for authenticated users. Existing apps already have
	 * an ID from the client. New builds create a real app document in Firestore
	 * (status: 'generating') so log events have an app to live under from the start.
	 *
	 * The app doc is created BEFORE the concurrency check so it acts as a
	 * lock — a second concurrent request will see this doc in `hasActiveGeneration`
	 * and reject. Without this ordering, two simultaneous requests could both
	 * pass the check before either writes a doc (classic TOCTOU).
	 */
	let appId = parsed.data.appId;
	let appCreated = false;
	/* The persisted app doc for an EXISTING-app request — captured off the
	 * authorization read below so the SA's working doc seeds from the saved
	 * blueprint with no extra Firestore fetch. Undefined for a new build (no
	 * app exists yet); the seed falls back to the empty doc there. */
	let loadedApp:
		| Awaited<ReturnType<typeof resolveAppAccess>>["app"]
		| undefined;
	/* The app's Project — the media tenant. Set in BOTH branches below (the
	 * active Project for a new build, the app's Project for an existing one) and
	 * used to scope chat-attachment resolution (`resolveAttachments`) to the
	 * Project the documents live in. */
	let projectId: string | undefined;
	/* Set when this POST claimed an existing app's run window (`claimRun` —
	 * a build flipped to `generating`, or an edit's `run_lock`). Carries the
	 * shape the claim moved the app out of, so the post-claim bail-out arms
	 * (concurrency, out-of-credits, reservation failure) can put the row back
	 * exactly where the claim found it — failing a previously-`complete` app to
	 * `error` over a rejected request would brick a working app. Set either
	 * pre-stream (the free / first-claim path) or inside `execute` (after the
	 * serialize-with-wait poll loop). */
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
			 * — a BUILD-mode instruction (`!appReady`) flips the row to
			 * `generating`; an EDIT (`appReady`) takes a `run_lock` without
			 * touching status. The claim is the per-app serialization lock:
			 * `hasActiveGeneration` below excludes this appId (so a run isn't
			 * blocked by its own row), so it can't arbitrate two POSTs on the SAME
			 * app — the transactional compare-and-flip inside `claimRun` is what
			 * serializes them, across BOTH modes (a build waits on a live edit-lock
			 * and vice versa, and on a PAUSED run of either mode — a paused run blocks
			 * a claim). A build claim covers every FREE shape the row can be in: a
			 * retry of a failed build (`error`), a new instruction into a finished one
			 * (`complete`), or a hard-killed `generating` row past its window.
			 *
			 * On a CONFLICT the route does not 429 — it defers the whole
			 * claim/gate/run sequence into `execute` behind a poll-wait
			 * (`waitForClaim`), so a second collaborator's request serializes
			 * behind the holder instead of bouncing. A NON-conflicting claim
			 * (free / first) proceeds through the pre-stream gating below,
			 * unchanged. */
			claimMode = parsed.data.appReady ? "edit" : "build";
			try {
				claimedRun = await claimRun(appId, claimMode, effectiveRunId, userId);
			} catch (err) {
				if (err instanceof RunConflictError) {
					/* The app is held — wait inside the stream (below), don't reject. */
					waitForClaim = true;
				} else {
					log.error("[chat] run claim write failed", err, { appId });
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

	/**
	 * Put a claimed run window back where `claimRun` found it — the bail-out arms
	 * (concurrency, out-of-credits, reservation failure) call this so a rejected
	 * request leaves the app EXACTLY as it was, whatever the claim moved out of (a
	 * plain `complete` / `error` app, or a hard-killed `generating` row — a claim
	 * only ever runs on a FREE app). `restoreRunState` writes the captured `prior`
	 * snapshot back verbatim — a faithful revert, not a lossy from-enum
	 * reconstruction. Fire-and-forget like `failApp`: a rejection must not block on
	 * Firestore, and a dropped revert degrades to the reaper settling the still-held
	 * row (refund-first). */
	const restoreClaimedRun = (claim: ClaimedRun): void => {
		void restoreRunState(appId, claim.prior);
	};

	/* The credit reservation this run booked — set by `runPostClaimGate` below
	 * (pre-stream on the free/first path, or inside `execute` after the
	 * serialize-with-wait poll loop). Threaded into the accumulator so a failed
	 * or no-op run refunds the exact charge against the exact month. */
	let reservation: Reservation | undefined;

	/**
	 * The post-`claimRun` gate: the cross-app concurrency check + the
	 * transactional credit reservation, run in that order AFTER the run window is
	 * claimed. Returns `null` on success (having set `reservation`), or a bail
	 * descriptor when a gate rejects — the caller surfaces it (a pre-stream
	 * `Response.json`, or an in-`execute` error data event) and, either way, this
	 * has already restored the claimed run window so a rejected request leaves the
	 * app exactly as it was.
	 *
	 * Shared by both paths because the serialize-with-wait flow moves the whole
	 * post-claim sequence inside `execute` (a stream write can only happen there),
	 * while the non-conflict path keeps it pre-stream — the gate logic must be
	 * identical on both.
	 */
	const runPostClaimGate = async (): Promise<{
		type: "generation_in_progress" | "out_of_credits" | "internal";
		message: string;
		status: number;
	} | null> => {
		// Cross-app concurrency guard — a NEW/retry BUILD only (`chargeable &&
		// !appReady`). It enforces "one build at a time per user" via
		// `hasActiveGeneration`, which queries `status === 'generating'` (only builds
		// set it) across Cloud Run instances. Gated by BOTH:
		//  - `!appReady` (build, not edit): an EDIT serializes PER-APP via its
		//    `run_lock`, NOT per-user, so a user editing app B must NOT be blocked by
		//    their own live BUILD on app A. Intended policy: edit one app while
		//    building another.
		//  - `chargeable` (a fresh instruction, not a free continuation): a paused-BUILD
		//    RESUME is `!appReady` too, but it claims/reserves NOTHING new — it
		//    continues a run that already passed this cap. Gating on `chargeable`
		//    keeps a resume from being 429'd by the user's own live build elsewhere
		//    (a bare `!appReady` gate would reject exactly that).
		// Runs AFTER the claim so the durable claimed window acts as the lock;
		// retries on the same app pass through (excludeAppId). A held-app WAITER
		// reaches here only once the prior holder released, so its own fresh claim is
		// what this now guards.
		if (chargeable && !appReady) {
			try {
				const inFlight = await hasActiveGeneration(userId, appId);
				if (inFlight) {
					if (appCreated) {
						failApp(appId, "generation_in_progress");
					} else if (claimedRun) {
						restoreClaimedRun(claimedRun);
					}
					return {
						type: "generation_in_progress",
						message: MESSAGES.generation_in_progress,
						status: 429,
					};
				}
			} catch (err) {
				log.error("[chat] concurrency check failed", err);
				// Fail open — if we can't check, let the request through rather than
				// blocking users due to a transient Firestore read error. The credit
				// gate's fast-fail read above already fails closed for budget
				// protection, and the reservation transaction below is the true
				// no-overshoot guard.
			}
		}

		/* Reserve the credits for this run — the transactional no-overshoot guard.
		 *
		 * Placement is load-bearing: this runs AFTER every rejection point (the
		 * concurrency guard just above) so a successful reservation is never
		 * followed by an early return that would leak the booked charge. A failed
		 * or no-op run refunds through the accumulator's `flush()`.
		 *
		 * Unlike the fast-fail balance read above (which can race a concurrent
		 * run), the reservation reads-checks-debits atomically, closing the
		 * cross-app concurrent-new-run race that `hasActiveGeneration` (per-app,
		 * fail-open) does not. A free continuation never reserves. */
		if (chargeable) {
			try {
				reservation = await reserveCredits(userId, cost, appId, effectiveRunId);
			} catch (err) {
				if (err instanceof OutOfCreditsError) {
					// Lost the rare race: passed the fast-fail balance read, then a
					// concurrent reservation depleted the balance before this debit.
					// Fail the just-created build doc — and put a claimed run window
					// back where the claim found it. An ordinary existing-app request
					// with no claim stays untouched.
					if (appCreated) {
						failApp(appId, "out_of_credits");
					} else if (claimedRun) {
						restoreClaimedRun(claimedRun);
					}
					return {
						type: "out_of_credits",
						message: MESSAGES.out_of_credits,
						status: 429,
					};
				}
				// Any other failure is infrastructure (Firestore down / transaction
				// contention exhausted). Fail closed — never silently skip the charge
				// and let an uncharged generation through. A claimed run window is put
				// back first — leaving it held would hand a working app to the reaper
				// over a request that never ran.
				if (claimedRun) {
					restoreClaimedRun(claimedRun);
				}
				log.error("[chat] credit reservation failed", err);
				/* The user-facing message must not read as a balance problem — this
				 * arm is infrastructure, and a credits framing would send the user
				 * chasing their allowance instead of retrying. It also asserts
				 * NOTHING about the charge: the transaction usually rolled back,
				 * but an ambiguous RPC outcome can leave the debit applied. */
				return {
					type: "internal",
					message:
						"That message didn't go through. Please try again in a moment.",
					status: 503,
				};
			}
		}
		return null;
	};

	/* Non-conflict path: the claim already succeeded pre-stream (a free / first
	 * claim), so run the concurrency + reservation gate pre-stream too, exactly
	 * as before, and bail with a `Response.json` on rejection. On a CONFLICT
	 * (`waitForClaim`), this whole sequence is DEFERRED into `execute` behind the
	 * poll-wait — skip it here. */
	if (!waitForClaim) {
		const bail = await runPostClaimGate();
		if (bail) {
			return Response.json(
				{ error: bail.message, type: bail.type },
				{ status: bail.status },
			);
		}
	}

	/* The paused-run resume's pause-flag clear does NOT happen pre-stream — it
	 * moves INSIDE `execute`, folded into `reacquireLease`'s success transaction,
	 * for BOTH modes. A SUPERSEDED resume (of either shape) must touch NOTHING on
	 * an app a co-member now owns: clearing `awaiting_input` there could flip the
	 * co-member's own live pause into a blocking lock, or unflag a run this POST
	 * doesn't own. `reacquireLease` clears the flag only on the owns-it branch, in
	 * the same txn that renews the lease. */

	/* Two collaborators replace the legacy EventLogger:
	 *
	 *  - `logWriter` batches durable event envelopes to Firestore (one doc per
	 *    mutation/conversation event). Failures never throw.
	 *  - `usage` accumulates per-call token counts for the actual-$ ledger and
	 *    the per-run summary document, and carries this run's credit reservation
	 *    so a failed or no-op run can refund it. Flushed on every terminal path.
	 *
	 * Placeholder fields (`promptMode` / `freshEdit` / `appReady` / `cacheExpired`
	 * / `moduleCount`) are rewritten via `usage.configureRun()` inside the
	 * execute block once we know the editing mode. */
	/* Chat-surface writer — every event out of this route is stamped
	 * `source: "chat"`. The MCP endpoint constructs its own LogWriter
	 * with `source: "mcp"`; the writer is the single authority on the
	 * surface tag so the two cannot drift. */
	const logWriter = new LogWriter(appId, "chat");
	const usage = new UsageAccumulator({
		appId,
		userId,
		runId: effectiveRunId,
		model: SA_MODEL,
		promptMode: "build",
		freshEdit: false,
		appReady: false,
		cacheExpired: false,
		moduleCount: 0,
		/* Reservation context for the refund branch in `flush()`. All three travel
		 * together (a chargeable turn that reserved) or all absent (a free
		 * continuation, which never reserves). On the NON-conflict path `reservation`
		 * is already set (the pre-stream gate ran), so seed it here. On the
		 * serialize-with-wait path the reservation lands INSIDE `execute` (after the
		 * poll loop + `claimRun`), so seed nothing now and set all three via
		 * `usage.configureRun` there — seeding a `didReserve` with no `chargePeriod`
		 * would leave the flush's refund gate half-armed. */
		didReserve: waitForClaim ? undefined : chargeable,
		reservedAmount: waitForClaim ? undefined : chargeable ? cost : undefined,
		chargePeriod: waitForClaim ? undefined : reservation?.period,
	});

	/* POST-scope mirror of the execute-local `finalized` latch, readable by the
	 * `onFinish` net (a sibling scope that can't see execute's closure). Set true
	 * whenever `finalizeRun` runs to completion; `onFinish`'s stranded-lock release
	 * fires ONLY when this stayed false — i.e. the prelude threw before any
	 * `finalizeRun`. A run that DID finalize (clean / failed / paused) already made
	 * the correct lock decision (a paused edit deliberately KEEPS its lock), so
	 * `onFinish` must not second-guess it. */
	let finalizeRan = false;

	/* No `req.signal` disconnect handling: the run is no longer tied to the
	 * browser connection. The agent loop is drained server-side (see the execute
	 * block), so a closed tab neither cancels the run nor finalizes it — `flush()`
	 * runs once on the run's true terminal state regardless of whether anyone is
	 * still reading. A run the process can't finish (hard kill) is settled by the
	 * stale-`generating` reaper. */
	const stream = createUIMessageStream({
		execute: async ({ writer }) => {
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
			};

			/**
			 * Classify + surface a generation error, then finalize the run as failed —
			 * the single failure funnel for both an init/build throw and a streamed
			 * model error. Emits the classified error as a conversation event and, on a
			 * chargeable run, the optimistic `data-credit-refund` toast (the
			 * authoritative decrement lands in `flush()` inside `finalizeRun`).
			 */
			const failRun = async (error: unknown, source: string): Promise<void> => {
				const classified = classifyError(error);
				ctx.emitError(classified, source);
				if (chargeable && !refundSignalled) {
					refundSignalled = true;
					writer.write({
						type: "data-credit-refund",
						data: { amount: cost },
						transient: true,
					});
				}
				await finalizeRun(classified);
			};

			/* Serialize-with-wait — the pre-stream claim CONFLICTED (another run
			 * holds this app). Rather than 429, poll `claimRun` until the holder
			 * releases (or the wait times out), then run the post-claim gate that
			 * the non-conflict path already ran pre-stream. This whole
			 * post-`claimRun` sequence lives inside the stream (a conversation event
			 * / error can only be written here). A successful claim sets `claimedRun`
			 * + `reservation`, so the rest of `execute` runs exactly as the
			 * non-conflict path does. */
			if (waitForClaim && claimMode) {
				const holderName = await loadAppHolderName(appId);
				/* User-visible busy indicator: a non-fatal (recoverable) conversation
				 * event the client toasts + shows in the signal panel, so the waiter
				 * sees WHY nothing is happening yet. `recoverable: true` renders it as
				 * a warning, not an error — the request hasn't failed, it's queued
				 * behind the holder. (A `data-phase` pulse was tried here but no client
				 * reducer renders it — this conversation event IS the busy signal.) */
				ctx.emitError(
					{
						type: "generation_in_progress",
						message: `Waiting — ${holderName}'s request is running on this app. Only one request runs at a time; yours will start automatically when theirs finishes.`,
						recoverable: true,
					},
					"route:serialize-wait",
				);

				const deadline = Date.now() + CLAIM_WAIT_MAX_MS;
				let claimError: unknown;
				while (Date.now() < deadline) {
					await new Promise((r) => setTimeout(r, CLAIM_WAIT_POLL_MS));
					try {
						claimedRun = await claimRun(
							appId,
							claimMode,
							effectiveRunId,
							userId,
						);
						break;
					} catch (err) {
						if (err instanceof RunConflictError) continue; // still held — keep waiting
						claimError = err;
						break;
					}
				}

				if (!claimedRun) {
					/* Timed out still-busy, or the claim write itself faulted. Emit a
					 * friendly close and end — nothing was claimed or reserved, so
					 * there is no window to restore and no charge to refund. The
					 * `finally` still flushes (a no-op refund) + drains the log. */
					if (claimError) {
						log.error("[chat] serialize-wait claim write failed", claimError, {
							appId,
						});
					}
					ctx.emitError(
						{
							type: claimError ? "internal" : "generation_in_progress",
							message: claimError
								? "Couldn't start your request just now. Please try again shortly."
								: `Still busy — ${holderName}'s request is taking a while. Please try again in a moment.`,
							recoverable: false,
						},
						"route:serialize-wait-timeout",
					);
					/* Held nothing (never won the claim) — flush + log only, and do NOT
					 * touch the marker/lock (the app is still held by the OTHER run). */
					await finalizeRun(undefined, { heldApp: false });
					return;
				}

				/* Won the claim after waiting — run the deferred concurrency +
				 * reservation gate. On a bail, surface it as a fatal conversation
				 * event and end. The gate already RESTORED the claimed window
				 * (`restoreClaimedRun`), so this POST no longer holds the app —
				 * `heldApp: false` keeps the finalize from re-touching it. */
				const bail = await runPostClaimGate();
				if (bail) {
					ctx.emitError(
						{ type: bail.type, message: bail.message, recoverable: false },
						"route:serialize-wait-gate",
					);
					await finalizeRun(undefined, { heldApp: false });
					return;
				}

				/* Reservation landed inside the stream on this path — tell the
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
					/* The two lost shapes read very differently to the person answering,
					 * so tell the truth per shape: "superseded" means another run
					 * actually holds the app now; "released" means the run simply timed
					 * out waiting and a scan reaped it (refund + free) with no
					 * re-claim — on a personal Project that is the ONLY lost shape, so
					 * a takeover message there would always be false. */
					ctx.emitError(
						reacquire === "superseded"
							? {
									type: "generation_in_progress",
									message:
										"Someone else started working on this app while you were answering, so this request was superseded. Refresh to pick up their changes, then try again.",
									recoverable: false,
								}
							: {
									type: "run_released",
									message:
										"This run waited for your answer longer than its window allows, so it was released and its hold was refunded. Refresh to get the latest state, then send your answer again.",
									recoverable: false,
								},
						reacquire === "superseded"
							? "route:resume-superseded"
							: "route:resume-released",
					);
					await finalizeRun(undefined, { heldApp: false });
					return;
				}
				/* `reacquireLease` already cleared `awaiting_input` + renewed the lease
				 * in its transaction (only when ownership held), so a superseded resume
				 * never touched the app a co-member now owns. No separate pause-clear. */
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
			 * Brand-new builds get the empty doc stamped with the Firestore
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
				/* Defensive — the useChat flow always ends with a user message, but
				 * if a caller bypassed the client and sent a malformed history we
				 * would silently drop the user-message event. Warn so the skip is
				 * visible in logs; the request still proceeds without the event. */
				log.warn(
					"[chat] last message not user-role; skipping user-message event",
					{
						role: lastMessage.role,
					},
				);
			}

			try {
				/* Two orthogonal decisions:
				 *
				 * 1. **Editing vs. build** — determined by appReady alone. If the app
				 *    exists (builder phase Ready/Completed), the SA always gets the
				 *    editing prompt + blueprint summary and only shared tools. This
				 *    holds for the entire edit session, including follow-up requests
				 *    after askQuestions rounds.
				 *
				 * 2. **Message strategy** — determined by cache expiry. When the
				 *    Anthropic prompt cache has expired (>5 min since last response),
				 *    only the last user message is sent (one-shot). Within the cache
				 *    window, full conversation history is sent so the SA can iterate
				 *    with context from prior turns (e.g. askQuestions answers).
				 *
				 * appReady is false during initial generation even after modules
				 * exist, so generation tools are never stripped mid-build. */
				const editing = !!appReady;
				const cacheExpired =
					!lastResponseAt ||
					Date.now() - new Date(lastResponseAt).getTime() > CACHE_TTL_MS;

				/* Backfill the accumulator seed now that we know the real
				 * editing/cache signals. These fields land on the per-run
				 * summary doc via `usage.flush()` — replaces the deleted
				 * `logger.logConfig` call (ConfigEvent removed in T3). */
				usage.configureRun({
					promptMode: editing ? "edit" : "build",
					freshEdit: editing && cacheExpired,
					appReady: editing,
					cacheExpired,
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

				/* The messages to actually send the SA this turn. `selectMessagesToSend`
				 * applies the one-shot trim (expired-cache edit → only the last user
				 * message; its system prompt already carries a compact blueprint
				 * summary, so prior turns would just burn tokens against a dead cache).
				 * Selecting BEFORE the resolve below is what makes an expired-cache edit
				 * avoid downloading/extracting history attachments it would then
				 * discard — the resolve runs over exactly the messages that will be
				 * sent. */
				const messagesToSend = selectMessagesToSend(messages, {
					editing,
					cacheExpired,
				});

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

				/* Strip historical tool parts that name a tool absent from THIS
				 * request's tool set — any such part would make Anthropic reject the
				 * request ("tool not found in tools array"). Two ways history carries
				 * an absent tool: a build-only planning tool (`generateSchema` /
				 * `planAppDesign`) carried into an edit turn, or a tool that has since
				 * been removed or renamed (a thread predating a deploy that changed
				 * the tool surface — e.g. the old singular `addCaseListColumn` /
				 * `addSearchInput` / `addField`, or the retired `generateScaffold` /
				 * `completeBuild`). The strip runs on EVERY continuation: build
				 * continuations always send full history, and a build paused on
				 * `awaiting_input` is exactly the shape designed to SURVIVE a deploy —
				 * gating the strip to edits would brick its resume on
				 * `validateUIMessages`, fail+refund the run, and re-poison every
				 * retry with the same history. (An expired-cache edit was already
				 * trimmed to the last user message above, so it strips nothing.)
				 * Keyed on `sa.tools` so the filter never drifts from the active set
				 * (more robust than a hardcoded legacy-name list). Stripping by part
				 * type removes both the call and its output in one step — the AI SDK
				 * keeps both sides of a tool invocation on the same part — so the
				 * converted Anthropic messages keep matched `tool_use` /
				 * `tool_result` pairs for the tools that remain. Assistant turns that
				 * collapse to zero parts are dropped so the wire carries no empty
				 * turns. Deterministic in its inputs, so successive requests produce
				 * identical cacheable prefixes. */
				const activeToolPartTypes = new Set<string>(
					Object.keys(sa.tools).map((name) => `tool-${name}`),
				);
				const stripUnknownToolParts = (
					m: NovaUIMessage,
				): NovaUIMessage | undefined => {
					if (m.role !== "assistant") return m;
					const nextParts = m.parts.filter(
						(p) =>
							!(p.type.startsWith("tool-") && !activeToolPartTypes.has(p.type)),
					);
					if (nextParts.length === 0) return undefined;
					return nextParts.length === m.parts.length
						? m
						: { ...m, parts: nextParts };
				};
				const effectiveMessages = preparedMessages
					.map(stripUnknownToolParts)
					.filter((m): m is NovaUIMessage => m !== undefined);

				/* Record the input-context composition for the per-run finalize
				 * log: how many messages were actually sent (after the cache-expiry
				 * last-message-only trim + the resolve) and their serialized size. The
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
				const modelMessages = await convertToModelMessages(validated, {
					tools: sa.tools,
				});
				const result = await sa.stream({ prompt: modelMessages });

				/* Drive the drain UN-awaited so the loop advances to its terminal state
				 * even when the forward loop below stalls (client gone). Awaiting it
				 * before forwarding would buffer the whole run and kill live streaming.
				 * Swallow its rejection — a failure surfaces as the UI error chunk below,
				 * not as a thrown drain. */
				const drained = Promise.resolve(result.consumeStream()).catch(() => {});

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
				 * chunk is dropped; tool-error chunks forward like any other. A failing
				 * `writer.write` means the client is gone, so stop forwarding (releasing
				 * the tee branch) but let the drain finish server-side. */
				let pendingError: unknown;
				let sawFatalError = false;
				for await (const chunk of result.toUIMessageStream({
					originalMessages: validated,
					onError: (error) => {
						pendingError = error;
						return error instanceof Error ? error.message : String(error);
					},
				})) {
					if (isFatalStreamErrorChunk(chunk.type)) {
						sawFatalError = true;
						continue;
					}
					try {
						writer.write(chunk);
					} catch {
						break;
					}
				}

				/* Block on the drain so finalization runs on the run's TRUE terminal
				 * state even if forwarding broke off early when the client left. */
				await drained;

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
					/* An edit run can land case-type records (`createModule` with
					 * `case_type_record`), and the chat surface's inline guarded
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
		},
		onFinish() {
			/* Last-resort safety net for a throw in the execute PRELUDE (before the
			 * main try) that skips `finalizeRun` — e.g. the `hydratePersistedBlueprint`
			 * / `ensureReferenceIndex` seed build. The execute block's awaited
			 * `finally` is the primary finalize path; this only matters if the prelude
			 * itself threw. Idempotent. (The lease heartbeat is started only AFTER the
			 * prelude, inside the main try whose `finally` always runs `finalizeRun` →
			 * `stopRunLeaseHeartbeat`, so a prelude throw that lands here never leaves
			 * a timer running.) */
			void (async () => {
				/* Flush FIRST: a prelude-throw edit's `flush()` refunds+SETTLES its
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
						log.error("[chat] onFinish run-lock release check failed", err, {
							appId,
						});
					}
				}
			})();
		},
		onError: (error) => {
			// Safety net — a model error is surfaced to the user as an error
			// conversation event via `ctx.emitError` in the execute block; this only
			// catches an unexpected throw out of `execute` itself.
			log.error("[chat] stream error", error);
			return error instanceof Error ? error.message : String(error);
		},
	});

	return createUIMessageStreamResponse({ stream });
}
