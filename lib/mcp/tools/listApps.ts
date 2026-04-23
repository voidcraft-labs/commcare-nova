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
 *
 * `_meta.run_id` rides on both the success and error envelope — absent
 * a target `app_id`, `run_id` is the only grouping signal admin surfaces
 * can use to stitch this call to sibling tool calls the MCP client
 * bundles under the same id.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type AppSummary, listApps } from "@/lib/db/apps";
import {
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { resolveRunId } from "../runId";
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
	/* Omitting `inputSchema` is the SDK's zero-argument overload —
	 * `list_apps` takes no client arguments, so the config object
	 * carries only the `description` and the callback signature
	 * collapses to `(extra) =>`. */
	server.registerTool(
		"list_apps",
		{
			description:
				"List the authenticated user's Nova apps. Returns id, name, status, and updated_at per app.",
		},
		async (extra): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			/* Resolve run id even though no `app_id` grounds this call —
			 * MCP clients bundle multi-call runs under one id, and an
			 * earlier `list_apps` followed by a `get_app` should share
			 * the same grouping key on admin surfaces. */
			const runId = resolveRunId(extra);
			try {
				const apps = await listApps(ctx.userId);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ apps: apps.map(toEntry) }),
						},
					],
					_meta: { run_id: runId },
				};
			} catch (err) {
				return toMcpErrorResult(err, { runId, userId: ctx.userId });
			}
		},
	);
}
