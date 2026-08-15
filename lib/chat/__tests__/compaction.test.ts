import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
	isOpenAICompactionChunk,
	modelMessagesContainCompaction,
	projectCompatibleCompactedHistory,
	projectModelHistoryFromNewestCompaction,
} from "@/lib/chat/compaction";

const MODEL = "gpt-5.6-sol";

function textMessage(id: string, role: "user" | "assistant", text: string) {
	return { id, role, parts: [{ type: "text", text }] } as UIMessage;
}

function compactedMessage(metadata: { model: string; contextVersion: string }) {
	return {
		id: "compacted",
		role: "assistant",
		metadata,
		parts: [
			{ type: "text", text: "visible text before the model boundary" },
			{
				type: "custom",
				kind: "openai.compaction",
				providerMetadata: { openai: { type: "compaction" } },
				value: "opaque-provider-item",
			},
		],
	} as unknown as UIMessage;
}

describe("model context compaction", () => {
	it("projects from the newest compatible compaction item without deleting UI history", () => {
		const complete = [
			textMessage("old-user", "user", "old request"),
			compactedMessage({ model: MODEL, contextVersion: "v1" }),
			textMessage("new-user", "user", "new request"),
		];
		const projected = projectCompatibleCompactedHistory(complete, MODEL);

		expect(complete).toHaveLength(3);
		expect(projected).toHaveLength(2);
		expect(projected[0]?.id).toBe("compacted");
		expect(projected[0]?.parts).toHaveLength(1);
		expect(projected[0]?.parts[0]).toMatchObject({
			type: "custom",
			kind: "openai.compaction",
		});
		expect(projected[1]?.id).toBe("new-user");
	});

	it("keeps ordinary history but strips an incompatible provider checkpoint", () => {
		const history = [
			textMessage("old", "user", "old"),
			compactedMessage({ model: MODEL, contextVersion: "v1" }),
		];
		for (const projected of [
			projectCompatibleCompactedHistory(history, "gpt-5.6-luna"),
			projectCompatibleCompactedHistory(history, MODEL, "v2"),
		]) {
			expect(projected).toHaveLength(2);
			expect(projected[0]).toEqual(history[0]);
			expect(projected[1]?.parts).toEqual([
				{ type: "text", text: "visible text before the model boundary" },
			]);
		}
	});

	it("recognizes stream and model-response compaction shapes", () => {
		expect(
			isOpenAICompactionChunk({
				type: "custom",
				kind: "openai.compaction",
			}),
		).toBe(true);
		expect(
			modelMessagesContainCompaction([
				{
					role: "assistant",
					content: [{ type: "custom", kind: "openai.compaction" }],
				},
			]),
		).toBe(true);
	});

	it("uses the newest checkpoint as the boundary inside a multi-step tool loop", () => {
		const projected = projectModelHistoryFromNewestCompaction([
			{ role: "user", content: "old context" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "old answer" },
					{ type: "custom", kind: "openai.compaction" },
					{
						type: "tool-call",
						toolCallId: "call-1",
						toolName: "searchBlueprint",
						input: {},
					},
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call-1",
						toolName: "searchBlueprint",
						output: { type: "json", value: { canCommit: false } },
					},
				],
			},
		]);

		expect(projected).toHaveLength(2);
		expect(projected[0]).toMatchObject({
			role: "assistant",
			content: [
				{ type: "custom", kind: "openai.compaction" },
				{ type: "tool-call", toolCallId: "call-1" },
			],
		});
		expect(projected[1]?.role).toBe("tool");
	});
});
