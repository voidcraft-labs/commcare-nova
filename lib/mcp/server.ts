/**
 * MCP server registration entry point.
 *
 * Invoked by `app/api/mcp/dispatch.ts::dispatchMcpTools` once per MCP
 * request after the caller has been authenticated — either via OAuth-
 * issued JWT verified against the AS's JWKS, or via API-key hash
 * check against the `apikey` collection. Both paths converge with a
 * `ToolContext` carrying `userId` + `scopes`; this module binds every
 * Nova tool onto a fresh `McpServer` it is handed.
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
 *      (search, add_fields, edit_field, create_form, …).
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
import { addFieldsTool } from "@/lib/agent/tools/addFields";
import { addCaseListColumnsTool } from "@/lib/agent/tools/case-list-config/addCaseListColumns";
import { addSearchInputsTool } from "@/lib/agent/tools/case-list-config/addSearchInputs";
import { removeCaseListColumnTool } from "@/lib/agent/tools/case-list-config/removeCaseListColumn";
import { removeSearchInputTool } from "@/lib/agent/tools/case-list-config/removeSearchInput";
import { reorderCaseListColumnsTool } from "@/lib/agent/tools/case-list-config/reorderCaseListColumns";
import { reorderSearchInputsTool } from "@/lib/agent/tools/case-list-config/reorderSearchInputs";
import { setCaseListFilterTool } from "@/lib/agent/tools/case-list-config/setCaseListFilter";
import { updateCaseListColumnTool } from "@/lib/agent/tools/case-list-config/updateCaseListColumn";
import { updateSearchInputTool } from "@/lib/agent/tools/case-list-config/updateSearchInput";
import { setCaseSearchAdvancedTool } from "@/lib/agent/tools/case-search-config/setCaseSearchAdvanced";
import { setCaseSearchDisplayTool } from "@/lib/agent/tools/case-search-config/setCaseSearchDisplay";
import { createFormTool } from "@/lib/agent/tools/createForm";
import { createModuleTool } from "@/lib/agent/tools/createModule";
import { editFieldTool } from "@/lib/agent/tools/editField";
import { generateSchemaTool } from "@/lib/agent/tools/generateSchema";
import { getFieldTool } from "@/lib/agent/tools/getField";
import { getFormTool } from "@/lib/agent/tools/getForm";
import { getModuleTool } from "@/lib/agent/tools/getModule";
import { attachFieldMediaTool } from "@/lib/agent/tools/media/attachFieldMedia";
import { attachOptionMediaTool } from "@/lib/agent/tools/media/attachOptionMedia";
import { listMediaAssetsTool } from "@/lib/agent/tools/media/listMediaAssets";
import { removeMediaAssetTool } from "@/lib/agent/tools/media/removeMediaAsset";
import { setAppLogoTool } from "@/lib/agent/tools/media/setAppLogo";
import { setMenuMediaTool } from "@/lib/agent/tools/media/setMenuMedia";
import { removeFieldTool } from "@/lib/agent/tools/removeField";
import { removeFormTool } from "@/lib/agent/tools/removeForm";
import { removeModuleTool } from "@/lib/agent/tools/removeModule";
import { searchBlueprintTool } from "@/lib/agent/tools/searchBlueprint";
import { updateAppTool } from "@/lib/agent/tools/updateApp";
import { updateFormTool } from "@/lib/agent/tools/updateForm";
import { updateModuleTool } from "@/lib/agent/tools/updateModule";
import type { AppCapability } from "@/lib/auth/projectRoles";
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
import { registerUploadMediaAsset } from "./tools/uploadMediaAsset";
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
const SHARED_TOOLS: ReadonlyArray<{
	name: string;
	tool: SharedToolModule;
	/** Minimum app capability the caller's Project role must grant. */
	requires: AppCapability;
}> = [
	{ name: "add_fields", tool: addFieldsTool, requires: "edit" },
	{ name: "create_form", tool: createFormTool, requires: "edit" },
	{ name: "create_module", tool: createModuleTool, requires: "edit" },
	{ name: "edit_field", tool: editFieldTool, requires: "edit" },
	/* The data-model tool — commits the case-type catalog onto the doc
	 * (never the app name; that's update_app's slot). create_module
	 * references the recorded types by name; a new case type enters an
	 * existing app through this tool. */
	{ name: "generate_schema", tool: generateSchemaTool, requires: "edit" },
	{ name: "get_field", tool: getFieldTool, requires: "view" },
	{ name: "get_form", tool: getFormTool, requires: "view" },
	{ name: "get_module", tool: getModuleTool, requires: "view" },
	{ name: "remove_field", tool: removeFieldTool, requires: "edit" },
	{ name: "remove_form", tool: removeFormTool, requires: "edit" },
	{ name: "remove_module", tool: removeModuleTool, requires: "edit" },
	{ name: "search_blueprint", tool: searchBlueprintTool, requires: "view" },
	/* Case-list-config mutations — atomic add / update / remove /
	 * reorder ops on each of the two arrays (`columns`,
	 * `searchInputs`), plus the wholesale `filter` setter.
	 * Snake_case MCP wire names mirror the camelCase TypeScript
	 * exports per the wire-name convention above. */
	{
		name: "add_case_list_columns",
		tool: addCaseListColumnsTool,
		requires: "edit",
	},
	{ name: "add_search_inputs", tool: addSearchInputsTool, requires: "edit" },
	{
		name: "remove_case_list_column",
		tool: removeCaseListColumnTool,
		requires: "edit",
	},
	{
		name: "remove_search_input",
		tool: removeSearchInputTool,
		requires: "edit",
	},
	{
		name: "reorder_case_list_columns",
		tool: reorderCaseListColumnsTool,
		requires: "edit",
	},
	{
		name: "reorder_search_inputs",
		tool: reorderSearchInputsTool,
		requires: "edit",
	},
	{
		name: "set_case_list_filter",
		tool: setCaseListFilterTool,
		requires: "edit",
	},
	{
		name: "update_case_list_column",
		tool: updateCaseListColumnTool,
		requires: "edit",
	},
	{
		name: "update_search_input",
		tool: updateSearchInputTool,
		requires: "edit",
	},
	/* Case-search-config wholesale mutations — one tool per cluster.
	 * Cross-binding contract: search inputs are NOT authored through
	 * these tools (they live on `caseListConfig.searchInputs` and use
	 * the case-list-config search-input quartet above). */
	{
		name: "set_case_search_advanced",
		tool: setCaseSearchAdvancedTool,
		requires: "edit",
	},
	{
		name: "set_case_search_display",
		tool: setCaseSearchDisplayTool,
		requires: "edit",
	},
	/* Media authoring — the dedicated surface for attaching asset ids to
	 * carriers (the generic mutation tools omit every media slot). Four
	 * doc-mutation tools, batch-shaped where the carrier repeats
	 * (field slots / options / menu tiles / app-logo) plus two library
	 * tools (`list` discovers asset ids; `remove` deletes one with a
	 * reference guard). The MCP-only `upload_media_asset` is
	 * hand-registered below — it neither targets a doc nor an app id, so
	 * it can't ride the shared adapter. */
	{ name: "attach_field_media", tool: attachFieldMediaTool, requires: "edit" },
	{
		name: "attach_option_media",
		tool: attachOptionMediaTool,
		requires: "edit",
	},
	{ name: "set_menu_media", tool: setMenuMediaTool, requires: "edit" },
	{ name: "set_app_logo", tool: setAppLogoTool, requires: "edit" },
	{ name: "list_media_assets", tool: listMediaAssetsTool, requires: "view" },
	{ name: "remove_media_asset", tool: removeMediaAssetTool, requires: "edit" },
	{ name: "update_app", tool: updateAppTool, requires: "edit" },
	{ name: "update_form", tool: updateFormTool, requires: "edit" },
	{ name: "update_module", tool: updateModuleTool, requires: "edit" },
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
	registerUploadMediaAsset(server, ctx);

	/* Shared SA tools — one manifest, one adapter, one source of truth
	 * with the chat-side `solutionsArchitect` factory. */
	for (const { name, tool, requires } of SHARED_TOOLS) {
		registerSharedTool(server, name, tool, ctx, requires);
	}
}
