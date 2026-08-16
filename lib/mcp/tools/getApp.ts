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
 * The `Project:` line is prepended HERE, not in the renderer — tenancy
 * is an MCP concern (the chat SA always works inside one app), and the
 * shared renderer stays blueprint-only.
 *
 * Returns the summary as text content. Pure read — no persistence, no
 * event-log write, no progress emission — scoped to the ownership
 * gate.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { summarizeBlueprint } from "@/lib/agent/summarizeBlueprint";
import { listUserProjects } from "@/lib/projects/membership";
import {
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { loadAppBlueprint } from "../loadApp";
import { LARGE_RESULT_META } from "../resultSize";
import type { ToolContext } from "../types";

/**
 * Register the single-argument `get_app` tool on an `McpServer`.
 *
 * `loadAppBlueprint` ownership-gates and loads the doc in one
 * read, throwing `McpAccessError` on a cross-tenant probe
 * or a vanished row. Only `.doc` is consumed here — the full `AppDoc`
 * envelope is available for callers that need denormalized columns
 * (see `compile_app`).
 */
export function registerGetApp(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"get_app",
		{
			description:
				"Get a blueprint summary (human-readable markdown) for one of your apps, headed by the Nova Project the app belongs to.",
			/* The summary scales with the app and is the largest thing
			 * this surface returns — the biggest app in production renders
			 * 73,534 chars, past what a host delivers by default. See
			 * `../resultSize`. */
			_meta: LARGE_RESULT_META,
			inputSchema: z.object({
				app_id: z
					.string()
					.describe(
						"App id to summarize. Must be an app the authenticated user owns.",
					),
			}),
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			const appId = args.app_id;
			try {
				const loaded = await loadAppBlueprint(appId, ctx.userId);
				/* Name the app's Project from the caller's own memberships —
				 * the access gate just proved they belong to it, so the
				 * lookup can only miss on a mid-request membership change. */
				const projects = await listUserProjects(ctx.userId);
				const projectName = projects.find(
					(p) => p.id === loaded.access.projectId,
				)?.name;
				const projectLine = `Project: ${
					projectName ?? "(name unavailable)"
				} (${loaded.access.projectId})`;
				return {
					content: [
						{
							type: "text",
							text: `${projectLine}\n\n${summarizeBlueprint(loaded.doc)}`,
						},
					],
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
