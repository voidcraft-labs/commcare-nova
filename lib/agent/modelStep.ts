import type { OpenAIResponsesProviderOptions } from "@ai-sdk/openai";
import {
	type FinishReason,
	isStepCount,
	type LanguageModel,
	type LanguageModelUsage,
	type ModelMessage,
	Output,
	type Schema,
	streamText,
	type ToolSet,
} from "ai";
import { projectModelHistoryFromNewestCompaction } from "@/lib/chat/compaction";
import { type ReasoningEffort, reasoningProviderOptions } from "@/lib/models";

export interface AgentModelStep {
	readonly toolCalls: readonly {
		readonly toolCallId: string;
		readonly toolName: string;
		readonly input: unknown;
	}[];
	readonly text: string;
	readonly reasoningText?: string;
	readonly usage: LanguageModelUsage;
	readonly responseMessages: ModelMessage[];
	readonly finishReason?: FinishReason;
}
export interface AgentModelRequest {
	readonly system: string;
	readonly messages: ModelMessage[];
	readonly tools: ToolSet;
	readonly signal: AbortSignal;
	readonly responseSchema?: Schema<unknown>;
	readonly maxOutputTokens?: number;
	readonly onReasoning?: (part: {
		type: "reasoning-start" | "reasoning-delta" | "reasoning-end";
		id: string;
		text?: string;
	}) => void;
}
export type AgentModelStepFn = (
	request: AgentModelRequest,
) => Promise<AgentModelStep>;

export class AgentModelStepError extends Error {
	constructor(
		cause: unknown,
		readonly usage: LanguageModelUsage | undefined,
	) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.name = cause instanceof Error ? cause.name : "AgentModelStepError";
	}
}

/** One response, fully drained before its durable tool calls are dispatched. */
export function productionModelStep(
	model: LanguageModel,
	reasoningEffort: ReasoningEffort,
	promptCacheKey: string,
): AgentModelStepFn {
	return async ({
		system,
		messages,
		tools,
		signal,
		onReasoning,
		responseSchema,
		maxOutputTokens,
	}) => {
		signal.throwIfAborted();
		const base = reasoningProviderOptions(reasoningEffort, { promptCacheKey });
		const result = streamText({
			model,
			instructions: system,
			messages: projectModelHistoryFromNewestCompaction(messages),
			tools,
			toolChoice: "auto",
			stopWhen: isStepCount(1),
			abortSignal: signal,
			...(responseSchema && {
				output: Output.object({ schema: responseSchema }),
			}),
			...(maxOutputTokens && { maxOutputTokens }),
			providerOptions: {
				openai: {
					...base.openai,
					parallelToolCalls: true,
				} satisfies OpenAIResponsesProviderOptions,
			},
		});
		const pending = [
			result.toolCalls,
			result.text,
			result.finalStep.then((step) => step.reasoningText),
			result.usage,
			result.responseMessages,
			result.finishReason,
		] as const;
		const settled = Promise.allSettled(pending);
		try {
			for await (const part of result.stream) {
				if (
					part.type === "reasoning-start" ||
					part.type === "reasoning-delta" ||
					part.type === "reasoning-end"
				)
					onReasoning?.(part);
				if (part.type === "error") throw part.error;
				if (part.type === "abort") {
					signal.throwIfAborted();
					throw new DOMException("The model call was aborted.", "AbortError");
				}
			}
		} catch (error) {
			const values = await settled;
			throw new AgentModelStepError(
				error,
				values[3].status === "fulfilled" ? values[3].value : undefined,
			);
		}
		const values = await settled;
		const failed = values.find((value) => value.status === "rejected");
		if (failed?.status === "rejected")
			throw new AgentModelStepError(
				failed.reason,
				values[3].status === "fulfilled" ? values[3].value : undefined,
			);
		const [
			toolCalls,
			text,
			reasoningText,
			usage,
			responseMessages,
			finishReason,
		] = await Promise.all(pending);
		if (responseMessages.length === 0)
			throw new AgentModelStepError(
				new Error("The model returned no response content."),
				usage,
			);
		if (
			finishReason === "length" ||
			finishReason === "content-filter" ||
			finishReason === "error"
		) {
			throw new AgentModelStepError(
				new Error(
					`The model response ended before completion (${finishReason}).`,
				),
				usage,
			);
		}
		return {
			toolCalls: toolCalls
				.filter((call) => call.providerExecuted !== true)
				.map((call) => ({
					toolCallId: call.toolCallId,
					toolName: call.toolName,
					input: call.input,
				})),
			text,
			...(reasoningText && { reasoningText }),
			usage,
			responseMessages,
			finishReason,
		};
	};
}
