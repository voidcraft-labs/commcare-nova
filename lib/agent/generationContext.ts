/**
 * GenerationContext — shared abstraction for all LLM calls and generation state.
 *
 * Owns the fan-out from a single agent run to every write surface the server
 * produces during generation:
 *
 *  - **SSE (`UIMessageStreamWriter`)** — live wire to the interactive builder.
 *    `emit()` is a pure pass-through for lifecycle/error events (`data-phase`,
 *    `data-fix-attempt`, `data-error`, `data-done`, …). Doc-mutating events
 *    go through `emitMutations`, which owns both the SSE payload and the
 *    matching event-log writes.
 *  - **Event log (`LogWriter`)** — Firestore-backed append-only event stream.
 *    `emitMutations` writes one `MutationEvent` per mutation; `emitConversation`
 *    writes one `ConversationEvent` per assistant/tool/user artifact. The log
 *    powers admin inspection and future replay. It is strictly supplemental —
 *    the blueprint snapshot on `AppDoc` is still authoritative.
 *  - **Usage (`UsageAccumulator`)** — per-request token + cost aggregation
 *    flushed once at request end. Outer agent steps carry `{ step: true }`;
 *    sub-gens (internal `generate` / `generatePlainText` / `streamGenerate`
 *    calls) accumulate tokens without stepping the counter.
 *
 * Implements `ToolExecutionContext` — the narrow interface extracted tool
 * modules consume. `recordMutations` + `recordConversation` are the
 * surface-neutral entry points; `emitMutations` + `emitConversation` are
 * the chat-surface implementations (with SSE fan-out) that the interface
 * methods delegate to.
 *
 * Sub-generation prompts/outputs (from `generate`, `generatePlainText`,
 * `streamGenerate`) are intentionally NOT persisted in the event log — only
 * aggregate token usage. Per spec §5 the log is supplemental and does not
 * carry per-tool payloads. Admin inspection surfaces should rely on per-run
 * summary docs and on agent-step-granularity conversation events.
 *
 * The context owns nothing stateful beyond a monotonic `seq` counter used to
 * preserve chronological order inside a single millisecond (multiple events
 * in one SSE burst share `ts`).
 */

import {
	type AnthropicProviderOptions,
	createAnthropic,
} from "@ai-sdk/anthropic";
import type {
	CallWarning,
	LanguageModelUsage,
	UIMessageStreamWriter,
} from "ai";
import { generateText, Output, streamText } from "ai";
import type { z } from "zod";
import type { Session } from "@/lib/auth";
import { updateApp } from "@/lib/db/apps";
import type { UsageAccumulator } from "@/lib/db/usage";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import type {
	ClassifiedErrorPayload,
	ConversationEvent,
	ConversationPayload,
	MutationEvent,
} from "@/lib/log/types";
import type { LogWriter } from "@/lib/log/writer";
import { log } from "@/lib/logger";
import { MODEL_DEFAULT, type ReasoningEffort } from "@/lib/models";
import { type ClassifiedError, classifyError } from "./errorClassifier";
import type { ToolExecutionContext } from "./toolExecutionContext";

/** Log AI SDK warnings to the console if present. */
export function logWarnings(
	label: string,
	warnings: CallWarning[] | undefined,
) {
	if (warnings?.length) {
		for (const w of warnings) {
			console.warn(`[${label}] warning:`, w);
		}
	}
}

/**
 * Anthropic provider options for adaptive extended thinking on Opus 4.7+.
 *
 * `effort` is a top-level provider option (NOT nested inside `thinking` — Zod
 * `$strip` silently drops it there). `display: 'summarized'` is required for
 * human-readable summaries to stream back; without it, thinking blocks come
 * through as encrypted/redacted on Opus 4.7.
 */
export function thinkingProviderOptions(effort: ReasoningEffort) {
	const anthropic: AnthropicProviderOptions = {
		thinking: { type: "adaptive", display: "summarized" },
		effort,
	};
	return { anthropic };
}

/**
 * Constructor options. Two orthogonal collaborators: `LogWriter` owns
 * durable event persistence (fire-and-forget); `UsageAccumulator` owns
 * cost aggregation and exposes the `runId` used on every event envelope.
 *
 * `appId` is required — the chat route creates the app doc via `createApp`
 * before constructing the context (Firestore-down = 503, not an orphaned
 * build). Every `GenerationContext` instance has a target app to persist
 * against, so `saveBlueprint` can persist the post-mutation doc threaded
 * in by each caller — the same shape as `McpContext`.
 */
