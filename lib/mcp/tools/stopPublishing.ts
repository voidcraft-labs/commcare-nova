/**
 * `nova.stop_publishing`: this app stops publishing to one CommCare HQ
 * project space, and the app there stays exactly as it is.
 *
 * It is the builder's "Stop publishing here" through the same lifecycle
 * (`lib/deployment/service.ts::stopPublishing`). CommCare HQ is asked
 * nothing, so a person whose key no longer reaches the project space can
 * still stop. The app capability resolves at `edit`, as for every deployment
 * write, so a viewer or a stranger finds nothing to stop; an editor meets the
 * store's `not_permitted`, which names who may, as `permission_denied`.
 *
 * Scope: `nova.hq.write`, checked before any read: an ending changes what
 * every later publish there does, and frees the HQ app to be brought in.
 * Kept off the Solutions Architect, as every deployment tool is.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	currentResourceIdentities,
	deploymentKept,
	stopPublishing,
} from "@/lib/deployment/service";
import {
	deploymentServerSchema,
	deploymentTargetSchema,
} from "@/lib/deployment/types";
import {
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { loadAppBlueprint } from "../loadApp";
import { assertScope, oauthScopeChallenge, SCOPES } from "../scopes";
import type { ToolContext } from "../types";
import { describeDeployment } from "./deploymentProjection";

export function registerStopPublishing(
	server: McpServer,
	ctx: ToolContext,
): void {
	server.registerTool(
		"stop_publishing",
		{
			scopeChallenge: oauthScopeChallenge(ctx, SCOPES.hqWrite),
			description:
				"Stop publishing an app to one CommCare HQ project space. The app in CommCare HQ stays exactly as it is, this Nova app stops publishing to it, and it can be brought in to Nova again as a new app. A later upload to that project space makes a new app there, beside the one that stays. Nothing is sent to CommCare HQ. Only an admin or owner of the app's Project can do this; anyone else gets `permission_denied` with who can. This cannot be undone from Nova, so call it only when the user asked for exactly this, after telling them what it does.",
			/* Strict, so the served schema is closed: the SDK converts an input
			 * schema on its input side, where a plain object stays open. The
			 * shapes are the browser boundary's, field by field. */
			inputSchema: z.strictObject({
				app_id: deploymentTargetSchema.shape.appId.describe(
					"App id whose publishing to stop.",
				),
				server: deploymentServerSchema.describe(
					"Which CommCare deployment the project space is on.",
				),
				domain: deploymentTargetSchema.shape.domain.describe(
					"The project space (domain slug) to stop publishing to.",
				),
			}),
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			try {
				assertScope(ctx, SCOPES.hqWrite, "stop_publishing");
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
				const stopped = await stopPublishing(
					scope,
					{ server: args.server, domain: args.domain },
					doc,
				);
				const [identities, kept] = await Promise.all([
					currentResourceIdentities(scope, doc),
					deploymentKept(scope, stopped.deployment),
				]);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								app_id: args.app_id,
								...describeDeployment(stopped.deployment, identities, kept),
								setup_artifact: stopped.artifact,
							}),
						},
					],
				};
			} catch (err) {
				return toMcpErrorResult(err, {
					appId: args.app_id,
					userId: ctx.userId,
				});
			}
		},
	);
}
