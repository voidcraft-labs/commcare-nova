/**
 * `nova.create_app` — mint an empty Nova app owned by the authenticated
 * user. Born `complete`: an empty app is at rest and valid (its
 * nameless, moduleless state is a pre-existing finding that only ever
 * shrinks), and every subsequent tool call gates on its own merits —
 * there is no draft window, no finishing step, and status never feeds
 * the gate. Exports gate on FINDINGS: an app whose content passes the
 * boundary review exports; one with findings doesn't, whatever its age.
 *
 * Scope: `nova.write`.
 *
 * Returns the new `app_id` so the caller can thread it into subsequent
 * tool calls (`update_app`, `create_module`, etc.).
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
 * **No event-log write on success.** `create_app` is atomic: the app
 * row itself is the record of creation (via its `created_at` + `owner`
 * fields), so duplicating that into the event log would add no
 * information.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensurePersonalProject } from "@/lib/auth/provisionProject";
import { createApp } from "@/lib/db/apps";
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
 * helper mints the Firestore document id.
 */
export function registerCreateApp(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"create_app",
		{
			description:
				"Create an empty Nova app owned by you and return its app_id for subsequent tool calls. Build it up with the other tools — every change is checked as it lands, so the app is always export-ready as far as it goes. Exports (compile_app / upload_app_to_hq) succeed once the content passes the full review.",
			inputSchema: {
				app_name: z
					.string()
					.optional()
					.describe(
						"Optional initial name. If omitted, the app name starts blank — set it with update_app before exporting.",
					),
			},
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			/* Mint the first run id for this app. Subsequent MCP tool
			 * calls on the same app read it off the doc and reuse it
			 * for the duration of the sliding inactivity window. */
			const runId = crypto.randomUUID();
			try {
				/* Normalize the optional name: `trim()` collapses surrounding
				 * whitespace, `|| undefined` maps the empty string (and the
				 * original omitted case) to undefined so the DB helper's
				 * `""` default kicks in. Whitespace-only names are treated
				 * as empty — otherwise the list row would show a blank with
				 * no visible way to rename. */
				const appName = args.app_name?.trim() || undefined;

				/* MCP-created apps land in the caller's personal Project. */
				const projectId = await ensurePersonalProject(ctx.userId);
				const appId = await createApp(ctx.userId, projectId, runId, {
					appName,
					status: "complete",
				});
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ stage: "app_created", app_id: appId }),
						},
					],
				};
			} catch (err) {
				return toMcpErrorResult(err, { userId: ctx.userId });
			}
		},
	);
}
