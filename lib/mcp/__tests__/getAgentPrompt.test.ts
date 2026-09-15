/** Real MCP dispatch. Role guidance is static and never reads an app. */
import { expect, it } from "vitest";
import {
	buildMcpAgentBuildPrompt,
	buildSolutionsArchitectPrompt,
} from "@/lib/agent/prompts";
import {
	INTERACTIVITY_INSTRUCTIONS,
	PROMPT_END_MARKER,
	PROMPT_MODES,
} from "../prompts";
import { registerGetAgentPrompt } from "../tools/getAgentPrompt";
import { withMcpClient } from "./client";

it.each(PROMPT_MODES)(
	"serves complete %s guidance through MCP",
	async (mode) => {
		await withMcpClient(registerGetAgentPrompt, async (client) => {
			const result = await client.callTool({
				name: "get_agent_prompt",
				arguments: { mode },
			});
			expect(result.isError).not.toBe(true);
			expect(result.content).toHaveLength(1);
			const content = result.content[0];
			if (content.type !== "text") throw new Error("Expected text guidance.");
			expect(
				content.text.startsWith(
					mode === "edit"
						? buildSolutionsArchitectPrompt()
						: buildMcpAgentBuildPrompt(),
				),
			).toBe(true);
			expect(content.text).toContain(
				INTERACTIVITY_INSTRUCTIONS[
					mode === "autonomous_build" ? "autonomous" : "interactive"
				],
			);
			expect(content.text.endsWith(PROMPT_END_MARKER)).toBe(true);
		});
	},
);

it.each([
	{ mode: "autonomous_edit" },
	{ mode: true },
	{},
	{ mode: "edit", app_id: "private-app" },
	{ mode: "build", cursor: "old-page" },
])("rejects unsupported input %j", async (args) => {
	await withMcpClient(registerGetAgentPrompt, async (client) => {
		const result = await client.callTool({
			name: "get_agent_prompt",
			arguments: args,
		});
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([
			{ type: "text", text: expect.stringContaining("Input validation error") },
		]);
	});
});
