/**
 * `nova.withdraw_deployment_confirmation`: withdraw what a person confirmed
 * about a CommCare HQ project space, so the next upload there asks again.
 *
 * A confirmation records that a project space has something no API key
 * reads: a plan feature, its flat location list, a Connect forwarder, sync
 * on form entry turned off. Nova
 * cannot see a plan change in CommCare HQ, so a confirmation stands until
 * someone withdraws it, here or from the deployment's card in the builder.
 * The row is kept with who withdrew it and when.
 *
 * Scope: `nova.hq.write`, checked before any read: the deployment tools are
 * gated as one family, and this changes what the next upload does. The app
 * capability is `edit`, as for every deployment write.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	currentResourceIdentities,
	setupArtifactFor,
} from "@/lib/deployment/service";
import {
	readDeploymentsForApp,
	withdrawDeploymentConfirmation,
} from "@/lib/deployment/store";
import {
	DEPLOYMENT_CONFIRMATION_KINDS,
	type DeploymentConfirmationKey,
	deploymentAppIdSchema,
} from "@/lib/deployment/types";
import { isPlanFeatureId, PLAN_FEATURE_IDS } from "@/lib/publish/planFeatures";
import {
	McpInvalidInputError,
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { loadAppBlueprint } from "../loadApp";
import { assertScope, oauthScopeChallenge, SCOPES } from "../scopes";
import type { ToolContext } from "../types";
import { describeDeployment } from "./deploymentProjection";

/** The key a call names, refused in the caller's words where it names none. */
function confirmationKey(
	kind: (typeof DEPLOYMENT_CONFIRMATION_KINDS)[number],
	subject: string | undefined,
): DeploymentConfirmationKey {
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
	server.registerTool(
		"withdraw_deployment_confirmation",
		{
			scopeChallenge: oauthScopeChallenge(ctx, SCOPES.hqWrite),
			description:
				"Withdraw something a user confirmed about a CommCare HQ project space (a plan feature, the flat location list, a Connect forwarder, or Sync Cases On Form Entry turned off), so the next `upload_app_to_hq` there asks about it again. Use it when the user says the project space no longer has it, for example after a plan change, which Nova cannot see. Read the confirmations in force from `get_deployment`'s `confirmations`. Withdrawing one that is not in force changes nothing. Returns the deployment.",
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
						"`plan-feature`, `flat-location-fixture`, `connect-forwarder` or `form-entry-sync-off`, as `get_deployment`'s `confirmations` names it.",
					),
				subject: z
					.string()
					.optional()
					.describe(
						"For a `plan-feature`, the plan feature's id as `confirmations` names it. Omit for the other three kinds.",
					),
			}),
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			try {
				assertScope(ctx, SCOPES.hqWrite, "withdraw_deployment_confirmation");
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
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								app_id: args.app_id,
								...describeDeployment(
									deployment,
									await currentResourceIdentities(scope, doc),
								),
								setup_artifact: await setupArtifactFor(scope, deployment, doc),
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
