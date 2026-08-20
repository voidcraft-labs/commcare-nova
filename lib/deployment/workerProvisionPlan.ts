/**
 * Which mobile workers Nova may make on a project space, under what
 * names, and under what claim.
 *
 * This is the third planner beside `lookupResourcePlan` and
 * `locationResourcePlan`, and it follows their rule for the same reason:
 * a NAME is never evidence of ownership. `users/util.py::is_username_available`
 * asks `dbaccessors.py::user_exists` for the COMPLETE username, which keys
 * the `users/by_username` view on `<name>@<domain>.commcarehq.org`
 * (`util.py::format_username` + `::cc_user_domain`) — so the namespace is one
 * project space, not CommCare HQ, and the same persona name is free to exist
 * on every other space. Within this one, a name already taken belongs to
 * somebody until a person says otherwise. `user_exists` also queries
 * `deleted_users_by_username`, so a RETIRED account still holds its name and
 * no one can ever take it back.
 *
 * Two things make workers stricter than the other two kinds.
 *
 *   * **A worker Nova already owns is always UPDATED, never remade.**
 *     A table or a place that has vanished from the target is simply
 *     recreated, because remaking one costs nothing. Remaking a worker
 *     does: `users/models.py::CommCareUser.retire` is a soft delete that
 *     leaves the Couch document and its username behind, so an account
 *     somebody deliberately retired would either refuse the new one or
 *     quietly hand a second account to a person who is meant to be gone.
 *     So the plan updates by the `user_id` the ledger holds and lets
 *     CommCare HQ say what it thinks, rather than guessing.
 *   * **Everything knowable is decided before the first account exists.**
 *     `api/resources/v0_5.py::CommCareUserResource.obj_create` calls
 *     `_update` and DISCARDS the errors it returns, so a create with an
 *     unusable location assignment answers 201 and silently drops it.
 *     A refusal a person can act on has to come from here.
 *
 * Everything in this module is pure, and none of it ever sees a password.
 * A credential is generated at the moment of the write, handed back once,
 * and stored nowhere — a planner that held one would be a planner whose
 * result could be logged.
 */

import type { BlueprintDoc } from "@/lib/domain";
/* Type-only, so the client-safe plan module never executes the
 * server-only worker driver. */
import type { ProvisionedWorker, WorkerProvisionRefusal } from "./workers";

export type { ProvisionedWorker, WorkerProvisionRefusal } from "./workers";

import {
	assignedLocationUuids,
	ownRecordValue,
	personasOf,
	personaUserData,
	userPropertiesOf,
	userPropertySlugsByUuid,
} from "@/lib/domain";
import type { DeploymentResource, DeploymentResourceOwnership } from "./types";

// ── Usernames ────────────────────────────────────────────────────────

/**
 * The two names CommCare reserves for itself
 * (`users/forms.py::UNALLOWED_MOBILE_WORKER_NAMES`, and the same pair
 * again in `users/util.py::is_username_available`).
 */
const RESERVED_USERNAMES: ReadonlySet<string> = new Set(["admin", "demo_user"]);

/**
 * What CommCare HQ appends to a bare name
 * (`users/util.py::cc_user_domain`, over `settings.HQ_ACCOUNT_ROOT`).
 */
const HQ_ACCOUNT_ROOT = "commcarehq.org";

/**
 * The complete username CommCare HQ will store, from the bare name a
 * person typed.
 *
 * `users/util.py::format_username` builds exactly this and lowercases it,
 * so Nova computes it rather than waiting to be told: the ledger keys a
 * worker on the complete name, and a name that only matched after
 * CommCare HQ folded its case would look like a different worker on the
 * next call.
 */
export function completeWorkerUsername(
	username: string,
	domain: string,
): string {
	return `${username}@${domain}.${HQ_ACCOUNT_ROOT}`.toLowerCase();
}

