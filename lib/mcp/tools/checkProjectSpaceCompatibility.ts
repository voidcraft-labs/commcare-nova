/**
 * `nova.check_project_space_compatibility`: check whether one explicitly
 * selected CommCare HQ project space can run an owned app.
 *
 * This is deliberately MCP-only. Compatibility describes a deployment target,
 * not authored app state, so the Solutions Architect never receives this tool
 * or carries target constraints while designing an app.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { probeHqProjectSpaceCompatibility } from "@/lib/commcare/client";
import { projectSpaceCompatibilityProbePlan } from "@/lib/commcare/projectSpaceCompatibility";
import { getCredentialsForUpload } from "@/lib/db/settings";
import {
	type HqToolErrorType,
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { loadAppBlueprint } from "../loadApp";
import { assertScope, SCOPES } from "../scopes";
import type { ToolContext } from "../types";

function makeHqGateError(
	errorType: Extract<
		HqToolErrorType,
		"hq_not_configured" | "domain_not_authorized"
	>,
	message: string,
	appId: string,
): McpToolErrorResult {
	return {
		isError: true,
		content: [
			{
				type: "text",
				text: JSON.stringify({ error_type: errorType, message, app_id: appId }),
			},
		],
	};
}

export function registerCheckProjectSpaceCompatibility(
	server: McpServer,
	ctx: ToolContext,
): void {
	server.registerTool(
		"check_project_space_compatibility",
		{
			description:
				"Read-only check of whether one explicitly selected CommCare HQ project space can run an owned app. Returns friendly required capabilities, their verification state, any blockers, non-blocking performance advisories, and next steps. It does not compile, upload, or change the app or project space. Call `get_hq_connection` first to list reachable project spaces, then pass the exact `domain` the user selected; never choose among several spaces for them. Required support that is missing or could not be verified blocks a later upload, while an advisory never does. This tool reports only what the app needs and whether the selected project space supports it.",
			inputSchema: z.object({
				app_id: z
					.string()
					.describe(
						"App id to inspect. Must be an app the authenticated user can view.",
					),
				domain: z
					.string()
					.trim()
					.min(1)
					.describe(
						"Exact CommCare HQ project-space identifier selected by the user. It must be one of `get_hq_connection`'s `available_domains`.",
					),
			}),
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			const appId = args.app_id;
			try {
				// This read reaches a third-party system. Gate it before ownership so
				// a credential without HQ access learns nothing about the app id.
				assertScope(ctx, SCOPES.hqRead, "check_project_space_compatibility");
				const loaded = await loadAppBlueprint(appId, ctx.userId);
				const credentials = await getCredentialsForUpload(
					ctx.userId,
					args.domain,
				);
				if (!credentials.ok) {
					if (credentials.error === "not_configured") {
						return makeHqGateError(
							"hq_not_configured",
							"CommCare HQ is not configured. Add your HQ credentials in Settings before checking a project space.",
							appId,
						);
					}
					const reachable = credentials.available
						.map((domain) => domain.name)
						.join(", ");
					return makeHqGateError(
						"domain_not_authorized",
						`Your stored CommCare HQ API key can't reach the “${args.domain}” project space. It reaches: ${reachable}. Pass one of those as \`domain\`, or update your key in Settings.`,
						appId,
					);
				}

				const compatibility = await probeHqProjectSpaceCompatibility(
					credentials.creds,
					credentials.domain.name,
					projectSpaceCompatibilityProbePlan(loaded.doc),
				);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								app_id: appId,
								app_name: loaded.app.app_name,
								project_space_compatibility: compatibility.report,
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
