/**
 * Which mobile workers Nova may make, under what names, and under what
 * claim.
 *
 * The ownership rule is the one every resource kind follows: a NAME is
 * never evidence of ownership. A mobile username is unique to ONE project
 * space — `users/util.py::is_username_available` asks `dbaccessors.py::user_exists`
 * about the complete `<name>@<domain>.commcarehq.org` (`::format_username`
 * + `::cc_user_domain`) — so the same name is free everywhere else and,
 * here, already in use means a real person's account until somebody says
 * otherwise.
 *
 * The rule peculiar to workers is the OTHER direction: a worker Nova
 * already owns is never remade. `users/models.py::CommCareUser.retire` is
 * a soft delete that keeps the document and its username, so remaking an
 * account somebody retired either gets refused or quietly hands a second
 * one to a person meant to be gone. Nova updates by the ledger's id and
 * lets CommCare HQ answer.
 */

import { describe, expect, it } from "vitest";
import type { BlueprintDoc } from "@/lib/domain";
import type { DeploymentResource } from "../types";
import type { PlannedWorker, RemoteWorker } from "../workerProvisionPlan";
import {
	completeWorkerUsername,
	defaultWorkerUsername,
	describeRequiredWorkerDataGaps,
	maxWorkerUsernameLength,
	plannedWorkersFor,
	planWorkerProvisioning,
	requiredWorkerDataGaps,
	retainUnconfirmedWorkers,
	unconfirmedWorkerKey,
} from "../workerProvisionPlan";

const DOMAIN = "myproject";
const AMINA = "018f0000-0000-7000-8000-000000000001";
const JOSEPH = "018f0000-0000-7000-8000-000000000002";
const DENVER = "018f0000-0000-7000-8000-0000000000d1";
const CADRE = "018f0000-0000-7000-8000-0000000000c1";
const CHW = "018f0000-0000-7000-8000-0000000000e1";

function worker(over: Partial<PlannedWorker> = {}): PlannedWorker {
	return {
		personaUuid: AMINA,
		personaName: "Amina",
		username: "amina",
		userData: { cadre: "community" },
		locationUuids: [],
		...over,
	};
}

function remote(over: Partial<RemoteWorker> = {}): RemoteWorker {
	return {
		userId: "hq-amina",
		username: `amina@${DOMAIN}.commcarehq.org`,
		...over,
	};
}

function mapping(over: Partial<DeploymentResource> = {}): DeploymentResource {
	return {
		deploymentId: "dep-1",
		kind: "worker",
		novaResourceId: AMINA,
		remoteId: "hq-amina",
		ownership: "nova-created",
		pushedIdentity: `amina@${DOMAIN}.commcarehq.org`,
		adoptedAt: null,
		adoptedBy: null,
		pushedRevision: null,
		pushedAt: "2026-08-20T00:00:00.000Z",
		remoteRevision: null,
		remoteObservedAt: null,
		supersededAt: null,
		...over,
	};
}

function placeMapping(): DeploymentResource {
	return mapping({
		kind: "location",
		novaResourceId: DENVER,
		remoteId: "hq-denver",
		pushedIdentity: "denver",
	});
}

function plan(
	over: Partial<Parameters<typeof planWorkerProvisioning>[0]> = {},
) {
	return planWorkerProvisioning({
		workers: [worker()],
		mappings: [],
		hqWorkers: [],
		workerDataGaps: new Map(),
		domain: DOMAIN,
		adoptPersonaUuids: [],
		...over,
	});
}

