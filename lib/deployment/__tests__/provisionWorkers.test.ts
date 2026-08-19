/**
 * `provisionWorkers` — the one mobile-worker lifecycle.
 *
 * These cover what provisioning MEANS: which refusals happen before a
 * single account exists, that a create carries a generated password and an
 * update never does, that a create with places sends them as a SECOND call
 * because CommCare HQ's create silently swallows the error, that what
 * landed before a stop is still handed back with its passwords, and that
 * the ledger reconciles against the document rather than against the call.
 *
 * The store is mocked because what it persists is proved against real
 * Postgres in `store.integration.test.ts`; the subject here is the
 * ordering and the decisions.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createHqMobileWorker,
	findHqMobileWorkers,
	updateHqMobileWorker,
} from "@/lib/commcare/hq/workers";
import { getCredentialsForUpload } from "@/lib/db/settings";
import type { BlueprintDoc } from "@/lib/domain";
import { readDeployment, recordPushedResources } from "../store";
import { NO_DEPLOYMENT_PHASE_OUTCOMES } from "../types";
import { provisionWorkers } from "../workers";

vi.mock("@/lib/db/settings", () => ({ getCredentialsForUpload: vi.fn() }));
/* Exactly the store surface `workers.ts` imports — no more, no less. */
vi.mock("../store", () => ({
	readDeployment: vi.fn(),
	recordPushedResources: vi.fn(),
}));
vi.mock("@/lib/commcare/hq/workers", () => ({
	findHqMobileWorkers: vi.fn(),
	createHqMobileWorker: vi.fn(),
	updateHqMobileWorker: vi.fn(),
}));

const SCOPE = {
	appId: "app-1",
	projectId: "proj-1",
	role: "owner" as const,
	actorUserId: "u1",
};
const DOMAIN = "acme";
const AMINA = "018f0000-0000-7000-8000-000000000001";
const JOSEPH = "018f0000-0000-7000-8000-000000000002";
const DENVER = "018f0000-0000-7000-8000-0000000000d1";
const CADRE = "018f0000-0000-7000-8000-0000000000c1";
const STATE = "018f0000-0000-7000-8000-0000000000f1";

function record(overrides: Record<string, unknown> = {}) {
	return {
		id: "dep-1",
		appId: SCOPE.appId,
		projectId: SCOPE.projectId,
		server: "production" as const,
		domain: DOMAIN,
		state: "uploaded" as const,
		resumePhase: null,
		phases: NO_DEPLOYMENT_PHASE_OUTCOMES,
		createdBy: "u1",
		createdAt: "2026-08-20T00:00:00.000Z",
		updatedAt: "2026-08-20T00:00:00.000Z",
		lastObservedAt: null,
		...overrides,
	};
}

function mapping(overrides: Record<string, unknown> = {}) {
	return {
		deploymentId: "dep-1",
		kind: "app" as const,
		novaResourceId: SCOPE.appId,
		remoteId: "hq-1",
		ownership: "nova-created" as const,
		pushedIdentity: null,
		adoptedAt: null,
		adoptedBy: null,
		pushedRevision: 3,
		pushedAt: "2026-08-20T00:00:00.000Z",
		remoteRevision: null,
		remoteObservedAt: null,
		supersededAt: null,
		...overrides,
	};
}

function view(active: unknown[] = [mapping()]) {
	return { deployment: record(), active, superseded: [] };
}

/** An app with two personas, one of which stands in a place. */
function doc(overrides: Record<string, unknown> = {}): BlueprintDoc {
	return {
		userProperties: {
			[CADRE]: { uuid: CADRE, slug: "cadre", label: "Cadre" },
		},
		userPropertyOrder: [CADRE],
		personas: {
			[AMINA]: {
				uuid: AMINA,
				name: "Amina",
				values: { [CADRE]: "community" },
				locations: { primaryUuid: DENVER },
			},
			[JOSEPH]: { uuid: JOSEPH, name: "Joseph" },
		},
		personaOrder: [AMINA, JOSEPH],
		organizationLevels: {
			[STATE]: { uuid: STATE, code: "state", name: "State" },
		},
		organizationLevelOrder: [STATE],
		...overrides,
	} as unknown as BlueprintDoc;
}

const PLACE = {
	id: DENVER,
	name: "Denver",
	siteCode: "denver",
} as unknown as Parameters<typeof provisionWorkers>[0]["locations"][number];

