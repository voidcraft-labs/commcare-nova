/**
 * GenerationContext — shared abstraction for all LLM calls and generation state.
 *
 * Owns the fan-out from a single agent run to every write surface the server
 * produces during generation. Phase 4 splits that fan-out cleanly:
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
 * Accessor the route installs so `saveBlueprint` can read the SA's latest
 * doc snapshot without the SA having to push it in. The SA owns the
 * authoritative doc and mutates it in place; the route just registers a
 * function that returns the current reference, which the context calls on
 * each intermediate save. Undefined until the SA registers — no-op saves
 * before that.
 */
export type DocProvider = () => BlueprintDoc | undefined;

/**
 * Constructor options. Phase 4 dropped the legacy `EventLogger` dependency —
 * the two new collaborators are orthogonal: `LogWriter` owns durable event
 * persistence (fire-and-forget), `UsageAccumulator` owns cost aggregation
 * and exposes the `runId` used on every event envelope.
 */
export interface GenerationContextOptions {
	apiKey: string;
	/** SSE writer for the live builder. Unchanged wire format. */
	writer: UIMessageStreamWriter;
	/** Event log sink — batched Firestore writer, one doc per event. */
	logWriter: LogWriter;
	/** Cost + step/tool-call counter for per-run summary + monthly cap. */
	usage: UsageAccumulator;
	/** Authenticated user session — always present (all users are authenticated). */
	session: Session;
	/** Firestore app ID — present when the app has been saved at least once. */
	appId?: string;
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

export class GenerationContext {
	private anthropic: ReturnType<typeof createAnthropic>;
	readonly writer: UIMessageStreamWriter;
	readonly logWriter: LogWriter;
	readonly usage: UsageAccumulator;
	/** Authenticated user session. */
	readonly session: Session;
	/** Firestore app ID — set when the app has been saved at least once. */
	readonly appId: string | undefined;
	/**
	 * Pull-based doc provider — the SA installs this during agent creation
	 * so intermediate saves always read the SA's current working state.
	 * Kept private so the emit pipeline owns the save timing; external
	 * readers should consult the doc store, not this context.
	 */
	private docProvider: DocProvider | undefined;
	/**
	 * Per-request monotonic counter. Each event envelope carries the next
	 * value — independent from the ts field so multiple events in one SSE
	 * burst stay chronologically ordered even when they share a millisecond.
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
	 * Register the function the context uses to read the SA's current doc
	 * for intermediate Firestore saves. The SA calls this once during
	 * agent construction. Replacing an existing provider is fine — the
	 * most recent registration wins.
	 */
	registerDocProvider(provider: DocProvider) {
		this.docProvider = provider;
	}

	/**
	 * Fire-and-forget save of the SA's current doc snapshot to Firestore.
	 *
	 * Called by `emitMutations` after every mutation batch so the app
	 * document's `updated_at` advances during generation. This lets the
	 * staleness check in `listApps()` distinguish "still actively
	 * generating" from "process died" — without this, `updated_at ===
	 * created_at` for the entire run. The doc is pulled from the
	 * registered provider at call time so we always pick up the latest
	 * mutation.
	 */
	private saveBlueprint() {
		if (!this.appId || !this.docProvider) return;
		const doc = this.docProvider();
		if (!doc) return;
		// `fieldParent` is a derived reverse-index rebuilt on the client from
		// `fieldOrder` in `docStore.load()`; strip it before writing so the
		// Firestore doc stays in the persistable shape the schema validates
		// on read. `void fieldParent` acknowledges the discard explicitly —
		// cleaner than an underscore-prefixed ghost variable.
		const { fieldParent, ...persistable } = doc;
		void fieldParent;
		updateApp(this.appId, persistable).catch((err) =>
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
	 */
	emitConversation(payload: ConversationPayload): void {
		const event: ConversationEvent = {
			kind: "conversation",
			runId: this.usage.runId,
			ts: Date.now(),
			seq: this.seq++,
			payload,
		};
		this.logWriter.logEvent(event);
		this.writer.write({
			type: "data-conversation-event",
			data: event,
			transient: true,
		});
	}

	/**
	 * Emit a transient data part to the live SSE stream. Pure pass-through.
	 *
	 * Remaining consumers after Phase-5 lifecycle derivation: `data-done`
	 * (full-doc reconciliation from validateApp), `data-blueprint-updated`
	 * (edit-mode coarse-tool replacements), `data-app-saved`
	 * (Firestore-save notification), `data-run-id` (client echo). All
	 * other former SSE signposts (`data-start-build`, `data-phase`,
	 * `data-fix-attempt`, `data-error`) are derived from the mutation +
	 * conversation event streams.
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
	 * event log.
	 *
	 * This is the ONLY sanctioned way for the SA (or its validation loop)
	 * to tell the client that the doc has changed. The mutations payload
	 * is the same `Mutation[]` the SA applied to its own internal doc via
	 * `applyMutations` on an Immer draft — the client applies the
	 * identical array via `docStore.applyMany(mutations)`.
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
	 * 4. Event log — one `MutationEvent` per mutation, reusing the same
	 *    envelopes that went out on SSE.
	 *
	 * No-op on empty batches — consumer is expected to short-circuit when
	 * appropriate.
	 */
	emitMutations(mutations: Mutation[], stage?: string): void {
		if (mutations.length === 0) return;

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
			...(stage && { stage }),
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
		 * died". */
		this.saveBlueprint();
		/* Event log — write the same envelopes we just sent on SSE. */
		for (const e of events) this.logWriter.logEvent(e);
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
	private trackSubGeneration(
		_model: string,
		usage: {
			inputTokens?: number;
			outputTokens?: number;
			inputTokenDetails?: {
				cacheReadTokens?: number;
				cacheWriteTokens?: number;
			};
		},
	): void {
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
			if (result.usage) this.trackSubGeneration(model, result.usage);
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
			if (result.usage) this.trackSubGeneration(model, result.usage);
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
		if (usage) this.trackSubGeneration(model, usage);
		return last;
	}
}
