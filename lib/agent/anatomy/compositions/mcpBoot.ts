/**
 * The MCP boot prompt: what `get_agent_prompt` hands an external client
 * agent. No Nova model runs here; the client mounts the MCP tools itself.
 *
 * Build mode boots the MCP-only build composition, edit mode boots the
 * architect's edit prompt with the complete app-state block inlined, and
 * the terminal marker is last by contract.
 */

import { z } from "zod";
import {
	MCP_BUILD_SEGMENTS,
	SOLUTIONS_ARCHITECT_SEGMENTS,
} from "@/lib/agent/prompts";
import {
	INTERACTIVITY_INSTRUCTIONS,
	PROMPT_END_MARKER,
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
	missingItem,
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
		why: "The plugin's build skill: the MCP build composition plus the interactive block, so the client agent may ask a handful of questions.",
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
		why: "An existing app: the architect's edit prompt with the complete app-state block inlined before the marker, because a boot prompt fetched once has no cache prefix to protect.",
		needs: ["app"],
		source: RENDERER,
	},
	{
		id: "edit-autonomous",
		label: "Edit, autonomous",
		why: "Not a workflow the plugin exposes; shown so the renderer's four combinations are all visible.",
		needs: ["app"],
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
			const schema = config.inputSchema as z.ZodType | undefined;
			collected.push({
				name,
				description: config.description ?? "",
				inputSchema:
					schema === undefined
						? {}
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
	async compose(momentId, inputs) {
		const spec = specById(MOMENTS, momentId, "MCP boot");
		const edit = spec.id.startsWith("edit");
		const interactive = spec.id.endsWith("interactive");
		const tools = toolsItem({
			tools: mcpTools(),
			source: { file: "lib/mcp/server.ts", symbol: "registerNovaTools" },
			note: "What the MCP server registers: the MCP-only tools, then every shared tool under its snake_case name with app_id added. The client decides how to present them to its model.",
		});
		if (edit && inputs.app === undefined) {
			return moment(spec, [
				missingItem({
					id: "system",
					label: "Boot prompt",
					needs: "app",
					explanation:
						"Pick a local app to render the edit prompt: the architect's segments, the interaction block, the complete app-state block, then the marker.",
					source: RENDERER,
				}),
				tools,
			]);
		}
		const doc = edit ? inputs.app?.doc : undefined;
		const text = renderAgentPrompt(interactive, doc);
		const base = edit ? SOLUTIONS_ARCHITECT_SEGMENTS : MCP_BUILD_SEGMENTS;
		const baseSymbol = edit
			? "SOLUTIONS_ARCHITECT_SEGMENTS"
			: "MCP_BUILD_SEGMENTS";
		const segments: PromptSegmentView[] = [
			...segmentViews(base, PROMPTS, baseSymbol),
			{
				id: "interaction-mode",
				title: "Interaction mode",
				text: INTERACTIVITY_INSTRUCTIONS[
					interactive ? "interactive" : "autonomous"
				].trim(),
				source: {
					file: "lib/mcp/prompts.ts",
					symbol: "INTERACTIVITY_INSTRUCTIONS",
				},
			},
			...(edit && doc !== undefined
				? [
						{
							id: "app-state",
							title: "Current app state",
							text: appStateSection(text),
							source: {
								file: "lib/mcp/prompts.ts",
								symbol: "appStateBlockFor",
							},
							generated: ["summarizeBlueprint"],
						} satisfies PromptSegmentView,
					]
				: []),
			{
				id: "end-marker",
				title: "Delivery marker",
				text: PROMPT_END_MARKER,
				source: { file: "lib/mcp/prompts.ts", symbol: "PROMPT_END_MARKER" },
			},
		];
		const system: ContextItem = systemItem({
			label: "Boot prompt",
			text,
			segments,
			source: RENDERER,
			origin: edit ? "derived" : "composed",
			note: edit
				? "The app-state block is the largest and most app-specific section, so the marker after it is what turns a truncated delivery into a refusal."
				: "Delivered as an MCP tool result. The marker is last so a size-capped delivery is detectable.",
		});
		return moment(spec, [system, tools]);
	},
};

/** The rendered prompt's app-state section: from its heading to the marker. */
function appStateSection(rendered: string): string {
	const heading = "## Current app state";
	const start = rendered.lastIndexOf(heading);
	const end = rendered.lastIndexOf(PROMPT_END_MARKER);
	if (start === -1 || end === -1) return "";
	return rendered.slice(start, end).trimEnd();
}
