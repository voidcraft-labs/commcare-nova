/**
 * GenerationContext — shared abstraction for all LLM calls and generation state.
 *
 * Owns the fan-out from a single agent run to every write surface the server
 * produces during generation. Phase 4 splits that fan-out cleanly:
 *
 *  - **SSE (`UIMessageStreamWriter`)** — live wire to the interactive builder.
 *    `emit()` is the only way anything reaches it. Wire format is unchanged
 *    from Phase 3 — the client still consumes `data-mutations`, `data-phase`,
 *    `data-error`, `data-done`, etc.
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
	ToolLoopAgent,
	ToolSet,
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
	 * Called after each doc-mutating emission so the app document's
	 * `updated_at` advances during generation. This lets the staleness
	 * check in `listApps()` distinguish "still actively generating" from
	 * "process died" — without this, `updated_at === created_at` for the
	 * entire run. The doc is pulled from the registered provider at call
	 * time so we always pick up the latest mutation.
	 */
	private saveBlueprint() {
		if (!this.appId || !this.docProvider) return;
		const doc = this.docProvider();
		if (!doc) return;
		// `fieldParent` is a derived reverse-index; strip it before writing
		// so the Firestore doc stays in the persistable shape the schema
		// validates on read.
		const { fieldParent: _fp, ...persistable } = doc;
		updateApp(this.appId, persistable).catch((err) =>
			log.error("[intermediate-save] failed", err),
		);
	}

	/**
	 * Build and queue one `MutationEvent` on the log writer.
	 *
	 * Called by `emitMutations` for every member of its batch — the live
	 * SSE event carries the full batch for the client, but the event log
	 * stores one document per mutation so admin inspection and future
	 * replay can reason about each change independently.
	 */
	private queueMutation(mutation: Mutation, stage?: string): void {
		const event: MutationEvent = {
			kind: "mutation",
			runId: this.usage.runId,
			ts: Date.now(),
			seq: this.seq++,
			actor: "agent",
			...(stage && { stage }),
			mutation,
		};
		this.logWriter.logEvent(event);
	}

	/**
	 * Write a `ConversationEvent` to the log. No SSE side-effect — the
	 * live client consumes conversation data through the `UIMessage` stream
	 * surfaced by `toUIMessageStream()`, which is a separate channel.
	 */
	emitConversation(payload: ConversationPayload): void {
		this.logWriter.logEvent({
			kind: "conversation",
			runId: this.usage.runId,
			ts: Date.now(),
			seq: this.seq++,
			payload,
		});
	}

	/**
	 * Emit a transient data part to the live SSE stream.
	 *
	 * SSE-only in Phase 4 — the event log is populated via `emitMutations`
	 * and `emitConversation` instead. The one side-effect kept here is the
	 * intermediate Firestore save on doc-mutating emissions: `data-mutations`
	 * is the only event type that advances the doc, so we trigger
	 * `saveBlueprint()` exactly on that.
	 */
	emit(type: `data-${string}`, data: unknown): void {
		this.writer.write({ type, data, transient: true });
		if (type === "data-mutations") this.saveBlueprint();
	}

	/**
	 * Emit a classified error — one conversation error event on the log,
	 * one `data-error` on SSE. The SSE path is wrapped in try/catch because
	 * the writer can be broken by the same failure that triggered the
	 * classification; the event log carries the error either way, so a
	 * broken writer is not fatal for admin observability.
	 */
	emitError(error: ClassifiedError, context?: string): void {
		const payload: ClassifiedErrorPayload = {
			type: error.type,
			message: error.message,
			fatal: !error.recoverable,
		};
		this.emitConversation({ type: "error", error: payload });
		try {
			this.emit("data-error", {
				message: error.message,
				type: error.type,
				fatal: !error.recoverable,
			});
		} catch {
			log.error(
				"[emitError] failed to emit — error is in event log",
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
	 * (`"scaffold"`, `"module:0"`, `"form:0-1"`, `"fix"`). The SSE payload
	 * carries it for clients that care; the event log stores it per-event
	 * so replay chaptering can group by stage.
	 *
	 * Fire-and-forget Firestore intermediate save happens automatically
	 * via the `data-mutations` branch in `emit()` — no-op for empty
	 * batches (consumer is expected to short-circuit when appropriate).
	 */
	emitMutations(mutations: Mutation[], stage?: string): void {
		if (mutations.length === 0) return;
		/* SSE — unchanged wire format for the live client. */
		this.emit("data-mutations", {
			mutations,
			...(stage !== undefined && { stage }),
		});
		/* Event log — one MutationEvent per mutation. */
		for (const m of mutations) this.queueMutation(m, stage);
	}

	/**
	 * Record token usage for a sub-generation LLM call.
	 *
	 * Sub-gens are the inner `generate` / `generatePlainText` /
	 * `streamGenerate` calls the SA's tools issue. They count toward the
	 * run summary's token totals but NOT toward `stepCount` — only the
	 * outer `runAgent` loop produces "steps" in the run-summary sense.
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

	/**
	 * Run a `ToolLoopAgent` to completion, funneling every artifact of every
	 * step onto the event log + usage accumulator.
	 *
	 * Per-step writes (all keyed off `onStepFinish`):
	 * - `usage.track(..., { step: true })` — counts as one outer agent step
	 *   and aggregates tokens (cache-aware) toward the run summary.
	 * - `assistant-reasoning` conversation event — if the model emitted any
	 *   summarized thinking for this step.
	 * - `assistant-text` conversation event — the visible response chunk.
	 * - For each `toolCall`: one `tool-call` conversation event, one
	 *   `usage.noteToolCall()`, and (when a matching `toolResult` is on the
	 *   same step) one paired `tool-result` event. Pairing by `toolCallId`
	 *   handles interleaved tool responses within a step.
	 *
	 * Doc mutations themselves don't go through here — tool handlers call
	 * `ctx.emitMutations(...)` directly. This loop is purely the outer
	 * conversation + usage fan-in.
	 */
	async runAgent<CO, T extends ToolSet>(
		agent: ToolLoopAgent<CO, T>,
		opts: {
			prompt: string;
			label: string;
			agentName: string;
			model?: string;
		},
	): Promise<void> {
		const result = await agent.stream({
			prompt: opts.prompt,
			onStepFinish: ({
				usage,
				text,
				reasoningText,
				toolCalls,
				toolResults,
				warnings,
			}) => {
				logWarnings(`runAgent:${opts.label}`, warnings);
				if (!usage) return;

				/* Usage — outer agent step; increments stepCount on the summary. */
				this.usage.track(
					{
						inputTokens: usage.inputTokens ?? 0,
						outputTokens: usage.outputTokens ?? 0,
						cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
						cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens,
					},
					{ step: true },
				);

				/* Conversation events — one per artifact produced by this step.
				 * Reasoning first (what it thought), then text (what it said),
				 * then tool-call + tool-result pairs keyed by toolCallId. */
				if (reasoningText) {
					this.emitConversation({
						type: "assistant-reasoning",
						text: reasoningText,
					});
				}
				if (text) {
					this.emitConversation({ type: "assistant-text", text });
				}
				/* Pair results to their originating call by toolCallId. Tool
				 * results are emitted inline on the same step in the current
				 * AI SDK shape, so a map lookup is enough — no cross-step
				 * bookkeeping needed. */
				const resultByCallId = new Map<string, unknown>();
				for (const tr of (toolResults ?? []) as Array<{
					toolCallId: string;
					output: unknown;
				}>) {
					resultByCallId.set(tr.toolCallId, tr.output);
				}
				for (const tc of toolCalls ?? []) {
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
			},
		});

		// Drain the stream to drive execution to completion.
		const reader = result.toUIMessageStream().getReader();
		while (!(await reader.read()).done) {}
	}
}
