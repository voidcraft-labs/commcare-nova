import { describe, expect, it } from "vitest";
import type { NovaUIMessage } from "@/lib/chat/attachmentRefs";
import { loadSourceMaterial } from "../sources";

describe("answered question source identity", () => {
	it("keeps request identity and review evidence stable when display parts move", async () => {
		const answer = {
			type: "tool-askQuestions" as const,
			toolCallId: "question-call",
			state: "output-available" as const,
			input: {
				header: "Work",
				questions: [
					{ question: "Who uses the app?", options: [{ label: "Nurses" }] },
				],
			},
			output: { "0": "Nurses" },
		};
		const original: NovaUIMessage = {
			id: "message",
			role: "assistant",
			parts: [answer],
		};
		const moved: NovaUIMessage = {
			...original,
			parts: [
				{ type: "step-start" },
				{ type: "text", text: "Before the question" },
				answer,
			],
		};
		const before = await loadSourceMaterial({
			projectId: "project",
			messages: [original],
		});
		const after = await loadSourceMaterial({
			projectId: "project",
			messages: [moved],
		});
		expect(before.requests[0].key).toBe("answers:message:question-call");
		expect(after.requests[0].key).toBe(before.requests[0].key);
		expect(after.requests[0].message).toEqual(before.requests[0].message);
		expect(before.requests[0].legacyKeys).toContain("answers:message:0");
		expect(after.requests[0].legacyKeys).toContain("answers:message:2");
		expect(after.digest).toBe(before.digest);
	});
});
