import "server-only";

/**
 * The one mobile-worker provisioning lifecycle.
 *
 * The browser's Workers panel and MCP's `provision_workers` both come
 * through here, for the same reason both publishes come through
 * `publishAppToHq`: a second path would be a second lifecycle, and the
 * two would drift on the first fix.
 *
 * It is deliberately NOT a publish rung. Making somebody an account is
 * not a thing a publish should do on the way past — it hands out a
 * credential, it is aimed at named people, and it is worth pressing a
 * button for. So it has no phase, folds no state, and leaves the
 * deployment's rungs exactly where it found them; the only durable thing
 * it writes is the ownership ledger, which is the record of what is on
 * the project space.
 *
 * Three refusals it makes before touching CommCare HQ are worth naming
 * here, because each one is a thing CommCare HQ would take without
 * complaining and then not do:
 *
 *   * a persona missing required worker information — CommCare HQ's own
 *     save refuses it, but only sometimes reports it;
 *   * a persona standing in a place this project space does not hold —
 *     `CommCareUserResource.obj_create` calls `_update` and DISCARDS the
 *     errors, so the account is made and the assignment silently is not;
 *   * a username Nova cannot account for — the account already belongs to
 *     somebody, and a name is never evidence of ownership.
 */

import type { CommCareCredentials } from "@/lib/commcare/client";
import type {
	HqMobileWorkerRefusal,
	HqMobileWorkerUpdate,
} from "@/lib/commcare/hq/workers";
import {
	createHqMobileWorker,
	findHqMobileWorkers,
	updateHqMobileWorker,
} from "@/lib/commcare/hq/workers";
import type { CommCareServer } from "@/lib/commcare/servers";
import { COMMCARE_SERVERS } from "@/lib/commcare/servers";
import { getCredentialsForUpload } from "@/lib/db/settings";
import type { BlueprintDoc } from "@/lib/domain";
import { organizationLevelsOf, personasOf } from "@/lib/domain";
import { log } from "@/lib/logger";
import type { StoredLocation } from "@/lib/organization/types";
import { activeRemoteApp } from "./resources";
import {
	type DeploymentScope,
	type DeploymentTargetKey,
	type RecordRemoteResourceInput,
	readDeployment,
	recordPushedResources,
} from "./store";
import type { DeploymentWithResources } from "./types";
import { generateWorkerPassword } from "./workerCredentials";
import type {
	PlannedWorkerPush,
	WorkerConflict,
	WorkerProvisionProblem,
} from "./workerProvisionPlan";
import {
	completeWorkerUsername,
	defaultWorkerUsername,
	plannedWorkersFor,
	planWorkerProvisioning,
	requiredWorkerDataGaps,
	workerProvisionProblems,
} from "./workerProvisionPlan";

/** Why a provisioning call stopped. */
export const WORKER_REFUSAL_CODES = [
	/** No CommCare HQ connection, or the stored key no longer works. */
	"hq_not_connected",
	/** The key cannot reach the project space this call names. */
	"domain_not_authorized",
	/**
	 * The app is not on this project space yet. A worker account exists to
	 * run an app; making one where the app is not is making an account for
	 * nothing, and the places the persona stands in are not there either.
	 */
	"app_not_published",
	/**
	 * CommCare HQ would not say which of these usernames it already holds,
	 * so Nova stopped rather than write over an account it cannot account
	 * for.
	 */
	"hq_worker_state_unknown",
	/** Something about the app or the request makes these workers unmakeable. */
	"workers_not_provisionable",
	/**
	 * One of the usernames belongs to an account Nova did not create. Nova
	 * never takes one over on its own.
	 */
	"hq_worker_conflict",
	/** CommCare HQ refused to make or change one of the accounts. */
	"hq_rejected_worker",
] as const;
export type WorkerRefusalCode = (typeof WORKER_REFUSAL_CODES)[number];

export interface WorkerProvisionRefusal {
	readonly code: WorkerRefusalCode;
	/** What happened and what to do about it, in one sentence. */
	readonly message: string;
	/** The specific things, when there are specific things. */
	readonly details: readonly string[];
	/**
	 * The exact accounts a person may name back through `adoptPersonaUuids`
	 * to take over. Empty unless the refusal WAS a name clash.
	 */
	readonly conflicts: readonly WorkerConflict[];
}

