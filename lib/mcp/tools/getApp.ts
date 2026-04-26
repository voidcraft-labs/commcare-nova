/**
 * `nova.get_app` — render a blueprint summary for one owned app.
 *
 * Scope: `nova.read`.
 *
 * Uses the same `summarizeBlueprint` renderer the SA edit-mode prompt
 * consumes. Any drift between the two would create divergent mental
 * models of an app across surfaces (SA reads one summary, MCP clients
 * get another); co-using the renderer makes that impossible by
 * construction and keeps a single canonical domain-vocabulary view.
 *
 * Returns the summary as text content. Pure read — no persistence, no
 * event-log write, no progress emission — scoped to the ownership
 * gate.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { summarizeBlueprint } from "@/lib/agent/summarizeBlueprint";
import {
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { loadAppBlueprint } from "../loadApp";
import type { ToolContext } from "../types";

/**
 * Register the single-argument `get_app` tool on an `McpServer`.
 *
 * `loadAppBlueprint` ownership-gates and loads the doc in one
 * Firestore read, throwing `McpAccessError` on a cross-tenant probe
 * or a vanished row. Only `.doc` is consumed here — the full `AppDoc`
 * envelope is available for callers that need denormalized columns
 * (see `compile_app`).
 */
export function registerGetApp(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"get_app",
		{
			description:
				"Get a blueprint summary (human-readable markdown) for one of your apps.",
			inputSchema: {
				app_id: z
					.string()
					.describe(
						"Firestore app id to summarize. Must be an app the authenticated user owns.",
					),
			},
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			const appId = args.app_id;
			try {
				const loaded = await loadAppBlueprint(appId, ctx.userId);
				return {
					content: [{ type: "text", text: summarizeBlueprint(loaded.doc) }],
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