/**
 * How long a bare name may be on this project space.
 *
 * `users/forms.py::get_mobile_worker_max_username_length` — the Django
 * `auth_user.username` column holds 128 characters and the project
 * space's own suffix eats into that, with 80 as the ceiling regardless.
 * CommCare HQ applies it on its own forms and its SMS path but NOT on the
 * REST resource, where an over-long name reaches the column instead and
 * fails as a database error nobody can read. Nova applies the same rule
 * so the refusal is a sentence rather than a 500.
 */
export function maxWorkerUsernameLength(domain: string): number {
	return Math.min(128 - `${domain}.${HQ_ACCOUNT_ROOT}`.length - 1, 80);
}

/**
 * Bare names Nova will send.
 *
 * Deliberately narrower than what CommCare HQ would take. Its own
 * `users/validation.py::BAD_MOBILE_USERNAME_REGEX` is
 * `[^A-Za-z0-9.+-_]`, whose `+-_` is an unescaped RANGE — it admits `@`,
 * `[`, `\`, and a dozen other characters by accident rather than by
 * intent. Building on that would make Nova depend on a bug. What is left
 * is the intersection of what CommCare HQ means and what Django's
 * `validate_email` accepts on the whole address, which is where the dot
 * rules come from: no leading dot, no trailing dot, no two in a row.
 */
const USERNAME_PATTERN = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;

/** Why a bare name cannot be used, or `null` when it can. */
export type WorkerUsernameProblem =
	| "empty"
	| "characters"
	| "reserved"
	| "too-long";

export function workerUsernameProblem(
	username: string,
	domain: string,
): WorkerUsernameProblem | null {
	if (username === "") return "empty";
	if (RESERVED_USERNAMES.has(username)) return "reserved";
	if (!USERNAME_PATTERN.test(username)) return "characters";
	if (username.length > maxWorkerUsernameLength(domain)) return "too-long";
	return null;
}

/**
 * The bare name Nova offers for a persona, before anybody edits it.
 *
 * A suggestion and never a decision: the username is what a person signs
 * in with, so the call that provisions always carries the exact name, and
 * this only fills the box in. Empty when the persona's name has nothing
 * usable in it at all — a name written entirely in a script this charset
 * cannot carry — which is the case that has to be typed rather than
 * guessed at.
 */
export function defaultWorkerUsername(personaName: string): string {
	const collapsed = personaName
		.toLowerCase()
		.replace(/\s+/g, ".")
		.replace(/[^a-z0-9._-]/g, "")
		.replace(/\.{2,}/g, ".")
		.replace(/^[.]+|[.]+$/g, "");
	return collapsed;
}

// ── Required worker information ──────────────────────────────────────

/**
 * The required worker information each persona still has no value for,
 * by persona uuid.
 *
 * `custom_data_fields/models.py::CustomDataFieldsDefinition.get_validator`
 * refuses a save that leaves a required field empty, so this is a real
 * prerequisite for creating an account rather than a preference. It is
 * ATTENTION on a publish and BLOCKING here, and both readings come from
 * this one function: an app publishes perfectly well with a gap, because
 * publishing creates no workers, and the moment somebody asks for a
 * worker the same gap is what CommCare HQ will refuse.
 *
 * The value checked is the EFFECTIVE one — `personaUserData`, the user
 * type's defaults with the persona's own layered over — because that is
 * the value the account is created with. Reading the persona's own bag
 * first and falling back to the role would disagree with it in exactly
 * the case authors use deliberately: a blank persona value is an
 * OVERRIDE, meaning "not this role's default, nothing", and CommCare HQ
 * refuses a required field that arrives empty however it got that way.
 */
export function requiredWorkerDataGaps(
	doc: BlueprintDoc,
): ReadonlyMap<string, readonly string[]> {
	const gaps = new Map<string, readonly string[]>();
	const properties = Object.values(userPropertiesOf(doc)).filter(
		(property) => property.required === true,
	);
	if (properties.length === 0) return gaps;
	for (const persona of Object.values(personasOf(doc))) {
		const values = personaUserData(persona, doc);
		const missing = properties
			.filter((property) => {
				const value = ownRecordValue(values, property.uuid);
				return value === undefined || value.trim() === "";
			})
			.map((property) => property.label);
		if (missing.length > 0) gaps.set(persona.uuid, missing);
	}
	return gaps;
}

