/**
 * `nova.provision_workers`: make mobile-worker accounts on a CommCare HQ
 * project space for an app's personas.
 *
 * Scope: `nova.hq.write`, plus `edit` on the app. It writes real accounts
 * on somebody else's server and writes Nova's ownership ledger, so it is
 * the same gate `upload_app_to_hq` and `refresh_deployment` take.
 *
 * **Kept off the Solutions Architect**, like every other deployment tool
 * here: the SA speaks the app's vocabulary, and who has an account on
 * which project space is not part of it.
 *
 * **Deliberately not part of publishing.** Publishing sends an app;
 * this hands out credentials to named people. Keeping them apart is what
 * lets a publish be something you do twenty times a day.
 *
 * Two things about the answer that a client has to get right:
 *
 *   * **`password` appears once and exists nowhere else.** Nova does not
 *     store it and cannot show it again — a lost one is reset on CommCare
 *     HQ. Show every password in `workers` to the user before doing
 *     anything else with this result, including when `error_type` is also
 *     present: a call that stopped halfway still made real accounts, and
 *     their passwords are in the same answer.
 *   * **A conflict is never resolved by guessing.** A username that is
 *     already taken belongs to somebody; `hq_worker_conflict` names each
 *     one, and only a person saying yes to that exact account turns into
 *     `adopt_personas`.
 *
 * Actionable `error_type` values, in the order their gates fire:
 *
 *   1. `scope_missing`:      the token lacks `nova.hq.write`.
 *   2. `hq_not_configured`:  no stored CommCare HQ credentials, or the
 *                            stored key is on a different CommCare server
 *                            than this deployment.
 *   3. `domain_not_authorized`: the key can't reach that project space.
 *   4. `app_not_published`:  the app isn't on that project space yet, so
 *                            an account there would have nothing to run
 *                            and no places to stand in. Publish first.
 *   5. `hq_worker_state_unknown`: CommCare HQ wouldn't say which of these
 *                            usernames it holds. Nothing was written.
 *   6. `workers_not_provisionable`: something about the request or the app
 *                            makes these accounts unmakeable — an unusable
 *                            username, required worker information with no
 *                            value, a persona standing in a place the
 *                            project space doesn't hold. Nothing was
 *                            written; `message` names each one.
 *   7. `hq_worker_conflict`: one or more usernames already belong to
 *                            accounts Nova didn't create. Nothing was
 *                            written; `worker_conflicts` carries them
 *                            structurally.
 *   8. `hq_rejected_worker`: CommCare HQ refused one of the writes. The
 *                            accounts before it are real and are in
 *                            `workers`, passwords included.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { provisionWorkersSchema } from "@/lib/deployment/types";
import type { WorkerConflict } from "@/lib/deployment/workerProvisionPlan";
import type {
	ProvisionedWorker,
	WorkerRefusalCode,
} from "@/lib/deployment/workers";
import { provisionWorkers } from "@/lib/deployment/workers";
import { readOrganization } from "@/lib/organization/service";
import {
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { loadAppBlueprint } from "../loadApp";
import { assertScope, SCOPES } from "../scopes";
import type { ToolContext } from "../types";

/**
 * The wire `error_type` for each refusal.
 *
 * `satisfies Record<WorkerRefusalCode, string>` forces every refusal the
 * lifecycle can produce to appear here, so a new one cannot reach a
 * client as an unlabelled failure. Two of them collapse onto tags
 * `upload_app_to_hq` already uses, because a client's move is identical:
 * go to Settings, or pick a space the key reaches.
 */
const WORKER_ERROR_TAGS = {
	hq_not_connected: "hq_not_configured",
	domain_not_authorized: "domain_not_authorized",
	app_not_published: "app_not_published",
	hq_worker_state_unknown: "hq_worker_state_unknown",
	workers_not_provisionable: "workers_not_provisionable",
	hq_worker_conflict: "hq_worker_conflict",
	hq_rejected_worker: "hq_rejected_worker",
} as const satisfies Record<WorkerRefusalCode, string>;

/**
 * One account, on the wire.
 *
 * `password` is present and non-null only for an account this call made.
 * An updated or adopted account keeps whatever password its person
 * already has, which Nova has never seen.
 */