function call(overrides: Record<string, unknown> = {}) {
	return provisionWorkers({
		scope: SCOPE,
		doc: doc(),
		locations: [PLACE],
		server: "production",
		domain: DOMAIN,
		workers: [{ personaUuid: AMINA, username: "amina" }],
		...overrides,
	} as Parameters<typeof provisionWorkers>[0]);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getCredentialsForUpload).mockResolvedValue({
		ok: true,
		creds: { username: "u", apiKey: "k", server: "production" },
		domain: { name: DOMAIN, displayName: "Acme" },
	} as never);
	vi.mocked(readDeployment).mockResolvedValue(
		view([
			mapping(),
			mapping({
				kind: "location",
				novaResourceId: DENVER,
				remoteId: "hq-denver",
				pushedIdentity: "denver",
			}),
		]) as never,
	);
	vi.mocked(findHqMobileWorkers).mockResolvedValue([]);
	vi.mocked(recordPushedResources).mockImplementation(
		async () => view() as never,
	);
});

describe("before anything is written", () => {
	it("refuses when the app is not on the project space", async () => {
		// A worker account exists to run an app, and the places its persona
		// stands in are only over there once a publish has put them there.
		vi.mocked(readDeployment).mockResolvedValue(null);
		const outcome = await call();
		expect(outcome.refusal?.code).toBe("app_not_published");
		expect(createHqMobileWorker).not.toHaveBeenCalled();
	});

	it("refuses a persona this app no longer has, by name", async () => {
		/* An MCP caller can hold a uuid the document has since dropped.
		 * Quietly making two accounts for a call that asked for three would
		 * leave somebody to work out which name is missing. */
		const GONE = "018f0000-0000-7000-8000-00000000dead";
		const outcome = await call({
			workers: [
				{ personaUuid: AMINA, username: "amina" },
				{ personaUuid: GONE, username: "ghost" },
			],
		});
		expect(outcome.refusal?.code).toBe("workers_not_provisionable");
		expect(outcome.refusal?.details).toEqual([GONE]);
		expect(findHqMobileWorkers).not.toHaveBeenCalled();
		expect(createHqMobileWorker).not.toHaveBeenCalled();
	});

	it("settles a username Nova would never write without asking about it", async () => {
		/* The name goes into an Elasticsearch `query_string`
		 * (`api/resources/v0_5.py::user_es_call`). Asking first spends a
		 * round trip and answers the wrong question: the refusal would name
		 * the project space when the name was the problem. */
		const outcome = await call({
			workers: [{ personaUuid: AMINA, username: "Amina Osei!" }],
		});
		expect(outcome.refusal?.code).toBe("workers_not_provisionable");
		expect(outcome.refusal?.details.join(" ")).toContain("Amina");
		expect(findHqMobileWorkers).not.toHaveBeenCalled();
	});

	it("refuses when CommCare HQ will not say which usernames it holds", async () => {
		// Reading that as "every name is free" would send a create for each
		// and write over whoever holds them.
		vi.mocked(findHqMobileWorkers).mockResolvedValue({
			success: false,
			status: 503,
		});
		const outcome = await call();
		expect(outcome.refusal?.code).toBe("hq_worker_state_unknown");
		expect(createHqMobileWorker).not.toHaveBeenCalled();
	});

	it("names a persona standing in a place the project space lacks", async () => {
		vi.mocked(readDeployment).mockResolvedValue(view() as never);
		const outcome = await call();
		expect(outcome.refusal?.code).toBe("workers_not_provisionable");
		expect(outcome.refusal?.details[0]).toContain("“Denver”");
		expect(createHqMobileWorker).not.toHaveBeenCalled();
	});

	it("hands back the conflicting accounts to be named", async () => {
		vi.mocked(findHqMobileWorkers).mockResolvedValue([
			{ userId: "somebody-elses", username: `amina@${DOMAIN}.commcarehq.org` },
		]);
		const outcome = await call();
		expect(outcome.refusal?.code).toBe("hq_worker_conflict");
		expect(outcome.refusal?.conflicts).toEqual([
			{
				personaUuid: AMINA,
				personaName: "Amina",
				username: `amina@${DOMAIN}.commcarehq.org`,
				remoteId: "somebody-elses",
			},
		]);
		expect(createHqMobileWorker).not.toHaveBeenCalled();
	});
});

