/**
 * `nova.list_apps` — enumerate the authenticated user's Nova apps.
 *
 * Scope: `nova.read` (enforced by the route handler's
 * `verifyAccessToken` declaration — the tool itself trusts the JWT by
 * the time it runs).
 *
 * Strictly enumeration. This tool has no `query` argument by design —
 * search is a separate concern served by `nova.search_apps`. Callers
 * that want a fuzzy name lookup use that tool; callers that want to
 * browse / paginate / filter-by-status / sort use this one.
 *
 * Returns id + name + status + updated_at per app plus an opaque
 * `next_cursor` when more pages exist. The user id from the verified
 * JWT is the owner filter — no ownership check and no `app_id` input,
 * both of which would be cross-tenant escape hatches.
 *
 * Read-only; no event log or progress emitter needed. Soft-deleted
 * rows (`status: "deleted"`) are dropped by `listApps` at the
 * persistence boundary.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type AppSummary, listApps } from "@/lib/db/apps";
import {
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import type { ToolContext } from "../types";

/**
 * Wire shape returned to the MCP client — one entry per visible app.
 *
 * Kept deliberately narrow: the caller's natural first question is
 * "which app is this and when was it last touched?" Module/form
 * counts, connect type, and error_type are available via `get_app`
 * for callers that need them.
 */
interface ListAppsEntry {
	app_id: string;
	name: string;
	status: AppSummary["status"];
	updated_at: string;
}

/**
 * Project a persistence-layer `AppSummary` into the narrow MCP response
 * row. Extracted so the list's mapping stays a single expression and
 * the wire shape has one canonical construction site — `search_apps`
 * uses the same projection so both surfaces emit identical entries.
 */
export function toEntry(summary: AppSummary): ListAppsEntry {
	return {
		app_id: summary.id,
		name: summary.app_name,
		status: summary.status,
		updated_at: summary.updated_at,
	};
}

/**
 * Zod schema for `list_apps` input. Every parameter is optional with an
 * explicit default applied at the schema layer, so downstream code
 * always receives a fully-populated options object. The rich
 * `.describe()` strings are the source of truth for what each param
 * does — agents read these via the MCP schema; skills and client code
 * do not duplicate them.
 */
export const listAppsInputSchema = {
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.default(10)
		.describe(
			"Maximum apps to return on this page. Defaults to 10; cap 100. Follow `next_cursor` to fetch additional pages.",
		),
	cursor: z
		.string()
		.optional()
		.describe(
			"Opaque pagination cursor. Pass the `next_cursor` from a prior `list_apps` response to fetch the next page. Must be used with the same `sort` as the prior call — mixing sort orders across pagination is rejected.",
		),
	status: z
		.enum(["generating", "complete", "error"])
		.optional()
		.describe(
			"Filter to apps with a specific lifecycle status. Omit to return apps regardless of status. `generating` is an in-flight build; `complete` is ready to use; `error` is a failed build.",
		),
	sort: z
		.enum(["updated_desc", "updated_asc", "name_asc", "name_desc"])
		.optional()
		.default("updated_desc")
		.describe(
			"Sort order. `updated_desc` (default) surfaces the most recently updated apps first; `updated_asc` is oldest-first. `name_asc` sorts alphabetically by app name A→Z (case-insensitive); `name_desc` is Z→A.",
		),
} as const;

/**
 * Register the `list_apps` tool on an `McpServer`.
 *
 * The handler is a thin adapter: it trusts the JWT for ownership,
 * delegates the Firestore query to `listApps`, projects each row via
 * `toEntry`, and passes `nextCursor` through unchanged. Any error is
 * classified through the shared `toMcpErrorResult` surface so callers
 * see a uniform error envelope across every Nova tool.
 */
export function registerListApps(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"list_apps",
		{
			description:
				"Enumerate your Nova apps with pagination, optional status filter, and a choice of sort order. Does NOT search by name — use `search_apps` for that. Returns id, name, status, and updated_at per app, plus an opaque `next_cursor` when more pages exist.",
			inputSchema: listAppsInputSchema,
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			try {
				const { apps, nextCursor } = await listApps(ctx.userId, {
					limit: args.limit,
					sort: args.sort,
					status: args.status,
					cursor: args.cursor,
				});

				/* The wire object only carries `next_cursor` when present so
				 * callers can branch on its existence without a separate
				 * "is this the last page" flag. Omitting the field when null
				 * keeps the payload minimal and the semantics obvious. */
				const body: { apps: ListAppsEntry[]; next_cursor?: string } = {
					apps: apps.map(toEntry),
				};
				if (nextCursor) body.next_cursor = nextCursor;

				return {
					content: [{ type: "text", text: JSON.stringify(body) }],
				};
			} catch (err) {
				return toMcpErrorResult(err, { userId: ctx.userId });
			}
		},
	);
}
