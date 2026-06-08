// lib/chat/validateMessages.ts
//
// Server-side validation for the chat route's `messages` array. The AI SDK's
// `useChat` POSTs the full message history, and the route reads attachment refs
// off each message's `metadata` and re-resolves them every turn (each ref drives
// a Firestore load + a GCS/extract read, and the new turn's refs are persisted
// into the event log). That metadata is UNTRUSTED — `chatRequestSchema` validates
// the route's own fields but deliberately does NOT re-parse the SDK-owned message
// `parts`, so without this the attachment metadata reaches resolution unbounded.
//
// This is the narrow security gate: it bounds the message count and the
// request-wide attachment total (the real DoS surface — `resolveAttachments`
// walks every message and batch-loads each unique asset), and validates each
// present `metadata` against `messageMetadataSchema` so the per-ref field-length
// caps and the per-message array cap are enforced. It does NOT re-validate the
// message `parts` — that shape is the AI SDK's contract, not ours.

import { messageMetadataSchema, type NovaUIMessage } from "./attachmentRefs";
import { MAX_CHAT_ATTACHMENTS, MAX_CHAT_MESSAGES } from "./limits";

/** The outcome of validating a request's `messages`: either the typed array
 *  (cast once, after the metadata checks pass) or a human-readable rejection. */
export type ChatMessagesValidation =
	| { ok: true; messages: NovaUIMessage[] }
	| { ok: false; error: string };

/**
 * Validate the raw `messages` payload from the chat request body. Returns the
 * typed messages on success, or an Elm-style error string to surface as a 400.
 *
 * The checks, in order:
 *   1. It must be an array (the SDK always sends one; a malformed body might not).
 *   2. Its length is capped (`MAX_CHAT_MESSAGES`) — a bounded history.
 *   3. Each message that CARRIES metadata has it validated against
 *      `messageMetadataSchema`. Messages without metadata (every assistant
 *      message, and plain user messages) are skipped — absent metadata is a
 *      valid, attachment-free message, and `z.object` would reject `undefined`.
 *   4. The attachment refs across the whole request are summed and capped
 *      (`MAX_CHAT_ATTACHMENTS`) — the meaningful bound, since resolution cost
 *      scales with the request total, not any single message.
 */
export function validateChatMessages(raw: unknown): ChatMessagesValidation {
	if (!Array.isArray(raw)) {
		return {
			ok: false,
			error:
				"This request is missing its messages — the chat history didn't arrive as a list. Resend from the composer, or check the client is POSTing a `messages` array.",
		};
	}

	if (raw.length > MAX_CHAT_MESSAGES) {
		return {
			ok: false,
			error: `This request carries ${raw.length} messages, over the ${MAX_CHAT_MESSAGES}-message limit. Start a fresh conversation to continue — the history has grown past what one request can send.`,
		};
	}

	let totalAttachments = 0;
	for (const message of raw) {
		// Only assistant + plain user messages reach here without metadata; an
		// absent (or null) `metadata` is a valid attachment-free message, so skip
		// it rather than fail the schema's object check on `undefined`.
		const metadata = (message as { metadata?: unknown }).metadata;
		if (metadata === undefined || metadata === null) continue;

		const parsed = messageMetadataSchema.safeParse(metadata);
		if (!parsed.success) {
			return {
				ok: false,
				error:
					"An attachment on one of these messages has invalid metadata — a field is missing, the wrong type, or over its length limit. Remove and re-attach the file from the composer.",
			};
		}
		totalAttachments += parsed.data.attachments?.length ?? 0;
	}

	if (totalAttachments > MAX_CHAT_ATTACHMENTS) {
		return {
			ok: false,
			error: `This request references ${totalAttachments} attachments, over the ${MAX_CHAT_ATTACHMENTS}-attachment limit. Send fewer files per conversation — each one is read on every turn.`,
		};
	}

	return { ok: true, messages: raw as NovaUIMessage[] };
}
