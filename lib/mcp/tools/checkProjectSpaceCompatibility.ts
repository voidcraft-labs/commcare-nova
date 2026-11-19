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
import { decrypt } from "@/lib/commcare/encryption";
import { projectSpaceCompatibilityProbePlan } from "@/lib/commcare/projectSpaceCompatibility";
import { resolveHqTarget } from "@/lib/db/settings";
import { firstPublishOf, nextPublishAction } from "@/lib/deployment/resources";
import { projectSpaceConfirmations } from "@/lib/deployment/service";
import {
	type DeploymentScope,
	type DeploymentTargetKey,
	readDeployment,
	readFirstPublishStates,
} from "@/lib/deployment/store";
import type { BlueprintDoc } from "@/lib/domain";
import { firstPublishLines } from "@/lib/publish/firstPublishCopy";
import { projectSpaceCompatibilityForTarget } from "@/lib/publish/projectSpaceCompatibility";
import { PUBLISH_PLAN_CREATES_BESIDE } from "@/lib/publish/stopPublishing";
import {
	type HqToolErrorType,
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { loadAppBlueprint } from "../loadApp";
import { registerScopedTool } from "../scopedTool";
import type { ToolContext } from "../types";
import {
	describeFirstPublish,
	type FirstPublishProjection,
} from "./deploymentProjection";
import { placementMovesAnswer } from "./uploadAppToHq";

export interface CheckProjectSpaceCompatibilityArgs {
	readonly app_id: string;
	readonly domain: string;
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

export function registerCheckProjectSpaceCompatibility(
	server: McpServer,
	ctx: ToolContext,
): void {
	registerScopedTool(
		server,
		ctx,
		"check_project_space_compatibility",
		{
			description:
				"Read-only check of whether one explicitly selected CommCare HQ project space can run an owned app. Returns friendly required capabilities, their verification state, any blockers, non-blocking performance advisories, and next steps. It does not compile, upload, or change the app or project space. Call `get_hq_connection` first to list reachable project spaces, then pass the exact `domain` the user selected; never choose among several spaces for them. Required support that is missing or could not be verified blocks a later upload, while an advisory never does. This tool reports only what the app needs and whether the selected project space supports it. It also returns what an upload there will ask the user to confirm, since no API key can read it: `plan_features` (each plan feature the app needs, with `plans`, `reasons`, `consequence`, `where_missing` (what the user can do where the project space lacks it, or null) and its `state`), `flat_location_fixture` (whether the project space still sends its location list, for an app that reads places), `connect_forwarder` (whether it forwards forms to CommCare Connect, for a Connect app) and `form_entry_sync_off` (whether Sync Cases On Form Entry is off, for an app that runs on Android and works on cases chosen in a menu with Search), each `null` when the app needs none and each with its own `where_missing`. Relay them with their reasons before the upload; a confirmation already on record reads `confirmed` with who confirmed it. `commtrack_off` says whether the project space's CommCare Supply setting needs confirming, and `placement_moves`, where present, lists the case changes Nova can move so the app doesn't need Save to Case. `first_publish`, where it is not null, is what this app's next upload changes in CommCare HQ beyond the user's own edits. Its `lead` says why: the app was brought in and Nova has not uploaded to it yet, or CommCare HQ's version holds something Nova writes its own way. Relay each `sentence` of `workers.lines`, then of `hq_only.lines`, then `reassurance` where it is not null, then `note`, before the upload. `new_app_beside`, where it is not null, says Nova stopped publishing this app to the project space, so an upload there makes a new app beside the one that stays: relay it before the upload, and upload only if the user wants a new app there.",
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
		(args) => checkProjectSpaceCompatibility(args, ctx),
	);
}

/** Shared handler used by the current tool and the temporary released-client
 * bridge. Keeping the compatibility decision here gives both names identical
 * scope, ownership, target-resolution, and live-probe behavior. */
export async function checkProjectSpaceCompatibility(
	args: CheckProjectSpaceCompatibilityArgs,
	ctx: ToolContext,
): Promise<McpToolSuccessResult | McpToolErrorResult> {
	const appId = args.app_id;
	try {
		const loaded = await loadAppBlueprint(appId, ctx.userId);
		const scope = {
			appId,
			projectId: loaded.access.projectId,
			role: loaded.access.role,
			actorUserId: ctx.userId,
		};
		const credentials = await resolveHqTarget(ctx.userId, args.domain);
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

		const plan = projectSpaceCompatibilityProbePlan(loaded.doc);
		const report =
			plan.capabilities.length === 0 && plan.advisories.length === 0
				? projectSpaceCompatibilityForTarget(credentials.domain.name, [], [])
				: (
						await probeHqProjectSpaceCompatibility(
							{
								username: credentials.username,
								apiKey: await decrypt(credentials.encryptedApiKey),
								server: credentials.server,
							},
							credentials.domain.name,
							plan,
						)
					).report;
		const target = {
			server: credentials.server,
			domain: credentials.domain.name,
		};
		const [confirmations, nextUpload] = await Promise.all([
			projectSpaceConfirmations(scope, loaded.doc, target),
			nextUploadThere(scope, target, loaded.doc),
		]);
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						app_id: appId,
						app_name: loaded.app.app_name,
						project_space_compatibility: report,
						...confirmations,
						/* The offer in the words `upload_app_to_hq` serves it,
						 * which its `accept_placement_moves` answers. */
						placement_moves: placementMovesAnswer(
							confirmations.placement_moves,
						),
						first_publish: nextUpload.firstPublish,
						new_app_beside: nextUpload.newAppBeside,
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
}

/**
 * What the next upload to the checked project space does there, in the words
 * the publish dialog shows, each through the one rule the builder reads it by,
 * so the two cannot answer differently:
 *
 * - `firstPublish`: what it changes beyond the user's own edits, the list the
 *   app's deployment there keeps (`resources.ts::firstPublishOf`). Null where
 *   the app has not reached the project space and where the deployment keeps
 *   no list for its live app.
 * - `newAppBeside`: the plan's sentence where publishing there was stopped,
 *   so the upload makes a new app beside the one that stays
 *   (`resources.ts::nextPublishAction`'s `creates-beside`). Null otherwise.
 */
async function nextUploadThere(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	doc: BlueprintDoc,
): Promise<{
	readonly firstPublish: FirstPublishProjection | null;
	readonly newAppBeside: string | null;
}> {
	const deployment = await readDeployment(scope, target);
	if (deployment === null) return { firstPublish: null, newAppBeside: null };
	const states = await readFirstPublishStates(scope);
	const view = firstPublishOf(
		deployment,
		states.get(deployment.deployment.id),
		doc.appSettings.runsOnlyOn,
	);
	return {
		firstPublish:
			view === null
				? null
				: describeFirstPublish(firstPublishLines(view, "publish")),
		newAppBeside:
			nextPublishAction(deployment) === "creates-beside"
				? PUBLISH_PLAN_CREATES_BESIDE
				: null,
	};
}