/** One account that now exists, as the caller needs to see it once. */
export interface ProvisionedWorker {
	readonly personaUuid: string;
	readonly personaName: string;
	/** The complete username the worker signs in with. */
	readonly username: string;
	/** CommCare HQ's `user_id`. */
	readonly userId: string;
	/** Whether this call made the account, as opposed to updating one. */
	readonly created: boolean;
	/** Whether Nova took over an account somebody else made. */
	readonly adopted: boolean;
	/**
	 * The password, for a newly made account, and `null` for every other
	 * outcome.
	 *
	 * This is the ONLY copy. Nova stores it nowhere and cannot show it
	 * again; an account whose password is lost is reset on CommCare HQ.
	 * Everything that handles this value has to keep it out of logs — see
	 * `workerCredentials.ts`.
	 */
	readonly password: string | null;
}

export interface ProvisionWorkersInput {
	readonly scope: DeploymentScope;
	readonly doc: BlueprintDoc;
	readonly server: CommCareServer;
	readonly domain: string;
	/**
	 * The app's places, so a refusal can name the place a persona stands in
	 * rather than its id. Places live outside the blueprint, which is why
	 * they arrive beside it.
	 */
	readonly locations: readonly StoredLocation[];
	/**
	 * Who to provision, and under what name. An absent username takes
	 * `defaultWorkerUsername(persona.name)`, which is a suggestion the
	 * surfaces fill their box with rather than something decided here.
	 */
	readonly workers: readonly {
		readonly personaUuid: string;
		readonly username?: string;
	}[];
	/**
	 * The personas whose username clash the caller has explicitly resolved
	 * by taking the existing account over. Absent means adopt nothing.
	 */
	readonly adoptPersonaUuids?: readonly string[];
	/** Called after each account lands, for a caller that reports progress. */
	readonly onWorkerProvisioned?: (done: number, total: number) => void;
}

/**
 * What one provisioning call amounted to.
 *
 * `refusal === null` means every worker asked for is now on the project
 * space. Otherwise `workers` is what landed BEFORE it stopped, and those
 * accounts are real: their passwords are in this answer and nowhere else,
 * so a caller must show them even while it shows the refusal.
 */
export interface ProvisionWorkersOutcome {
	readonly refusal: WorkerProvisionRefusal | null;
	readonly workers: readonly ProvisionedWorker[];
	/**
	 * The record as it stands now. Null when nothing was written, and also
	 * when the write itself failed — the accounts and their passwords are
	 * never held back for it.
	 */
	readonly deployment: DeploymentWithResources | null;
}

