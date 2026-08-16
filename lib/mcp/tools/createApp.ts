/**
 * `nova.create_app` — mint a born-export-ready Nova app owned by the
 * authenticated user. Every app starts with a real name plus one survey
 * module, survey form, and text question. There is no empty persisted state,
 * draft window, or finishing step.
 *
 * Scope: `nova.write`.
 *
 * Returns the committed sequence-1 blueprint and starter UUIDs with the new
 * `app_id`, so callers continue from exact identity without rediscovery.
 *
 * Tenancy: with no `project_id` the app is born in the caller's personal
 * Project, as before. An explicit `project_id` targets a shared Project
 * instead — gated here by `requireProjectAccess` at the `edit` capability
 * (denials for nonexistent / non-member Projects collapse to the standard
 * Project not-found envelope), and re-asserted inside the genesis
 * transaction. Scope gating happens at the route layer via
 * `verifyAccessToken`, so by the time this handler runs the JWT
 * already proved `nova.write`.
 *
 * Run grouping: the new app doc is seeded with a freshly-minted run id.
 * Subsequent MCP tool calls that land within the sliding inactivity
 * window (see `lib/mcp/runId.ts`) read the id off the app doc and reuse
 * it, so the whole build groups onto a single event-log run.
 *
 * Genesis does not replay its construction mutations. `createApp` writes the
 * canonical result as the immutable Project-bearing sequence-one baseline and
 * app/entity rows, with one attributed `fold-baseline` app change so all later
 * authored mutations begin after that baseline.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ensurePersonalProject } from "@/lib/auth/provisionProject";
import { createExplicitBlankApp } from "@/lib/db/appGenesis";
import {
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { requireProjectAccess } from "../ownership";
import type { ToolContext } from "../types";

/**
 * Register the `create_app` tool on an `McpServer`.
 *
 * The only input is an optional name; the underlying `createApp`
 * helper mints the app id (a `crypto.randomUUID()`) and commits canonical
 * genesis atomically.
 */
export function registerCreateApp(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"create_app",
		{
			description:
				"Create a Nova app with the canonical export-ready survey starter and return its exact sequence-1 blueprint and starter UUIDs for subsequent tool calls. Every later change is checked as it lands. Pass project_id to create the app in a shared Nova Project so its members can see it; omit it and the app lands in your personal Project.",
			inputSchema: z.object({
				app_name: z
					.string()
					.optional()
					.describe(
						'Optional initial name. Omitted or whitespace-only names become the real persisted name "Untitled".',
					),
				project_id: z
					.string()
					.min(1)
					.optional()
					.describe(
						"Optional Project to create the app in, from list_projects. Requires an editor or higher role there. Omitted, the app is created in your personal Project.",
					),
			}),
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			/* Mint the first run id for this app. Subsequent MCP tool
			 * calls on the same app read it off the doc and reuse it
			 * for the duration of the sliding inactivity window. */
			const runId = crypto.randomUUID();
			try {
				/* An explicit project_id targets that Project (membership at
				 * the `edit` capability checked here, re-asserted inside the
				 * genesis transaction); otherwise the app lands in the
				 * caller's personal Project. */
				const projectId = args.project_id
					? (
							await requireProjectAccess(
								ctx.userId,
								args.project_id,
								"edit",
								"Your role in this Project can't create apps. Ask a Project admin to make you an editor.",
							)
						).projectId
					: await ensurePersonalProject(ctx.userId);
				const receipt = await createExplicitBlankApp(
					ctx.userId,
					projectId,
					runId,
					{
						name: args.app_name,
						status: "complete",
					},
				);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								stage: "app_created",
								app_id: receipt.appId,
								base_seq: receipt.baseSeq,
								blueprint: receipt.blueprint,
								starter: {
									module_uuid: receipt.starter.moduleUuid,
									form_uuid: receipt.starter.formUuid,
									field_uuid: receipt.starter.fieldUuid,
								},
							}),
						},
					],
				};
			} catch (err) {
				return toMcpErrorResult(err, {
					userId: ctx.userId,
					projectId: args.project_id,
				});
			}
		},
	);
}
