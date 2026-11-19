/**
 * `nova.get_deployment` and `nova.refresh_deployment`: the read and
 * re-check operations around `upload_app_to_hq`.
 *
 * **These are kept off the Solutions Architect, and that is deliberate.**
 * The SA speaks domain vocabulary and does not own CommCare deployment
 * concerns, the same standing decision that keeps
 * `check_project_space_compatibility` off that surface. A deployment is not
 * authored vocabulary: it is durable state about somebody else's server,
 * and an agent designing an app has no business reasoning about it. That
 * says nothing about the builder, which reaches the same operations
 * through `lib/deployment/actions.ts`.
 *
 * Scopes follow the existing split. Reading a deployment needs
 * `nova.hq.read`. Refreshing is read-only against CommCare HQ but WRITES
 * Nova's own record, so it takes `nova.hq.write` and `edit` on the app. A
 * read-scoped token must not be able to knock a `runnable` deployment to
 * `incomplete` during an HQ blip, which is durable state every Project
 * member sees.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { COMMCARE_SERVERS } from "@/lib/commcare/servers";
import {
	artifactOrganization,
	currentResourceIdentities,
	type HeldDeploymentKept,
	holdDeploymentKept,
	keptFromHeld,
	landedDeploymentKept,
	refreshDeployment,
	refreshKeptValues,
	setupArtifactFor,
} from "@/lib/deployment/service";
import {
	type DeploymentScope,
	type DeploymentTargetKey,
	readDeploymentNovaRevisions,
	readDeploymentsForApp,
	readTargetFacts,
	withDeploymentReadSnapshot,
} from "@/lib/deployment/store";
import { deploymentKeptOf } from "@/lib/deployment/targetFacts";
import {
	type DeploymentKept,
	deploymentAppIdSchema,
	deploymentServerSchema,
	deploymentTargetSchema,
} from "@/lib/deployment/types";
import { type BlueprintDoc, orderedOrganizationLevels } from "@/lib/domain";
import { driftDate } from "@/lib/publish/driftReference";
import {
	keptChanged,
	keptListUnreadSentence,
	keptRefreshSentence,
} from "@/lib/publish/keptValues";
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
import { landedNovaRevisions, landedResourceIdentities } from "./landedReads";

/** After the kept list's sentence for `changed-in-hq`: where a client reads what changed. */
const READ_HQ_CHANGES_POINTER = " `read_hq_changes` lists what changed.";