export async function provisionWorkers(
	input: ProvisionWorkersInput,
): Promise<ProvisionWorkersOutcome> {
	const target: DeploymentTargetKey = {
		server: input.server,
		domain: input.domain,
	};

	const resolved = await resolveCredentials(input);
	if ("code" in resolved) return refused(resolved);
	const { creds, domain } = resolved;

	/* The app has to be there first. Its places are what a persona's
	 * assignment points at, and an account that can sign in to an app the
	 * project space does not hold is an account with nothing to do. */
	const deployment = await readDeployment(input.scope, target);
	if (deployment === null || activeRemoteApp(deployment) === null) {
		return refused({
			code: "app_not_published",
			message: `“${domain}” doesn't have this app yet, so there's nothing for a worker to sign in to. Publish it there first, then come back.`,
			details: [],
		});
	}

	/* A persona this app no longer has is not a worker Nova can decide
	 * anything about: there is no name, no user data, and no assignment to
	 * send. Dropping it quietly would answer a call for three accounts
	 * with two and say nothing about the third. */
	const personas = personasOf(input.doc);
	const unknown = input.workers
		.map((worker) => worker.personaUuid)
		.filter((personaUuid) => personas[personaUuid] === undefined);
	if (unknown.length > 0) {
		return refused({
			code: "workers_not_provisionable",
			message: `${unknown.length === 1 ? "One of these personas isn't" : "Some of these personas aren't"} in this app any more, so there's nobody to make an account for. Ask for the app's personas again and provision from that list.`,
			details: unknown,
		});
	}

	const requested = input.workers.map((worker) => ({
		personaUuid: worker.personaUuid,
		username:
			worker.username ??
			defaultWorkerUsername(personas[worker.personaUuid]?.name ?? ""),
	}));
	const workers = plannedWorkersFor(input.doc, requested);

	const planInput = {
		workers,
		mappings: deployment.active,
		workerDataGaps: requiredWorkerDataGaps(input.doc),
		domain,
	} as const;

	/* Before the search, not after it. A username reaches CommCare HQ as
	 * part of an Elasticsearch `query_string`, and asking about a name Nova
	 * would refuse to write anyway trades a round trip for the wrong
	 * refusal: the project space would look unable to answer when the name
	 * was the problem all along. */
	const problems = workerProvisionProblems(planInput);
	if (problems.length > 0) {
		return refused(unprovisionable(problems, domain, input.locations));
	}

	const found = await findHqMobileWorkers(
		creds,
		domain,
		workers.map((worker) => completeWorkerUsername(worker.username, domain)),
	);
	if ("success" in found) {
		return refused({
			code: "hq_worker_state_unknown",
			message: `CommCare HQ wouldn't say which of these usernames “${domain}” already has, so Nova stopped rather than write over somebody's account. Try again in a moment.`,
			details: [],
		});
	}

	const plan = planWorkerProvisioning({
		...planInput,
		hqWorkers: found,
		adoptPersonaUuids: input.adoptPersonaUuids ?? [],
	});
	if (!plan.ok) {
		return plan.reason === "conflict"
			? refused(
					{
						code: "hq_worker_conflict",
						message: `“${domain}” already has an account under ${plan.conflicts.length === 1 ? "this username" : "these usernames"}, and Nova didn't create ${plan.conflicts.length === 1 ? "it" : "them"}. Name the personas to take over, or pick different usernames.`,
						details: plan.conflicts.map(
							(conflict) => `${conflict.personaName}: ${conflict.username}`,
						),
					},
					plan.conflicts,
				)
			: refused(unprovisionable(plan.problems, domain, input.locations));
	}

	/* Nova only speaks about a worker's places when the app HAS places to
	 * speak about. An app with no organization has no opinion on where
	 * anybody stands, and an adopted account may well be assigned by hand
	 * on CommCare HQ — sending an empty list would clear that
	 * (`api/user_updates.py::CommcareUserUpdates._update_location` →
	 * `::_remove_all_locations`) on the strength of Nova having nothing to
	 * say. */
	const speaksAboutPlaces =
		Object.keys(organizationLevelsOf(input.doc)).length > 0;

	const provisioned: ProvisionedWorker[] = [];
	const landed: RecordRemoteResourceInput[] = [];
	const stopped = async (
		refusal: WorkerProvisionRefusal,
	): Promise<ProvisionWorkersOutcome> => ({
		refusal,
		workers: provisioned,
		deployment: await recordLanded(input, target, landed),
	});

	for (const push of plan.pushes) {
		const written = await writeWorker(creds, domain, push, speaksAboutPlaces);
		/* Recorded FIRST, and independently of the refusal. A create whose
		 * follow-up assignment is refused answers with both: the account is
		 * real, its password is in this answer and nowhere else, and a
		 * refusal that returned before this would throw away the only copy
		 * and leave an account nothing in Nova points at. */
		if (written.landed !== null) {
			landed.push({
				kind: "worker",
				novaResourceId: push.personaUuid,
				remoteId: written.landed.userId,
				ownership: push.ownership,
				pushedIdentity: push.completeUsername,
				adoptedBy:
					push.ownership === "adopted" ? input.scope.actorUserId : null,
				/* A persona's account carries no version of anything: the
				 * blueprint sequence would say nothing about whether the
				 * account over there is current, because a persona's own
				 * values are only part of what an account holds. */
				pushedRevision: null,
				remoteRevision: null,
			});
			provisioned.push({
				personaUuid: push.personaUuid,
				personaName: push.personaName,
				username: push.completeUsername,
				userId: written.landed.userId,
				created: push.remoteId === null,
				adopted: push.ownership === "adopted",
				password: written.landed.password,
			});
			input.onWorkerProvisioned?.(provisioned.length, plan.pushes.length);
		}
		if (written.refusal !== null) {
			return stopped({
				code: "hq_rejected_worker",
				message: written.refusal.message,
				details: written.refusal.details,
				conflicts: [],
			});
		}
	}

	log.info("[deployment] workers provisioned", {
		domain,
		appId: input.scope.appId,
		created: provisioned.filter((worker) => worker.created).length,
		updated: provisioned.filter((worker) => !worker.created).length,
	});
	return {
		refusal: null,
		workers: provisioned,
		deployment: await recordLanded(input, target, landed),
	};
}