function describeWorker(worker: ProvisionedWorker) {
	return {
		persona_uuid: worker.personaUuid,
		persona_name: worker.personaName,
		username: worker.username,
		hq_user_id: worker.userId,
		action: worker.created ? "created" : "updated",
		adopted: worker.adopted,
		password: worker.password,
	};
}

function describeConflict(conflict: WorkerConflict) {
	return {
		persona_uuid: conflict.personaUuid,
		persona_name: conflict.personaName,
		username: conflict.username,
		hq_user_id: conflict.remoteId,
	};
}

export function registerProvisionWorkers(
	server: McpServer,
	ctx: ToolContext,
): void {
	server.registerTool(
		"provision_workers",
		{
			description:
				"Create CommCare HQ mobile-worker accounts for this app's personas on a project space, or bring existing ones into step with what the app says. The app must already be published there. Each account this call creates comes back with a `password` that exists only in this answer — show every one of them to the user immediately, including when the call also reports an error, because Nova stores none of them and cannot show them again. Omit a worker's `username` to take Nova's suggestion from the persona's name. If a username already belongs to an account Nova didn't create, the call refuses with `hq_worker_conflict` and names each one; ask the user about that exact account and only then send its persona in `adopt_personas`. Nova never deletes or retires a worker, because CommCare HQ's own delete soft-deletes every case that worker owns.",
			inputSchema: z.object({
				app_id: provisionWorkersSchema.shape.appId.describe(
					"App id whose personas to provision. Must be an app the caller can edit.",
				),
				server: provisionWorkersSchema.shape.server.describe(
					"Which CommCare deployment the project space is on.",
				),
				domain: provisionWorkersSchema.shape.domain.describe(
					"The project space (domain slug) to make the accounts on. The app must already be published there.",
				),
				workers: z
					.array(
						z.object({
							persona_uuid: z
								.string()
								.describe("The persona this account stands for."),
							username: z
								.string()
								.optional()
								.describe(
									"The name this worker signs in with, before CommCare HQ appends `@<domain>.commcarehq.org`. Lowercase letters, numbers, and . _ or -. Omit to take Nova's suggestion from the persona's name.",
								),
						}),
					)
					.min(1)
					.max(50)
					.describe("Who to provision. At most 50 in one call."),
				adopt_personas: z
					.array(z.string())
					.optional()
					.describe(
						"Persona uuids whose username already exists on the project space and which the user has confirmed Nova may take over. Send only after an `hq_worker_conflict` refusal named them and the user said yes for each one; a shared username is not evidence the account is theirs. Omit to adopt nothing.",
					),
			}),
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			try {
				assertScope(ctx, SCOPES.hqWrite, "provision_workers");
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
				/* The places, so a refusal can name the one a persona stands
				 * in rather than making somebody look up a uuid. */
				const organization = await readOrganization({
					appId: args.app_id,
					projectId: access.projectId,
					role: access.role,
					actorUserId: ctx.userId,
				});
				const outcome = await provisionWorkers({
					scope,
					doc,
					locations: organization.locations,
					server: args.server,
					domain: args.domain,
					workers: args.workers.map((worker) => ({
						personaUuid: worker.persona_uuid,
						...(worker.username === undefined
							? {}
							: { username: worker.username }),
					})),
					...(args.adopt_personas && {
						adoptPersonaUuids: args.adopt_personas,
					}),
				});

				/* The workers travel on BOTH shapes. A refusal that arrived
				 * after three accounts were made carries three passwords that
				 * exist nowhere else, and an envelope that dropped them to
				 * report the fourth would lose them for good. */
				const workers = outcome.workers.map(describeWorker);
				if (outcome.refusal !== null) {
					const refusal = outcome.refusal;
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: JSON.stringify({
									error_type: WORKER_ERROR_TAGS[refusal.code],
									message:
										refusal.details.length > 0
											? `${refusal.message} ${refusal.details.join(" ")}`
											: refusal.message,
									app_id: args.app_id,
									workers,
									...(refusal.conflicts.length > 0 && {
										worker_conflicts: refusal.conflicts.map(describeConflict),
									}),
								}),
							},
						],
					};
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								app_id: args.app_id,
								domain: args.domain,
								workers,
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
