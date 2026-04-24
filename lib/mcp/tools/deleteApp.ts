/**
 * `nova.delete_app` — soft-delete an owned Nova app.
 *
 * Scope: `nova.write`.
 *
 * Marks the app `status: "deleted"` and returns the recovery-window
 * deadline. The blueprint, event log, and HQ credentials survive the
 * soft-delete — a retention job hard-deletes rows past the window, and
 * support can recover within the window by flipping the status back to
 * `"complete"`. The dual layer (soft-delete + retention sweep) mirrors
 * the behavior of every other surface in Nova that wraps a destructive
 * action (`listApps` already filters `"deleted"` rows at the query
 * boundary).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { softDeleteApp } from "@/lib/db/apps";
import {
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { requireOwnedApp } from "../ownership";
import type { ToolContext } from "../types";

/**
 * Register the single-argument `delete_app` tool on an `McpServer`.
 *
 * The ownership gate runs first so a cross-tenant delete probe can
 * never reach the write. The `stage: "app_deleted"` marker inside the
 * content JSON lets the model latch on to the life-cycle event without
 * having to infer it from the tool name alone — same pattern
 * `create_app` uses for `app_created`.
 */
export function registerDeleteApp(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"delete_app",
		{
			description:
				"Soft-delete one of your apps. Filters from list surfaces; recoverable within the returned window.",
			inputSchema: {
				app_id: z
					.string()
					.describe(
						"Firestore app id to delete. Must be an app the authenticated user owns.",
					),
			},
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			const appId = args.app_id;
			try {
				await requireOwnedApp(ctx.userId, appId);
				const recoverableUntil = await softDeleteApp(appId);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								stage: "app_deleted",
								app_id: appId,
								deleted: true,
								recoverable_until: recoverableUntil,
							}),
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
