/**
 * `nova.get_deployment`, `nova.refresh_deployment`, and
 * `nova.adopt_hq_app` — the read, re-check, and attach operations around
 * `upload_app_to_hq`.
 *
 * **These are MCP-only, and that is deliberate.** Nova's internal
 * Solutions Architect speaks domain vocabulary and does not own CommCare
 * deployment concerns — the same standing decision that keeps
 * `get_app_hq_feature_flags` off the SA surface. A deployment is not
 * authored vocabulary: it is durable state about somebody else's server,
 * and an agent designing an app has no business reasoning about it.
 *
 * Scopes follow the existing split. Reading a deployment needs
 * `nova.hq.read`; adopting one needs `nova.hq.write`, because attaching a
 * Nova app to a CommCare HQ app decides what a later publish may replace.
 * Refreshing is read-only against CommCare HQ but WRITES Nova's own
 * record, so it takes `nova.hq.write` and `edit` on the app. A read-scoped
 * token must not be able to knock a `runnable` deployment to `incomplete`
 * during an HQ blip, which is durable state every Project member sees.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { COMMCARE_SERVERS } from "@/lib/commcare/servers";
import {
	adoptRemoteApp,
	refreshDeployment,
	setupArtifactFor,
} from "@/lib/deployment/service";
import { readDeploymentsForApp } from "@/lib/deployment/store";
import { deploymentServerSchema, hqAppIdSchema } from "@/lib/deployment/types";
import {
	McpInvalidInputError,
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { loadAppBlueprint } from "../loadApp";
import { assertScope, SCOPES } from "../scopes";
import type { ToolContext } from "../types";
import { describeDeployment } from "./deploymentProjection";

function jsonResult(payload: unknown): McpToolSuccessResult {
	return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/** Every CommCare HQ project space this app has been published to. */
export function registerGetDeployment(
	server: McpServer,
	ctx: ToolContext,
): void {
	server.registerTool(
		"get_deployment",
		{
			description:
				"Report where an app has been published on CommCare HQ and what state each publication is in. `state` is one of `preflight`, `uploaded`, `built`, `released`, `runnable`, or `incomplete`; `incomplete` also carries `retry_from`, the phase a retry re-enters. Nova can import an app with an API key but cannot make a build or release one, because CommCare HQ allows those only from a signed-in browser session. So `built` and `released` are observed rather than performed, and `setup_artifact` states what a person must do on the project space. Reads only; call `refresh_deployment` to ask CommCare HQ again.",
			inputSchema: {
				app_id: z
					.string()
					.describe("App id to report on. Must be an app the caller can view."),
			},
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			try {
				assertScope(ctx, SCOPES.hqRead, "get_deployment");
				const { doc, access } = await loadAppBlueprint(
					args.app_id,
					ctx.userId,
					"view",
				);
				const scope = {
					appId: args.app_id,
					projectId: access.projectId,
					role: access.role,
					actorUserId: ctx.userId,
				};
				const deployments = await readDeploymentsForApp(scope);
				const views = await Promise.all(
					deployments.map(async (deployment) => ({
						...describeDeployment(deployment),
						setup_artifact: await setupArtifactFor(scope, deployment, doc),
					})),
				);
				return jsonResult({ app_id: args.app_id, deployments: views });
			} catch (err) {
				return toMcpErrorResult(err, {
					appId: args.app_id,
					userId: ctx.userId,
				});
			}
		},
	);
}

/** Ask CommCare HQ again what has happened to a published app. */
export function registerRefreshDeployment(
	server: McpServer,
	ctx: ToolContext,
): void {
	server.registerTool(
		"refresh_deployment",
		{
			description:
				"Ask CommCare HQ again what has happened to an app Nova published, and update the stored deployment state. It reads CommCare HQ and writes Nova's own record, so it needs the HQ write scope and edit access to the app: it can move a deployment to `built`, `released`, or `runnable`, and can move it BACK when a build stops being released there. `runnable` means the released build served the file a device installs from. Use this after telling a user to make a version and release it on CommCare HQ.",
			inputSchema: {
				app_id: z.string().describe("App id whose deployment to re-check."),
				server: deploymentServerSchema.describe(
					"Which CommCare deployment the project space is on.",
				),
				domain: z
					.string()
					.describe("The project space (domain slug) to re-check."),
			},
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			try {
				assertScope(ctx, SCOPES.hqWrite, "refresh_deployment");
				/* Read-only against CommCare HQ, but it persists what it saw,
				 * so the app capability is `edit` rather than `view`. */
				const { doc, access } = await loadAppBlueprint(
					args.app_id,
					ctx.userId,
					"edit",
				);
				const scope = {
					appId: args.app_id,
					projectId: access.projectId,
					role: access.role,
					actorUserId: ctx.userId,
				};
				const refreshed = await refreshDeployment(
					scope,
					{ server: args.server, domain: args.domain.trim() },
					doc,
				);
				if (refreshed === null) {
					throw new McpInvalidInputError(
						`This app has no deployment to “${args.domain.trim()}” on the ${COMMCARE_SERVERS[args.server].label} CommCare server. Publish it there first, or call get_deployment to see where it has been published.`,
					);
				}
				return jsonResult({
					app_id: args.app_id,
					...describeDeployment(refreshed.deployment),
					setup_artifact: refreshed.artifact,
				});
			} catch (err) {
				return toMcpErrorResult(err, {
					appId: args.app_id,
					userId: ctx.userId,
				});
			}
		},
	);
}

/** Attach a deployment to an app that is already on CommCare HQ. */
export function registerAdoptHqApp(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"adopt_hq_app",
		{
			description:
				"Tell Nova that an app already on CommCare HQ is this Nova app's publication, so it can report its build and release state. Requires the exact CommCare HQ app id. Nova never matches by name, because two project spaces can hold unrelated apps with the same name. Use this when somebody imported the app file by hand instead of publishing from Nova. It does not upload anything and does not change the app on CommCare HQ.",
			inputSchema: {
				app_id: z.string().describe("The Nova app id."),
				server: deploymentServerSchema.describe(
					"Which CommCare deployment the project space is on.",
				),
				domain: z
					.string()
					.describe("The project space (domain slug) the app is on."),
				hq_app_id: hqAppIdSchema.describe(
					"The exact CommCare HQ app id, from the app's URL on CommCare HQ.",
				),
			},
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			try {
				assertScope(ctx, SCOPES.hqWrite, "adopt_hq_app");
				const { doc, access } = await loadAppBlueprint(
					args.app_id,
					ctx.userId,
					"edit",
				);
				const scope = {
					appId: args.app_id,
					projectId: access.projectId,
					role: access.role,
					actorUserId: ctx.userId,
				};
				const deployment = await adoptRemoteApp(
					scope,
					{ server: args.server, domain: args.domain.trim() },
					args.hq_app_id,
				);
				return jsonResult({
					app_id: args.app_id,
					...describeDeployment(deployment),
					setup_artifact: await setupArtifactFor(scope, deployment, doc),
				});
			} catch (err) {
				return toMcpErrorResult(err, {
					appId: args.app_id,
					userId: ctx.userId,
				});
			}
		},
	);
}
