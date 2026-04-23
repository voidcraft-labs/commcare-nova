/**
 * `nova.list_apps` — enumerate the authenticated user's Nova apps.
 *
 * Scope: `nova.read` (enforced by the route handler's
 * `verifyAccessToken` declaration — the tool itself trusts the JWT by
 * the time it runs).
 *
 * Returns id + name + status + updated_at per app. The user id from
 * the verified JWT is the filter — no ownership check and no `app_id`
 * input, which would both be cross-tenant escape hatches.
 *
 * Read-only; no event log or progress emitter needed. Soft-deleted
 * rows (`status: "deleted"`) are dropped by `listApps` at the
 * persistence boundary.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type AppSummary, listApps } from "@/lib/db/apps";
import { toMcpErrorResult } from "../errors";
import type { ToolContext } from "../types";

/** Wire shape returned to the MCP client — one entry per visible app. */
interface ListAppsEntry {
	app_id: string;
	name: string;
	status: AppSummary["status"];
	updated_at: string;
}

/**
 * Project a persistence-layer `AppSummary` into the narrow MCP response
 * row. Extracted so the list's mapping stays a single expression and
 * the wire shape has one canonical construction site.
 */
function toEntry(summary: AppSummary): ListAppsEntry {
	return {
		app_id: summary.id,
		name: summary.app_name,
		status: summary.status,
		updated_at: summary.updated_at,
	};
}

/**
 * Register the zero-argument `list_apps` tool on an `McpServer`.
 */
export function registerListApps(server: McpServer, ctx: ToolContext): void {
	server.tool(
		"list_apps",
		"List the authenticated user's Nova apps. Returns id, name, status, and updated_at per app.",
		/* Empty raw shape — the MCP SDK's `.tool(name, desc, shape, cb)`
		 * overload still requires a schema argument even when the tool
		 * takes zero parameters. An empty record satisfies the SDK's
		 * `ZodRawShapeCompat` without accepting any client-supplied
		 * arguments. */
		{},
		async () => {
			try {
				const apps = await listApps(ctx.userId);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ apps: apps.map(toEntry) }),
						},
					],
				};
			} catch (err) {
				return toMcpErrorResult(err);
			}
		},
	);
}
