import type { ModelMessage, UIMessage } from "ai";
import { MODEL_CONTEXT_VERSION } from "@/lib/models";

type MessagePart = UIMessage["parts"][number];

/** OpenAI returns a server compaction item as a provider custom part. */
export function isOpenAICompactionPart(part: MessagePart): boolean {
	if (part.type !== "custom" || part.kind !== "openai.compaction") return false;
	const openai = (
		part as MessagePart & {
			providerMetadata?: { openai?: { type?: unknown } };
		}
	).providerMetadata?.openai;
	return openai?.type === "compaction";
}

export function isOpenAICompactionChunk(chunk: {
	type: string;
	kind?: string;
	providerMetadata?: { openai?: { type?: unknown } };
}): boolean {
	return (
		(chunk.type === "custom" && chunk.kind === "openai.compaction") ||
		chunk.providerMetadata?.openai?.type === "compaction"
	);
}

/** Model-message form returned by generateText before UI conversion. */
export function modelMessagesContainCompaction(
	messages: readonly unknown[],
): boolean {
	const visit = (value: unknown): boolean => {
		if (Array.isArray(value)) return value.some(visit);
		if (value === null || typeof value !== "object") return false;
		const record = value as Record<string, unknown>;
		if (record.type === "custom" && record.kind === "openai.compaction") {
			return true;
		}
		return Object.values(record).some(visit);
	};
	return messages.some(visit);
}

/**
 * Once automatic server-side compaction emits a checkpoint during a multi-step
 * tool loop, make that checkpoint the new model-history boundary. System
 * instructions remain outside this array and are injected fresh by the agent;
 * tool calls/results after the checkpoint remain paired in the retained suffix.
 */
export function projectModelHistoryFromNewestCompaction(
	messages: readonly ModelMessage[],
): ModelMessage[] {
	let newest: { messageIndex: number; partIndex: number } | undefined;
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
		const message = messages[messageIndex];
		if (message.role !== "assistant" || !Array.isArray(message.content))
			continue;
		for (let partIndex = 0; partIndex < message.content.length; partIndex++) {
			const part = message.content[partIndex] as {
				type?: unknown;
				kind?: unknown;
			};
			if (part.type === "custom" && part.kind === "openai.compaction") {
				newest = { messageIndex, partIndex };
			}
		}
	}
	if (newest === undefined) return [...messages];
	const boundary = messages[newest.messageIndex];
	if (boundary.role !== "assistant" || !Array.isArray(boundary.content)) {
		return [...messages];
	}
	return [
		{ ...boundary, content: boundary.content.slice(newest.partIndex) },
		...messages.slice(newest.messageIndex + 1),
	];
}

function withoutOpenAICompactionParts<M extends UIMessage>(
	message: M,
): M | null {
	const parts = message.parts.filter((part) => !isOpenAICompactionPart(part));
	if (parts.length === 0) return null;
	return { ...message, parts };
}

/**
 * Project a complete person-visible transcript into model history. OpenAI and
 * the AI SDK own the compaction trigger and opaque encrypted checkpoint; Nova
 * only retains and replays that provider item. The newest item replaces
 * everything before it only when its producing model and Nova context contract
 * match this turn. A stale, model-crossing, or unversioned item is removed and
 * the ordinary sanitized history is used instead — an incompatible provider
 * checkpoint must never be sent to another model/context contract.
 */
export function projectCompatibleCompactedHistory<M extends UIMessage>(
	messages: readonly M[],
	turnModel: string,
	contextVersion = MODEL_CONTEXT_VERSION,
): M[] {
	let newest:
		| { messageIndex: number; partIndex: number; message: M }
		| undefined;

	for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
		const message = messages[messageIndex];
		for (let partIndex = 0; partIndex < message.parts.length; partIndex++) {
			if (isOpenAICompactionPart(message.parts[partIndex])) {
				newest = { messageIndex, partIndex, message };
			}
		}
	}
	if (!newest) return [...messages];

	const metadata = newest.message.metadata as
		| { model?: unknown; contextVersion?: unknown }
		| undefined;
	if (
		metadata?.model !== turnModel ||
		metadata.contextVersion !== contextVersion
	) {
		return messages.flatMap((message) => {
			const projected = withoutOpenAICompactionParts(message);
			return projected === null ? [] : [projected];
		});
	}

	const compactedMessage = {
		...newest.message,
		parts: newest.message.parts.slice(newest.partIndex),
	};
	return [compactedMessage, ...messages.slice(newest.messageIndex + 1)];
}
