/**
 * GenerationContext — shared abstraction for all LLM calls.
 *
 * Wraps an Anthropic client + UI stream writer + EventLogger. Provides structured
 * generation (one-shot and streaming) with automatic run logging, plus transient
 * data part emission. Used by the Solutions Architect agent and its generation tools.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import type {
	CallWarning,
	ToolLoopAgent,
	ToolSet,
	UIMessageStreamWriter,
} from "ai";
import { generateText, Output, streamText } from "ai";
import type { z } from "zod";
import { log } from "@/lib/log";
import type { Session } from "../auth";
import { MODEL_DEFAULT, type ReasoningEffort } from "../models";
import { type ClassifiedError, classifyError } from "./errorClassifier";
import type { EventLogger } from "./eventLogger";

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

/** Anthropic provider options for adaptive extended thinking. */
export function thinkingProviderOptions(effort: ReasoningEffort) {
	return {
		anthropic: {
			thinking: { type: "adaptive" as const, effort },
		},
	};
}

/** Options for constructing a GenerationContext. */
interface GenerationContextOptions {
	apiKey: string;
	writer: UIMessageStreamWriter;
	logger: EventLogger;
	/** Authenticated user session — always present (all users are authenticated). */
	session: Session;
	/** Firestore project ID — present when the project has been saved at least once. */
	projectId?: string;
}

export class GenerationContext {
	private anthropic: ReturnType<typeof createAnthropic>;
	readonly writer: UIMessageStreamWriter;
	readonly logger: EventLogger;
	/** Authenticated user session. */
	readonly session: Session;
	/** Firestore project ID — set when the project has been saved at least once. */
	readonly projectId: string | undefined;

	constructor(opts: GenerationContextOptions) {
		this.anthropic = createAnthropic({ apiKey: opts.apiKey });
		this.writer = opts.writer;
		this.logger = opts.logger;
		this.session = opts.session;
		this.projectId = opts.projectId;
	}

	/** Get the Anthropic model provider for a given model ID. */
	model(id: string) {
		return this.anthropic(id);
	}

	/** Emit a transient data part to the client stream. Also buffers for run logging. */
	emit(type: `data-${string}`, data: unknown) {
		this.writer.write({ type, data, transient: true });
		this.logger.logEmission(type, data);
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
				this.logger.logSubResult(opts.label, {
					model,
					input_tokens: result.usage.inputTokens ?? 0,
					output_tokens: result.usage.outputTokens ?? 0,
					input: { system: opts.system, message: opts.prompt },
					output: result.text,
					...(result.reasoningText && { reasoningText: result.reasoningText }),
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
				this.logger.logSubResult(opts.label, {
					model,
					input_tokens: result.usage.inputTokens ?? 0,
					output_tokens: result.usage.outputTokens ?? 0,
					input: { system: opts.system, message: opts.prompt },
					output: result.output,
					...(result.reasoningText && { reasoningText: result.reasoningText }),
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
			this.logger.logSubResult(opts.label, {
				model,
				input_tokens: usage.inputTokens ?? 0,
				output_tokens: usage.outputTokens ?? 0,
				input: { system: opts.system, message: opts.prompt },
				output: last,
				...(reasoningText && { reasoningText }),
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