/**
 * The same gaps, as the lines a preflight check lists.
 *
 * One projection of one rule, so the sentence a publish shows and the
 * refusal a provisioning call gives can never disagree about which
 * persona is missing what.
 */
export function describeRequiredWorkerDataGaps(
	doc: BlueprintDoc,
): readonly string[] {
	const personas = personasOf(doc);
	const lines: string[] = [];
	for (const [personaUuid, missing] of requiredWorkerDataGaps(doc)) {
		const persona = ownRecordValue(personas, personaUuid);
		if (persona === undefined) continue;
		lines.push(`${persona.name}: ${missing.join(", ")}`);
	}
	return lines;
}

// ── The plan ─────────────────────────────────────────────────────────

/** One worker the project space already holds, as the search found it. */
export interface RemoteWorker {
	/** CommCare HQ's `user_id`. */
	readonly userId: string;
	/** The complete username. */
	readonly username: string;
}

/** One persona, projected into what CommCare HQ needs to hold it. */
export interface PlannedWorker {
	readonly personaUuid: string;
	readonly personaName: string;
	/** The bare name; CommCare HQ appends the project space's own suffix. */
	readonly username: string;
	/**
	 * Every user property the app declares, keyed by its current slug, with
	 * an empty value for one this persona has nothing to say about.
	 *
	 * Complete rather than only what is set, for the same reason a place
	 * sends its whole property bag: `users/user_data.py::UserData.update`
	 * touches exactly the keys it is handed, so a value cleared in Nova
	 * would sit on the account forever if the key were simply left out.
	 */
	readonly userData: Readonly<Record<string, string>>;
	/**
	 * The persona's places as Nova knows them, primary first. Empty when
	 * the persona stands nowhere, which is a real state rather than a gap.
	 */
	readonly locationUuids: readonly string[];
}

/** Something that makes a worker unmakeable, whoever owns what. */
export type WorkerProvisionProblem =
	| {
			readonly kind: "username";
			readonly personaUuid: string;
			readonly personaName: string;
			readonly username: string;
			readonly problem: WorkerUsernameProblem;
			/** The ceiling, for the one problem where a number helps. */
			readonly maxLength: number;
	  }
	| {
			/** Two personas in one call asking for the same account. */
			readonly kind: "username-repeated";
			readonly personaUuid: string;
			readonly personaName: string;
			readonly username: string;
	  }
	| {
			/**
			 * One persona named twice in one call. Provisioning would make
			 * two accounts for them and the ledger holds one mapping per
			 * persona, so the second would supersede the first and leave an
			 * account nothing points at.
			 */
			readonly kind: "persona-repeated";
			readonly personaUuid: string;
			readonly personaName: string;
	  }
	| {
			/** Required worker information the account cannot be saved without. */
			readonly kind: "missing-worker-data";
			readonly personaUuid: string;
			readonly personaName: string;
			readonly missing: readonly string[];
	  }
	| {
			/**
			 * The persona stands in a place this project space does not hold
			 * yet. Publishing the app puts the places there; until then the
			 * assignment has nothing to point at, and CommCare HQ would take
			 * the account and drop the assignment without saying so.
			 */
			readonly kind: "place-not-pushed";
			readonly personaUuid: string;
			readonly personaName: string;
			readonly locationUuid: string;
	  };

/** A username already in use by an account Nova cannot account for. */
export interface WorkerConflict {
	readonly personaUuid: string;
	readonly personaName: string;
	/** The complete username, as CommCare HQ shows it. */
	readonly username: string;
	/** CommCare HQ's id for the account already there. */
	readonly remoteId: string;
}

