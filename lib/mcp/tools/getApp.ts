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
 * Returns the summary as text content. No persistence, no run id
 * plumbing, no progress emission — a pure read with deterministic
 * per-call side effects scoped to the ownership gate.
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
import { McpAccessError, requireOwnedApp } from "../ownership";
import { resolveRunId } from "../runId";
import type { ToolContext } from "../types";

/**
 * Register the single-argument `get_app` tool on an `McpServer`.
 *
 * Ownership is verified before the app load and, because the two reads
 * aren't atomic, the load path independently surfaces a concurrent
 * hard-delete as `not_found`. A pre-load ownership pass still pays for
 * itself here: cross-tenant probes short-circuit before Firestore has
 * to return anything more than an owner field.
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
		async (args, extra): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			const appId = args.app_id;
			/* Resolve `run_id` at the top so both success and error envelopes
			 * thread the same id onto `_meta` — admin surfaces grouping by
			 * run id rely on every exit path stamping it consistently. */
			const runId = resolveRunId(extra);
			try {
				await requireOwnedApp(ctx.userId, appId);

				/* `loadAppBlueprint` both fetches the row and rebuilds the
				 * derived `fieldParent` index. Null means the row vanished
				 * between the ownership check and this read (concurrent
				 * hard-delete); collapse that race to the same `not_found`
				 * a missing-app probe gets. Only `.doc` is needed here —
				 * the full `AppDoc` is returned for callers that consume
				 * denormalized columns (see `compile_app`). */
				const loaded = await loadAppBlueprint(appId);
				if (!loaded) throw new McpAccessError("not_found");

				return {
					content: [{ type: "text", text: summarizeBlueprint(loaded.doc) }],
					_meta: { app_id: appId, run_id: runId },
				};
			} catch (err) {
				return toMcpErrorResult(err, {
					appId,
					runId,
					userId: ctx.userId,
				});
			}
		},
	);
}