interface GenerationContextOptions {
	apiKey: string;
	/** SSE writer for the live builder. Unchanged wire format. */
	writer: UIMessageStreamWriter;
	/** Event log sink — batched Firestore writer, one doc per event. */
	logWriter: LogWriter;
	/** Cost + step/tool-call counter for per-run summary + monthly cap. */
	usage: UsageAccumulator;
	/** Authenticated user session — always present (all users are authenticated). */
	session: Session;
	/** Firestore app id. The chat route creates the app doc before this
	 * constructor runs so every context has a valid target app. */
	appId: string;
}

/**
 * One completed agent step, normalized to the minimum surface the step
 * handler needs. Callers (the SA's `onStepFinish`, tests) map the AI SDK's
 * step-finish argument into this shape so `handleAgentStep` stays stable
 * across SDK minor-version bumps.
 */
export interface AgentStep {
	usage?: LanguageModelUsage;
	text?: string;
	reasoningText?: string;
	toolCalls?: Array<{
		toolCallId: string;
		toolName: string;
		input: unknown;
	}>;
	toolResults?: Array<{
		toolCallId: string;
		output: unknown;
	}>;
	warnings?: CallWarning[];
}

export class GenerationContext implements ToolExecutionContext {
	private anthropic: ReturnType<typeof createAnthropic>;
	readonly writer: UIMessageStreamWriter;
	readonly logWriter: LogWriter;
	readonly usage: UsageAccumulator;
	/** Authenticated user session. */
	readonly session: Session;
	/** Firestore app id — required. Created before construction by the
	 * chat route so every context has a valid persistence target. */
	readonly appId: string;
	/**
	 * Per-request tiebreaker for same-millisecond SSE bursts. Resets to 0
	 * each request; doc IDs are Firestore-minted, so no cross-request
	 * uniqueness is needed.
	 */
	private seq = 0;

	constructor(opts: GenerationContextOptions) {
		this.anthropic = createAnthropic({ apiKey: opts.apiKey });
		this.writer = opts.writer;
		this.logWriter = opts.logWriter;
		this.usage = opts.usage;
		this.session = opts.session;
		this.appId = opts.appId;
	}

	/** Get the Anthropic model provider for a given model ID. */
	model(id: string) {
		return this.anthropic(id);
	}

	/**
	 * ToolExecutionContext accessor — the authenticated Better Auth user
	 * id. Exposed so shared tool bodies can look up user-scoped resources
	 * (e.g. KMS-encrypted HQ credentials) through the interface without
	 * dipping into the concrete class.
	 */
	get userId(): string {
		return this.session.user.id;
	}

	/**
	 * ToolExecutionContext accessor — the per-run grouping id, sourced
	 * from the `UsageAccumulator` so the run-id stamped on every event
	 * envelope stays consistent with the run-summary doc.
	 */
	get runId(): string {
		return this.usage.runId;
	}

	/**
	 * Fire-and-forget save of the SA's current doc snapshot to Firestore.
	 *
	 * Called by `emitMutations` after every mutation batch so the app
	 * document's `updated_at` advances during generation. This lets the
	 * staleness check in `listApps()` distinguish "still actively
	 * generating" from "process died" — without this, `updated_at ===
	 * created_at` for the entire run.
	 *
	 * `doc` is the post-mutation blueprint, threaded in by the caller.
	 * Chat stays fire-and-forget because the SA's fix-retry discipline
	 * covers missed intermediate saves and we don't want to block the
	 * SSE stream on Firestore latency. Errors are logged; no rejection
	 * ever propagates out of this method. `McpContext.saveBlueprint`
	 * mirrors the same strip via the shared `toPersistableDoc` helper
	 * but awaits the write (its fail-closed contract has no agent loop
	 * to retry).
	 */
	private saveBlueprint(doc: BlueprintDoc): void {
		updateApp(this.appId, toPersistableDoc(doc)).catch((err) =>
			log.error("[intermediate-save] failed", err),
		);
	}

	/**
	 * Write a `ConversationEvent` to both the event log and the SSE stream.
	 *
	 * The log write is the durable debug artifact (and replay source). The
	 * SSE emission carries the same envelope to the live client so the
	 * session store's event buffer mirrors the persisted log in real time —
	 * every lifecycle derivation (stage, error, status message, validation
	 * attempt) reads from that buffer, so live + replay end up driving the
	 * UI from the same data.
	 *
	 * Returns the built envelope so callers can hand it to downstream
	 * metadata surfaces without rebuilding it — mirrors
	 * `McpContext.recordConversation` so a shared tool body can treat
	 * both implementations identically.
	 */
	emitConversation(payload: ConversationPayload): ConversationEvent {
		const event: ConversationEvent = {
			kind: "conversation",
			runId: this.usage.runId,
			ts: Date.now(),
			seq: this.seq++,
			/* `source: "chat"` is stamped inline so the in-memory event we
			 * hold is schema-valid and self-documenting. The writer re-stamps
			 * it authoritatively on its way to Firestore (see LogWriter), so
			 * this is defense-in-depth, not the canonical value. */
			source: "chat",
			payload,
		};
		this.logWriter.logEvent(event);
		this.writer.write({
			type: "data-conversation-event",
			data: event,
			transient: true,
		});
		return event;
	}