/** One worker's place in the call. */
export interface PlannedWorkerPush {
	readonly personaUuid: string;
	readonly personaName: string;
	/** The bare name, for a create. */
	readonly username: string;
	/** The complete name, which is what the ledger records. */
	readonly completeUsername: string;
	/**
	 * The account to update, or `null` to make one. This is the whole
	 * create-or-update switch, and it is decided here rather than at the
	 * write so that "Nova will make 3 accounts and update 1" can be said
	 * before anybody presses anything.
	 */
	readonly remoteId: string | null;
	readonly ownership: DeploymentResourceOwnership;
	readonly userData: Readonly<Record<string, string>>;
	/** CommCare HQ location ids, primary first. Empty means stands nowhere. */
	readonly locationIds: readonly string[];
}

export type WorkerProvisionPlan =
	| { readonly ok: true; readonly pushes: readonly PlannedWorkerPush[] }
	| {
			readonly ok: false;
			readonly reason: "unprovisionable";
			readonly problems: readonly WorkerProvisionProblem[];
	  }
	| {
			readonly ok: false;
			readonly reason: "conflict";
			readonly conflicts: readonly WorkerConflict[];
	  };

export interface PlanWorkerProvisioningInput {
	/** The personas this call names, already projected. */
	readonly workers: readonly PlannedWorker[];
	/** The deployment's live mappings — every kind; this filters its own. */
	readonly mappings: readonly DeploymentResource[];
	/** What the project space already holds under these names. */
	readonly hqWorkers: readonly RemoteWorker[];
	/** Required worker information still missing, by persona uuid. */
	readonly workerDataGaps: ReadonlyMap<string, readonly string[]>;
	/** The project space, which decides the suffix and the length ceiling. */
	readonly domain: string;
	/**
	 * The personas whose name clash the caller has explicitly resolved by
	 * taking the existing account over. Nothing is adopted that is not
	 * named here.
	 */
	readonly adoptPersonaUuids: readonly string[];
}

/**
 * Everything about this call that CommCare HQ must not be asked about.
 *
 * Separate from the plan because it has to run BEFORE the search: a
 * username goes into an Elasticsearch `query_string`
 * (`api/resources/v0_5.py::user_es_call`), and asking about a name Nova
 * would never write spends a round trip to answer a question with no
 * bearing on anything. It also makes the refusal the accurate one — the
 * name is the problem, not the project space's willingness to talk about
 * it.
 *
 * Every problem is collected rather than the first one returned. A person
 * fixing five names one refusal at a time is a person Nova wasted an
 * afternoon of.
 */
export function workerProvisionProblems(
	input: Pick<
		PlanWorkerProvisioningInput,
		"workers" | "mappings" | "workerDataGaps" | "domain"
	>,
): readonly WorkerProvisionProblem[] {
	const problems: WorkerProvisionProblem[] = [];
	const claimed = new Map<string, string>();
	const named = new Set<string>();
	const remoteIdByLocationUuid = new Map(
		input.mappings
			.filter((resource) => resource.kind === "location")
			.map((resource) => [resource.novaResourceId, resource.remoteId] as const),
	);

	for (const worker of input.workers) {
		if (named.has(worker.personaUuid)) {
			problems.push({
				kind: "persona-repeated",
				personaUuid: worker.personaUuid,
				personaName: worker.personaName,
			});
		}
		named.add(worker.personaUuid);

		const problem = workerUsernameProblem(worker.username, input.domain);
		if (problem !== null) {
			problems.push({
				kind: "username",
				personaUuid: worker.personaUuid,
				personaName: worker.personaName,
				username: worker.username,
				problem,
				maxLength: maxWorkerUsernameLength(input.domain),
			});
		} else if (claimed.has(worker.username)) {
			problems.push({
				kind: "username-repeated",
				personaUuid: worker.personaUuid,
				personaName: worker.personaName,
				username: worker.username,
			});
		} else {
			claimed.set(worker.username, worker.personaUuid);
		}

		const missing = input.workerDataGaps.get(worker.personaUuid);
		if (missing !== undefined && missing.length > 0) {
			problems.push({
				kind: "missing-worker-data",
				personaUuid: worker.personaUuid,
				personaName: worker.personaName,
				missing,
			});
		}

		for (const locationUuid of worker.locationUuids) {
			if (remoteIdByLocationUuid.has(locationUuid)) continue;
			problems.push({
				kind: "place-not-pushed",
				personaUuid: worker.personaUuid,
				personaName: worker.personaName,
				locationUuid,
			});
		}
	}
	return problems;
}

