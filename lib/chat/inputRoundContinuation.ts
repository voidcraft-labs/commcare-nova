import type { UIMessage } from "ai";
import type { InputRound } from "./inputRound";

/** Client ownership of one server-issued invitation. Transcript shape never
 * grants continuation: it only proves all answers for that invitation exist. */
export function createInputRoundContinuation(
	initial: InputRound | null,
	legacyInputPause = false,
) {
	let round = initial;
	let suspended = false;
	const attempted = new Set<string>();
	const acceptsAnswer = (toolCallId: string) =>
		!suspended &&
		round?.state === "pending" &&
		round.kind === "questions" &&
		round.toolCallIds.includes(toolCallId);
	return {
		get round() {
			return round;
		},
		get requiresReconciliation() {
			return suspended;
		},
		get awaitsTypedMessage() {
			return (
				!suspended &&
				((round?.state === "pending" && round.kind === "message") ||
					(round === null && legacyInputPause))
			);
		},
		adopt(next: InputRound | null) {
			legacyInputPause = false;
			// A cold replay can include the old pending receipt before its
			// consumption. Never downgrade an already-consumed invitation.
			if (round?.id === next?.id && round?.state === "consumed") return;
			round = next;
		},
		acceptsAnswer,
		markSubmitted() {
			if (round?.state === "pending") attempted.add(round.id);
		},
		suspend() {
			suspended = true;
		},
		/** Called only for a deliberate answer action, never on request finish. */
		retryAnswer(toolCallId: string) {
			if (acceptsAnswer(toolCallId) && round) attempted.delete(round.id);
		},
		claimAutomatic(messages: readonly UIMessage[]): boolean {
			if (suspended || !answeredInputRound(messages, round) || !round)
				return false;
			if (attempted.has(round.id)) return false;
			attempted.add(round.id);
			return true;
		},
	};
}

export type InputRoundContinuation = ReturnType<
	typeof createInputRoundContinuation
>;

export function answeredInputRound(
	messages: readonly UIMessage[],
	round: InputRound | null,
): boolean {
	if (
		round?.state !== "pending" ||
		round.kind !== "questions" ||
		round.toolCallIds.length === 0
	)
		return false;
	const last = messages.at(-1);
	if (last?.role !== "assistant" || last.id !== round.assistantMessageId)
		return false;
	return round.toolCallIds.every((id) => {
		const parts = last.parts.filter(
			(part) => part.type === "tool-askQuestions" && part.toolCallId === id,
		);
		return (
			parts.length === 1 &&
			"state" in parts[0] &&
			parts[0].state === "output-available"
		);
	});
}
