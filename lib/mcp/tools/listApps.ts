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
 * Returns id + name + status + updated_at + Project per app plus an
 * opaque `next_cursor` when more pages exist. The verified-JWT user id resolves
 * to the caller's enumeration scope — EVERY Project they're a member of
 * (`callerProjectScope`), the same reachability the ownership gate
 * grants `get_app` / the editing tools / `delete_app` — so an app the
 * caller can open by id is never invisible here. There is no `app_id`
 * input, which would be a cross-tenant escape hatch.
 *
 * Read-only; no event log or progress emitter needed. Soft-deleted
 * rows (`deleted_at != null`) are dropped by the persistence boundary.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type AppSummary, listAppsAcrossProjects } from "@/lib/db/apps";
import { listUserProjects } from "@/lib/projects/membership";
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
 * "which app is this, where does it live, and when was it last
 * touched?" Module/form counts, connect type, and error_type are
 * available via `get_app` for callers that need them.
 */
interface ListAppsEntry {
	app_id: string;
	name: string;
	status: AppSummary["status"];
	updated_at: string;
	/** The Project the app belongs to — its tenancy + sharing boundary. */
	project_id: string;
	/** The Project's display name. The ids and names come from ONE
	 *  membership read, so every enumerated app's Project has a name; the
	 *  wire keeps the nullable shape so a missing name would degrade to
	 *  `null` rather than a crash. */
	project_name: string | null;
}

/**
 * The caller's enumeration scope, resolved from ONE membership read: the
 * Project ids feed the cross-Project query and the names feed entry
 * projection, so the two can't straddle a concurrent membership change.
 * Every Project the caller is a member of is in scope — an MCP key is
 * headless (no "active Project" UI context), so "everything you can
 * access" is the correct scope, exactly the reachability the ownership
 * gate grants the by-id tools. Shared by `list_apps` and `search_apps`.
 */
export interface CallerProjectScope {
	readonly projectIds: string[];
	readonly projectNames: ReadonlyMap<string, string>;
}

export async function callerProjectScope(
	userId: string,
): Promise<CallerProjectScope> {
	const projects = await listUserProjects(userId);
	return {
		projectIds: projects.map((p) => p.id),
		projectNames: new Map(projects.map((p) => [p.id, p.name])),
	};
}

/**
 * Project a persistence-layer `AppSummary` into the narrow MCP response
 * row. Extracted so the list's mapping stays a single expression and
 * the wire shape has one canonical construction site — `search_apps`
 * uses the same projection so both surfaces emit identical entries.
 */
export function toEntry(
	summary: AppSummary,
	projectNames: ReadonlyMap<string, string>,
): ListAppsEntry {
	return {
		app_id: summary.id,
		name: summary.app_name,
		status: summary.status,
		updated_at: summary.updated_at,
		project_id: summary.project_id,
		project_name: projectNames.get(summary.project_id) ?? null,
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
export const listAppsInputSchema = z.object({
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
			"Opaque pagination cursor. Pass the `next_cursor` from a prior `list_apps` response to fetch the next page. Must be used with the same `sort` as the prior call. Mixing sort orders across pagination is rejected.",
		),
	status: z
		.enum(["generating", "complete", "error"])
		.optional()
		.describe(
			"Filter to apps with a specific status. Omit to return apps regardless of status. `generating` is an in-flight chat build run; `complete` is an app at rest; `error` is a failed build.",
		),
	sort: z
		.enum(["updated_desc", "updated_asc", "name_asc", "name_desc"])
		.optional()
		.default("updated_desc")
		.describe(
			"Sort order. `updated_desc` (default) surfaces the most recently updated apps first; `updated_asc` is oldest-first. `name_asc` sorts alphabetically by app name A→Z (case-insensitive); `name_desc` is Z→A.",
		),
});

/**
 * Register the `list_apps` tool on an `McpServer`.
 *
 * The handler is a thin adapter: it resolves the caller's enumeration
 * scope (every Project they're a member of), delegates the
 * query to `listAppsAcrossProjects`, projects each row via `toEntry`,
 * and passes `nextCursor` through unchanged. Any error is classified
 * through the shared `toMcpErrorResult` surface so callers see a uniform
 * error envelope across every Nova tool.
 */
export function registerListApps(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"list_apps",
		{
			description:
				"Enumerate your Nova apps with pagination, optional status filter, and a choice of sort order. Does NOT search by name. Use `search_apps` for that. Returns id, name, status, updated_at, and the app's Project (project_id + project_name) per app, plus an opaque `next_cursor` when more pages exist. Covers every Project you're a member of, shared ones included.",
			inputSchema: listAppsInputSchema,
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			try {
				/* Enumerate across every Project the caller is a member of — the
				 * same reachability the ownership gate grants the by-id tools, so
				 * a shared-Project app is never invisible to enumeration. Ids and
				 * names ride one membership read. */
				const { projectIds, projectNames } = await callerProjectScope(
					ctx.userId,
				);
				const { apps, nextCursor } = await listAppsAcrossProjects(projectIds, {
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
					apps: apps.map((summary) => toEntry(summary, projectNames)),
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
