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
 *
 * Run-id sourcing: honors `extra._meta.run_id` when the MCP client
 * threads one so the `runs/{runId}` summary doc groups this creation
 * with whatever subagent follow-up calls share the id. Absent a
 * client-threaded value, a fresh uuid is minted per call.
 *
 * **No event-log write on success.** `create_app` is atomic and the
 * `run_id` stored on the app doc has no corresponding stream of
 * `MutationEvent` / `ConversationEvent` entries. Admin surfaces that
 * group event-log rows by `run_id` will show an empty group for
 * MCP-created apps until a subsequent tool call (`generate_schema`,
 * `add_module`, etc.) writes events under the same id. This is by
 * design — the creation itself is a single Firestore write the app
 * row records directly via its `created_at` + `owner` fields.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createApp } from "@/lib/db/apps";
import {
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { resolveRunId } from "../runId";
import type { ToolContext } from "../types";

/**
 * Register the `create_app` tool on an `McpServer`.
 *
 * The only input is an optional name; the underlying `createApp`
 * helper mints the Firestore document id.
 */
export function registerCreateApp(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"create_app",
		{
			description:
				"Create an empty Nova app owned by you. Returns the new app_id for use in subsequent tool calls.",
			inputSchema: {
				app_name: z
					.string()
					.optional()
					.describe(
						"Optional initial name. If omitted, the app name starts blank and can be set later.",
					),
			},
		},
		async (args, extra): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			/* Thread the client-supplied run id when present, mint a fresh
			 * one otherwise. Every created doc persists this id so admin
			 * surfaces can group any follow-up tool calls (`generate_schema`,
			 * `add_module`) that ride on the same run id. */
			const runId = resolveRunId(extra);
			try {
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
				return toMcpErrorResult(err, { runId, userId: ctx.userId });
			}
		},
	);
}
