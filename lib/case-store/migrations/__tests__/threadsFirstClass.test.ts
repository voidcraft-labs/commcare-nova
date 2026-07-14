/**
 * The threads migration's message transform: lossy StoredThreadMessage rows
 * → text-parts-only UIMessages that hydrate `useChat` and read as plain
 * dialogue to the SA. The DDL itself is exercised by every harness run
 * (the per-test databases replay all migrations).
 */
import { describe, expect, it } from "vitest";
import { storedMessageToUIMessage } from "../20260714000000_threads_first_class";

describe("storedMessageToUIMessage", () => {
	it("keeps text parts verbatim", () => {
		expect(
			storedMessageToUIMessage({
				id: "m1",
				role: "user",
				parts: [{ type: "text", text: "build a clinic app" }],
			}),
		).toEqual({
			id: "m1",
			role: "user",
			parts: [{ type: "text", text: "build a clinic app" }],
		});
	});

	it("flattens an askQuestions round into readable Q/A dialogue", () => {
		const msg = storedMessageToUIMessage({
			id: "m2",
			role: "assistant",
			parts: [
				{
					type: "askQuestions",
					toolCallId: "t1",
					header: "Case setup",
					questions: [
						{ question: "Track clients?", answer: "Yes" },
						{ question: "Include GPS?", answer: "" },
					],
				},
			],
		});
		expect(msg.parts).toHaveLength(1);
		expect(msg.parts[0].text).toBe(
			"Case setup\n\nTrack clients?\n→ Yes\n\nInclude GPS?",
		);
	});

	it("carries attachments into message metadata and drops empty parts", () => {
		const msg = storedMessageToUIMessage({
			id: "m3",
			role: "user",
			parts: [{ type: "text", text: "" }],
			attachments: [{ assetId: "a1" }],
		});
		expect(msg.parts).toEqual([]);
		expect(msg.metadata).toEqual({ attachments: [{ assetId: "a1" }] });
	});
});
