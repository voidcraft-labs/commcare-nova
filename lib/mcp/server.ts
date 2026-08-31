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
 *      `create_app`, `delete_app`, `check_project_space_compatibility`,
 *      `compile_app`,
 *      `upload_app_to_hq`, `get_agent_prompt`, and the Project-management
 *      set (`list_projects`, `create_project`, `invite_member`,
 *      `list_members`, `update_member_role`, `move_app`). Each owns
 *      request-shaped logic the chat
 *      surface never needed: cross-app ownership scans, HQ REST client
 *      calls, compile format branching, CCZ streaming, prompt templating
 *      by build mode, Project tenancy writes. That bespoke logic means each
 *      module hand-rolls its
 *      own `server.registerTool(...)` call behind a `register*(server, ctx)`
 *      facade — there is nothing meaningful to factor out of them.
 *
 *   2. **Shared SA tools** (`lib/agent/tools/*`) — the blueprint
 *      readers + writers the chat-side Solutions Architect already uses
 *      (search, add_fields, edit_field, create_form, …).
 *      Those modules share a uniform contract (input schema, `execute`
 *      against a workspace-owned `ToolInvocationContext`) so the MCP
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

import type { McpServer } from "@modelcontextprotocol/server";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import { registerSharedTool } from "./adapters/sharedToolAdapter";
import { registerCheckProjectSpaceCompatibility } from "./tools/checkProjectSpaceCompatibility";
import { registerCompileApp } from "./tools/compileApp";
import { registerCreateApp } from "./tools/createApp";
import { registerCreateProject } from "./tools/createProject";
import { registerDeleteApp } from "./tools/deleteApp";
import {
	registerGetDeployment,
	registerRefreshDeployment,
} from "./tools/deploymentTools";
import { registerGetAgentPrompt } from "./tools/getAgentPrompt";
import { registerGetApp } from "./tools/getApp";
import { registerGetAppHqFeatureFlagsCompatibility } from "./tools/getAppHqFeatureFlagsCompatibility";
import { registerGetHqConnection } from "./tools/getHqConnection";
import { registerInviteMember } from "./tools/inviteMember";
import { registerListApps } from "./tools/listApps";
import { registerListMembers } from "./tools/listMembers";
import { registerListProjects } from "./tools/listProjects";
import { registerMoveApp } from "./tools/moveApp";
import { registerProvisionWorkers } from "./tools/provisionWorkers";
import { registerSearchApps } from "./tools/searchApps";
import { registerUpdateMemberRole } from "./tools/updateMemberRole";
import { registerUploadAppToHq } from "./tools/uploadAppToHq";
import { registerUploadMediaAsset } from "./tools/uploadMediaAsset";
import type { ToolContext } from "./types";

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
	registerCheckProjectSpaceCompatibility(server, ctx);
	registerGetAppHqFeatureFlagsCompatibility(server, ctx);
	registerCreateApp(server, ctx);
	registerDeleteApp(server, ctx);
	registerCompileApp(server, ctx);
	registerGetHqConnection(server, ctx);
	registerUploadAppToHq(server, ctx);
	registerGetDeployment(server, ctx);
	registerRefreshDeployment(server, ctx);
	registerProvisionWorkers(server, ctx);
	registerUploadMediaAsset(server, ctx);
	registerListProjects(server, ctx);
	registerCreateProject(server, ctx);
	registerInviteMember(server, ctx);
	registerListMembers(server, ctx);
	registerUpdateMemberRole(server, ctx);
	registerMoveApp(server, ctx);

	/* Shared SA tools — one manifest, one adapter, one source of truth
	 * with the chat-side `solutionsArchitect` factory. */
	for (const { mcpName, tool, requires } of SHARED_TOOL_REGISTRY) {
		registerSharedTool(server, mcpName, tool, ctx, requires);
	}
}
