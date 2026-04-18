import {
	createAgentUIStream,
	createUIMessageStream,
	createUIMessageStreamResponse,
	type UIMessage,
} from "ai";
import {
	classifyError,
	createSolutionsArchitect,
	GenerationContext,
	MESSAGES,
} from "@/lib/agent";
import { resolveApiKey } from "@/lib/auth-utils";
import {
	createApp,
	failApp,
	hasActiveGeneration,
	loadAppOwner,
} from "@/lib/db/apps";
import {
	getMonthlyUsage,
	MONTHLY_SPEND_CAP_USD,
	UsageAccumulator,
} from "@/lib/db/usage";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import { LogWriter } from "@/lib/log/writer";
import { log } from "@/lib/logger";
import { SA_MODEL } from "@/lib/models";
import { CACHE_TTL_MS, chatRequestSchema } from "@/lib/schemas/apiSchemas";

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
	const keyResult = await resolveApiKey(req);
	if (!keyResult.ok) {
		return new Response(JSON.stringify({ error: keyResult.error }), {
			status: keyResult.status,
		});
	}

	// Spend cap check — fails closed on Firestore errors. If we can't verify
	// the user's usage, we reject the request rather than risk uncapped spend.
	try {
		const usage = await getMonthlyUsage(keyResult.session.user.id);
		if ((usage?.cost_estimate ?? 0) >= MONTHLY_SPEND_CAP_USD) {
			return Response.json(
				{
					error: MESSAGES.spend_cap_exceeded,
					type: "spend_cap_exceeded",
				},
				{ status: 429 },
			);
		}
	} catch (err) {
		log.error("[chat] spend cap check failed", err);
		return Response.json(
			{
				error: "Unable to verify usage. Please try again shortly.",
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
	if (!appId) {
		try {
			appId = await createApp(keyResult.session.user.id, effectiveRunId);
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
		if (!owner || owner !== keyResult.session.user.id) {
			return Response.json(
				{ error: "App not found", type: "not_found" },
				{ status: 404 },
			);
		}
	}

	// Concurrency guard — only one generation at a time per user. Prevents
	// concurrent requests from blowing past the spend cap and works across
	// Cloud Run instances because the check is Firestore-based.
	//
	// Runs AFTER createApp so the new doc acts as a lock. If another build
	// is already in progress, we fail the just-created doc and return 429.
	// Retries on the same app pass through (excludeAppId).
	try {
		const inFlight = await hasActiveGeneration(
			keyResult.session.user.id,
			appId,
		);
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
		// blocking users due to a transient Firestore read error. The spend
		// cap check above already fails closed for budget protection.
	}

	/* Two collaborators replace the legacy EventLogger:
	 *
	 *  - `logWriter` batches durable event envelopes to Firestore (one doc per
	 *    mutation/conversation event). Failures never throw.
	 *  - `usage` accumulates per-call token counts for the monthly spend cap
	 *    and per-run summary document. Flushed on every terminal path.
	 *
	 * Placeholder fields (`promptMode` / `freshEdit` / `appReady` / `cacheExpired`
	 * / `moduleCount`) are rewritten via `usage.configureRun()` inside the
	 * execute block once we know the editing mode. See plan §Task 9. */
	const logWriter = new LogWriter(appId);
	const usage = new UsageAccumulator({
		appId,
		userId: keyResult.session.user.id,
		runId: effectiveRunId,
		model: SA_MODEL,
		promptMode: "build",
		freshEdit: false,
		appReady: false,
		cacheExpired: false,
		moduleCount: 0,
	});

	/* Safety net on client disconnect — both flushes are idempotent, so this
	 * is a no-op if the execute finally block already ran. Fire-and-forget is
	 * correct: abort is asynchronous/out-of-band, no handler awaits it. */
	req.signal.addEventListener("abort", () => {
		void usage.flush();
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

			// Emit appId immediately so the client can update the URL.
			// appId is guaranteed non-null here — the createApp / ownership
			// branch above returns on every failure path.
			writer.write({
				type: "data-app-saved",
				data: { appId },
				transient: true,
			});

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
			 * calls) naturally follows from seq=1. */
			const lastMessage = messages.at(-1);
			if (lastMessage?.role === "user") {
				const text = lastMessage.parts
					.filter((p: { type: string }) => p.type === "text")
					.map((p: { type: string; text?: string }) => p.text ?? "")
					.join("\n");
				ctx.emitConversation({ type: "user-message", text });
			}

			/** Classify, emit, and persist a generation error. */
			const handleRouteError = (error: unknown, source: string) => {
				const classified = classifyError(error);
				ctx.emitError(classified, source);
				failApp(appId, classified.type);
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

				/* When editing with an expired cache, only send the last user message.
				 * The SA's system prompt includes a compact blueprint summary for
				 * context. Sending the full build history would (a) waste tokens on a
				 * dead cache and (b) fail SDK validation because tool call parts from
				 * generation (generateSchema, etc.) reference tools excluded in edit
				 * mode. Within the cache window, full history is safe — it only
				 * contains edit-session messages with shared-tool references. */
				const effectiveMessages =
					editing && cacheExpired
						? messages.filter((m) => m.role === "user").slice(-1)
						: messages;

				const agentStream = await createAgentUIStream({
					agent: sa,
					uiMessages: effectiveMessages,
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
