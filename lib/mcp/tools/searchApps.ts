/**
 * `nova.search_apps` — fuzzy search across the authenticated user's
 * Nova apps by name.
 *
 * Scope: `nova.read` (enforced by the route handler's
 * `verifyAccessToken` declaration — the tool itself trusts the JWT by
 * the time it runs).
 *
 * This is the search counterpart to `nova.list_apps`. Where `list_apps`
 * enumerates, `search_apps` hunts for a specific app by name with
 * typo-tolerant substring matching (Fuse.js + Bitap under the hood).
 * Relevance scoring is the ordering — there is no `sort` parameter, by
 * design. A caller who wants "most-recent first without search" should
 * use `list_apps` instead.
 *
 * Returns the same entry shape as `list_apps` so downstream renderers
 * (markdown tables, card grids, etc.) work identically across the two
 * surfaces; only the ordering contract differs.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchApps } from "@/lib/db/apps";
import {
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import type { ToolContext } from "../types";
import { toEntry } from "./listApps";

/**
 * Zod schema for `search_apps` input. `query` is required — a search
 * tool without a search phrase has no work to do; the schema enforces
 * that rather than producing a confusing "passed empty query" edge
 * case at the runtime boundary. `sort` is intentionally absent:
 * relevance is the only sensible ordering for a fuzzy search.
 */
export const searchAppsInputSchema = {
	query: z
		.string()
		.min(1)
		.max(100)
		.describe(
			"The phrase to search for in app names. Case-insensitive, fuzzy (tolerates typos and partial matches), and matches anywhere in the name — not just the start. Ordering of the response is by relevance, not recency.",
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.default(10)
		.describe(
			"Maximum matches to return on this page. Defaults to 10; cap 100. Follow `next_cursor` to continue searching more of the user's apps.",
		),
	cursor: z
		.string()
		.optional()
		.describe(
			"Opaque pagination cursor. Pass the `next_cursor` from a prior `search_apps` response to continue searching the next batch of the user's apps. A single `search_apps` call scans a bounded slice of the user's apps; calling repeatedly with the cursor exhausts the full dataset.",
		),
	status: z
		.enum(["generating", "complete", "error"])
		.optional()
		.describe(
			"Restrict the search to apps with a specific lifecycle status. Omit to search across all statuses.",
		),
} as const;

/**
 * Register the `search_apps` tool on an `McpServer`.
 *
 * Thin adapter: delegates to the DB-layer `searchApps` which composes
 * on top of `listApps` internally and runs Fuse.js over each in-memory
 * page. The MCP tool's responsibility is shaping the wire response —
 * same `{apps, next_cursor?}` envelope as `list_apps` so clients don't
 * branch on which tool they invoked.
 */
export function registerSearchApps(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"search_apps",
		{
			description:
				"Search your Nova apps by name (fuzzy, case-insensitive substring match, typo-tolerant). Use when looking for a specific app you remember by name. Returns id, name, status, and updated_at per match, ordered by relevance, plus an opaque `next_cursor` when more pages of the user's apps remain to be scanned.",
			inputSchema: searchAppsInputSchema,
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			try {
				const { apps, nextCursor } = await searchApps(ctx.userId, {
					query: args.query,
					limit: args.limit,
					status: args.status,
					cursor: args.cursor,
				});

				/* Mirror `list_apps`'s wire shape exactly so downstream
				 * renderers branch only on `apps.length` / `next_cursor`,
				 * not on which of the two tools was called. */
				const body: {
					apps: ReturnType<typeof toEntry>[];
					next_cursor?: string;
				} = {
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