/**
 * Plan the call, or refuse it.
 *
 * Problems are reported before ownership, and ALL of them at once. An app
 * whose personas cannot be made into accounts has to change before any
 * question of who owns what matters, and answering an adoption prompt
 * only to meet a second refusal is two trips for one problem.
 *
 * The refusal is all-or-nothing for a different reason than the other two
 * planners': provisioning is a deliberate act somebody asked for by name,
 * so making three of the four accounts they asked for and refusing the
 * fourth would leave them working out which three.
 */
export function planWorkerProvisioning(
	input: PlanWorkerProvisioningInput,
): WorkerProvisionPlan {
	const remoteByUsername = new Map(
		input.hqWorkers.map((worker) => [worker.username, worker] as const),
	);
	const mappingByPersona = new Map(
		input.mappings
			.filter((resource) => resource.kind === "worker")
			.map((resource) => [resource.novaResourceId, resource] as const),
	);
	const remoteIdByLocationUuid = new Map(
		input.mappings
			.filter((resource) => resource.kind === "location")
			.map((resource) => [resource.novaResourceId, resource.remoteId] as const),
	);
	const adopting = new Set(input.adoptPersonaUuids);

	const problems = workerProvisionProblems(input);
	if (problems.length > 0)
		return { ok: false, reason: "unprovisionable", problems };

	const pushes: PlannedWorkerPush[] = [];
	const conflicts: WorkerConflict[] = [];

	for (const worker of input.workers) {
		const completeUsername = completeWorkerUsername(
			worker.username,
			input.domain,
		);
		const mapping = mappingByPersona.get(worker.personaUuid);
		const remote = remoteByUsername.get(completeUsername);
		const locationIds = worker.locationUuids.map(
			/* Proved present by the problem pass above; the map is total over
			 * every uuid that reached here. */
			(locationUuid) => remoteIdByLocationUuid.get(locationUuid) as string,
		);
		const shared = {
			personaUuid: worker.personaUuid,
			personaName: worker.personaName,
			username: worker.username,
			completeUsername,
			userData: worker.userData,
			locationIds,
		} as const;

		/* Nova already holds this persona's account under this exact name.
		 * The account is updated in place, under the claim already recorded.
		 *
		 * Not finding it in the search is deliberately NOT a reason to make
		 * a new one. The search is Elasticsearch-backed
		 * (`api/resources/v0_5.py::user_es_call`) and so is a moment behind,
		 * and an account that is genuinely gone was retired rather than
		 * deleted — remaking it would hand a second account to somebody who
		 * is meant to be gone. Updating by the id the ledger holds either
		 * works or gets CommCare HQ's own answer about why not.
		 *
		 * The id comparison matters when the search DID find something: an
		 * account Nova made can be retired and a different one made under
		 * the same name, and updating that one would edit a stranger's
		 * account. So a mismatch falls through to the same explicit
		 * decision a stranger's account gets. */
		if (
			mapping !== undefined &&
			mapping.pushedIdentity === completeUsername &&
			(remote === undefined || remote.userId === mapping.remoteId)
		) {
			pushes.push({
				...shared,
				remoteId: mapping.remoteId,
				ownership: mapping.ownership,
			});
			continue;
		}

		/* Nothing of that name is there, so the call makes it and the claim
		 * is unambiguous. A mapping under a DIFFERENT name means somebody
		 * asked for a new username: the old account stays exactly where it
		 * is, the ledger supersedes its row, and the left-behind report
		 * names it from that row's own `pushedIdentity`. Nova never retires
		 * an account, because `CommCareUser.retire` soft-deletes every case
		 * that worker owns. */
		if (remote === undefined) {
			/* Always `nova-created`, even when the superseded mapping was
			 * `adopted`. Reaching here with a mapping means a RENAME, so this
			 * makes an account that did not exist a moment ago: Nova made it,
			 * and inheriting the old claim would file an account nobody has
			 * ever seen as one somebody chose to take over. */
			pushes.push({ ...shared, remoteId: null, ownership: "nova-created" });
			continue;
		}

		if (!adopting.has(worker.personaUuid)) {
			conflicts.push({
				personaUuid: worker.personaUuid,
				personaName: worker.personaName,
				username: completeUsername,
				remoteId: remote.userId,
			});
			continue;
		}
		pushes.push({ ...shared, remoteId: remote.userId, ownership: "adopted" });
	}

	if (conflicts.length > 0) return { ok: false, reason: "conflict", conflicts };
	return { ok: true, pushes };
}

