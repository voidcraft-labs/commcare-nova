/**
 * Temporary MCP registration for the released nova-plugin.
 *
 * The public tool name and envelope are retained only as a transport bridge.
 * Its contents are projected from Nova's semantic compatibility report and
 * never contain the private CommCare HQ settings, slugs, or namespaces used by
 * the emission boundary. New clients use `check_project_space_compatibility`.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { projectSpaceCompatibilityForPrepublish } from "@/lib/commcare/projectSpaceCompatibility";
import type { ProjectSpaceCompatibilityReport } from "@/lib/publish/projectSpaceCompatibility";
import { legacyFeatureFlagCompatibilityReport } from "@/lib/publish/projectSpaceCompatibilityLegacy";
import {
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { loadAppBlueprint } from "../loadApp";
import type { ToolContext } from "../types";
import { checkProjectSpaceCompatibility } from "./checkProjectSpaceCompatibility";

function successPayload(
	appId: string,
	appName: string,
	domainChecked: boolean,
	report: ProjectSpaceCompatibilityReport,
): McpToolSuccessResult {
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify({
					app_id: appId,
					app_name: appName,
					domain_checked: domainChecked,
					project_space_compatibility: report,
					feature_flag_requirements:
						legacyFeatureFlagCompatibilityReport(report),
				}),
			},
		],
	};
}

export function registerGetAppHqFeatureFlagsCompatibility(
	server: McpServer,
	ctx: ToolContext,
): void {
	server.registerTool(
		"get_app_hq_feature_flags",
		{
			description:
				"Compatibility bridge for released Nova clients. Read-only and deprecated: new clients must call `check_project_space_compatibility` with an explicit user-selected project space. This response includes the semantic `project_space_compatibility` report plus a legacy-shaped projection whose entries are app capabilities, never private CommCare HQ settings or slugs. Omitting `domain` describes what the app needs without checking a destination; supplying it performs the same live, blocking-readiness check as the current tool.",
			inputSchema: z.object({
				app_id: z.string(),
				domain: z.string().trim().min(1).optional(),
			}),
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			const appId = args.app_id;
			try {
				if (args.domain) {
					const result = await checkProjectSpaceCompatibility(
						{ app_id: appId, domain: args.domain },
						ctx,
					);
					if ("isError" in result && result.isError) return result;
					const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
						app_name: string;
						project_space_compatibility: ProjectSpaceCompatibilityReport;
					};
					return successPayload(
						appId,
						payload.app_name,
						true,
						payload.project_space_compatibility,
					);
				}

				const loaded = await loadAppBlueprint(appId, ctx.userId);
				return successPayload(
					appId,
					loaded.app.app_name,
					false,
					projectSpaceCompatibilityForPrepublish(loaded.doc),
				);
			} catch (err) {
				return toMcpErrorResult(err, {
					appId,
					userId: ctx.userId,
				});
			}
		},
	);
}
