// lib/chat/__tests__/validateMessages.test.ts
//
// Unit tests for the chat route's server-side message gate. This is a pure
// function over the request body's `messages`, so it's tested as in/out — no
// route, no mocks. The contracts it guards: a bounded message count, a bounded
// request-wide attachment total, per-ref field-length caps, and — the easy thing
// to get wrong — that ordinary messages WITHOUT attachment metadata pass (an
// absent `metadata` is a valid attachment-free message, not a schema violation).

import { describe, expect, it } from "vitest";
import type { AttachmentRef, NovaUIMessage } from "../attachmentRefs";
import {
	MAX_ATTACHMENTS_PER_MESSAGE,
	MAX_CHAT_ATTACHMENTS,
	MAX_CHAT_MESSAGES,
} from "../limits";
import { validateChatMessages } from "../validateMessages";

/** A valid image attachment ref, overridable per test. */
function ref(over: Partial<AttachmentRef> = {}): AttachmentRef {
	return {
		assetId: "11111111-1111-1111-1111-111111111111",
		kind: "image",
		filename: "diagram.png",
		mimeType: "image/png",
		...over,
	};
}

/** A user message with optional attachment refs in metadata. */
function userMsg(refs?: AttachmentRef[]): NovaUIMessage {
	return {
		id: "u1",
		role: "user",
		parts: [{ type: "text", text: "build this" }],
		...(refs ? { metadata: { attachments: refs } } : {}),
	} as NovaUIMessage;
}

/** A plain assistant message — no metadata at all. */
function assistantMsg(): NovaUIMessage {
	return {
		id: "a1",
		role: "assistant",
		parts: [{ type: "text", text: "done" }],
	} as NovaUIMessage;
}

describe("validateChatMessages", () => {
	it("rejects a non-array body", () => {
		const result = validateChatMessages(undefined);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("messages");
	});

	it("passes ordinary messages with no attachment metadata", () => {
		// The critical case: assistant messages and plain user messages have NO
		// `metadata`, and the metadata schema is an object that rejects `undefined`.
		// They must pass untouched — failing here would break all normal chat.
		const messages = [userMsg(), assistantMsg(), userMsg()];
		const result = validateChatMessages(messages);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.messages).toBe(messages);
	});

	it("passes a message carrying valid attachment refs", () => {
		const result = validateChatMessages([userMsg([ref(), ref()])]);
		expect(result.ok).toBe(true);
	});

	it("rejects more than MAX_CHAT_MESSAGES messages", () => {
		const messages = Array.from({ length: MAX_CHAT_MESSAGES + 1 }, () =>
			assistantMsg(),
		);
		const result = validateChatMessages(messages);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain(String(MAX_CHAT_MESSAGES));
	});

	it("rejects a request whose attachment total exceeds MAX_CHAT_ATTACHMENTS", () => {
		// Spread across many messages so it's the REQUEST total that trips, not any
		// single message's per-message cap (each message stays within that cap).
		const perMsg = MAX_ATTACHMENTS_PER_MESSAGE;
		const msgCount = Math.ceil((MAX_CHAT_ATTACHMENTS + 1) / perMsg);
		const messages = Array.from({ length: msgCount }, () =>
			userMsg(Array.from({ length: perMsg }, () => ref())),
		);
		const result = validateChatMessages(messages);
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.error).toContain(String(MAX_CHAT_ATTACHMENTS));
	});

	it("rejects a single message over the per-message attachment cap", () => {
		const refs = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, () =>
			ref(),
		);
		const result = validateChatMessages([userMsg(refs)]);
		expect(result.ok).toBe(false);
	});

	it("rejects an attachment ref with an over-length field", () => {
		// A title past its 200-char cap — the kind of bloat the caps bound from
		// reaching the event log.
		const result = validateChatMessages([
			userMsg([ref({ title: "x".repeat(201) })]),
		]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("metadata");
	});

	it("rejects an attachment ref missing a required field", () => {
		// assetId is required + non-empty; an empty one is a malformed ref.
		const result = validateChatMessages([userMsg([ref({ assetId: "" })])]);
		expect(result.ok).toBe(false);
	});

	it("rejects an unknown attachment kind", () => {
		const result = validateChatMessages([
			// biome-ignore lint/suspicious/noExplicitAny: deliberately invalid kind
			userMsg([ref({ kind: "spreadsheet" as any })]),
		]);
		expect(result.ok).toBe(false);
	});
});