/**
 * What writing one worker amounted to.
 *
 * Both halves can be filled at once, and that pairing is the whole reason
 * this is not a union. A create is two calls: the account, then the
 * places. When the second refuses, the account IS there and its password
 * exists only in this answer — so the refusal travels beside the landing
 * rather than instead of it.
 */
interface WorkerWriteResult {
	/** The account, when CommCare HQ made or already held one. */
	readonly landed: {
		readonly userId: string;
		/** Only ever set on a create; an update never resets a password. */
		readonly password: string | null;
	} | null;
	readonly refusal: {
		readonly message: string;
		readonly details: readonly string[];
	} | null;
}

/**
 * Write one worker, in the one or two calls CommCare HQ needs.
 *
 * A create sends everything EXCEPT the places, and then sends the places
 * on their own. That is not caution, it is the only way to find out
 * whether the assignment landed:
 * `api/resources/v0_5.py::CommCareUserResource.obj_create` calls `_update`
 * and throws away the errors it returns, so a create whose location ids
 * do not resolve answers 201 with the worker standing nowhere and says
 * nothing about it. `::obj_update` gathers the same errors into one 400.
 * So the account is made first, then told where it stands by a call that
 * can refuse.
 *
 * An update is one call, because it already reports everything.
 */
async function writeWorker(
	creds: CommCareCredentials,
	domain: string,
	push: PlannedWorkerPush,
	speaksAboutPlaces: boolean,
): Promise<WorkerWriteResult> {
	const places: HqMobileWorkerUpdate["locations"] = !speaksAboutPlaces
		? undefined
		: push.locationIds.length === 0
			? null
			: {
					primaryLocationId: push.locationIds[0] as string,
					locationIds: push.locationIds,
				};

	if (push.remoteId === null) {
		const password = generateWorkerPassword();
		/* The user data rides along with the create, which the places
		 * cannot. `::obj_create` runs `validate_profile_id` on it BEFORE
		 * `CommCareUser.create`, outside the branch that swallows `_update`'s
		 * errors, so a project space that requires a profile refuses the
		 * whole create and says so. Nothing else in this payload can fail
		 * quietly: `UserData.__setitem__` raises only for the
		 * system-provided `commcare_profile` key, and Nova's own slug rules
		 * forbid a `commcare`-prefixed property. */
		const created = await createHqMobileWorker(creds, domain, {
			username: push.username,
			password,
			userData: push.userData,
		});
		if ("success" in created) {
			return {
				landed: null,
				refusal: rejection(created, domain, push, "make"),
			};
		}
		const account = { userId: created.userId, password };
		if (places === undefined || places === null) {
			return { landed: account, refusal: null };
		}
		const assigned = await updateHqMobileWorker(creds, domain, created.userId, {
			locations: places,
		});
		if ("success" in assigned) {
			/* The account IS there — this is the assignment refusing, not the
			 * create. Saying so is the whole point of the second call, and
			 * the landing travels with it: the password in this answer is the
			 * only copy, and a refusal that dropped it would leave an account
			 * nobody can sign in to and nothing in Nova points at. */
			return {
				landed: account,
				refusal: {
					message: `Nova made the account for “${push.personaName}” on “${domain}”, but CommCare HQ wouldn't put them in the places their persona names. The account works; the assignment didn't happen.`,
					details: assigned.message === "" ? [] : [assigned.message],
				},
			};
		}
		return { landed: account, refusal: null };
	}

	const updated = await updateHqMobileWorker(creds, domain, push.remoteId, {
		userData: push.userData,
		...(places === undefined ? {} : { locations: places }),
	});
	if ("success" in updated) {
		/* An update refusing says nothing about the account: it was already
		 * there, under a mapping Nova already holds. */
		return {
			landed: null,
			refusal: rejection(updated, domain, push, "update"),
		};
	}
	return { landed: { userId: push.remoteId, password: null }, refusal: null };
}

