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
 * The stop names the HQ app the client read (`hq_app_id`, as `get_deployment`
 * shows it) and ends that mapping or nothing: a repeat of a stop that landed
 * answers the stopped deployment, and a deployment that publishes to another
 * HQ app now answers `deployment_changed`, having stopped nothing.
 *
 * Scope: `nova.hq.write`, checked by its registration before anything runs: an ending changes what
 * every later publish there does, and frees the HQ app to be brought in once
 * every publish to it has finished.
 * Kept off the Solutions Architect, as every deployment tool is.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { landedDeploymentKept, stopPublishing } from "@/lib/deployment/service";
import {
	deploymentServerSchema,
	deploymentTargetSchema,
	hqAppIdSchema,
} from "@/lib/deployment/types";
import { orderedOrganizationLevels } from "@/lib/domain";
import { toolWriteGrant } from "../credentialWriteGrant";
import {
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { loadAppBlueprint } from "../loadApp";
import { registerScopedTool } from "../scopedTool";
import type { ToolContext } from "../types";
import { describeDeployment } from "./deploymentProjection";
import { landedNovaRevisions, landedResourceIdentities } from "./landedReads";

export function registerStopPublishing(
	server: McpServer,
	ctx: ToolContext,
): void {
	registerScopedTool(
		server,
		ctx,
		"stop_publishing",
		{
			description:
				"Stop publishing an app to one CommCare HQ project space. The app in CommCare HQ stays exactly as it is, this Nova app stops publishing to it, and it can be brought in to Nova again as a new app once any publish to it that was running has finished. Pass the `hq_app_id` `get_deployment` shows for this project space: the stop ends publishing to that HQ app or does nothing. Calling it again for the same `hq_app_id` answers the stopped deployment. If this app publishes to a different HQ app there by then, the call returns `deployment_changed` and stops nothing: read `get_deployment` again and ask the user before stopping that one. A later upload to that project space makes a new app there, beside the one that stays. Nothing is sent to CommCare HQ. Only an admin or owner of the app's Project can do this: an editor gets `permission_denied` with who can, and someone who cannot edit the app gets `not_found`, as every tool that changes an app answers them. This cannot be undone from Nova, so call it only when the user asked for exactly this, after telling them what it does. Once publishing has stopped, the answer says so even where Nova could not read everything back: `setup_artifact` is then null, and `get_deployment` reads it again.",
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
				hq_app_id: hqAppIdSchema.describe(
					"The `hq_app_id` `get_deployment` shows for this project space: the CommCare HQ app the user decided to stop publishing to.",
				),
			}),
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			try {
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
					requireOperation: toolWriteGrant(ctx, "stop_publishing"),
				};
				const stopped = await stopPublishing(
					scope,
					{ server: args.server, domain: args.domain },
					args.hq_app_id,
					doc,
				);
				/* The ending has committed: from here on, a fault reading what the
				 * answer shows answers less, never an error, since an agent told
				 * the stop failed would stop again and be told there is nothing
				 * to stop. */
				const [identities, kept, novaRevisions] = await Promise.all([
					landedResourceIdentities(scope, doc, args.domain, "stop"),
					landedDeploymentKept(scope, stopped.deployment, "stop"),
					landedNovaRevisions(scope, args.domain, "stop"),
				]);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								app_id: args.app_id,
								...describeDeployment(
									stopped.deployment,
									identities,
									kept,
									novaRevisions,
									orderedOrganizationLevels(doc),
								),
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
