/**
 * MCP server registration entry point.
 *
 * Invoked by the route handler (`app/api/mcp/route.ts`) once per MCP
 * request after the bearer token has been verified against the local
 * JWKS. A fresh `McpServer` is handed in and this module binds every
 * Nova tool onto it.
 *
 * Two categories of tool, two registration paths:
 *
 *   1. **MCP-only tools** (`lib/mcp/tools/*`) — `list_apps`, `get_app`,
 *      `create_app`, `delete_app`, `compile_app`, `upload_app_to_hq`,
 *      and `get_agent_prompt`. Each owns request-shaped logic the chat
 *      surface never needed: cross-app ownership scans, HQ REST client
 *      calls, compile format branching, CCZ streaming, prompt templating
 *      by build mode. That bespoke logic means each module hand-rolls its
 *      own `server.registerTool(...)` call behind a `register*(server, ctx)`
 *      facade — there is nothing meaningful to factor out of them.
 *
 *   2. **Shared SA tools** (`lib/agent/tools/*`) — the blueprint
 *      readers + writers the chat-side Solutions Architect already uses
 *      (search, add_field, edit_field, create_form, validate_app, …).
 *      Those modules share a uniform contract (input schema, `execute`
 *      against a `BlueprintDoc` + `ToolExecutionContext`) so the MCP
 *      surface funnels them through one adapter: `registerSharedTool`
 *      adds ownership + per-call log writer + progress emitter + result
 *      projection in one place. Adding a new shared tool is a one-line
 *      change to the manifest below — no per-tool boilerplate in this
 *      file.
 *
 * The split keeps each site honest about its complexity: tools whose
 * shape the adapter can't express go through the MCP-only path; tools
 * whose shape it can go through the shared path, so the domain
 * definition lives in exactly one place (`lib/agent/tools`) and is
 * consumed identically by the chat-side agent and the MCP endpoint.
 *
 * Nova exposes no standalone MCP prompt resources. The agent-prompt
 * surface is served through the `get_agent_prompt` tool instead, because
 * the rendered prompt varies by build mode (new vs edit) and embeds an
 * app-scoped blueprint summary. Those inputs need `app_id`, which MCP
 * prompt resources can't receive.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { addFieldTool } from "@/lib/agent/tools/addField";
import { addFieldsTool } from "@/lib/agent/tools/addFields";
import { addCaseListColumnTool } from "@/lib/agent/tools/case-list-config/addCaseListColumn";
import { addSearchInputTool } from "@/lib/agent/tools/case-list-config/addSearchInput";
import { removeCaseListColumnTool } from "@/lib/agent/tools/case-list-config/removeCaseListColumn";
import { removeSearchInputTool } from "@/lib/agent/tools/case-list-config/removeSearchInput";
import { reorderCaseListColumnsTool } from "@/lib/agent/tools/case-list-config/reorderCaseListColumns";
import { reorderSearchInputsTool } from "@/lib/agent/tools/case-list-config/reorderSearchInputs";
import { setCaseListFilterTool } from "@/lib/agent/tools/case-list-config/setCaseListFilter";
import { updateCaseListColumnTool } from "@/lib/agent/tools/case-list-config/updateCaseListColumn";
import { updateSearchInputTool } from "@/lib/agent/tools/case-list-config/updateSearchInput";
import { setCaseSearchClaimTool } from "@/lib/agent/tools/case-search-config/setCaseSearchClaim";
import { setCaseSearchDisplayTool } from "@/lib/agent/tools/case-search-config/setCaseSearchDisplay";
import { createFormTool } from "@/lib/agent/tools/createForm";
import { createModuleTool } from "@/lib/agent/tools/createModule";
import { editFieldTool } from "@/lib/agent/tools/editField";
import { generateScaffoldTool } from "@/lib/agent/tools/generateScaffold";
import { generateSchemaTool } from "@/lib/agent/tools/generateSchema";
import { getFieldTool } from "@/lib/agent/tools/getField";
import { getFormTool } from "@/lib/agent/tools/getForm";
import { getModuleTool } from "@/lib/agent/tools/getModule";
import { removeFieldTool } from "@/lib/agent/tools/removeField";
import { removeFormTool } from "@/lib/agent/tools/removeForm";
import { removeModuleTool } from "@/lib/agent/tools/removeModule";
import { searchBlueprintTool } from "@/lib/agent/tools/searchBlueprint";
import { updateFormTool } from "@/lib/agent/tools/updateForm";
import { updateModuleTool } from "@/lib/agent/tools/updateModule";
import { validateAppTool } from "@/lib/agent/tools/validateApp";
import {
	registerSharedTool,
	type SharedToolModule,
} from "./adapters/sharedToolAdapter";
import { registerCompileApp } from "./tools/compileApp";
import { registerCreateApp } from "./tools/createApp";
import { registerDeleteApp } from "./tools/deleteApp";
import { registerGetAgentPrompt } from "./tools/getAgentPrompt";
import { registerGetApp } from "./tools/getApp";
import { registerGetHqConnection } from "./tools/getHqConnection";
import { registerListApps } from "./tools/listApps";
import { registerSearchApps } from "./tools/searchApps";
import { registerUploadAppToHq } from "./tools/uploadAppToHq";
import type { ToolContext } from "./types";

/**
 * Manifest of shared-tool modules paired with their snake_case MCP wire
 * names. Typed as `ReadonlyArray<{ name, tool }>` so TypeScript fails
 * loudly if a module shape drifts away from the adapter's
 * `SharedToolModule` contract — the compile error is far more useful
 * than a runtime `server.registerTool` failure once a live request is
 * already in flight.
 *
 * **Wire-name convention**: snake_case is standard across MCP tools
 * (matches the MCP SDK's built-in naming convention). The TypeScript
 * export name stays camelCase so JavaScript idiom is preserved on
 * both sides of the boundary without either side bleeding into the
 * other.
 *
 * **`askQuestions` is intentionally absent.** The chat-side SA uses it
 * to emit mid-run clarifying questions through the UI's question panel;
 * the MCP surface doesn't — Claude Code's `AskUserQuestion` covers that
 * interaction pattern client-side. Adding it here would give the MCP
 * agent a dead-end question path (it has no client-side panel to render
 * the result).
 */
