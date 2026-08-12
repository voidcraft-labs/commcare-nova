import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { projectDesignStepMessages } from "@/lib/agent/design/loop/designAgent";
import { DESIGN_STATE_MESSAGE_HEADING } from "@/lib/agent/design/loop/packageRender";

const checkpoint = {
	role: "assistant",
	content: [
		{
			type: "custom",
			kind: "openai.compaction",
			providerMetadata: { openai: { type: "compaction" } },
		},
	],
} as unknown as ModelMessage;

describe("design agent compaction checkpoint", () => {
	it("replaces old model history and appends one fresh server state message", async () => {
		const fresh = vi.fn(
			async (): Promise<ModelMessage> => ({
				role: "user",
				content: `${DESIGN_STATE_MESSAGE_HEADING}\n\nworkspace revision 4`,
			}),
		);
		const persist = vi.fn(async () => undefined);
		const projected = await projectDesignStepMessages(
			[
				{ role: "user", content: "old request" },
				checkpoint,
				{ role: "assistant", content: "continuing" },
			],
			fresh,
			persist,
		);
		expect(projected).toHaveLength(3);
		expect(projected[0]).toMatchObject({ role: "assistant" });
		expect(projected[2]).toEqual({
			role: "user",
			content: `${DESIGN_STATE_MESSAGE_HEADING}\n\nworkspace revision 4`,
		});
		expect(fresh).toHaveBeenCalledOnce();
		expect(persist).toHaveBeenCalledOnce();
		expect(persist).toHaveBeenCalledWith({
			boundaryDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
			message: projected[2],
		});
	});

	it("retains an authoritative state already appended after the checkpoint", async () => {
		const fresh = vi.fn(
			async (): Promise<ModelMessage> => ({
				role: "user",
				content: DESIGN_STATE_MESSAGE_HEADING,
			}),
		);
		const existingState: ModelMessage = {
			role: "user",
			content: `${DESIGN_STATE_MESSAGE_HEADING}\n\nworkspace revision 4`,
		};
		const projected = await projectDesignStepMessages(
			[checkpoint, existingState, { role: "assistant", content: "next" }],
			fresh,
		);
		expect(projected).toContainEqual(existingState);
		expect(fresh).not.toHaveBeenCalled();
	});
});