describe("making an account", () => {
	it("creates without places, then assigns them in a second call", async () => {
		// `CommCareUserResource.obj_create` calls `_update` and DISCARDS its
		// errors, so a create carrying an unresolvable location answers 201
		// with the worker standing nowhere. `obj_update` reports.
		vi.mocked(createHqMobileWorker).mockResolvedValue({ userId: "hq-amina" });
		vi.mocked(updateHqMobileWorker).mockResolvedValue({ userId: "hq-amina" });

		const outcome = await call();
		expect(outcome.refusal).toBeNull();

		const created = vi.mocked(createHqMobileWorker).mock.calls[0]?.[2];
		expect(created).toMatchObject({
			username: "amina",
			userData: { cadre: "community" },
		});
		expect(created && "locations" in created).toBe(false);
		expect(typeof created?.password).toBe("string");

		expect(vi.mocked(updateHqMobileWorker).mock.calls[0]?.[3]).toEqual({
			locations: { primaryLocationId: "hq-denver", locationIds: ["hq-denver"] },
		});
	});

	it("hands the password back exactly once, and only for a new account", async () => {
		vi.mocked(createHqMobileWorker).mockResolvedValue({ userId: "hq-joseph" });
		const outcome = await call({
			workers: [{ personaUuid: JOSEPH, username: "joseph" }],
		});
		expect(outcome.workers[0]).toMatchObject({
			personaName: "Joseph",
			username: `joseph@${DOMAIN}.commcarehq.org`,
			userId: "hq-joseph",
			created: true,
			adopted: false,
		});
		expect(outcome.workers[0]?.password).toEqual(
			vi.mocked(createHqMobileWorker).mock.calls[0]?.[2]?.password,
		);
	});

	it("says the account works when only the assignment was refused", async () => {
		// The password in this answer is the only copy. Reporting the
		// account as unmade would throw it away.
		vi.mocked(createHqMobileWorker).mockResolvedValue({ userId: "hq-amina" });
		vi.mocked(updateHqMobileWorker).mockResolvedValue({
			success: false,
			status: 400,
			message: "Could not find location ids: hq-denver.",
		});

		const outcome = await call();
		expect(outcome.refusal?.code).toBe("hq_rejected_worker");
		expect(outcome.refusal?.message).toContain("The account works");
		expect(outcome.refusal?.details).toEqual([
			"Could not find location ids: hq-denver.",
		]);

		/* Saying it in the refusal is not enough. The account has to reach
		 * the answer with its password, and the ledger has to hold the
		 * mapping — otherwise the only copy of the password is gone and the
		 * next call meets Nova's own account as a stranger's. */
		expect(outcome.workers).toEqual([
			expect.objectContaining({
				personaUuid: AMINA,
				userId: "hq-amina",
				created: true,
				password: expect.any(String),
			}),
		]);
		expect(recordPushedResources).toHaveBeenCalledWith(
			SCOPE,
			expect.anything(),
			[
				expect.objectContaining({
					kind: "worker",
					novaResourceId: AMINA,
					remoteId: "hq-amina",
				}),
			],
			expect.objectContaining({ status: "reconciled" }),
		);
	});

	it("hands the passwords back even when the ledger write fails", async () => {
		/* The accounts are on CommCare HQ and their passwords exist in this
		 * answer and nowhere else. A rejected write here used to reject the
		 * whole call, which destroyed the only copy of credentials for
		 * accounts nobody could then sign in to. Losing the ledger row is
		 * recoverable — the next call stops and asks — so the write is
		 * allowed to fail and the answer goes out regardless. */
		vi.mocked(createHqMobileWorker).mockResolvedValue({ userId: "hq-amina" });
		vi.mocked(updateHqMobileWorker).mockResolvedValue({ userId: "hq-amina" });
		vi.mocked(recordPushedResources).mockRejectedValue(
			new Error("connection terminated"),
		);

		const outcome = await call();

		expect(outcome.refusal).toBeNull();
		expect(outcome.workers).toEqual([
			expect.objectContaining({
				personaUuid: AMINA,
				userId: "hq-amina",
				password: expect.any(String),
			}),
		]);
		expect(outcome.deployment).toBeNull();
	});

	it("keeps the accounts that landed before the one that stopped", async () => {
		vi.mocked(createHqMobileWorker)
			.mockResolvedValueOnce({ userId: "hq-joseph" })
			.mockResolvedValueOnce({
				success: false,
				status: 400,
				message: "Username is already taken or reserved.",
			});

		const outcome = await call({
			doc: doc({ organizationLevels: {}, organizationLevelOrder: [] }),
			workers: [
				{ personaUuid: JOSEPH, username: "joseph" },
				{ personaUuid: AMINA, username: "amina" },
			],
		});
		expect(outcome.refusal?.code).toBe("hq_rejected_worker");
		expect(outcome.workers).toHaveLength(1);
		expect(outcome.workers[0]?.personaName).toBe("Joseph");
		expect(typeof outcome.workers[0]?.password).toBe("string");
		/* The one that landed is really there, so it is recorded rather
		 * than forgotten: a retry has to update it, not make a second. */
		expect(vi.mocked(recordPushedResources).mock.calls[0]?.[2]).toHaveLength(1);
	});
});