function jsonResult(payload: unknown): McpToolSuccessResult {
	return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/** Every CommCare HQ project space this app has been published to. */
export function registerGetDeployment(
	server: McpServer,
	ctx: ToolContext,
): void {
	registerScopedTool(
		server,
		ctx,
		"get_deployment",
		{
			description:
				"Report where an app has been published on CommCare HQ and what state each publication is in. `state` is one of `preflight`, `uploaded`, `built`, `released`, `runnable`, `incomplete` or `ended`; `incomplete` also carries `retry_from`, the phase a retry re-enters. Nova can import an app with an API key but cannot make a build or release one, because CommCare HQ allows those only from a signed-in browser session. So `built` and `released` are observed rather than performed, and `setup_artifact` states what a person must do on the project space. `deployment.confirmations` lists what a person confirmed about each project space for this app (a plan feature, the flat location list, a Connect forwarder, Sync Cases On Form Entry turned off); `withdraw_deployment_confirmation` takes one back, and the next upload there asks again. Reads only; call `refresh_deployment` to ask CommCare HQ again. `deployment.kept` lists the settings that stay as CommCare HQ holds them on that project space, with the date Nova read them. `brought_in` says the app came from CommCare HQ on that project space, when and by whom. `ending` says Nova stopped publishing there: the app in CommCare HQ stays, and the next upload makes a new app beside it; where `ending.held_by_another_app` is true, another Nova app publishes to that CommCare HQ app now, so `ending.hq_app_id` is left out and there is no way back to it to offer. `nova_revision` is the revision of this app that CommCare HQ's copy was last known to match, beside `pushed_revision`, the one Nova last sent: after changes made in CommCare HQ are brought in, the two differ, and only a revision after `nova_revision` holds something waiting to be published.",
			inputSchema: z.object({
				/* The same wire schema the browser boundary validates, so the
				 * two surfaces cannot drift into accepting different things. */
				app_id: deploymentAppIdSchema.describe(
					"App id to report on. Must be an app the caller can view.",
				),
			}),
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			try {
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
				/* The records, their ledgers, the revisions and every kept list of
				 * one moment, for a caller allowed to see them then: a move or a stop
				 * that commits meanwhile is wholly before or wholly after. Each kept
				 * list is projected once the snapshot has given its connection back. */
				const { deployments, novaRevisions, heldKept } =
					await withDeploymentReadSnapshot(scope, "view", async (snapshot) => {
						const deployments = await readDeploymentsForApp(snapshot);
						const heldKept = new Map<string, HeldDeploymentKept>();
						for (const deployment of deployments)
							heldKept.set(
								deployment.deployment.id,
								await holdDeploymentKept(snapshot, deployment),
							);
						return {
							deployments,
							novaRevisions: await readDeploymentNovaRevisions(snapshot),
							heldKept,
						};
					});
				const kept = new Map<string, DeploymentKept | null>(
					[...heldKept].map(([id, held]) => [id, keptFromHeld(held)]),
				);
				/* One read of the app's organization for all of them, and one of its
				 * lookup identities: both belong to the app, not to any one
				 * project space, so a second read could only return the same
				 * answer. */
				const organization =
					deployments.length === 0 ? null : await artifactOrganization(scope);
				const identities =
					deployments.length === 0
						? new Map<string, string>()
						: await currentResourceIdentities(scope, doc);
				const views = await Promise.all(
					deployments.map(async (deployment) => ({
						...describeDeployment(
							deployment,
							identities,
							kept.get(deployment.deployment.id) ?? null,
							novaRevisions,
							orderedOrganizationLevels(doc),
						),
						setup_artifact: await setupArtifactFor(
							scope,
							deployment,
							doc,
							organization,
						),
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
	registerScopedTool(
		server,
		ctx,
		"refresh_deployment",
		{
			description:
				"Ask CommCare HQ again what has happened to an app Nova published, and update the stored deployment state. It reads CommCare HQ and writes Nova's own record, so it needs the HQ write scope and edit access to the app: it can move a deployment to `built`, `released`, or `runnable`, and can move it BACK when a build stops being released there. `runnable` means the released build served the file a device installs from. Its result carries the same `deployment.confirmations` as `get_deployment`. Use this after telling a user to make a version and release it on CommCare HQ. Pass `kept_values: true` to read again the settings this project space keeps in CommCare HQ (the `kept` list of `get_deployment`) without asking about builds. It updates them only where nothing Nova publishes has changed in CommCare HQ since the last publish, and says so otherwise. Where Nova couldn't read back `kept` or `nova_revision` after its write landed, that field is left out and the refresh still landed: `get_deployment` reads them again.",
			inputSchema: z.object({
				/* The exact shapes `deploymentTargetSchema` validates on the
				 * browser boundary, field by field, so the two surfaces cannot
				 * drift into accepting different things. */
				app_id: deploymentTargetSchema.shape.appId.describe(
					"App id whose deployment to re-check.",
				),
				server: deploymentServerSchema.describe(
					"Which CommCare deployment the project space is on.",
				),
				domain: deploymentTargetSchema.shape.domain.describe(
					"The project space (domain slug) to re-check.",
				),
				kept_values: z
					.boolean()
					.optional()
					.describe(
						"Read the project space's kept settings again, in place of the build and release check.",
					),
			}),
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			try {
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
				if (args.kept_values === true) {
					return jsonResult(
						await refreshKeptValuesResult(
							scope,
							{ server: args.server, domain: args.domain },
							doc,
						),
					);
				}
				const refreshed = await refreshDeployment(
					scope,
					{ server: args.server, domain: args.domain },
					doc,
				);
				if (refreshed === null) {
					throw new McpInvalidInputError(
						`This app has no deployment to “${args.domain}” on the ${COMMCARE_SERVERS[args.server].label} CommCare server. Publish it there first, or call get_deployment to see where it has been published.`,
					);
				}
				/* The check's write has landed, so what Nova could not read just
				 * now is left out of the answer rather than failing it. */
				const [identities, kept, novaRevisions] = await Promise.all([
					landedResourceIdentities(scope, doc, args.domain, "check-status"),
					landedDeploymentKept(scope, refreshed.deployment, "check-status"),
					landedNovaRevisions(scope, args.domain, "check-status"),
				]);
				return jsonResult({
					app_id: args.app_id,
					...describeDeployment(
						refreshed.deployment,
						identities,
						kept,
						novaRevisions,
						orderedOrganizationLevels(doc),
					),
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

/**
 * `refresh_deployment` with `kept_values`: read the kept settings again and
 * answer with the sentence the Publishing card shows, dated with the UTC day
 * of the read the list stood on (`driftDate`, as every MCP sentence writes a
 * date), and with the deployment where the outcome
 * carries one. A `DeploymentError` (no key, a key that cannot reach the
 * project space, a key on another server) reaches the client as the tool's
 * error, as Check status's does.
 */
async function refreshKeptValuesResult(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	doc: BlueprintDoc,
) {
	const before = await readTargetFacts(scope, target);
	const outcome = await refreshKeptValues(scope, target);
	const context = {
		date: before === null ? "the last read" : driftDate(before.observedAt),
		space: target.domain,
	};
	if (outcome.kind !== "refreshed" && outcome.kind !== "superseded") {
		const sentence = keptRefreshSentence(
			{ kind: outcome.kind, changed: false },
			context,
		);
		return {
			app_id: scope.appId,
			kept_refresh: outcome.kind,
			/* Where CommCare HQ saved the app, the card offers what changed;
			 * a client is pointed at the tool that lists it. */
			message:
				outcome.kind === "changed-in-hq"
					? `${sentence}${READ_HQ_CHANGES_POINTER}`
					: sentence,
		};
	}
	/* The refresh's write has landed, so a list Nova could not read just now
	 * leaves `kept` out and says so, rather than failing the answer; the
	 * other reads after it answer less the same way. */
	const kept = await landedDeploymentKept(
		scope,
		outcome.deployment,
		"kept-refresh",
	);
	/* The card's rule: anything kept differs from the list before the
	 * refresh, a value under a label listed on both sides included. */
	const message =
		kept === "unread"
			? keptListUnreadSentence(context.date)
			: keptRefreshSentence(
					{
						kind: outcome.kind,
						changed: keptChanged(
							before === null ? null : deploymentKeptOf(before),
							kept,
						),
					},
					context,
				);
	return {
		app_id: scope.appId,
		kept_refresh: outcome.kind,
		message,
		...describeDeployment(
			outcome.deployment,
			await landedResourceIdentities(scope, doc, target.domain, "kept-refresh"),
			kept,
			await landedNovaRevisions(scope, target.domain, "kept-refresh"),
			orderedOrganizationLevels(doc),
		),
		setup_artifact: await setupArtifactFor(
			scope,
			outcome.deployment,
			doc,
			await artifactOrganization(scope),
		),
	};
}