/**
 * Project the personas a call names into what CommCare HQ needs.
 *
 * The blueprint holds identity — a property's uuid, a place's uuid — and
 * CommCare HQ holds names. This is the one crossing, so a renamed
 * property reaches the account under its current slug and nothing else in
 * the provisioning path has to know that slugs can change.
 *
 * A persona the document does not have is skipped rather than guessed at.
 * The caller names personas, and one that no longer exists is a stale
 * screen rather than a worker to make.
 */
export function plannedWorkersFor(
	doc: BlueprintDoc,
	requests: readonly {
		readonly personaUuid: string;
		readonly username: string;
	}[],
): readonly PlannedWorker[] {
	const personas = personasOf(doc);
	const slugs = userPropertySlugsByUuid(doc);
	const declared = Object.values(userPropertiesOf(doc));
	const workers: PlannedWorker[] = [];
	for (const request of requests) {
		const persona = ownRecordValue(personas, request.personaUuid);
		if (persona === undefined) continue;
		const values = personaUserData(persona, doc);
		const userData: Record<string, string> = {};
		for (const property of declared) {
			const slug = slugs.get(property.uuid);
			if (slug === undefined) continue;
			userData[slug] = ownRecordValue(values, property.uuid) ?? "";
		}
		workers.push({
			personaUuid: persona.uuid,
			personaName: persona.name,
			username: request.username,
			userData,
			locationUuids: assignedLocationUuids(persona.locations),
		});
	}
	return workers;
}

/**
 * An account that may be on the project space, and the password it would
 * have.
 *
 * This exists because a refusal from CommCare HQ is not proof that
 * nothing happened: `v0_5.py::CommCareUserResource.obj_create` commits
 * the account before the answer is serialized, so a failure past that
 * point is a live worker and a 5xx. Nova cannot record a mapping for it
 * (there is no id to record, and the ownership ledger stores none), and
 * it cannot go and look either, because every username-shaped read
 * CommCare HQ offers runs on Elasticsearch and lags a create by seconds
 * (`query_adapters.py::UserQuerySetAdapter` for the user resource,
 * `v0_5.py::user_es_call` for `bulk-user`), so an empty answer would be
 * read as proof of the very thing it cannot prove.
 *
 * What Nova CAN do is refuse to throw the password away. If the account
 * is there, this is the only copy of its credential in existence; if it
 * is not, this costs a person one glance at their project space.
 */
export interface UnconfirmedWorker {
	readonly personaUuid: string;
	readonly personaName: string;
	/** The complete username the account would have. */
	readonly username: string;
	/** The generated password. The only copy, exactly as for a real one. */
	readonly password: string;
}

/** How one held credential is addressed: the persona AND the exact name. */
export function unconfirmedWorkerKey(
	personaUuid: string,
	username: string,
): string {
	return `${personaUuid}:${username}`;
}

