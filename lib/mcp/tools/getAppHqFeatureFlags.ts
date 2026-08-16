/**
 * `nova.get_app_hq_feature_flags`: explain the CommCare HQ feature flags an
 * owned app requires, and optionally check those requirements against one
 * explicitly selected connected HQ project space.
 *
 * Scope: the app-only path needs the route-level `nova.read` floor. Supplying
 * `domain` additionally requires `nova.hq.read`, because that path uses the
 * caller's stored credentials for a read-only request to CommCare HQ. The
 * conditional gate keeps the no-domain disclosure broadly available without
 * silently granting third-party access.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { probeHqFeatureFlags } from "@/lib/commcare/client";
import {
	featureFlagReportForPrepublish,
	featureFlagReportForUpload,
	requiredHqFeatureFlagUses,
} from "@/lib/commcare/featureFlags";
import { getCredentialsForUpload } from "@/lib/db/settings";
import type {
	HqFeatureFlagReport,
	HqFeatureFlagRequirement,
} from "@/lib/publish/hqFeatureFlags";
import {
	type HqToolErrorType,
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { loadAppBlueprint } from "../loadApp";
import { assertScope, SCOPES } from "../scopes";
import type { ToolContext } from "../types";

type RequirementWithReasons = HqFeatureFlagRequirement & {
	readonly reasons: readonly string[];
};

type ReportWithReasons = Omit<
	HqFeatureFlagReport,
	"required_flags" | "missing_flags" | "unverified_flags"
> & {
	readonly required_flags: readonly RequirementWithReasons[];
	readonly missing_flags: readonly RequirementWithReasons[];
	readonly unverified_flags: readonly RequirementWithReasons[];
};

function addReasonsToReport(
	report: HqFeatureFlagReport,
	requirements: readonly RequirementWithReasons[],
): ReportWithReasons {
	const byId = new Map(
		requirements.map((requirement) => [requirement.id, requirement]),
	);
	const withReasons = (
		flags: readonly HqFeatureFlagRequirement[],
	): RequirementWithReasons[] =>
		flags.flatMap((flag) => {
			const enriched = byId.get(flag.id);
			return enriched ? [enriched] : [];
		});

	return {
		...report,
		required_flags: withReasons(report.required_flags),
		missing_flags: withReasons(report.missing_flags),
		unverified_flags: withReasons(report.unverified_flags),
	};
}

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

export function registerGetAppHqFeatureFlags(
	server: McpServer,
	ctx: ToolContext,
): void {
	server.registerTool(
		"get_app_hq_feature_flags",
		{
			description:
				"Read-only pre-publish check for the CommCare HQ feature flags one Nova app requires; it does not compile or upload the app. Returns only applicable flags, app-specific reasons, plain-language descriptions, public docs, and support guidance. With no `domain`, it does not use an HQ connection and reports requirements without claiming any flag is off. With an explicit `domain`, it uses the caller's connected HQ account to check that project space and reports confirmed `missing_flags` separately from `unverified_flags`; this domain path requires `nova.hq.read`. Call `get_hq_connection` to list reachable project spaces, and never choose among multiple spaces for the user. This check is informational only: its result must never cause an agent to remove, undo, or avoid requested app functionality.",
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
					.optional()
					.describe(
						"Optional exact CommCare HQ project-space slug to check. It must be one of `get_hq_connection`'s `available_domains`. Omit it to inspect app requirements without accessing HQ or making any enabled/missing claim.",
					),
			}),
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			const appId = args.app_id;
			try {
				if (args.domain) {
					// A domain probe reaches a third-party system. Gate it before app
					// ownership so a credential without HQ access learns nothing.
					assertScope(ctx, SCOPES.hqRead, "get_app_hq_feature_flags");
				}
				const loaded = await loadAppBlueprint(appId, ctx.userId);
				const uses = requiredHqFeatureFlagUses(loaded.doc);
				const requiredFlags = uses.map(({ requirement, reasons }) => ({
					...requirement,
					reasons,
				}));

				let report = featureFlagReportForPrepublish(loaded.doc);
				if (args.domain) {
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
					const probes = await probeHqFeatureFlags(
						credentials.creds,
						credentials.domain.name,
						uses.map((use) => use.requirement),
					);
					report = featureFlagReportForUpload(
						credentials.domain.name,
						probes,
						"prepublish",
					);
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								app_id: appId,
								app_name: loaded.app.app_name,
								domain_checked: args.domain !== undefined,
								feature_flag_requirements: addReasonsToReport(
									report,
									requiredFlags,
								),
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
