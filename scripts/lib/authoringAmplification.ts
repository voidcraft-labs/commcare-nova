/** Conservative incident repair: only a repeated final suffix with one durable origin. */
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface AmplificationPlan {
	messageId: string;
	copies: number;
	removedParts: number;
	messages: unknown[];
	beforeDigest: string;
	afterDigest: string;
}

/** No interior deduplication: earlier part indexes are durable answer identities. */
export function findAuthoringAmplification(
	messages: readonly unknown[],
): AmplificationPlan | null {
	const last = messages.at(-1);
	if (
		!record(last) ||
		last.role !== "assistant" ||
		typeof last.id !== "string" ||
		!Array.isArray(last.parts)
	)
		return null;
	const parts: unknown[] = last.parts;
	const tail = parts.at(-1);
	if (
		!record(tail) ||
		tail.type !== "text" ||
		tail.state !== "done" ||
		typeof tail.text !== "string" ||
		!tail.text.trim()
	)
		return null;
	const tailDigest = canonicalJsonDigest(tail);
	let first = parts.length - 1;
	while (first > 0 && canonicalJsonDigest(parts[first - 1]) === tailDigest)
		first--;
	const copies = parts.length - first;
	if (
		copies < 2 ||
		!parts
			.slice(0, first)
			.some(
				(part) =>
					record(part) &&
					part.type === "tool-askQuestions" &&
					part.state === "output-available",
			)
	)
		return null;
	const repaired = [
		...messages.slice(0, -1),
		{ ...last, parts: parts.slice(0, first + 1) },
	];
	return {
		messageId: last.id,
		copies,
		removedParts: copies - 1,
		messages: repaired,
		beforeDigest: canonicalJsonDigest(messages),
		afterDigest: canonicalJsonDigest(repaired),
	};
}

export function planAuthoringAmplificationRepair(
	messages: readonly unknown[],
	durableMessages: readonly unknown[],
): AmplificationPlan | null {
	const plan = findAuthoringAmplification(messages);
	if (!plan) return null;
	const last = messages.at(-1);
	if (!record(last) || !Array.isArray(last.parts)) return null;
	const tail = last.parts.at(-1);
	if (!record(tail)) return null;
	// One emitted final must have exactly one model origin. Ambiguity is a refusal.
	let origins = 0;
	for (const message of durableMessages) {
		if (!record(message) || message.role !== "assistant") continue;
		if (message.content === tail.text) origins++;
		if (Array.isArray(message.content)) {
			for (const part of message.content) {
				if (record(part) && part.type === "text" && part.text === tail.text)
					origins++;
			}
		}
	}
	if (origins !== 1) return null;
	return plan;
}
