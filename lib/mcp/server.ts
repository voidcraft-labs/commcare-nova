/** Register Nova's MCP surface after authentication. Shared editing operations
 * come from SHARED_TOOL_REGISTRY; the common lifecycle opens and saves private
 * work. MCP-only account, saved-app and deployment tools retain their own
 * authorization and effects. No definitions or execution state persist on the
 * request-scoped server. */

import type { McpServer } from "@modelcontextprotocol/server";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import { registerSharedTool } from "./adapters/sharedToolAdapter";
import { registerCheckProjectSpaceCompatibility } from "./tools/checkProjectSpaceCompatibility";
import { registerCompileApp } from "./tools/compileApp";
import { registerCreateProject } from "./tools/createProject";
import { registerDeleteApp } from "./tools/deleteApp";
import {
	registerGetDeployment,
	registerRefreshDeployment,
} from "./tools/deploymentTools";
import { registerGetAgentPrompt } from "./tools/getAgentPrompt";
import { registerGetApp } from "./tools/getApp";
import { registerGetEntryPointLink } from "./tools/getEntryPointLink";
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
import { registerWorkTools } from "./tools/work";
import type { ToolContext } from "./types";

export function registerNovaTools(server: McpServer, ctx: ToolContext): void {
	/* Account, saved-app and deployment operations remain immediate. */
	registerGetAgentPrompt(server);
	registerListApps(server, ctx);
	registerSearchApps(server, ctx);
	registerGetApp(server, ctx);
	registerCheckProjectSpaceCompatibility(server, ctx);
	registerWorkTools(server, ctx);
	registerDeleteApp(server, ctx);
	registerCompileApp(server, ctx);
	registerGetHqConnection(server, ctx);
	registerUploadAppToHq(server, ctx);
	registerGetDeployment(server, ctx);
	registerRefreshDeployment(server, ctx);
	registerGetEntryPointLink(server, ctx);
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
	for (const entry of SHARED_TOOL_REGISTRY) {
		registerSharedTool(server, entry, ctx);
	}
}
