/**
 * `nova.get_app_feature_flags` — explain the CommCare HQ feature flags an
 * owned app requires without compiling, publishing, or probing an HQ domain.
 *
 * Scope: the route-level `nova.read` floor only. This inspects Nova's current
 * blueprint and does not touch stored HQ credentials, so requiring an
 * orthogonal `nova.hq.*` scope would prevent exactly the pre-publish check the
 * tool exists to support.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requiredHqFeatureFlagUses } from "@/lib/commcare/featureFlags";
import {
	HQ_FEATURE_FLAG_SUPPORT_EMAIL,
	HQ_FEATURE_FLAGS_DOCS_URL,
} from "@/lib/publish/hqFeatureFlags";
import {
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { loadAppBlueprint } from "../loadApp";
import type { ToolContext } from "../types";

export function registerGetAppFeatureFlags(
	server: McpServer,
	ctx: ToolContext,
): void {
	server.registerTool(
		"get_app_feature_flags",
		{
			description:
				"Inspect one of the user's Nova apps and return only the CommCare HQ feature flags that app currently requires, why each applies, a short description, and public documentation links. This is a read-only pre-publish check: it does not compile or upload the app, does not need an HQ connection, and does not claim any flag is enabled or missing on a project space.",
			inputSchema: {
				app_id: z
					.string()
					.describe(
						"App id to inspect. Must be an app the authenticated user can view.",
					),
			},
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			const appId = args.app_id;
			try {
				const loaded = await loadAppBlueprint(appId, ctx.userId);
				const uses = requiredHqFeatureFlagUses(loaded.doc);
				const requiredFlags = uses.map(({ requirement, reasons }) => ({
					...requirement,
					reasons,
				}));
				const message =
					requiredFlags.length === 0
						? "This app does not currently use a Nova feature that needs a CommCare HQ feature flag."
						: `This app requires ${requiredFlags.map((flag) => `${flag.label} (${flag.slug})`).join(", ")} in the CommCare HQ project space where it will be used. No project space was checked, so these are requirements, not flags known to be off. If a required flag is not enabled, contact ${HQ_FEATURE_FLAG_SUPPORT_EMAIL} and name the project space.`;

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								app_id: appId,
								app_name: loaded.app.app_name,
								required_flags: requiredFlags,
								domain_checked: false,
								support_email: HQ_FEATURE_FLAG_SUPPORT_EMAIL,
								docs_url: HQ_FEATURE_FLAGS_DOCS_URL,
								message,
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
