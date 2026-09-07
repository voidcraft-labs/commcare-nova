import { describe, expect, it } from "vitest";
import { DESIGN_STATE_MESSAGE_HEADING } from "../packageRender";
import {
	catalogInput,
	consumeDesignAgent,
	wireAgent,
	withDesignResponses,
} from "./designAgentPeer";

describe("design agent provider compaction checkpoint", () => {
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
