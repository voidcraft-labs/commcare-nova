/** Static, server-owned authoring guidance. This read contains no app data. */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { PROMPT_MODES, renderAgentPrompt } from "../prompts";

export function registerGetAgentPrompt(server: McpServer): void {
	server.registerTool(
		"get_agent_prompt",
		{
			description:
				"Get current Nova authoring guidance for a build or edit. The complete text ends with NOVA-PROMPT-END. Read app state separately with get_app.",
			inputSchema: z.object({ mode: z.enum(PROMPT_MODES) }).strict(),
		},
		async ({ mode }) => ({
			content: [{ type: "text" as const, text: renderAgentPrompt(mode) }],
		}),
	);
}
