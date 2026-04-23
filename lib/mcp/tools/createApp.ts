/**
 * `nova.create_app` — mint an empty Nova app owned by the authenticated
 * user.
 *
 * Scope: `nova.write`.
 *
 * Returns the new `app_id` so the caller can thread it into subsequent
 * tool calls (`generate_schema`, `add_module`, etc.).
 *
 * No ownership check: there's nothing to own yet — the app is being
 * created in this call. Scope gating happens at the route layer via
 * `verifyAccessToken`, so by the time this handler runs the JWT
 * already proved `nova.write`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createApp } from "@/lib/db/apps";
import { toMcpErrorResult } from "../errors";
import type { ToolContext } from "../types";

/**
 * Register the `create_app` tool on an `McpServer`.
 *
 * The only input is an optional name; the underlying `createApp`
 * helper mints the Firestore document id.
 */
export function registerCreateApp(server: McpServer, ctx: ToolContext): void {
	server.tool(
		"create_app",
		"Create an empty Nova app owned by you. Returns the new app_id for use in subsequent tool calls.",
		{
			app_name: z
				.string()
				.optional()
				.describe(
					"Optional initial name. If omitted, the app name starts blank and can be set later.",
				),
		},
		async (args) => {
			try {
				// Run id is minted per call; every created doc carries one so admin surfaces can group events.
				const runId = crypto.randomUUID();

				/* Normalize the optional name: `trim()` collapses surrounding
				 * whitespace, `|| undefined` maps the empty string (and the
				 * original omitted case) to undefined so the DB helper's
				 * `""` default kicks in. Whitespace-only names are treated
				 * as empty — otherwise the list row would show a blank with
				 * no visible way to rename. */
				const appName = args.app_name?.trim() || undefined;

				// Atomic creation — status "complete" keeps the staleness timer quiet.
				const appId = await createApp(ctx.userId, runId, {
					appName,
					status: "complete",
				});
				return {
					content: [{ type: "text", text: JSON.stringify({ app_id: appId }) }],
					_meta: { stage: "app_created", app_id: appId, run_id: runId },
				};
			} catch (err) {
				return toMcpErrorResult(err);
			}
		},
	);
}
