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
import { resolveAnthropicKey } from "@/lib/auth-utils";
import type { NovaUIMessage } from "@/lib/chat/attachmentRefs";
import { MAX_CHAT_MESSAGE_CHARS } from "@/lib/chat/limits";
import { selectMessagesToSend } from "@/lib/chat/messageStrategy";
import { validateChatMessages } from "@/lib/chat/validateMessages";
import {
	createApp,
	failApp,
	hasActiveGeneration,
	loadAppOwnerAndStatus,
	setAwaitingInput,
} from "@/lib/db/apps";
import { ACTUAL_COST_BACKSTOP_USD } from "@/lib/db/creditPolicy";
import {
	getCurrentCreditBalance,
	OutOfCreditsError,
	type Reservation,
	refundReservation,
	reserveCredits,
} from "@/lib/db/credits";
import { getMonthlyUsage, UsageAccumulator } from "@/lib/db/usage";
import {
	type CommitPhase,
	commitPhaseForAppStatus,
} from "@/lib/doc/commitVerdicts";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
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

// ── Route Handler ──────────────────────────────────────────────────────

export async function POST(req: Request) {
	const body = await req.json();

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

	const { doc, runId, lastResponseAt, appReady } = parsed.data;

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
	/* Validity-gate phase, derived server-side from the app doc's own
	 * lifecycle status (`commitPhaseForAppStatus`) — never from the
	 * client-reported `appReady` flag, which picks only the prompt/tool
	 * mode. A brand-new build's doc is created `generating` below, so it
	 * gates under the construction window without a re-read. */
	let commitPhase: CommitPhase = "building";
	if (!appId) {
		try {
			appId = await createApp(userId, effectiveRunId);
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
		/* Verify ownership — apps are a root-level collection, so the path no
		 * longer scopes writes to the authenticated user. Without this check,
		 * a crafted request with another user's appId would overwrite their app. */
		const access = await loadAppOwnerAndStatus(appId);
		if (!access || access.owner !== userId) {
			return Response.json(
				{ error: "App not found", type: "not_found" },
				{ status: 404 },
			);
		}
		commitPhase = commitPhaseForAppStatus(access.status);
		/* This POST runs against an existing app — if it's resuming a build that
		 * paused on an `askQuestions` round, clear the pause flag now (before the
		 * stream) so a resume that then hard-kills becomes reapable again. A no-op
		 * for an ordinary edit (the field is absent). The run re-sets it below if it
		 * pauses on a question again. */
		void setAwaitingInput(appId, false);
	}

	// Concurrency guard — only one generation at a time per user. Prevents
	// concurrent requests from racing past the credit gate and works across
	// Cloud Run instances because the check is Firestore-based.
	//
	// Runs AFTER createApp so the new doc acts as a lock. If another build
	// is already in progress, we fail the just-created doc and return 429.
	// Retries on the same app pass through (excludeAppId).
	try {
		const inFlight = await hasActiveGeneration(userId, appId);
		if (inFlight) {
			if (!parsed.data.appId) {
				failApp(appId, "generation_in_progress");
			}
			return Response.json(
				{
					error: MESSAGES.generation_in_progress,
					type: "generation_in_progress",
				},
				{ status: 429 },
			);
		}
	} catch (err) {
		log.error("[chat] concurrency check failed", err);
		// Fail open — if we can't check, let the request through rather than
		// blocking users due to a transient Firestore read error. The credit
		// gate's fast-fail read above already fails closed for budget protection,
		// and the reservation transaction below is the true no-overshoot guard.
	}

	/* Reserve the credits for this run — the transactional no-overshoot guard.
	 *
	 * Placement is load-bearing: this runs AFTER every pre-stream rejection point
	 * (createApp's 503, the ownership 404, the concurrency 429) and BEFORE the
	 * accumulator/stream are constructed. So a successful reservation is never
	 * followed by an early return that would leak the booked charge — the only
	 * returns past this point are this block's own catch arms, which fire only
	 * when the transaction THREW (rolled back, nothing booked). Everything else
	 * runs inside the stream, where `flush()` refunds a failed or no-op run.
	 *
	 * Unlike the fast-fail balance read above (which can race a concurrent run),
	 * the reservation reads-checks-debits atomically, closing the cross-app
	 * concurrent-new-run race that `hasActiveGeneration` (per-app, fail-open)
	 * does not. A free continuation never reserves. */
	let reservation: Reservation | undefined;
	if (chargeable) {
		try {
			reservation = await reserveCredits(userId, cost, appId);
		} catch (err) {
			if (err instanceof OutOfCreditsError) {
				// Lost the rare race: passed the fast-fail balance read, then a
				// concurrent reservation depleted the balance before this debit. Fail
				// the just-created build doc (a retry on an existing app must not) and
				// surface the same out-of-credits 429 the fast-fail read returns.
				if (appCreated) {
					failApp(appId, "out_of_credits");
				}
				return Response.json(
					{ error: MESSAGES.out_of_credits, type: "out_of_credits" },
					{ status: 429 },
				);
			}
			// Any other failure is infrastructure (Firestore down / transaction
			// contention exhausted). Fail closed — never silently skip the charge
			// and let an uncharged generation through.
			log.error("[chat] credit reservation failed", err);
			return Response.json(
				{
					error: "Unable to reserve credits. Please try again shortly.",
					type: "internal",
				},
				{ status: 503 },
			);
		}
	}

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
		 * continuation, which never reserves). `reservation` is set iff `chargeable`
		 * succeeded above, so its `period` is present exactly when `didReserve` is. */
		didReserve: chargeable,
		reservedAmount: chargeable ? cost : undefined,
		chargePeriod: reservation?.period,
	});

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

			/* Build the SA's working doc. The client ships the persistable
			 * slice (no `fieldParent`) on wire; we deep-clone so in-flight
			 * mutations never leak back into the request body, then rebuild
			 * the reverse-parent index the SA's mutation helpers rely on.
			 * Brand-new builds get the empty doc stamped with the Firestore
			 * `appId` that `createApp` just minted. */
			const sessionDoc: BlueprintDoc = doc
				? structuredClone({ ...doc, fieldParent: {} })
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
						fieldParent: {},
					};
			rebuildFieldParent(sessionDoc);

			const ctx = new GenerationContext({
				apiKey: keyResult.apiKey,
				writer,
				logWriter,
				usage,
				session: keyResult.session,
				appId,
				/* Server-derived gate phase (see the `commitPhase` resolution
				 * beside the ownership check) — the app doc's status, not the
				 * client's `appReady` flag, decides whether the completeness
				 * ratchet holds. */
				commitPhase,
			});

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
			 */
			const finalizeRun = async (failure?: {
				type: ErrorType;
			}): Promise<void> => {
				if (finalized) return;
				finalized = true;
				if (failure) usage.markRunFailed();
				await usage.flush();
				await logWriter.flush();
				if (failure) {
					/* Settle the run's reservation off the durable marker, THEN flip to
					 * `error`. `flush` above refunds a hold THIS POST booked, but a
					 * multi-POST run's hold may have been booked by an EARLIER POST
					 * (askQuestions: an earlier chargeable POST reserves, then a free
					 * continuation fails here), and `refundReservation` reads the hold off
					 * the marker so it settles it no matter which POST booked it.
					 * Idempotent: a no-op when flush already settled it or there is nothing
					 * to settle. Flip to `error` only once the hold is settled; a refund
					 * that did not commit leaves the build `generating` for the reaper to
					 * retry (mirroring `reapStaleGenerating`'s refund-before-flip). */
					let refundSettled = true;
					try {
						await refundReservation(appId);
					} catch (err) {
						refundSettled = false;
						log.error("[chat] failed-run reservation refund failed", err, {
							appId,
						});
					}
					/* Flip to `error` only for a BUILD (the app is `generating`). A failed
					 * EDIT must NOT flip its already-`complete` app to `error`: that would
					 * brick a working app over a transient model error (the build page
					 * redirects non-`complete` apps; the list hides the open-link for
					 * `error`), leaving the user no path back to a blueprint that is fine on
					 * disk. The failed edit still refunds its hold (above) and surfaces the
					 * error via the conversation event (`failRun`); the app stays open. */
					if (refundSettled && !appReady) {
						failApp(appId, failure.type);
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
				 * in the run log (like `validation-attempt`). */
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
					userId,
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

				/* Live-cache edits send full history. Any tool-use/result part that
				 * names a tool absent from THIS request's tool set would make
				 * Anthropic reject the request ("tool not found in tools array").
				 * Two ways a historical part can name an absent tool: a build-only
				 * generation tool (`generateSchema` / `generateScaffold`) carried into
				 * an edit turn, or a tool that has since been removed or renamed (a
				 * build thread predating a deploy that changed the tool surface — e.g.
				 * the old singular `addCaseListColumn` / `addSearchInput` / `addField`).
				 * Strip any `tool-<name>` part whose `<name>` isn't a currently-
				 * registered tool, keyed on `sa.tools` so the filter never drifts from
				 * the active set (more robust than a hardcoded legacy-name list).
				 * Stripping by part type removes both the call and its output in one
				 * step — the AI SDK keeps both sides of a tool invocation on the same
				 * part — so the converted Anthropic messages keep matched
				 * `tool_use` / `tool_result` pairs for the tools that remain.
				 * Assistant turns that collapse to zero parts are dropped so the wire
				 * carries no empty turns. Deterministic in its inputs, so successive
				 * edit requests produce identical cacheable prefixes. (Expired-cache
				 * edits already trimmed to the last user message above, so this is a
				 * no-op for them — hence it runs only for the live-cache edit branch.) */
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
				const effectiveMessages =
					editing && !cacheExpired
						? preparedMessages
								.map(stripUnknownToolParts)
								.filter((m): m is NovaUIMessage => m !== undefined)
						: preparedMessages;

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

				if (sawFatalError) {
					await failRun(
						pendingError ??
							new Error("The generation stream ended in an error."),
						"route:stream",
					);
				} else if (ctx.pausedOnInput()) {
					/* The run paused on an `askQuestions` round (awaiting the user's
					 * answer) rather than finishing. Mark the build `awaiting_input` so the
					 * staleness reaper skips it — it's alive, not hard-killed, and a later
					 * POST will resume it. The charge stands (the clean finally's
					 * `finalizeRun()` flushes it); the flag is cleared when that POST
					 * resumes the run. */
					await setAwaitingInput(appId, true);
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
				 * container the instant the final byte is written. */
				await finalizeRun();
			}
		},
		onFinish() {
			/* Last-resort safety net for a throw in the execute prelude (before the
			 * try) that skips `finalizeRun`. The execute block's awaited `finally`
			 * is the primary finalize path; this fire-and-forget flush only matters
			 * if the prelude itself threw. Idempotent. */
			void usage.flush();
			void logWriter.flush();
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
