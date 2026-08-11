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
		const projected = await projectDesignStepMessages(
			[
				{ role: "user", content: "old request" },
				checkpoint,
				{ role: "assistant", content: "continuing" },
			],
			fresh,
		);
		expect(projected).toHaveLength(3);
		expect(projected[0]).toMatchObject({ role: "assistant" });
		expect(projected[2]).toEqual({
			role: "user",
			content: `${DESIGN_STATE_MESSAGE_HEADING}\n\nworkspace revision 4`,
		});
		expect(fresh).toHaveBeenCalledOnce();
	});

	it("replaces a retained state checkpoint with current server state", async () => {
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
		expect(projected).not.toContainEqual(existingState);
		expect(projected).toContainEqual({
			role: "user",
			content: DESIGN_STATE_MESSAGE_HEADING,
		});
		expect(fresh).toHaveBeenCalledOnce();
	});
});
