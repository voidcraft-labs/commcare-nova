import {
	createAgentUIStream,
	createUIMessageStream,
	createUIMessageStreamResponse,
	type UIMessage,
} from "ai";
import { resolveApiKey } from "@/lib/auth-utils";
import {
	createApp,
	failApp,
	hasActiveGeneration,
	loadAppOwner,
} from "@/lib/db/apps";
import { getMonthlyUsage, MONTHLY_SPEND_CAP_USD } from "@/lib/db/usage";
import { log } from "@/lib/log";
import { CACHE_TTL_MS, chatRequestSchema } from "@/lib/schemas/apiSchemas";
import type { AppBlueprint } from "@/lib/schemas/blueprint";
import { classifyError, MESSAGES } from "@/lib/services/errorClassifier";
import { EventLogger } from "@/lib/services/eventLogger";
import { GenerationContext } from "@/lib/services/generationContext";
import { createSolutionsArchitect } from "@/lib/services/solutionsArchitect";

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

	const { blueprint, runId, lastResponseAt, appReady } = parsed.data;

	const logger = new EventLogger(runId);

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
			appId = await createApp(keyResult.session.user.id, logger.runId);
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
			if (appId && !parsed.data.appId) {
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

	if (appId) {
		logger.enableFirestore(appId, keyResult.session.user.id);
	}

	// Safety net on client disconnect — finalize() is idempotent, so this
	// is a no-op if the execute finally block already ran.
	req.signal.addEventListener("abort", () => {
		void logger.finalize();
	});

	logger.logConversation(messages);

	const stream = createUIMessageStream({
		execute: async ({ writer }) => {
			// Send runId to client so it can send it back on subsequent requests
			writer.write({
				type: "data-run-id",
				data: { runId: logger.runId },
				transient: true,
			});

			// Emit appId immediately so the client can update the URL
			if (appId) {
				writer.write({
					type: "data-app-saved",
					data: { appId },
					transient: true,
				});
			}

			/* Create a mutable blueprint copy for the SA to modify in place.
			 * structuredClone isolates the working copy from the input so
			 * in-flight mutations don't corrupt the caller's reference. */
			const mutableBp: AppBlueprint = structuredClone(
				blueprint ?? { app_name: "", modules: [], case_types: null },
			);

			const ctx = new GenerationContext({
				apiKey: keyResult.apiKey,
				writer,
				logger,
				session: keyResult.session,
				appId,
				blueprint: mutableBp,
			});

			/** Classify, emit, and persist a generation error. */
			const handleRouteError = (error: unknown, source: string) => {
				const classified = classifyError(error);
				ctx.emitError(classified, source);
				if (appId) {
					failApp(appId, classified.type);
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

				logger.logConfig({
					prompt_mode: editing ? "edit" : "build",
					fresh_edit: editing && cacheExpired,
					app_ready: editing,
					cache_expired: cacheExpired,
					module_count: mutableBp.modules.length,
				});

				const sa = createSolutionsArchitect(ctx, mutableBp, editing);

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
				await logger.finalize();
			}
		},
		onFinish() {
			// Fallback finalize; see execute finally block for primary path.
			logger.finalize();
		},
		onError: (error) => {
			// Safety net — most errors are now caught above and emitted as data-error.
			log.error("[chat] stream error", error);
			return error instanceof Error ? error.message : String(error);
		},
	});

	return createUIMessageStreamResponse({ stream });
}