/**
 * CommCare HQ's refusal, in Nova's voice, with its own sentence kept.
 *
 * Its wording is more specific than anything Nova could say about a rule
 * it did not predict — a name already taken or reserved, a profile the
 * project space requires, a password its own strength rule rejects — so
 * it travels verbatim rather than summarized.
 */
function rejection(
	error: HqMobileWorkerRefusal,
	domain: string,
	push: PlannedWorkerPush,
	verb: "make" | "update",
): NonNullable<WorkerWriteResult["refusal"]> {
	const permissions = error.status === 401 || error.status === 403;
	return {
		message: permissions
			? `CommCare HQ wouldn't let Nova ${verb} the account for “${push.personaName}” on “${domain}”. Creating mobile workers needs the Edit Mobile Workers permission on your CommCare HQ account.`
			: `CommCare HQ wouldn't ${verb} the account for “${push.personaName}” on “${domain}”, so Nova stopped there. Any workers before this one are on the project space.`,
		details: error.message === "" ? [] : [error.message],
	};
}

/**
 * Write what landed, and reconcile the ledger against the personas the
 * app still has.
 *
 * The reconciliation is keyed on the DOCUMENT rather than on this call:
 * naming three personas says nothing about the other twelve, but a
 * persona that no longer exists has an account sitting on the project
 * space that nothing in Nova points at. Superseding that mapping is what
 * makes the left-behind report name it. Nova retires nobody — CommCare
 * HQ's own DELETE soft-deletes every case that worker owns — so the
 * account stays exactly where it is and starts being reported instead of
 * claimed.
 *
 * It runs on the refusal path too, and with nothing landed. Both are
 * deliberate: a create whose place assignment was refused still made an
 * account, and the reconciliation answers a question about the DOCUMENT
 * that this call's outcome has no bearing on.
 *
 * It also NEVER throws, which matters more than what it writes. By the
 * time it runs, accounts exist on CommCare HQ and their passwords are
 * held in one place: the answer this call is assembling. A rejected
 * promise here would take that answer with it and leave real accounts
 * nobody can sign in to. Losing the ledger row is bad — the next call
 * meets Nova's own account as a stranger's and stops to ask — and losing
 * the passwords is unrecoverable, so the write is allowed to fail loudly
 * and the answer goes out regardless.
 */
async function recordLanded(
	input: ProvisionWorkersInput,
	target: DeploymentTargetKey,
	landed: readonly RecordRemoteResourceInput[],
): Promise<DeploymentWithResources | null> {
	try {
		return await recordPushedResources(input.scope, target, landed, {
			status: "reconciled",
			kind: "worker",
			stillUsed: Object.keys(personasOf(input.doc)),
		});
	} catch (error) {
		log.error("[deployment] worker mappings could not be recorded", error, {
			domain: input.domain,
			appId: input.scope.appId,
			workers: landed.length,
		});
		return null;
	}
}

/** The stored key, or the refusal that stands in for it. */
async function resolveCredentials(input: ProvisionWorkersInput): Promise<
	| { readonly creds: CommCareCredentials; readonly domain: string }
	| {
			readonly code: WorkerRefusalCode;
			readonly message: string;
			readonly details: readonly string[];
	  }
