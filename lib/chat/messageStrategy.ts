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
 * In expired-cache EDIT mode the SA gets one-shot delivery — only the last user
 * message — because its system prompt already carries a compact blueprint
 * summary, so prior turns would just burn tokens against a dead Anthropic prompt
 * cache. In every other mode (a build, or a live-cache edit) it gets the full
 * history so it can iterate with prior-turn context.
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
		// The last USER message specifically: even if the very last message is an
		// assistant turn (a malformed history), we want the latest user request,
		// never an empty trailing turn.
		return messages.filter((m) => m.role === "user").slice(-1);
	}
	return messages;
}
