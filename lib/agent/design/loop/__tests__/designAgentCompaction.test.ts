import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { projectDesignWorkingContext } from "../designAgent";
import { DESIGN_STATE_MESSAGE_HEADING } from "../packageRender";
import {
	catalogInput,
	consumeDesignAgent,
	wireAgent,
	withDesignResponses,
} from "./designAgentPeer";

describe("design agent provider compaction checkpoint", () => {
	it("replaces only server state while preserving identical user text and complete tool exchanges", () => {
		const oldState: ModelMessage = {
			role: "user",
			content: `${DESIGN_STATE_MESSAGE_HEADING}\nOld findings and candidate.`,
		};
		const currentState: ModelMessage = {
			role: "user",
			content: `${DESIGN_STATE_MESSAGE_HEADING}\nCurrent findings and candidate.`,
		};
		const call: ModelMessage = {
			role: "assistant",
			content: [
				{
					type: "reasoning",
					text: "Inspect the saved design.",
					providerOptions: { openai: { encryptedContent: "opaque-reasoning" } },
				},
				{
					type: "tool-call",
					toolCallId: "read",
					toolName: "inspectDesign",
					input: { selection: { kind: "root" } },
				},
			],
		};
		const result: ModelMessage = {
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "read",
					toolName: "inspectDesign",
					output: { type: "json", value: { ok: true, name: "Garden" } },
				},
			],
		};
		const copiedUser = structuredClone(oldState);
		const items = [
			{ appendKey: "state:earlier", message: oldState },
			{ appendKey: "ui-turn:user-copy", message: copiedUser },
			{ appendKey: "response:read", message: call },
			{ appendKey: "response:read", message: result },
			{ appendKey: "compaction-state:current", message: currentState },
		];
		const before = structuredClone(items);
		expect(projectDesignWorkingContext(items)).toEqual([
			copiedUser,
			call,
			result,
			currentState,
		]);
		expect(items).toEqual(before);
	});

	it("replays opaque checkpoint bytes, retains tool pairs and appends one fresh state across native SDK steps", async () => {
		await withDesignResponses(
			[
				[
					{
						type: "compaction",
						id: "cmp_actual",
						encryptedContent: "opaque-encrypted-state",
					},
					{
						type: "tool",
						callId: "inspect_after_checkpoint",
						name: "inspectProjectData",
						input: catalogInput,
					},
				],
				[
					{
						type: "tool",
						callId: "inspect_next",
						name: "inspectProjectData",
						input: catalogInput,
					},
				],
				[{ type: "text", text: "The current Project catalog is empty." }],
			],
			async (model, requests) => {
				let freshCount = 0;
				const persisted: string[] = [];
				const result = await consumeDesignAgent(
					wireAgent(model, {
						freshStateMessage: async () => {
							freshCount++;
							return {
								role: "user",
								content: `${DESIGN_STATE_MESSAGE_HEADING}\nworkspace revision 4`,
							};
						},
						onCompactionState: async ({ boundaryDigest }) => {
							persisted.push(boundaryDigest);
						},
					}),
					[{ role: "user", content: "Superseded history before checkpoint." }],
				);
				expect(result.steps).toHaveLength(3);
				expect(result.text).toBe("The current Project catalog is empty.");
				expect(freshCount).toBe(1);
				expect(persisted).toHaveLength(1);
				expect(persisted[0]).toMatch(/^[a-f0-9]{64}$/);
				for (const request of requests.slice(1)) {
					expect(request.input).toContainEqual({
						type: "compaction",
						id: "cmp_actual",
						encrypted_content: "opaque-encrypted-state",
					});
					expect(JSON.stringify(request.input)).not.toContain(
						"Superseded history",
					);
					expect(
						JSON.stringify(request.input).split("workspace revision 4"),
					).toHaveLength(2);
					expect(
						request.input
							?.filter((item) => item.call_id === "inspect_after_checkpoint")
							.map((item) => item.type),
					).toEqual(["function_call", "function_call_output"]);
				}
				expect(
					requests[2].input
						?.filter((item) => item.call_id === "inspect_next")
						.map((item) => item.type),
				).toEqual(["function_call", "function_call_output"]);
			},
		);
	});
});