describe("usernames", () => {
	it("builds the complete name CommCare HQ will store", () => {
		// `users/util.py::format_username` over `cc_user_domain`, lowercased.
		expect(completeWorkerUsername("Amina", DOMAIN)).toBe(
			`amina@${DOMAIN}.commcarehq.org`,
		);
	});

	it("takes the project space's own length ceiling", () => {
		// `users/forms.py::get_mobile_worker_max_username_length`:
		// `min(128 - len(cc_user_domain(domain)) - 1, 80)`.
		expect(maxWorkerUsernameLength(DOMAIN)).toBe(80);
		expect(maxWorkerUsernameLength("a".repeat(40))).toBe(
			128 - `${"a".repeat(40)}.commcarehq.org`.length - 1,
		);
	});

	it("suggests a name from the persona's, and nothing when it cannot", () => {
		expect(defaultWorkerUsername("Community health worker")).toBe(
			"community.health.worker",
		);
		expect(defaultWorkerUsername("  Amina  B.  ")).toBe("amina.b");
		expect(defaultWorkerUsername("العاملة")).toBe("");
	});

	it("names every unusable one before deciding anything about ownership", () => {
		const result = plan({
			workers: [
				worker({ username: "" }),
				worker({
					personaUuid: JOSEPH,
					personaName: "Joseph",
					username: "admin",
				}),
			],
			hqWorkers: [remote({ userId: "somebody-elses" })],
		});
		expect(result).toMatchObject({ ok: false, reason: "unprovisionable" });
		if (result.ok || result.reason !== "unprovisionable") return;
		expect(result.problems.map((problem) => problem.kind)).toEqual([
			"username",
			"username",
		]);
		// `users/forms.py::UNALLOWED_MOBILE_WORKER_NAMES`.
		expect(result.problems[1]).toMatchObject({ problem: "reserved" });
	});

	it("refuses a dot CommCare HQ's own email check would refuse", () => {
		// Django's `validate_email` runs on the whole address, and its user
		// regex admits no leading, trailing, or doubled dot.
		for (const username of [".amina", "amina.", "amina..b", "Amina"]) {
			const result = plan({ workers: [worker({ username })] });
			expect(result).toMatchObject({ ok: false, reason: "unprovisionable" });
		}
	});

	it("refuses two personas asking for one account", () => {
		const result = plan({
			workers: [
				worker(),
				worker({ personaUuid: JOSEPH, personaName: "Joseph" }),
			],
		});
		expect(result).toMatchObject({ ok: false, reason: "unprovisionable" });
		if (result.ok || result.reason !== "unprovisionable") return;
		expect(result.problems[0]).toMatchObject({ kind: "username-repeated" });
	});

	it("refuses one persona asked for twice under two names", () => {
		/* Two creates, one mapping. The ledger holds one live row per
		 * persona, so the second account would supersede the first the
		 * moment it was written and leave a real account on the project
		 * space that nothing in Nova points at. */
		const result = plan({
			workers: [worker(), worker({ username: "amina.osei" })],
		});
		expect(result).toMatchObject({ ok: false, reason: "unprovisionable" });
		if (result.ok || result.reason !== "unprovisionable") return;
		expect(result.problems).toEqual([
			expect.objectContaining({
				kind: "persona-repeated",
				personaName: "Amina",
			}),
		]);
	});
});

