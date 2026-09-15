/** Authorized app overview. Detailed content is available through scoped reads. */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { appOverview } from "@/lib/agent/appOverview";
import { listUserProjects } from "@/lib/projects/membership";
import {
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { loadAppBlueprint } from "../loadApp";
import { LARGE_RESULT_META } from "../resultSize";
import type { ToolContext } from "../types";

/**
 * Register the single-argument `get_app` tool on an `McpServer`.
 *
 * `loadAppBlueprint` ownership-gates and loads the doc in one
 * read, throwing `McpAccessError` on a cross-tenant probe
 * or a vanished row. Only `.doc` is consumed here — the full `AppDoc`
 * envelope is available for callers that need denormalized columns
 * (see `compile_app`).
 */
export function registerGetApp(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"get_app",
		{
			description:
				"Get an app overview: workflows, record model, languages, and configured capabilities. Read individual modules, forms or fields for their content and settings.",
			_meta: LARGE_RESULT_META,
			inputSchema: z.object({
				app_id: z.string().describe("App ID. Requires access to its Project."),
			}),
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			const appId = args.app_id;
			try {
				const loaded = await loadAppBlueprint(appId, ctx.userId);
				/* Name the app's Project from the caller's own memberships —
				 * the access gate just proved they belong to it, so the
				 * lookup can only miss on a mid-request membership change. */
				const projects = await listUserProjects(ctx.userId);
				const projectName = projects.find(
					(p) => p.id === loaded.access.projectId,
				)?.name;
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								project: {
									id: loaded.access.projectId,
									name: projectName ?? null,
								},
								app: appOverview(loaded.doc),
							}),
						},
					],
				};
			} catch (err) {
				return toMcpErrorResult(err, {
					appId,
					userId: ctx.userId,
				});
			}
		},
	);
}
