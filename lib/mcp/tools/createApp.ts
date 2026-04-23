/**
 * `nova.create_app` — mint an empty Nova app owned by the authenticated
 * user.
 *
 * Scope: `nova.write`.
 *
 * Returns the new `app_id` so the caller can thread it into subsequent
 * tool calls (`generate_schema`, `add_module`, etc.). The app is
 * created with `status: "complete"` — MCP has no long-running
 * generation loop, so starting in `"generating"` would trip the
 * chat-path timeout inference in `listApps` and self-mark the app as
 * failed after 10 minutes of MCP inactivity.
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
 * helper mints the Firestore document id. A run id is minted per call
 * via `crypto.randomUUID()` so admin surfaces can group the creation
 * event under a distinct id (and so the created doc has the same
 * `run_id` shape a chat-path creation would).
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
				/* Mint a run id per call. The chat path inherits a run id
				 * from the client; MCP has no equivalent handshake, so the
				 * per-call uuid keeps the `run_id` field shape consistent
				 * with chat-created apps without coupling either path to
				 * the other. */
				const runId = crypto.randomUUID();

				/* Normalize the optional name: blanks collapse to
				 * `undefined` so the DB helper can fall back to its `""`
				 * default. A whitespace-only name is treated as empty —
				 * the alternative ("    ") would produce a confusing list
				 * row and no way to rename visibly until someone types
				 * real characters. */
				const trimmed = args.app_name?.trim();
				const appName =
					trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;

				const appId = await createApp(ctx.userId, runId, {
					appName,
					/* `"complete"` is the right lifecycle for an atomic MCP
					 * creation. See `CreateAppOptions` in `lib/db/apps.ts`
					 * for the chat-vs-MCP rationale. */
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
