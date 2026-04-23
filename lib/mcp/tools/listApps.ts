/**
 * `nova.list_apps` — enumerate the authenticated user's Nova apps.
 *
 * Scope: `nova.read` (enforced by the route handler's
 * `verifyAccessToken` declaration — the tool itself trusts the JWT by
 * the time it runs).
 *
 * Returns id + name + status + updated_at per app. Soft-deleted apps
 * (`status: "deleted"`) are filtered out so callers only see live apps;
 * when the persistence layer adds its own filter on read, the double
 * filter becomes redundant but harmless and keeps this tool's contract
 * self-sufficient regardless of layer ordering.
 *
 * No ownership check, no `app_id` input — the user id from the verified
 * JWT is the filter. No `ctx`-per-call plumbing (`LogWriter`,
 * `McpContext`) because no blueprint mutations happen: the list is a
 * pure Firestore read and needs no event log or progress emitter.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type AppSummary, listApps } from "@/lib/db/apps";
import { toMcpErrorResult } from "../errors";
import type { ToolContext } from "../types";

/**
 * Summary status value the filter guards against. Declared as a separate
 * constant because the on-disk `AppSummary.status` enum does not include
 * `"deleted"` yet — soft delete adds it later. Keeping the sentinel as a
 * named string makes the forward-looking intent obvious and avoids
 * scattering widened comparisons through the filter expression.
 */
const DELETED_STATUS = "deleted";

/** Wire shape returned to the MCP client — one entry per visible app. */
interface ListAppsEntry {
	app_id: string;
	name: string;
	status: AppSummary["status"];
	updated_at: string;
}

/**
 * Project a persistence-layer `AppSummary` into the narrow MCP response
 * row. Extracted so the list's mapping stays a single expression and the
 * wire shape has one canonical construction site.
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
 *
 * `ctx.userId` comes from the verified JWT `sub` claim. The tool itself
 * never accepts a user id as input — that would be a cross-tenant
 * escape hatch.
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
				/* Defensive filter — the persistence layer gains its own
				 * filter for `"deleted"` status when soft-delete lands.
				 * Comparing through `string` widens the type beyond the
				 * current `AppSummary["status"]` enum (`"generating" |
				 * "complete" | "error"`), so the comparison is valid
				 * today AND continues to match once `"deleted"` joins
				 * the enum. */
				const visible = apps.filter(
					(a) => (a.status as string) !== DELETED_STATUS,
				);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ apps: visible.map(toEntry) }),
						},
					],
				};
			} catch (err) {
				return toMcpErrorResult(err);
			}
		},
	);
}