	/**
	 * Emit a transient data part to the live SSE stream. Pure pass-through.
	 *
	 * Used for one-shot lifecycle signals that live outside the
	 * `data-mutations` / `data-conversation-event` streams:
	 *
	 *   - `data-done` — full-doc reconciliation from validateApp.
	 *   - `data-blueprint-updated` — edit-mode coarse-tool replacements.
	 *   - `data-app-id` — one-shot appId announcement driving the
	 *     `/build/new` → `/build/{id}` URL swap on new builds.
	 *   - `data-run-id` — server-minted run identifier the client echoes
	 *     back on follow-up requests.
	 *
	 * Other signposts (start-build, phase, fix-attempt, error) are derived
	 * client-side from the mutation + conversation event streams rather
	 * than emitted here.
	 */
	emit(type: `data-${string}`, data: unknown): void {
		this.writer.write({ type, data, transient: true });
	}

	/**
	 * Emit a classified error as a conversation event. The single
	 * `emitConversation` call handles both the event log write AND the
	 * SSE emission (via `data-conversation-event`), so the client sees
	 * the error in its buffer and derivations pick it up without a
	 * separate `data-error` side channel.
	 *
	 * Wrapped in try/catch because the writer can be broken by the same
	 * failure that triggered the classification; the event log carries
	 * the error either way, so a broken SSE writer is not fatal for
	 * admin observability.
	 */
	emitError(error: ClassifiedError, context?: string): void {
		const payload: ClassifiedErrorPayload = {
			type: error.type,
			message: error.message,
			fatal: !error.recoverable,
		};
		try {
			this.emitConversation({ type: "error", error: payload });
		} catch {
			log.error(
				"[emitError] conversation event emission failed — error may not reach the log",
				undefined,
				{ errorMessage: error.message, context: context ?? "" },
			);
		}
	}

	/**
	 * Emit a fine-grained mutation batch to the client stream and the
	 * event log, and persist the post-mutation doc snapshot to Firestore.
	 *
	 * This is the ONLY sanctioned way for the SA (or its validation loop)
	 * to tell the client that the doc has changed. The mutations payload
	 * is the same `Mutation[]` the SA applied to its own internal doc via
	 * `applyMutations` on an Immer draft — the client applies the
	 * identical array via `docStore.applyMany(mutations)`.
	 *
	 * `doc` is the POST-mutation blueprint — callers apply the mutations
	 * on their working doc FIRST, then thread the resulting value in
	 * here. The persisted snapshot is exactly that value. Matches the
	 * semantic on `McpContext.recordMutations` so a shared tool body can
	 * invoke the interface method uniformly on either surface.
	 *
	 * The optional `stage` string is a semantic tag for the log
	 * (`"scaffold"`, `"module:0"`, `"form:0-1"`, `"fix:attempt-N"`). It's
	 * stamped on every MutationEvent envelope — both log and SSE see the
	 * same tag, so lifecycle derivations over the client buffer match
	 * replay derivations over the persisted log.
	 *
	 * Writes, in order:
	 * 1. Build MutationEvent envelopes — same values on the wire + log.
	 * 2. SSE — one `data-mutations` event carrying both the raw
	 *    `mutations` (for `docStore.applyMany`, preserving zundo grouping)
	 *    AND the `events` envelope array (for the session events buffer).
	 * 3. Firestore intermediate save — advances `updated_at` on the app
	 *    doc so listApps can distinguish in-progress from orphaned runs.
	 *    Fire-and-forget; this method does not await the Firestore write.
	 * 4. Event log — one `MutationEvent` per mutation, reusing the same
	 *    envelopes that went out on SSE.
	 *
	 * Returns the built envelopes so callers can forward them to
	 * downstream metadata without rebuilding. No-op on empty batches,
	 * returning `[]`.
	 */
	emitMutations(
		mutations: Mutation[],
		doc: BlueprintDoc,
		stage?: string,
	): MutationEvent[] {
		if (mutations.length === 0) return [];

		/* Build MutationEvent envelopes once; the same values ship on SSE
		 * (client pushes to the events buffer) and on the log writer.
		 * `seq` is allocated monotonically per envelope — contiguous with
		 * conversation events emitted in the same run. */
		const events: MutationEvent[] = mutations.map((mutation) => ({
			kind: "mutation",
			runId: this.usage.runId,
			ts: Date.now(),
			seq: this.seq++,
			actor: "agent",
			/* Inline `source: "chat"` so the envelope we ship on SSE
			 * (via `data-mutations` → session events buffer) is
			 * schema-valid. LogWriter re-stamps it on the way to
			 * Firestore regardless; this is the client-facing value. */
			source: "chat",
			/* Include `stage` whenever the caller explicitly passed a value —
			 * empty-string is a valid stage. Mirrors McpContext.recordMutations. */
			...(stage !== undefined && { stage }),
			mutation,
		}));

		this.writer.write({
			type: "data-mutations",
			data: {
				mutations,
				events,
				...(stage !== undefined && { stage }),
			},
			transient: true,
		});
		/* Fire-and-forget intermediate save advances `updated_at` so the
		 * staleness detector distinguishes "still generating" from "process
		 * died". The caller owns the doc shape; we just persist whatever
		 * post-mutation snapshot they handed us. */
		this.saveBlueprint(doc);
		/* Event log — write the same envelopes we just sent on SSE. */
		for (const e of events) this.logWriter.logEvent(e);
		return events;
	}