> {
	const result = await getCredentialsForUpload(
		input.scope.actorUserId,
		input.domain,
	);
	if (!result.ok) {
		return result.error === "not_configured"
			? {
					code: "hq_not_connected",
					message:
						"CommCare HQ isn't connected yet. Add your API key in Settings, picking the server your account lives on.",
					details: [],
				}
			: {
					code: "domain_not_authorized",
					message: `Your API key can't reach the project space “${input.domain}”. Pick one it does reach, or ask a CommCare HQ administrator to add you to that space.`,
					details: result.available.map((space) => space.name),
				};
	}
	/* The same guard the publish path keeps: the stored key can change
	 * between the read that chose this target's server and this one, and a
	 * worker made on the wrong CommCare installation is a real account on
	 * a project space nobody meant. */
	if (result.creds.server !== input.server) {
		return {
			code: "hq_not_connected",
			message: `This deployment is on the ${COMMCARE_SERVERS[input.server].label} CommCare server, and your API key is on ${COMMCARE_SERVERS[result.creds.server].label}. Those are separate installations with separate accounts, so your key cannot see it. Add a key for ${COMMCARE_SERVERS[input.server].label} in Settings.`,
			details: [],
		};
	}
	return { creds: result.creds, domain: result.domain.name };
}

/**
 * One unprovisionable persona, in the words a person can act on.
 *
 * Total over the problem union with no default arm, so a problem kind
 * added later fails to compile rather than reaching somebody as a blank
 * line in a refusal.
 */
function describeProblem(
	problem: WorkerProvisionProblem,
	places: ReadonlyMap<string, string>,
): string {
	switch (problem.kind) {
		case "username":
			return `${problem.personaName}: ${describeUsernameProblem(problem)}`;
		case "username-repeated":
			return `${problem.personaName}: “${problem.username}” is already asked for by another persona in this batch. One account belongs to one persona.`;
		case "persona-repeated":
			return `${problem.personaName} is named twice here. One account belongs to one persona, so ask for them once.`;
		case "missing-worker-data":
			return `${problem.personaName}: no value for ${problem.missing.join(", ")}. CommCare HQ won't save a worker without the information marked required.`;
		case "place-not-pushed":
			return `${problem.personaName}: stands in ${places.get(problem.locationUuid) ?? "a place this app no longer has"}, which isn't on this project space yet. Publish the app there first.`;
	}
}

function describeUsernameProblem(
	problem: Extract<WorkerProvisionProblem, { kind: "username" }>,
): string {
	switch (problem.problem) {
		case "empty":
			return "needs a username. Nova couldn't make one out of the persona's name, so type the one this worker will sign in with.";
		case "reserved":
			return `“${problem.username}” is a name CommCare keeps for itself. Pick another one.`;
		case "characters":
			return `“${problem.username}” can hold lowercase letters, numbers, and . _ or -, and a dot has to sit between two of them.`;
		case "too-long":
			return `“${problem.username}” is longer than the ${problem.maxLength} characters this project space allows.`;
	}
}

/**
 * The one refusal for everything Nova will not ask CommCare HQ about.
 *
 * All or nothing, deliberately: the accounts in one call belong to one
 * team, and making four of five would leave somebody to work out which
 * one is missing from a list of five names. Every problem is named so the
 * next attempt is the last one.
 */
function unprovisionable(
	problems: readonly WorkerProvisionProblem[],
	domain: string,
	locations: readonly StoredLocation[],
): {
	readonly code: WorkerRefusalCode;
	readonly message: string;
	readonly details: readonly string[];
} {
	return {
		code: "workers_not_provisionable",
		message: `Nova can't make ${problems.length === 1 ? "one of these workers" : "these workers"} on “${domain}” yet, so it hasn't made any of them.`,
		details: problems.map((problem) =>
			describeProblem(problem, placeNames(locations)),
		),
	};
}

/** Every place's current name, for the one refusal that names one. */
function placeNames(
	locations: readonly StoredLocation[],
): ReadonlyMap<string, string> {
	return new Map(locations.map((place) => [place.id, `“${place.name}”`]));
}

function refused(
	refusal: {
		readonly code: WorkerRefusalCode;
		readonly message: string;
		readonly details: readonly string[];
	},
	conflicts: readonly WorkerConflict[] = [],
): ProvisionWorkersOutcome {
	return {
		refusal: { ...refusal, conflicts },
		workers: [],
		deployment: null,
	};
}
