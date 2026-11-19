/**
 * `nova.withdraw_deployment_confirmation`: withdraw what a person confirmed
 * about a CommCare HQ project space, so the next upload there asks again.
 *
 * A confirmation records that a project space has something no API key
 * reads: a plan feature, its flat location list, a Connect forwarder, sync
 * on form entry turned off, CommCare Supply turned off, or that a level takes
 * workers where CommCare HQ manages the app's places. Nova
 * cannot see a plan change in CommCare HQ, so a confirmation stands until
 * someone withdraws it, here or from the deployment's card in the builder.
 * The row is kept with who withdrew it and when.
 *
 * Scope: `nova.hq.write`, checked by its registration before anything runs: the deployment tools are
 * gated as one family, and this changes what the next upload does. The app
 * capability is `edit`, as for every deployment write.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { landedDeploymentKept } from "@/lib/deployment/service";
import {
	readDeploymentsForApp,
	withdrawDeploymentConfirmation,
} from "@/lib/deployment/store";
import {
	DEPLOYMENT_CONFIRMATION_KINDS,
	type DeploymentConfirmationKey,
	deploymentAppIdSchema,
	organizationLevelCodeSchema,
} from "@/lib/deployment/types";
import { orderedOrganizationLevels } from "@/lib/domain";
import { isPlanFeatureId, PLAN_FEATURE_IDS } from "@/lib/publish/planFeatures";
import {
	McpInvalidInputError,
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { loadAppBlueprint } from "../loadApp";
import { registerScopedTool } from "../scopedTool";
import type { ToolContext } from "../types";
import { describeDeployment } from "./deploymentProjection";
import {
	landedNovaRevisions,
	landedResourceIdentities,
	landedSetupArtifact,
} from "./landedReads";

/** The key a call names, refused in the caller's words where it names none. */
function confirmationKey(
	kind: (typeof DEPLOYMENT_CONFIRMATION_KINDS)[number],
	subject: string | undefined,
): DeploymentConfirmationKey {
	if (kind === "worker-level") {
		const code = organizationLevelCodeSchema.safeParse(subject);
		if (!code.success) {
			throw new McpInvalidInputError(
				"A worker level confirmation is withdrawn by the level's code, as `confirmations` names it in `subject`. Read the deployment's `confirmations` from get_deployment for the ones in force.",
			);
		}
		return { kind, subject: code.data };
	}
	if (kind !== "plan-feature") return { kind };
	if (!isPlanFeatureId(subject)) {
		throw new McpInvalidInputError(
			`A plan feature confirmation is withdrawn by its id, one of ${PLAN_FEATURE_IDS.join(", ")}. Read the deployment's \`confirmations\` from get_deployment for the ones in force.`,
		);
	}
	return { kind, subject };
}

export function registerWithdrawDeploymentConfirmation(
	server: McpServer,
	ctx: ToolContext,
): void {
	registerScopedTool(
		server,
		ctx,
		"withdraw_deployment_confirmation",
		{
			description:
				"Withdraw something a user confirmed about a CommCare HQ project space (a plan feature, the flat location list, a Connect forwarder, Sync Cases On Form Entry turned off, CommCare Supply turned off, or that a level takes workers), so the next `upload_app_to_hq` there asks about it again, or for a level, the next `provision_workers` that stands a worker there. Use it when the user says the project space no longer has it, for example after a plan change, which Nova cannot see. Read the confirmations in force from `get_deployment`'s `confirmations`. Withdrawing one that is not in force changes nothing. Returns the deployment.",
			inputSchema: z.object({
				app_id: deploymentAppIdSchema.describe(
					"App id whose deployment holds the confirmation. Requires edit access in the app's Project.",
				),
				domain: z
					.string()
					.trim()
					.min(1)
					.optional()
					.describe(
						"The project space (domain slug) the confirmation is about, as `get_deployment` names it. Omit only when the app is published to a single project space.",
					),
				kind: z
					.enum(DEPLOYMENT_CONFIRMATION_KINDS)
					.describe(
						"`plan-feature`, `flat-location-fixture`, `connect-forwarder`, `form-entry-sync-off`, `commtrack-off` or `worker-level`, as `get_deployment`'s `confirmations` names it.",
					),
				subject: z
					.string()
					.optional()
					.describe(
						"For a `plan-feature`, the plan feature's id, and for a `worker-level`, the level's code, as `confirmations` names it. Omit for the other kinds.",
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
				const key = confirmationKey(args.kind, args.subject);
				const scope = {
					appId: args.app_id,
					projectId: access.projectId,
					role: access.role,
					actorUserId: ctx.userId,
				};
				/* The deployment is found from the ledger, so withdrawing asks
				 * CommCare HQ nothing and needs no key. */
				const requested = args.domain?.trim() || undefined;
				const candidates = (await readDeploymentsForApp(scope)).filter(
					(view) =>
						requested === undefined || view.deployment.domain === requested,
				);
				const [only] = candidates;
				if (only === undefined || candidates.length > 1) {
					throw new McpInvalidInputError(
						only === undefined
							? requested === undefined
								? "This app isn't published to any project space, so it holds no confirmation to withdraw."
								: `This app isn't published to “${requested}”, so it holds no confirmation there. Call get_deployment to see where it is published.`
							: requested === undefined
								? "This app is published to more than one project space. Pass `domain` to name the one this confirmation is about."
								: `This app is published to “${requested}” on more than one CommCare server, so Nova can't tell which one you mean. Withdraw it from the deployment's card in the builder, where each server is shown.`,
					);
				}
				const deployment = await withdrawDeploymentConfirmation(
					scope,
					{ server: only.deployment.server, domain: only.deployment.domain },
					key,
				);
				/* The withdrawal has landed, so what Nova could not read just
				 * now is left out of the answer rather than failing it. */
				const domain = only.deployment.domain;
				const [identities, kept, novaRevisions, artifact] = await Promise.all([
					landedResourceIdentities(scope, doc, domain, "withdraw"),
					landedDeploymentKept(scope, deployment, "withdraw"),
					landedNovaRevisions(scope, domain, "withdraw"),
					landedSetupArtifact(scope, deployment, doc, "withdraw"),
				]);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								app_id: args.app_id,
								...describeDeployment(
									deployment,
									identities,
									kept,
									novaRevisions,
									orderedOrganizationLevels(doc),
								),
								setup_artifact: artifact,
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
