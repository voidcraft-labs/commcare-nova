import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";

/** Fold the actual emitted SDK chunks. This makes the completed fixture
 * browsable; it does not exercise the HTTP stream/reconnect lifecycle. */
export async function foldTrialChunks(
	chunks: readonly UIMessageChunk[],
	seed?: UIMessage,
) {
	let message: UIMessage | null = null;
	const stream = new ReadableStream<UIMessageChunk>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
	for await (const snapshot of readUIMessageStream({
		message: seed,
		stream,
		terminateOnError: true,
	}))
		message = snapshot;
	return message;
}

export function trialConversationWithResponse(
	messages: readonly UIMessage[],
	response: UIMessage | null,
): UIMessage[] {
	if (!response) return [...messages];
	return messages.at(-1)?.id === response.id
		? [...messages.slice(0, -1), response]
		: [...messages, response];
}

/** Apply an ordinary answer to the exact server-produced question message. */
export function answerTrialQuestion<T extends UIMessage>(
	messages: readonly T[],
	toolCallId: string,
	answers: Record<string, string>,
): T[] {
	let matched = false;
	const result = messages.map((message) => ({
		...message,
		parts: message.parts.map((part) => {
			if (part.type !== "tool-askQuestions" || part.toolCallId !== toolCallId)
				return part;
			matched = true;
			return { ...part, state: "output-available" as const, output: answers };
		}),
	}));
	if (!matched)
		throw new Error("The saved transcript has no matching question.");
	return result as T[];
}