	/**
	 * ToolExecutionContext implementation. Delegates to `emitMutations`,
	 * which takes `doc` directly and persists it via `saveBlueprint`.
	 * The chat surface's intermediate save is fire-and-forget (SA
	 * fix-retry discipline covers missed saves), so the returned promise
	 * resolves as soon as the synchronous SSE write + log enqueue
	 * complete — matching the interface's asynchronous signature while
	 * preserving the chat surface's "don't block the stream on
	 * Firestore" invariant.
	 *
	 * The `async` keyword is load-bearing for the interface's
	 * `Promise<MutationEvent[]>` return type; the body is synchronous
	 * because `emitMutations` is synchronous and `saveBlueprint` is
	 * fire-and-forget. No `await` appears inside this method by design.
	 */
	async recordMutations(
		mutations: Mutation[],
		doc: BlueprintDoc,
		stage?: string,
	): Promise<MutationEvent[]> {
		return this.emitMutations(mutations, doc, stage);
	}

	/**
	 * ToolExecutionContext implementation. Pure delegator to
	 * `emitConversation`; synchronous by construction (no Firestore
	 * latency to block on for conversation events — the durable persistence
	 * is owned by the batched `LogWriter.flush`).
	 */
	recordConversation(payload: ConversationPayload): ConversationEvent {
		return this.emitConversation(payload);
	}

	/**
	 * Process one completed agent step: track usage, emit conversation
	 * events (reasoning, text, tool-call + tool-result pairs), and note
	 * tool-call counts.
	 *
	 * This is the shared fan-in for every `ToolLoopAgent` driven by this
	 * context — the SA's inline `onStepFinish` funnels here; any future
	 * agent should do the same. The caller owns mapping whatever shape
	 * the AI SDK's `onStepFinish` provides into `AgentStep`, so this
	 * method stays stable across SDK minor-version bumps.
	 *
	 * Ordering mirrors the model's own production order: reasoning summary
	 * (if emitted), then visible text, then tool-call + tool-result pairs
	 * keyed by `toolCallId` (the SDK emits results on the same step as the
	 * originating call in the current shape, so a single-pass map lookup
	 * is sufficient — no cross-step bookkeeping needed).
	 *
	 * `label` is used only for the warning-log prefix; not persisted.
	 */
	handleAgentStep(step: AgentStep, label: string): void {
		logWarnings(`runAgent:${label}`, step.warnings);
		const { usage } = step;
		if (!usage) return;

		/* Outer agent step — increments stepCount on the run summary. */
		this.usage.track(
			{
				inputTokens: usage.inputTokens ?? 0,
				outputTokens: usage.outputTokens ?? 0,
				cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
				cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens,
			},
			{ step: true },
		);

		if (step.reasoningText) {
			this.emitConversation({
				type: "assistant-reasoning",
				text: step.reasoningText,
			});
		}
		if (step.text) {
			this.emitConversation({ type: "assistant-text", text: step.text });
		}

		const resultByCallId = new Map<string, unknown>();
		for (const tr of step.toolResults ?? []) {
			resultByCallId.set(tr.toolCallId, tr.output);
		}
		for (const tc of step.toolCalls ?? []) {
			this.usage.noteToolCall();
			this.emitConversation({
				type: "tool-call",
				toolCallId: tc.toolCallId,
				toolName: tc.toolName,
				input: tc.input,
			});
			const out = resultByCallId.get(tc.toolCallId);
			if (out !== undefined) {
				this.emitConversation({
					type: "tool-result",
					toolCallId: tc.toolCallId,
					toolName: tc.toolName,
					output: out,
				});
			}
		}
	}

