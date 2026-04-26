/**
 * `nova.delete_app` — soft-delete an owned Nova app.
 *
 * Scope: `nova.write`.
 *
 * Records `deleted_at` + `recoverable_until` on the app row and
 * returns the recovery-window deadline. Lifecycle status is untouched
 * — `deleted_at != null` is the sole soft-delete marker; soft-delete
 * and lifecycle status are orthogonal axes, so the row's real status
 * roundtrips through any subsequent restore. The blueprint, event
 * log, and HQ credentials all survive intact. `listApps` filters
 * `deleted_at != null` rows at the query boundary, so a deleted app
 * vanishes from every active surface immediately.
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
