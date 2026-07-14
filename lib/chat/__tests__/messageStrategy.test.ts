// lib/chat/__tests__/messageStrategy.test.ts
//
// Unit tests for the chat route's message-delivery selection. Pure in/out — the
// route harness it lives in isn't testable, but this transform is. It guards the
// one-shot trim: an expired-cache EDIT sends the last user message onward (a
// trailing answered-askQuestions assistant message rides along — the SA must see
// the answers the event log records as delivered), while every other mode sends
// the full history. Getting this wrong either wastes tokens against a dead cache
// or drops context the SA needs.

import { describe, expect, it } from "vitest";
import type { NovaUIMessage } from "../attachmentRefs";
import { selectMessagesToSend } from "../messageStrategy";

function msg(id: string, role: "user" | "assistant"): NovaUIMessage {
	return { id, role, parts: [{ type: "text", text: id }] } as NovaUIMessage;
}

const history: NovaUIMessage[] = [
	msg("u1", "user"),
	msg("a1", "assistant"),
	msg("u2", "user"),
	msg("a2", "assistant"),
	msg("u3", "user"),
];

describe("selectMessagesToSend", () => {
	it("sends only the last user message in an expired-cache edit", () => {
		const out = selectMessagesToSend(history, {
			editing: true,
			cacheExpired: true,
		});
		expect(out.map((m) => m.id)).toEqual(["u3"]);
	});

	it("sends the full history for a live-cache edit", () => {
		const out = selectMessagesToSend(history, {
			editing: true,
			cacheExpired: false,
		});
		expect(out).toBe(history);
	});

	it("sends the full history for a build (not editing), cache state aside", () => {
		expect(
			selectMessagesToSend(history, { editing: false, cacheExpired: true }),
		).toBe(history);
		expect(
			selectMessagesToSend(history, { editing: false, cacheExpired: false }),
		).toBe(history);
	});

	it("keeps a trailing assistant message — it carries an answered question round", () => {
		// The answered-askQuestions resend ends with the ASSISTANT message whose
		// tool part holds the user's answers. The one-shot trim must deliver it:
		// anchoring on the last user message and slicing FORWARD keeps the round,
		// so the SA sees the answers the event log records as delivered.
		const trailing = [...history, msg("a3", "assistant")];
		const out = selectMessagesToSend(trailing, {
			editing: true,
			cacheExpired: true,
		});
		expect(out.map((m) => m.id)).toEqual(["u3", "a3"]);
	});

	it("sends nothing for a history with no user message at all", () => {
		const assistantOnly = [msg("a1", "assistant")];
		const out = selectMessagesToSend(assistantOnly, {
			editing: true,
			cacheExpired: true,
		});
		expect(out).toEqual([]);
	});
});