	/**
	 * Record token usage for a sub-generation LLM call.
	 *
	 * Sub-gens are the inner `generate` / `generatePlainText` /
	 * `streamGenerate` calls the SA's tools issue. They count toward the
	 * run summary's token totals but NOT toward `stepCount` — only outer
	 * agent steps (handled by `handleAgentStep`) produce "steps" in the
	 * run-summary sense.
	 *
	 * Per spec §5 the event log does not carry per-tool usage; if sub-gen
	 * prompt/output observability becomes a product requirement, it will
	 * live on a separate admin-only collection, not here.
	 */
	private trackSubGeneration(usage: {
		inputTokens?: number;
		outputTokens?: number;
		inputTokenDetails?: {
			cacheReadTokens?: number;
			cacheWriteTokens?: number;
		};
	}): void {
		this.usage.track({
			inputTokens: usage.inputTokens ?? 0,
			outputTokens: usage.outputTokens ?? 0,
			cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
			cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens,
		});
	}

	/** Text-only generation (no schema) with automatic usage tracking. */
	async generatePlainText(opts: {
		system: string;
		prompt: string;
		label: string;
		model?: string;
		maxOutputTokens?: number;
	}): Promise<string> {
		try {
			const model = opts.model ?? MODEL_DEFAULT;
			const result = await generateText({
				model: this.anthropic(model),
				system: opts.system,
				prompt: opts.prompt,
				maxOutputTokens: opts.maxOutputTokens,
			});
			logWarnings(`generatePlainText:${opts.label}`, result.warnings);
			if (result.usage) this.trackSubGeneration(result.usage);
			return result.text;
		} catch (error) {
			this.emitError(classifyError(error), `generatePlainText:${opts.label}`);
			throw error;
		}
	}

	/** One-shot structured generation with automatic usage tracking. */
	async generate<T>(
		schema: z.ZodType<T>,
		opts: {
			system: string;
			prompt: string;
			label: string;
			model?: string;
			maxOutputTokens?: number;
			reasoning?: { effort: ReasoningEffort };
		},
	): Promise<T | null> {
		try {
			const model = opts.model ?? MODEL_DEFAULT;
			const result = await generateText({
				model: this.anthropic(model),
				output: Output.object({ schema }),
				system: opts.system,
				prompt: opts.prompt,
				maxOutputTokens: opts.maxOutputTokens,
				...(opts.reasoning && {
					providerOptions: thinkingProviderOptions(opts.reasoning.effort),
				}),
			});
			logWarnings(`generate:${opts.label}`, result.warnings);
			if (result.usage) this.trackSubGeneration(result.usage);
			return result.output ?? null;
		} catch (error) {
			this.emitError(classifyError(error), `generate:${opts.label}`);
			throw error;
		}
	}

	/** Streaming structured generation with partial callbacks and automatic usage tracking. */
	async streamGenerate<T>(
		schema: z.ZodType<T>,
		opts: {
			system: string;
			prompt: string;
			label: string;
			model?: string;
			maxOutputTokens?: number;
			onPartial?: (partial: Partial<T>) => void;
			reasoning?: { effort: ReasoningEffort };
		},
	): Promise<T | null> {
		const model = opts.model ?? MODEL_DEFAULT;
		const result = streamText({
			model: this.anthropic(model),
			output: Output.object({ schema }),
			system: opts.system,
			prompt: opts.prompt,
			maxOutputTokens: opts.maxOutputTokens,
			...(opts.reasoning && {
				providerOptions: thinkingProviderOptions(opts.reasoning.effort),
			}),
			onError: ({ error }) => {
				this.emitError(classifyError(error), `streamGenerate:${opts.label}`);
			},
		});

		let last: T | null = null;
		for await (const partial of result.partialOutputStream) {
			opts.onPartial?.(partial as Partial<T>);
			last = partial as T;
		}

		logWarnings(`streamGenerate:${opts.label}`, await result.warnings);
		const usage = await result.usage;
		if (usage) this.trackSubGeneration(usage);
		return last;
	}
}