describe("updating an account Nova already owns", () => {
	beforeEach(() => {
		vi.mocked(readDeployment).mockResolvedValue(
			view([
				mapping(),
				mapping({
					kind: "location",
					novaResourceId: DENVER,
					remoteId: "hq-denver",
					pushedIdentity: "denver",
				}),
				mapping({
					kind: "worker",
					novaResourceId: AMINA,
					remoteId: "hq-amina",
					pushedIdentity: `amina@${DOMAIN}.commcarehq.org`,
				}),
			]) as never,
		);
		vi.mocked(updateHqMobileWorker).mockResolvedValue({ userId: "hq-amina" });
	});

	it("sends one call with no password at all", async () => {
		const outcome = await call();
		expect(outcome.refusal).toBeNull();
		expect(createHqMobileWorker).not.toHaveBeenCalled();
		expect(vi.mocked(updateHqMobileWorker).mock.calls[0]?.[3]).toEqual({
			userData: { cadre: "community" },
			locations: { primaryLocationId: "hq-denver", locationIds: ["hq-denver"] },
		});
		expect(outcome.workers[0]).toMatchObject({
			created: false,
			password: null,
		});
	});

	it("says nothing about places when the app has no organization", async () => {
		// `_update_location` reads an empty list as "remove all", so an app
		// with nothing to say would strip a hand-made assignment off an
		// adopted account.
		await call({
			doc: doc({ organizationLevels: {}, organizationLevelOrder: [] }),
		});
		const sent = vi.mocked(updateHqMobileWorker).mock.calls[0]?.[3];
		expect(sent && "locations" in sent).toBe(false);
	});

	it("clears a persona's places when the app has an organization and it stands nowhere", async () => {
		// The app HAS places, and this persona is in none of them. That is a
		// statement, not silence, so the account's assignment is emptied.
		vi.mocked(readDeployment).mockResolvedValue(
			view([
				mapping(),
				mapping({
					kind: "worker",
					novaResourceId: JOSEPH,
					remoteId: "hq-joseph",
					pushedIdentity: `joseph@${DOMAIN}.commcarehq.org`,
				}),
			]) as never,
		);
		vi.mocked(updateHqMobileWorker).mockResolvedValue({ userId: "hq-joseph" });

		await call({ workers: [{ personaUuid: JOSEPH, username: "joseph" }] });
		expect(vi.mocked(updateHqMobileWorker).mock.calls[0]?.[3]).toEqual({
			userData: { cadre: "" },
			locations: null,
		});
	});
});

describe("the ledger", () => {
	it("reconciles against the document, not against the call", async () => {
		// Naming one persona says nothing about the others, so supersession
		// cannot be read off what the call named the way a push's can. What
		// it CAN be read off is which personas the app still has.
		vi.mocked(createHqMobileWorker).mockResolvedValue({ userId: "hq-joseph" });
		await call({
			doc: doc({ organizationLevels: {}, organizationLevelOrder: [] }),
			workers: [{ personaUuid: JOSEPH, username: "joseph" }],
		});
		expect(vi.mocked(recordPushedResources).mock.calls[0]?.[3]).toEqual({
			status: "reconciled",
			kind: "worker",
			stillUsed: [AMINA, JOSEPH],
		});
	});

	it("attributes an adoption to whoever made the decision", async () => {
		vi.mocked(findHqMobileWorkers).mockResolvedValue([
			{ userId: "somebody-elses", username: `amina@${DOMAIN}.commcarehq.org` },
		]);
		vi.mocked(updateHqMobileWorker).mockResolvedValue({
			userId: "somebody-elses",
		});
		const outcome = await call({ adoptPersonaUuids: [AMINA] });
		expect(outcome.refusal).toBeNull();
		expect(
			vi.mocked(recordPushedResources).mock.calls[0]?.[2][0],
		).toMatchObject({
			kind: "worker",
			novaResourceId: AMINA,
			remoteId: "somebody-elses",
			ownership: "adopted",
			adoptedBy: "u1",
			pushedIdentity: `amina@${DOMAIN}.commcarehq.org`,
		});
		expect(outcome.workers[0]?.adopted).toBe(true);
	});
});
