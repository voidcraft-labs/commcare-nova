/**
 * GenerationContext — shared abstraction for all LLM calls and generation state.
 *
 * Wraps an Anthropic client + UI stream writer + EventLogger. Provides structured
 * generation (one-shot and streaming) with automatic run logging, transient data
 * part emission, and intermediate Firestore saves (so `updated_at` advances
 * during generation for accurate staleness detection).
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
import type { BlueprintDoc } from "@/lib/domain";
import { log } from "@/lib/log";
import { MODEL_DEFAULT, type ReasoningEffort } from "@/lib/models";
import type { EventLogger } from "@/lib/services/eventLogger";
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
 * Emission types that indicate the in-memory blueprint was mutated.
 *
 * When `emit()` sees one of these, it fires a background Firestore save so
 * the app document's `updated_at` advances during generation — enabling
 * accurate staleness detection. `data-done` is excluded because
 * `completeApp()` already handles the final save with `status: "complete"`.
 */
const SAVE_TRIGGER_TYPES: ReadonlySet<string> = new Set([
	"data-schema",
	"data-scaffold",
	"data-module-done",
	"data-form-updated",
	"data-blueprint-updated",
	"data-form-fixed",
]);

/**
 * Accessor the route installs so `saveBlueprint` can read the SA's latest
 * doc snapshot without the SA having to push it in. The SA owns the
 * authoritative doc and mutates it in place; the route just registers a
 * function that returns the current reference, which the context calls on
 * each intermediate save. Undefined until the SA registers — no-op saves
 * before that.
 */
export type DocProvider = () => BlueprintDoc | undefined;

/** Options for constructing a GenerationContext. */
interface GenerationContextOptions {
	apiKey: string;
	writer: UIMessageStreamWriter;
	logger: EventLogger;
	/** Authenticated user session — always present (all users are authenticated). */
	session: Session;
	/** Firestore app ID — present when the app has been saved at least once. */
	appId?: string;
}

export class GenerationContext {
	private anthropic: ReturnType<typeof createAnthropic>;
	readonly writer: UIMessageStreamWriter;
	readonly logger: EventLogger;
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

	constructor(opts: GenerationContextOptions) {
		this.anthropic = createAnthropic({ apiKey: opts.apiKey });
		this.writer = opts.writer;
		this.logger = opts.logger;
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

	/** Emit a transient data part to the client stream. Also buffers for run logging. */
	emit(type: `data-${string}`, data: unknown) {
		this.writer.write({ type, data, transient: true });
		this.logger.logEmission(type, data);
		if (SAVE_TRIGGER_TYPES.has(type)) {
			this.saveBlueprint();
		}
	}

	/** Emit a classified error to the client and log it. */
	emitError(error: ClassifiedError, context?: string) {
		this.logger.logError(error, context);
		try {
			this.emit("data-error", {
				message: error.message,
				type: error.type,
				fatal: !error.recoverable,
			});
		} catch {
			// Writer is broken — error is already in run log
			log.error("[emitError] failed to emit — error is in run log", undefined, {
				errorMessage: error.message,
			});
		}
	}

	/**
	 * Log a sub-generation result with full token + cache breakdown.
	 * Shared by generatePlainText, generate, and streamGenerate so the
	 * usage-to-logSubResult mapping lives in one place.
	 */
	private logUsage(
		label: string,
		model: string,
		usage: {
			inputTokens?: number;
			outputTokens?: number;
			inputTokenDetails?: {
				cacheReadTokens?: number;
				cacheWriteTokens?: number;
			};
		},
		opts: {
			system: string;
			prompt: string;
			output: unknown;
			reasoningText?: string;
		},
	) {
		this.logger.logSubResult(label, {
			model,
			input_tokens: usage.inputTokens ?? 0,
			output_tokens: usage.outputTokens ?? 0,
			cache_read_tokens: usage.inputTokenDetails?.cacheReadTokens ?? undefined,
			cache_write_tokens:
				usage.inputTokenDetails?.cacheWriteTokens ?? undefined,
			input: { system: opts.system, message: opts.prompt },
			output: opts.output,
			...(opts.reasoningText && { reasoningText: opts.reasoningText }),
		});
	}

	/** Text-only generation (no schema) with automatic run logging. */
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
			if (result.usage) {
				this.logUsage(opts.label, model, result.usage, {
					system: opts.system,
					prompt: opts.prompt,
					output: result.text,
					reasoningText: result.reasoningText ?? undefined,
				});
			}
			return result.text;
		} catch (error) {
			this.emitError(classifyError(error), `generatePlainText:${opts.label}`);
			throw error;
		}
	}

	/** One-shot structured generation with automatic run logging. */
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
			if (result.usage) {
				this.logUsage(opts.label, model, result.usage, {
					system: opts.system,
					prompt: opts.prompt,
					output: result.output,
					reasoningText: result.reasoningText ?? undefined,
				});
			}
			return result.output ?? null;
		} catch (error) {
			this.emitError(classifyError(error), `generate:${opts.label}`);
			throw error;
		}
	}

	/** Streaming structured generation with partial callbacks and automatic run logging. */
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
		const [usage, reasoningText] = await Promise.all([
			result.usage,
			result.reasoningText,
		]);
		if (usage) {
			this.logUsage(opts.label, model, usage, {
				system: opts.system,
				prompt: opts.prompt,
				output: last,
				reasoningText: reasoningText ?? undefined,
			});
		}
		return last;
	}

	/**
	 * Run a ToolLoopAgent to completion with centralized step logging.
	 *
	 * All agent execution should go through this method so logging and token
	 * tracking happen in one place.
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
		const model = opts.model ?? MODEL_DEFAULT;

		const result = await agent.stream({
			prompt: opts.prompt,
			onStepFinish: ({ usage, text, reasoningText, toolCalls, warnings }) => {
				logWarnings(`runAgent:${opts.label}`, warnings);
				if (usage) {
					this.logger.logStep({
						text: text || undefined,
						reasoning: reasoningText || undefined,
						tool_calls: toolCalls?.map((tc) => ({
							name: tc.toolName,
							args: tc.input,
						})),
						usage: {
							model,
							input_tokens: usage.inputTokens ?? 0,
							output_tokens: usage.outputTokens ?? 0,
							cache_read_tokens:
								usage.inputTokenDetails?.cacheReadTokens ?? undefined,
							cache_write_tokens:
								usage.inputTokenDetails?.cacheWriteTokens ?? undefined,
						},
					});
				}
			},
		});

		// Drain the stream to drive execution to completion
		const reader = result.toUIMessageStream().getReader();
		while (!(await reader.read()).done) {}
	}
}
