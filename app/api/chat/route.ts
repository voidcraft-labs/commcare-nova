import {
	createAgentUIStream,
	createUIMessageStream,
	createUIMessageStreamResponse,
	isTextUIPart,
	type UIMessage,
} from "ai";
import {
	BUILD_ONLY_TOOL_NAMES,
	classifyError,
	createSolutionsArchitect,
	GenerationContext,
	MESSAGES,
} from "@/lib/agent";
import { resolveAnthropicKey } from "@/lib/auth-utils";
import {
	createApp,
	failApp,
	hasActiveGeneration,
	loadAppOwner,
} from "@/lib/db/apps";
import { ACTUAL_COST_BACKSTOP_USD } from "@/lib/db/creditPolicy";
import {
	getCurrentCreditBalance,
	OutOfCreditsError,
	type Reservation,
	reserveCredits,
} from "@/lib/db/credits";
import { getMonthlyUsage, UsageAccumulator } from "@/lib/db/usage";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import { LogWriter } from "@/lib/log/writer";
import { log } from "@/lib/logger";
import { SA_MODEL } from "@/lib/models";
import { creditGateDecision } from "./creditGate";
import { CACHE_TTL_MS, chatRequestSchema } from "./schema";

export const maxDuration = 300;

// ── Route Handler ──────────────────────────────────────────────────────

