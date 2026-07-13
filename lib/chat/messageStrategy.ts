// lib/chat/messageStrategy.ts
//
// Pure message-delivery selection for the chat route: which messages the SA
// actually receives this turn, given the editing mode + the prompt-cache window.
// Split out so the one-shot trim — the part that decides an expired-cache edit
// sends only the last user message — is unit-testable without a route harness.

import type { NovaUIMessage } from "./attachmentRefs";

/**
 * The messages to resolve + send the SA for this turn.
 *
 * In expired-cache EDIT mode the SA gets one-shot delivery — the last user
 * message onward — because its system prompt already carries a compact
 * blueprint summary, so earlier turns would just burn tokens against a dead
 * prompt cache. In every other mode (a build, or a live-cache edit) it gets
 * the full history so it can iterate with prior-turn context.
 *
 * "Onward" matters: when the user answers an askQuestions round after the
 * cache lapses, the history ends with the ASSISTANT message whose tool part
 * carries the answers. Trimming to the user message alone would re-run the
 * original request blind to the question round — the SA would re-ask or act
 * on unconfirmed assumptions, while the event log (which records the answers
 * as delivered tool-results) claimed otherwise. Keeping everything from the
 * last user message forward delivers the round + answers at one-shot cost.
 *
 * Selecting here, BEFORE the attachment resolve, is what makes an expired-cache
 * edit avoid downloading/extracting history attachments it would then discard —
 * the resolve runs over exactly the messages that will be sent. SA input is
 * unchanged either way (resolution is per-message and order-preserving); this
 * only removes wasted work.
 *
 * `editing` and `cacheExpired` are the two orthogonal signals the route already
 * computes; passing them in keeps this a pure function of its inputs.
 */
export function selectMessagesToSend(
	messages: NovaUIMessage[],
	{ editing, cacheExpired }: { editing: boolean; cacheExpired: boolean },
): NovaUIMessage[] {
	if (editing && cacheExpired) {
		// Anchored on the last USER message specifically: a history whose tail
		// is assistant-only (an answered question round) keeps that tail, and a
		// malformed history with no user message at all sends nothing rather
		// than an unanchored trailing turn.
		const lastUserIdx = messages.findLastIndex((m) => m.role === "user");
		if (lastUserIdx === -1) return [];
		return messages.slice(lastUserIdx);
	}
	return messages;
}
