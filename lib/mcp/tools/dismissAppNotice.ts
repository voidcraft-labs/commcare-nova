/**
 * `nova.dismiss_app_notice`: dismiss one migration notice of an app for the caller alone.
 *
 * Scope: `nova.write`.
 *
 * Resolves `view` on the app, so a viewer can dismiss. Other members keep seeing the notice until they dismiss it themselves.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveAppScope } from "@/lib/db/appAccess";
import { MCP_NOTICE_DISMISSED } from "@/lib/notices/migrationNoticeCopy";
import { dismissAppNotice } from "@/lib/notices/store";
import {
	McpInvalidInputError,
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { rethrowAsMcpAccess } from "../ownership";
import type { ToolContext } from "../types";

const NO_SUCH_NOTICE =
	"This app has no notice with that ID. get_app lists the notices you can dismiss.";

/**
 * Register `dismiss_app_notice`. It writes Nova state and reads or writes
 * nothing in CommCare HQ, so the route-wide `nova.write` floor is its only
 * scope. An app the caller cannot view answers as every app tool does, so a
 * notice id never shows whether an app exists.
 */
export function registerDismissAppNotice(
	server: McpServer,
	ctx: ToolContext,
): void {
	server.registerTool(
		"dismiss_app_notice",
		{
			description:
				"Dismiss one of an app's notices for you alone, once the user has read it. Other members still see it until they dismiss it.",
			inputSchema: z.object({
				app_id: z.string().describe("App ID. Requires access to its Project."),
				notice_id: z
					.string()
					.describe("The notice's `id`, as get_app lists it under `notices`."),
			}),
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			const appId = args.app_id;
			try {
				try {
					await resolveAppScope(appId, ctx.userId, "view");
				} catch (err) {
					rethrowAsMcpAccess(err);
				}
				const found = await dismissAppNotice({
					appId,
					noticeId: args.notice_id,
					userId: ctx.userId,
				});
				if (!found) throw new McpInvalidInputError(NO_SUCH_NOTICE);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								dismissed: true,
								message: MCP_NOTICE_DISMISSED,
							}),
						},
					],
				};
			} catch (err) {
				return toMcpErrorResult(err, { appId, userId: ctx.userId });
			}
		},
	);
}