export async function POST(req: Request) {
	const body = await req.json();

	// Messages come from the AI SDK's useChat — typed but not schema-validated
	const messages: UIMessage[] = body.messages;
	if (!Array.isArray(messages)) {
		return new Response(JSON.stringify({ error: "Missing messages array" }), {
			status: 400,
		});
	}

	// Validate our fields (apiKey, blueprint, etc.)
	const parsed = chatRequestSchema.safeParse(body);
	if (!parsed.success) {
		return new Response(JSON.stringify({ error: "Invalid request body" }), {
			status: 400,
		});
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
	 * array (straight off `body`) and the raw `body.appReady` — BEFORE the
	 * message-strategy transform further down (the `editing && cacheExpired`
	 * last-user-message-only path). That transform leaves a `user` message last
	 * on every POST, so reading the transformed array here would charge every
	 * clarification round-trip and break the free-continuation property. */
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
		const owner = await loadAppOwner(appId);
		if (!owner || owner !== userId) {
			return Response.json(
				{ error: "App not found", type: "not_found" },
				{ status: 404 },
			);
		}
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
			reservation = await reserveCredits(userId, cost);
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

	/* Observability safety net on client disconnect. Deliberately flushes ONLY
	 * the log writer, NOT the usage accumulator: `usage.flush()` makes the credit
	 * decision (charge vs. refund) AND latches `_finalized`, and at disconnect the
	 * accumulator holds a MID-FLIGHT snapshot — flushing it here would refund the
	 * reservation against a `costEstimate` of 0 and then no-op the real flush, so a
	 * run that kept accruing cost (the model call is now cancelled via `abortSignal`
	 * below, but any already-streamed steps still count) would finalize as a
	 * refunded, cost-invisible free build. The single authoritative credit/cost
	 * flush is the execute `finally`, which runs after the agent stream reaches its
	 * TRUE final state (completed, cancelled, or errored) — see that block. The log
	 * flush makes no credit decision, so it is safe to fire here. Idempotent and
	 * fire-and-forget (abort is out-of-band; no handler awaits it). */
	req.signal.addEventListener("abort", () => {
		void logWriter.flush();
	});

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
			 * SDK updates automatically. */
			const lastMessage = messages.at(-1);
			if (lastMessage?.role === "user") {
				const text = lastMessage.parts
					.filter(isTextUIPart)
					.map((p) => p.text)
					.join("\n");
				/* Guarded the way `GenerationContext.emitError` guards its own
				 * conversation write: this call runs BEFORE the main try below, so an
				 * escaping throw would skip the `finally` and leak the credit
				 * reservation (no flush → no refund of a run that never started). A
				 * failed user-message log is non-fatal to the request — log it and
				 * proceed; the SA still runs and the reservation still finalizes. */
				try {
					ctx.emitConversation({ type: "user-message", text });
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

			/* Latch so the refund signal fires at most once per run. Both the
			 * stream-error and init-error catches funnel through `handleRouteError`,
			 * and a run could in principle hit it more than once; the user should see
			 * exactly one refund toast, and the credits are refunded exactly once by
			 * the (idempotent) `flush()` regardless. */
			let refundSignalled = false;

			/**
			 * Classify, emit, and persist a generation error — the single failure
			 * funnel both the stream and init catches flow through.
			 *
			 * Fire-and-forget — `failApp` is itself fire-and-forget (it swallows
			 * Firestore errors internally), and the emit helpers never throw.
			 * Returning `void` makes that contract explicit so a future
			 * maintainer doesn't wrap the call in `await` expecting the
			 * Firestore write to complete before continuing.
			 *
			 * Marks the run failed so `flush()` hands the reservation back (actual $
			 * still accrues — the backstop must see retry-spam — but the user isn't
			 * charged credits for a broken result). On a chargeable run it also emits
			 * the transient `data-credit-refund` part so the client can toast the
			 * refund. The signal is optimistic (emitted here, at failure detection);
			 * the authoritative decrement lands later in `flush()`.
			 */
			const handleRouteError = (error: unknown, source: string): void => {
				/* A client disconnect is NOT a generation failure. The AI SDK ends an
				 * aborted stream cleanly (an `abort` chunk, then done — no throw), but
				 * the reader can still surface a throw when `writer.write` hits the
				 * torn-down stream, landing us here. On a true abort we must NOT mark
				 * the run failed, fail the app, or refund-toast: that would log a false
				 * error, flip a healthy app to `error`, and toast a refund the user
				 * never sees. The execute `finally`'s `flush()` is the sole arbiter of
				 * charge-vs-refund for an abort, deciding purely on the final
				 * `costEstimate` (0 steps → refund; ≥1 step → keep the charge). */
				if (req.signal.aborted) return;

				const classified = classifyError(error);
				ctx.emitError(classified, source);
				failApp(appId, classified.type);
				usage.markRunFailed();
				if (chargeable && !refundSignalled) {
					refundSignalled = true;
					writer.write({
						type: "data-credit-refund",
						data: { amount: cost },
						transient: true,
					});
				}
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

				/* Two message-strategy knobs, both driven by `editing`:
				 *
				 * 1. **Cache-expired edits get one-shot delivery.** The SA's system
				 *    prompt already carries a compact blueprint summary, so past
				 *    turns would just waste tokens against a dead cache.
				 *
				 * 2. **Live-cache edits get full history, but with build-only tool
				 *    parts stripped.** Edit mode excludes `generateSchema` and
				 *    `generateScaffold` from the tool set; any lingering tool-use
				 *    parts from the original build would make Anthropic reject
				 *    the request ("tool not found in tools array"). Stripping
				 *    them by `tool-${name}` part type removes
				 *    both the call and its output in one step — AI SDK v5 keeps
				 *    both sides of a tool invocation on the same part — so the
				 *    converted Anthropic messages come out with matched
				 *    `tool_use` / `tool_result` pairs for the tools that remain.
				 *    Assistant messages that collapse to zero parts after the
				 *    strip are dropped so the wire doesn't carry empty turns.
				 *    The filter is deterministic in its inputs, so successive
				 *    edit requests produce identical prefixes and hit the
				 *    prompt cache as intended. */
				const buildOnlyPartTypes = new Set<string>(
					BUILD_ONLY_TOOL_NAMES.map((name) => `tool-${name}`),
				);
				const stripBuildOnlyParts = (m: UIMessage): UIMessage | undefined => {
					if (m.role !== "assistant") return m;
					const nextParts = m.parts.filter(
						(p) => !buildOnlyPartTypes.has(p.type),
					);
					if (nextParts.length === 0) return undefined;
					return nextParts.length === m.parts.length
						? m
						: { ...m, parts: nextParts };
				};
				const effectiveMessages = editing
					? cacheExpired
						? messages.filter((m) => m.role === "user").slice(-1)
						: messages
								.map(stripBuildOnlyParts)
								.filter((m): m is UIMessage => m !== undefined)
					: messages;

				/* Record the input-context composition for the per-run finalize
				 * log: how many messages were actually sent (after the cache-expiry
				 * last-message-only trim) and their serialized size. The system
				 * prompt is ~constant, so this is the variable part of the
				 * per-request input cost — the lever the cost investigation needs
				 * visibility into. */
				usage.configureRun({
					sentMessageCount: effectiveMessages.length,
					sentMessageChars: JSON.stringify(effectiveMessages).length,
				});

				/* Forward the request's abort signal into the agent so a client
				 * disconnect actually CANCELS the model call. Without it, the SDK
				 * keeps the SA running on the shared Anthropic key after the user is
				 * gone (Cloud Run holds the function alive up to `maxDuration`),
				 * burning real cost no one reads. With it, an abort cancels the call
				 * and the stream reaches a genuine final state, so the `finally`
				 * flush can decide charge-vs-refund on the TRUE cost: 0 steps → the
				 * reserved credits are refunded; ≥1 step → the real cost is recorded
				 * and the charge stands. */
				const agentStream = await createAgentUIStream({
					agent: sa,
					uiMessages: effectiveMessages,
					abortSignal: req.signal,
				});

				// Manual consumption instead of writer.merge() — lets us catch stream
				// errors and emit data-error before the stream closes.
				const reader = agentStream.getReader();
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						writer.write(value);
					}
				} catch (streamError) {
					handleRouteError(streamError, "route:stream");
				}
			} catch (error) {
				handleRouteError(error, "route:init");
			} finally {
				/* Primary flush path. Await both so the response doesn't
				 * resolve before persistence lands — matters on Cloud Run,
				 * where the container can be killed right after the final
				 * byte is written. Both flushes are idempotent. */
				await usage.flush();
				await logWriter.flush();
			}
		},
		onFinish() {
			/* Fallback flush — the execute finally block is the primary
			 * path. Fire-and-forget: the stream is already closed and
			 * nothing awaits this callback. Idempotent. */
			void usage.flush();
			void logWriter.flush();
		},
		onError: (error) => {
			// Safety net — most errors are now caught above and emitted as data-error.
			log.error("[chat] stream error", error);
			return error instanceof Error ? error.message : String(error);
		},
	});

	return createUIMessageStreamResponse({ stream });
}
