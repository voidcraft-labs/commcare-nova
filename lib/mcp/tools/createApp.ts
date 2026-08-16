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
 * No ownership check: there's nothing to own yet — the app is being
 * created in this call. Scope gating happens at the route layer via
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
				"Create a Nova app with the canonical export-ready survey starter and return its exact sequence-1 blueprint and starter UUIDs for subsequent tool calls. Every later change is checked as it lands.",
			inputSchema: z.object({
				app_name: z
					.string()
					.optional()
					.describe(
						'Optional initial name. Omitted or whitespace-only names become the real persisted name "Untitled".',
					),
			}),
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			/* Mint the first run id for this app. Subsequent MCP tool
			 * calls on the same app read it off the doc and reuse it
			 * for the duration of the sliding inactivity window. */
			const runId = crypto.randomUUID();
			try {
				/* MCP-created apps land in the caller's personal Project. */
				const projectId = await ensurePersonalProject(ctx.userId);
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
				return toMcpErrorResult(err, { userId: ctx.userId });
			}
		},
	);
}
