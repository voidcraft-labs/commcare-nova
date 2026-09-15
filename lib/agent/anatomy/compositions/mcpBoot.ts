/**
 * The MCP boot prompt: what `get_agent_prompt` hands an external client
 * agent. No Nova model runs here; the client mounts the MCP tools itself.
 *
 * Build mode boots the MCP-only build composition, edit mode boots the
 * architect's edit prompt without app state, and
 * the terminal marker is last by contract.
 */

import type { StandardJSONSchemaV1 } from "@standard-schema/spec";
import { z } from "zod";
import {
	MCP_BUILD_SEGMENTS,
	SOLUTIONS_ARCHITECT_SEGMENTS,
} from "@/lib/agent/prompts";
import {
	agentPromptSegments,
	type PromptMode,
	renderAgentPrompt,
} from "@/lib/mcp/prompts";
import { registerNovaTools } from "@/lib/mcp/server";
import type {
	ContextItem,
	MomentSpec,
	PromptSegmentView,
	RoleComposition,
	ToolDefinitionView,
} from "../types";
import {
	moment,
	segmentViews,
	specById,
	systemItem,
	toolsItem,
	wireJson,
} from "./shared";

const RENDERER = { file: "lib/mcp/prompts.ts", symbol: "renderAgentPrompt" };
const PROMPTS = "lib/agent/prompts.ts";

const MOMENTS: readonly MomentSpec[] = [
	{
		id: "build-interactive",
		label: "Build, interactive",
		why: "Build guidance with questions available for consequential choices.",
		needs: [],
		source: RENDERER,
	},
	{
		id: "build-autonomous",
		label: "Build, autonomous",
		why: "The autobuild skill: the same build composition with the autonomous block, which forbids asking and requires defaults reported in the summary.",
		needs: [],
		source: RENDERER,
	},
	{
		id: "edit-interactive",
		label: "Edit, interactive",
		why: "Edit guidance. The client reads the current app separately through get_app.",
		needs: [],
		source: RENDERER,
	},
];

/** Every MCP tool as the server registers it, collected through a stub
 * server. Registration reads nothing from the tool context. */
export function collectMcpToolDefinitions(): ToolDefinitionView[] {
	const collected: ToolDefinitionView[] = [];
	const server = {
		registerTool(
			name: string,
			config: { description?: string; inputSchema?: unknown },
		) {
			const schema = config.inputSchema as
				| z.ZodType
				| StandardJSONSchemaV1
				| undefined;
			collected.push({
				name,
				description: config.description ?? "",
				inputSchema:
					schema === undefined
						? {}
						: !(schema instanceof z.ZodType)
							? wireJson(
									schema["~standard"].jsonSchema.input({ target: "draft-07" }),
								)
							: wireJson(
									z.toJSONSchema(schema, {
										target: "draft-7",
										io: "input",
										unrepresentable: "any",
									}),
								),
				strict: undefined,
			});
		},
	};
	const ctx = new Proxy(
		{},
		{
			get(_target, property) {
				throw new Error(
					`Collecting MCP tool definitions read ctx.${String(property)} at registration time. The anatomy expects registration to be pure; look at the tool that registered last.`,
				);
			},
		},
	);
	registerNovaTools(server as never, ctx as never);
	return collected;
}

let mcpToolsMemo: ToolDefinitionView[] | undefined;

function mcpTools(): ToolDefinitionView[] {
	mcpToolsMemo ??= collectMcpToolDefinitions();
	return mcpToolsMemo;
}

export const mcpBootComposition: RoleComposition = {
	role: "mcp-boot",
	moments: MOMENTS,
	async compose(momentId) {
		const spec = specById(MOMENTS, momentId, "MCP boot");
		const edit = spec.id.startsWith("edit");
		const interactive = spec.id.endsWith("interactive");
		const tools = toolsItem({
			tools: mcpTools(),
			source: { file: "lib/mcp/server.ts", symbol: "registerNovaTools" },
			note: "What the MCP server registers: the MCP-only tools, then every shared tool under its snake_case name with app_id added. The client decides how to present them to its model.",
		});
		const mode: PromptMode = edit
			? "edit"
			: interactive
				? "build"
				: "autonomous_build";
		const text = renderAgentPrompt(mode);
		/* The renderer's own pieces. The base prompt piece is shown as the
		 * segments its builder joins, so the architect's and the build
		 * prompt's parts read the same here as on their own pages. */
		const pieces = agentPromptSegments(mode);
		const segments: PromptSegmentView[] = pieces.flatMap((piece) => {
			if (piece.id === "architect") {
				return segmentViews(
					SOLUTIONS_ARCHITECT_SEGMENTS,
					PROMPTS,
					"SOLUTIONS_ARCHITECT_SEGMENTS",
				);
			}
			if (piece.id === "build") {
				return segmentViews(MCP_BUILD_SEGMENTS, PROMPTS, "MCP_BUILD_SEGMENTS");
			}
			return [
				{
					id: piece.id,
					title: piece.title,
					text: piece.text.trim(),
					source: {
						file: "lib/mcp/prompts.ts",
						symbol:
							piece.id === "interaction-mode"
								? "INTERACTIVITY_INSTRUCTIONS"
								: piece.id === "reference"
									? "agentPromptSegments"
									: "PROMPT_END_MARKER",
					},
					...(piece.generated && { generated: piece.generated }),
				},
			];
		});
		const system: ContextItem = systemItem({
			label: "Boot prompt",
			text,
			segments,
			source: RENDERER,
			origin: "composed",
			note: "Static guidance delivered in one MCP result. App state and detailed references are read separately.",
		});
		return moment(spec, [system, tools]);
	},
};
