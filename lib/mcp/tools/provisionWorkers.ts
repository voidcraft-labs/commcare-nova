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
 *   * **A refused call can still have made an account.** CommCare HQ
 *     commits a worker before it serializes the answer, so a failure past
 *     that point is a live account and an error. `hq_worker_may_exist`
 *     reports exactly that, and `unconfirmed_workers` carries the
 *     passwords for accounts that may or may not be there. Show them with
 *     the same urgency as `workers`, because if the account exists the
 *     password is irreplaceable. Never say the account was not created —
 *     Nova does not know, and neither does the client.
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
 *                            written; `message` names each one, and
 *                            `worker_levels` any level to confirm beside
 *                            them.
 *      `worker_levels_unconfirmed`: a persona stands in a place CommCare HQ
 *                            manages for the app there, at a level nobody
 *                            confirmed takes workers in that project space;
 *                            HQ's level API doesn't say. Nothing was
 *                            written; `worker_levels` names each level with
 *                            its code and who would stand there. Ask the
 *                            user, and send the codes they confirm in
 *                            `confirm_worker_levels`.
 *   7. `hq_worker_conflict`: one or more usernames already belong to
 *                            accounts Nova didn't create. Nothing was
 *                            written; `worker_conflicts` carries them
 *                            structurally.
 *   8. `hq_rejected_worker`: CommCare HQ would not complete one of the
 *                            writes. The accounts before it are real and
 *                            are in `workers`, passwords included. This
 *                            one is NOT always a proven non-event: an
 *                            UPDATE that broke off mid-flight lands here
 *                            too, and its `message` says whether the
 *                            change may have taken. Relay the message
 *                            rather than reading the tag as "nothing
 *                            changed".
 *   9. `hq_worker_may_exist`: CommCare HQ broke off mid-create and said
 *                            nothing about what it made. The username may
 *                            or may not be an account now;
 *                            `unconfirmed_workers` carries it with its
 *                            password. Tell the user to look for that
 *                            username on the project space. If it is not
 *                            there, call again to make it. If it IS,
 *                            calling again straight away still tries to
 *                            create and comes back as
 *                            `hq_rejected_worker` saying the name is
 *                            taken — CommCare HQ's username search runs on
 *                            an index that trails its own new account by
 *                            seconds, so `hq_worker_conflict` and the
 *                            adoption path only become available once that
 *                            catches up. Wait a moment before retrying,
 *                            and never send `adopt_personas` for an
 *                            account no `worker_conflicts` entry names.
 *  10. `not_found` with `workers`: the app was deleted, or the caller can
 *                            no longer make its workers, after this call
 *                            made some accounts. Those accounts are real
 *                            and in `workers`, passwords included; the
 *                            message says the app was deleted where the
 *                            caller may still edit it.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	MAX_WORKER_LEVELS_PER_PROVISION_CALL,
	organizationLevelCodeSchema,
	provisionWorkersSchema,
} from "@/lib/deployment/types";
import type {
	WorkerConflict,
	WorkerLevelToConfirm,
} from "@/lib/deployment/workerProvisionPlan";
import type {
	ProvisionedWorker,
	UnconfirmedWorker,
	WorkerRefusalCode,
} from "@/lib/deployment/workers";
import { provisionWorkers } from "@/lib/deployment/workers";
import { readPlaceOverview } from "@/lib/organization/pages";
import {
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { loadAppBlueprint } from "../loadApp";
import { registerScopedTool } from "../scopedTool";
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
	worker_levels_unconfirmed: "worker_levels_unconfirmed",
	hq_worker_conflict: "hq_worker_conflict",
	hq_rejected_worker: "hq_rejected_worker",
	hq_worker_may_exist: "hq_worker_may_exist",
	/* The access-failure bucket every tool answers a deleted or unreachable
	 * app with, carrying the accounts made before it. */
	app_not_available: "not_found",
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

/**
 * One account CommCare HQ neither confirmed nor ruled out.
 *
 * Shaped deliberately unlike `describeWorker`: there is no `hq_user_id`
 * and no `action`, because neither is known. What it does carry is the
 * password, which is the entire reason it is on the wire.
 */
function describeUnconfirmed(worker: UnconfirmedWorker) {
	return {
		persona_uuid: worker.personaUuid,
		persona_name: worker.personaName,
		username: worker.username,
		password: worker.password,
	};
}

function describeLevel(level: WorkerLevelToConfirm) {
	return {
		code: level.code,
		name: level.name,
		persona_names: level.personaNames,
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
	registerScopedTool(
		server,
		ctx,
		"provision_workers",
		{
			description:
				"Create CommCare HQ mobile-worker accounts for this app's personas on a project space, or bring existing ones into step with what the app says. The app must already be published there. Each account this call creates comes back with a `password` that exists only in this answer — show every one of them to the user immediately, including when the call also reports an error, because Nova stores none of them and cannot show them again. Omit a worker's `username` to take Nova's suggestion from the persona's name. If a username already belongs to an account Nova didn't create, the call refuses with `hq_worker_conflict` and names each one; ask the user about that exact account and only then send its persona in `adopt_personas`. If CommCare HQ breaks off mid-create, the call refuses with `hq_worker_may_exist` and puts that account's password in `unconfirmed_workers`: show it to the user immediately, because the account may be real and that password is the only one it will ever have, and tell them to look for that username on the project space rather than saying it was not created. Taking an account over changes only the worker information and the places its persona names. Where CommCare HQ manages the app's places in that project space, its level API doesn't say which levels take workers, so the call refuses with `worker_levels_unconfirmed` and names each level in `worker_levels`; ask the user whether places at each level take workers there (CommCare HQ's Organization Levels page shows it), and only then send the codes they confirm in `confirm_worker_levels`. Nova never deletes or retires a worker, because CommCare HQ's own delete soft-deletes every case that worker owns.",
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
				confirm_worker_levels: z
					.array(organizationLevelCodeSchema)
					.max(MAX_WORKER_LEVELS_PER_PROVISION_CALL)
					.optional()
					.describe(
						"Codes of the organization levels the user confirmed take workers in this project space, as a `worker_levels_unconfirmed` refusal's `worker_levels` names them. Send only after the user said yes for each level; Nova records it for the deployment until someone withdraws it. Omit to confirm nothing.",
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
				};
				/* The places, so a refusal can name the one a persona stands
				 * in rather than making somebody look up a uuid. */
				const organization = await readPlaceOverview({
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
					...(args.confirm_worker_levels && {
						confirmWorkerLevels: args.confirm_worker_levels,
					}),
				});

				/* The workers travel on BOTH shapes. A refusal that arrived
				 * after three accounts were made carries three passwords that
				 * exist nowhere else, and an envelope that dropped them to
				 * report the fourth would lose them for good. */
				const workers = outcome.workers.map(describeWorker);
				const unconfirmed = outcome.unconfirmed.map(describeUnconfirmed);
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
									...(unconfirmed.length > 0 && {
										unconfirmed_workers: unconfirmed,
									}),
									...(refusal.conflicts.length > 0 && {
										worker_conflicts: refusal.conflicts.map(describeConflict),
									}),
									...(refusal.levels.length > 0 && {
										worker_levels: refusal.levels.map(describeLevel),
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