describe("a project space with none of these accounts", () => {
	it("makes each one and claims it", () => {
		const result = plan({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.pushes[0]).toMatchObject({
			remoteId: null,
			ownership: "nova-created",
			completeUsername: `amina@${DOMAIN}.commcarehq.org`,
		});
	});

	it("refuses a username somebody already has", () => {
		const result = plan({ hqWorkers: [remote({ userId: "somebody-elses" })] });
		expect(result).toEqual({
			ok: false,
			reason: "conflict",
			conflicts: [
				{
					personaUuid: AMINA,
					personaName: "Amina",
					username: `amina@${DOMAIN}.commcarehq.org`,
					remoteId: "somebody-elses",
				},
			],
		});
	});

	it("takes over exactly the accounts a person named", () => {
		const result = plan({
			hqWorkers: [remote({ userId: "somebody-elses" })],
			adoptPersonaUuids: [AMINA],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.pushes[0]).toMatchObject({
			remoteId: "somebody-elses",
			ownership: "adopted",
		});
	});
});

describe("a project space Nova already owns accounts on", () => {
	it("updates in place under the claim already recorded", () => {
		const result = plan({ mappings: [mapping()], hqWorkers: [remote()] });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.pushes[0]).toMatchObject({
			remoteId: "hq-amina",
			ownership: "nova-created",
		});
	});

	it("keeps an adoption's claim across a later call", () => {
		const result = plan({
			mappings: [mapping({ ownership: "adopted" })],
			hqWorkers: [remote()],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.pushes[0]?.ownership).toBe("adopted");
	});

	it("updates rather than remakes an account the search cannot see", () => {
		// The search is Elasticsearch-backed and a moment behind, and an
		// account that is genuinely gone was RETIRED rather than deleted.
		// Either way, making a second one is the wrong move.
		const result = plan({ mappings: [mapping()] });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.pushes[0]).toMatchObject({
			remoteId: "hq-amina",
			ownership: "nova-created",
		});
	});

	it("refuses a mapped name now held by a different account", () => {
		const result = plan({
			mappings: [mapping()],
			hqWorkers: [remote({ userId: "a-different-one" })],
		});
		expect(result).toMatchObject({ ok: false, reason: "conflict" });
	});

	it("makes a fresh account when the persona asks for a new name", () => {
		// A username is create-once on CommCare HQ, so a rename is a new
		// account. The old one keeps its own row and is reported left
		// behind; inheriting an adopted claim would file an account nobody
		// has seen as one somebody chose to take over.
		const result = plan({
			workers: [worker({ username: "amina.b" })],
			mappings: [mapping({ ownership: "adopted" })],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.pushes[0]).toMatchObject({
			remoteId: null,
			ownership: "nova-created",
			completeUsername: `amina.b@${DOMAIN}.commcarehq.org`,
		});
	});
});

describe("things CommCare HQ would take and then not do", () => {
	it("refuses a persona with no value for required worker information", () => {
		const result = plan({
			workerDataGaps: new Map([[AMINA, ["Cadre"]]]),
		});
		expect(result).toMatchObject({ ok: false, reason: "unprovisionable" });
		if (result.ok || result.reason !== "unprovisionable") return;
		expect(result.problems[0]).toEqual({
			kind: "missing-worker-data",
			personaUuid: AMINA,
			personaName: "Amina",
			missing: ["Cadre"],
		});
	});

	it("refuses a persona standing in a place the target does not hold", () => {
		// `obj_create` calls `_update` and DISCARDS its errors, so this
		// would otherwise answer 201 with the worker standing nowhere.
		const result = plan({ workers: [worker({ locationUuids: [DENVER] })] });
		expect(result).toMatchObject({ ok: false, reason: "unprovisionable" });
		if (result.ok || result.reason !== "unprovisionable") return;
		expect(result.problems[0]).toEqual({
			kind: "place-not-pushed",
			personaUuid: AMINA,
			personaName: "Amina",
			locationUuid: DENVER,
		});
	});

	it("resolves each place through the ledger, primary first", () => {
		const result = plan({
			workers: [worker({ locationUuids: [DENVER] })],
			mappings: [placeMapping()],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.pushes[0]?.locationIds).toEqual(["hq-denver"]);
	});
});

describe("required worker information", () => {
	const doc = {
		userProperties: {
			[CADRE]: { uuid: CADRE, slug: "cadre", label: "Cadre", required: true },
		},
		userPropertyOrder: [CADRE],
		userTypes: {
			[CHW]: { uuid: CHW, name: "CHW", values: { [CADRE]: "community" } },
		},
		userTypeOrder: [CHW],
		personas: {
			[AMINA]: { uuid: AMINA, name: "Amina", userTypeUuid: CHW },
			[JOSEPH]: { uuid: JOSEPH, name: "Joseph" },
		},
		personaOrder: [AMINA, JOSEPH],
	} as unknown as BlueprintDoc;

	it("counts a role's default as a value the persona has", () => {
		expect([...requiredWorkerDataGaps(doc).keys()]).toEqual([JOSEPH]);
	});

	it("reads a blank override as no value at all", () => {
		const blanked = {
			...doc,
			personas: {
				...(doc as { personas: Record<string, unknown> }).personas,
				[AMINA]: {
					uuid: AMINA,
					name: "Amina",
					userTypeUuid: CHW,
					values: { [CADRE]: "  " },
				},
			},
		} as unknown as BlueprintDoc;
		expect([...requiredWorkerDataGaps(blanked).keys()].sort()).toEqual(
			[AMINA, JOSEPH].sort(),
		);
	});

	it("says the same thing to a publish as it does to a provisioning call", () => {
		expect(describeRequiredWorkerDataGaps(doc)).toEqual(["Joseph: Cadre"]);
	});
});

describe("plannedWorkersFor", () => {
	const doc = {
		userProperties: {
			[CADRE]: { uuid: CADRE, slug: "cadre", label: "Cadre" },
		},
		userPropertyOrder: [CADRE],
		userTypes: {
			[CHW]: { uuid: CHW, name: "CHW", values: { [CADRE]: "community" } },
		},
		userTypeOrder: [CHW],
		personas: {
			[AMINA]: {
				uuid: AMINA,
				name: "Amina",
				userTypeUuid: CHW,
				locations: { primaryUuid: DENVER },
			},
			[JOSEPH]: { uuid: JOSEPH, name: "Joseph" },
		},
		personaOrder: [AMINA, JOSEPH],
	} as unknown as BlueprintDoc;

	it("keys the worker data by each property's current slug", () => {
		const [projected] = plannedWorkersFor(doc, [
			{ personaUuid: AMINA, username: "amina" },
		]);
		expect(projected).toMatchObject({
			personaName: "Amina",
			userData: { cadre: "community" },
			locationUuids: [DENVER],
		});
	});

	it("sends an empty value for a declared property with none set", () => {
		// A cleared value would otherwise sit on the account forever:
		// `users/user_data.py::UserData.update` touches only the keys it is
		// handed.
		const [projected] = plannedWorkersFor(doc, [
			{ personaUuid: JOSEPH, username: "joseph" },
		]);
		expect(projected?.userData).toEqual({ cadre: "" });
	});

	it("skips a persona the document no longer has", () => {
		expect(
			plannedWorkersFor(doc, [{ personaUuid: "gone", username: "gone" }]),
		).toHaveLength(0);
	});
});

/**
 * Which unconfirmed credentials a surface keeps.
 *
 * Pinned because the refusal that produces one asks the person to
 * provision again, and the button that does it sits right beside the
 * password. A rule that dropped the row on the next answer would make
 * following Nova's own instruction the way to lose a live account's only
 * credential, and CommCare HQ stores passwords hashed, so there is no
 * second chance at it.
 */
describe("retainUnconfirmedWorkers", () => {
	const AMINA_NAME = "amina@acme.commcarehq.org";
	const DOUBTED = {
		personaUuid: AMINA,
		personaName: "Amina",
		username: AMINA_NAME,
		password: "kept-once",
	};
	const held = { [unconfirmedWorkerKey(AMINA, AMINA_NAME)]: DOUBTED };

	it("keeps a doubtful credential through an answer that says nothing about it", () => {
		expect(
			retainUnconfirmedWorkers(held, {
				workers: [
					{
						personaUuid: JOSEPH,
						username: "joseph@acme.commcarehq.org",
						created: true,
					},
				],
			}),
		).toEqual(held);
	});

	it("drops it once that exact account is really created", () => {
		// A create succeeding under this name proves the doubtful account
		// never existed, because CommCare HQ refuses a taken username.
		expect(
			retainUnconfirmedWorkers(held, {
				workers: [{ personaUuid: AMINA, username: AMINA_NAME, created: true }],
			}),
		).toEqual({});
	});

	it("keeps it when the same persona is created under a DIFFERENT name", () => {
		/* Renaming is one of the two ways out Nova offers for a taken
		 * username, so this is an ordinary next step — and it says nothing
		 * about whether the first account exists. Dropping here would throw
		 * away the password for the very account the person went to look
		 * at. */
		expect(
			retainUnconfirmedWorkers(held, {
				workers: [
					{
						personaUuid: AMINA,
						username: "amina2@acme.commcarehq.org",
						created: true,
					},
				],
			}),
		).toEqual(held);
	});

	it("keeps it when that account was ADOPTED rather than created", () => {
		/* The account that was in doubt turned out to be real and Nova has
		 * now claimed it. The password held here is the one it was made
		 * with, and nothing else has a copy. */
		expect(
			retainUnconfirmedWorkers(held, {
				workers: [{ personaUuid: AMINA, username: AMINA_NAME, created: false }],
			}),
		).toEqual(held);
	});

	it("survives an answer from a server that predates the field", () => {
		/* Server Action ids are stable across builds so open tabs live
		 * through a deploy, which is exactly when a client can get an answer
		 * carrying no `unconfirmed` at all. */
		expect(retainUnconfirmedWorkers(held, { workers: [] })).toEqual(held);
	});

	it("accumulates rather than replacing", () => {
		const second = {
			personaUuid: JOSEPH,
			personaName: "Joseph",
			username: "joseph@acme.commcarehq.org",
			password: "also-kept",
		};
		expect(
			retainUnconfirmedWorkers(held, {
				workers: [],
				unconfirmed: [second],
			}),
		).toEqual({
			...held,
			[unconfirmedWorkerKey(JOSEPH, second.username)]: second,
		});
	});
});
