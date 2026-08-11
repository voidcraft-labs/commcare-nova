import type { UIMessage } from "ai";

/** Reconstruct the completed input boundary of a run whose process died.
 * A fresh turn's partial assistant message disappears whole. An answered
 * question continuation keeps the same assistant message id across runs, so
 * preserve its parts through the last durable answer and discard only the
 * later partial work. Both the browser and route use this exact projection so
 * the stream grows from the same message the server persists. */
export function trimInterruptedRecoveryHistory<T extends UIMessage>(
	messages: readonly T[],
): T[] {
	const trailing = messages.at(-1);
	if (trailing?.role !== "assistant") return [...messages];
	let lastAnsweredQuestion = -1;
	for (const [index, part] of trailing.parts.entries()) {
		if (
			part.type === "tool-askQuestions" &&
			"state" in part &&
			part.state === "output-available"
		) {
			lastAnsweredQuestion = index;
		}
	}
	if (lastAnsweredQuestion < 0) return messages.slice(0, -1);
	if (lastAnsweredQuestion === trailing.parts.length - 1) return [...messages];
	return [
		...messages.slice(0, -1),
		{
			...trailing,
			parts: trailing.parts.slice(0, lastAnsweredQuestion + 1),
		} as T,
	];
}