/**
 * Which unconfirmed credentials a surface must still be holding after the
 * next answer arrives.
 *
 * A pure rule rather than a line inside the panel, because it is the last
 * guard on a value that cannot be regenerated: CommCare HQ stores
 * passwords hashed, so one lost here is lost for good. The refusal that
 * produces an unconfirmed worker asks the person to provision again, and
 * the button that does it is right there — so an answer that simply
 * replaced the previous one would make following the on-screen
 * instruction the way to destroy a live account's only password.
 *
 * A row is dropped on exactly one proof: a later call CREATED an account
 * for that persona UNDER THE SAME USERNAME. Only then is the doubtful
 * account ruled out, because CommCare HQ would have refused the create if
 * the name were taken.
 *
 * The username half of that is not a detail. Renaming is one of the two
 * ways out Nova offers a person whose username is taken, so "provision
 * Amina again as `amina2`" is an ordinary next step — and it says NOTHING
 * about whether `amina` exists. Keying the drop on the persona alone
 * would throw away the password for the very account they went to look
 * at.
 *
 * An ADOPTED account is never dropped either. That is the account that
 * was in doubt, now proven real and claimed in the ledger, and the
 * generated password held here is the one it was made with — CommCare HQ
 * never told Nova a second one.
 */
export function retainUnconfirmedWorkers(
	held: Readonly<Record<string, UnconfirmedWorker>>,
	answer: {
		readonly workers: readonly {
			readonly personaUuid: string;
			readonly username: string;
			readonly created: boolean;
		}[];
		readonly unconfirmed?: readonly UnconfirmedWorker[];
	},
): Record<string, UnconfirmedWorker> {
	const next = { ...held };
	for (const worker of answer.workers) {
		if (!worker.created) continue;
		delete next[unconfirmedWorkerKey(worker.personaUuid, worker.username)];
	}
	/* Optional because a client loaded against one revision can reach a
	 * server running another: Server Action ids are pinned stable across
	 * builds so open tabs survive a deploy, which is exactly the window
	 * where an older answer carries no `unconfirmed` at all. */
	for (const worker of answer.unconfirmed ?? []) {
		next[unconfirmedWorkerKey(worker.personaUuid, worker.username)] = worker;
	}
	return next;
}

/**
 * What one target's Workers panel is showing for its confirmed accounts:
 * every credential provisioning has produced there, plus the latest call's
 * refusal.
 *
 * Held in the builder session rather than in the panel for the same reason
 * the unconfirmed credentials are: a new account's password exists nowhere
 * but on screen, and the panel unmounts on an ordinary App setup section
 * switch. The public docs promise the passwords stay until the person
 * leaves the PAGE, so the page-lived session store is the thing that has
 * to hold them.
 */
export interface HeldProvisioningOutcome {
	readonly workers: readonly ProvisionedWorker[];
	readonly refusal: WorkerProvisionRefusal | null;
}

/** How one target's held outcome is addressed. Same identity the record
 *  fold uses: US, India, and EU can hold unrelated same-named spaces. */
export function provisioningOutcomeKey(server: string, domain: string): string {
	return `${server}\u0000${domain}`;
}

/**
 * Fold one provisioning answer into a target's held outcome.
 *
 * Workers ACCUMULATE across calls, merged per account (persona AND
 * username, like the unconfirmed key): somebody who makes three workers,
 * then two more, is handing out five passwords, and an answer that simply
 * replaced the last one would destroy the first three's only copies. A
 * later answer for the same account wins except for its password — an
 * update carries none (`password: null`), and the password the account
 * was MADE with is still the one it signs in with.
 *
 * The refusal is the latest call's, verbatim, including null: it describes
 * one attempt, and the newest attempt's answer is the standing one.
 */
export function foldProvisioningOutcome(
	held: HeldProvisioningOutcome | undefined,
	answer: {
		readonly workers: readonly ProvisionedWorker[];
		readonly refusal: WorkerProvisionRefusal | null;
	},
): HeldProvisioningOutcome {
	const merged = [...(held?.workers ?? [])];
	for (const worker of answer.workers) {
		const key = unconfirmedWorkerKey(worker.personaUuid, worker.username);
		const at = merged.findIndex(
			(candidate) =>
				unconfirmedWorkerKey(candidate.personaUuid, candidate.username) === key,
		);
		if (at === -1) {
			merged.push(worker);
			continue;
		}
		merged[at] = {
			...worker,
			password: worker.password ?? merged[at].password,
		};
	}
	return { workers: merged, refusal: answer.refusal };
}