const SHARED_TOOLS: ReadonlyArray<{ name: string; tool: SharedToolModule }> = [
	{ name: "add_field", tool: addFieldTool },
	{ name: "add_fields", tool: addFieldsTool },
	{ name: "create_form", tool: createFormTool },
	{ name: "create_module", tool: createModuleTool },
	{ name: "edit_field", tool: editFieldTool },
	{ name: "generate_schema", tool: generateSchemaTool },
	{ name: "generate_scaffold", tool: generateScaffoldTool },
	{ name: "get_field", tool: getFieldTool },
	{ name: "get_form", tool: getFormTool },
	{ name: "get_module", tool: getModuleTool },
	{ name: "remove_field", tool: removeFieldTool },
	{ name: "remove_form", tool: removeFormTool },
	{ name: "remove_module", tool: removeModuleTool },
	{ name: "search_blueprint", tool: searchBlueprintTool },
	/* Case-list-config mutations — atomic add / update / remove /
	 * reorder ops on each of the two arrays (`columns`,
	 * `searchInputs`), plus the wholesale `filter` setter.
	 * Snake_case MCP wire names mirror the camelCase TypeScript
	 * exports per the wire-name convention above. */
	{ name: "add_case_list_column", tool: addCaseListColumnTool },
	{ name: "add_search_input", tool: addSearchInputTool },
	{ name: "remove_case_list_column", tool: removeCaseListColumnTool },
	{ name: "remove_search_input", tool: removeSearchInputTool },
	{ name: "reorder_case_list_columns", tool: reorderCaseListColumnsTool },
	{ name: "reorder_search_inputs", tool: reorderSearchInputsTool },
	{ name: "set_case_list_filter", tool: setCaseListFilterTool },
	{ name: "update_case_list_column", tool: updateCaseListColumnTool },
	{ name: "update_search_input", tool: updateSearchInputTool },
	/* Case-search-config wholesale mutations — one tool per cluster.
	 * Cross-binding contract: search inputs are NOT authored through
	 * these tools (they live on `caseListConfig.searchInputs` and use
	 * the case-list-config search-input quartet above). */
	{ name: "set_case_search_claim", tool: setCaseSearchClaimTool },
	{ name: "set_case_search_display", tool: setCaseSearchDisplayTool },
	{ name: "update_form", tool: updateFormTool },
	{ name: "update_module", tool: updateModuleTool },
	{ name: "validate_app", tool: validateAppTool },
];

/**
 * Register every Nova tool on a fresh `McpServer`. Called once per
 * request by the MCP route handler after JWT verification succeeds.
 *
 * Ordering isn't load-bearing — MCP's tool registry is flat and
 * unordered — but MCP-only tools are listed first for readability so a
 * reader scanning the file sees the small hand-registered set before
 * the longer adapter loop.
 *
 * @param server - The per-request `McpServer` instance supplied by
 *   `createMcpHandler`. A fresh server is instantiated for every MCP
 *   session; nothing is cached between requests.
 * @param ctx - Authenticated caller identity + parsed scopes. Every
 *   tool receives this via closure so the user id resolves without
 *   touching the raw JWT.
 */
export function registerNovaTools(server: McpServer, ctx: ToolContext): void {
	/* MCP-only tools — each owns bespoke per-request logic the shared
	 * adapter intentionally can't express (ownership scans across the
	 * full app table, HQ client calls, compile-format branching, prompt
	 * templating). */
	registerGetAgentPrompt(server, ctx);
	registerListApps(server, ctx);
	registerSearchApps(server, ctx);
	registerGetApp(server, ctx);
	registerCreateApp(server, ctx);
	registerDeleteApp(server, ctx);
	registerCompileApp(server, ctx);
	registerGetHqConnection(server, ctx);
	registerUploadAppToHq(server, ctx);

	/* Shared SA tools — one manifest, one adapter, one source of truth
	 * with the chat-side `solutionsArchitect` factory. */
	for (const { name, tool } of SHARED_TOOLS) {
		registerSharedTool(server, name, tool, ctx);
	}
}
