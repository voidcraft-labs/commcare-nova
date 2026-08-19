/**
 * The deployment store against real Postgres.
 *
 * What this proves that a mocked test cannot: the migration's constraints
 * actually hold, and the fold-in-transaction writes really do decide
 * against the FRESH row. The partial unique index makes "two live mappings
 * for one Nova resource" unrepresentable, the CHECK pairs `incomplete`
 * with a resume phase, and a stale observation is discarded once a publish
 * has replaced what it asked about — whether that publish recreated the
 * app under a new remote id or updated it in place, where the `pushed_at`
 * token is the only thing that tells the publishes apart. Deployments
 * moving with their app is proved next door, in
 * `lib/db/__tests__/projectMove.integration.test.ts`.
 */

import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { activeRemoteApp } from "../resources";
import {
	applyDeploymentObservation,
	type DeploymentScope,
	foldDeploymentAttempt,
	readDeployment,
	readDeploymentPreviewRecords,
	readDeploymentsForApp,
	recordPushedResources,
	recordRemoteResource,
} from "../store";

const h = setupAppStateTestDb("deployments_");

const AT = "2026-08-06T00:00:00.000Z";
const TARGET: { server: "production" | "india"; domain: string } = {
	server: "production",
	domain: "acme",
};

async function seed(
	appId = "app-1",
	projectId = "proj-1",
): Promise<DeploymentScope> {
	await h.seedApp({
		id: appId,
		owner: "u1",
		project_id: projectId,
		app_name: "Vaccine Tracker",
	});
	await h.seedProjectMember("u1", projectId, "owner");
	return { appId, projectId, role: "owner", actorUserId: "u1" };
}

function preflightPassed() {
	return { status: "succeeded" as const, at: AT };
}

async function create(scope: DeploymentScope, target = TARGET) {
	return foldDeploymentAttempt(scope, target, "preflight", preflightPassed(), {
		ensure: true,
	});
}

async function publish(
	scope: DeploymentScope,
	remoteId: string,
	seq: number,
	remoteRevision: number | null = null,
) {
	await create(scope);
	return recordRemoteResource(scope, TARGET, {
		kind: "app",
		novaResourceId: scope.appId,
		remoteId,
		ownership: "nova-created",
		pushedRevision: seq,
		uploadedAt: AT,
		remoteRevision,
	});
}

/** The staleness token an observer carries: the active mapping's pushedAt. */
function pushedAtToken(view: Parameters<typeof activeRemoteApp>[0]) {
	return activeRemoteApp(view)?.pushedAt ?? null;
}

describe("creating a deployment", () => {
	it("starts by folding the passed preflight, and is idempotent per target", async () => {
		const scope = await seed();

		const first = await create(scope);
		const second = await create(scope);

		expect(first.deployment.state).toBe("preflight");
		expect(first.deployment.resumePhase).toBeNull();
		expect(first.deployment.phases.preflight?.status).toBe("succeeded");
		expect(second.deployment.id).toBe(first.deployment.id);
		expect(await readDeploymentsForApp(scope)).toHaveLength(1);
	});

	it("keeps one deployment per project space, not per publish", async () => {
		const scope = await seed();
		await create(scope);
		await create(scope, { server: "production", domain: "other" });
		await create(scope, { server: "india", domain: "acme" });

		expect(await readDeploymentsForApp(scope)).toHaveLength(3);
	});

	it("refuses to fold against a record that does not exist", async () => {
		const scope = await seed();
		await expect(
			foldDeploymentAttempt(scope, TARGET, "preflight", preflightPassed()),
		).rejects.toThrow(/isn't available/);
	});
});

describe("attempt folds", () => {
	it("moves an unreached record to incomplete with the phase a retry resumes at", async () => {
		const scope = await seed();
		await create(scope);

		const refused = await foldDeploymentAttempt(scope, TARGET, "upload", {
			status: "failed",
			at: AT,
			failure: {
				code: "hq_rejected_upload",
				message: "CommCare HQ refused the app.",
				details: [],
			},
		});

		expect(refused.deployment.state).toBe("incomplete");
		expect(refused.deployment.resumePhase).toBe("upload");
		expect(refused.deployment.phases.upload?.status).toBe("failed");
	});

	it("writes NOTHING when the attempt is refused against a reached record", async () => {
		const scope = await seed();
		const live = await publish(scope, "hq-1", 7);

		const after = await foldDeploymentAttempt(scope, TARGET, "preflight", {
			status: "failed",
			at: "2026-08-07T00:00:00.000Z",
			failure: {
				code: "hq_not_connected",
				message: "The caller's key expired.",
				details: [],
			},
		});

		// The record still describes the target: same state, same phases,
		// no stale attempt failure for a later reader to misattribute.
		expect(after.deployment.state).toBe("uploaded");
		expect(after.deployment.phases.preflight).toEqual(
			live.deployment.phases.preflight,
		);
		expect(after.deployment.updatedAt).toBe(live.deployment.updatedAt);
	});

	it("refuses a state and resume phase that disagree", async () => {
		const scope = await seed();
		const created = await create(scope);

		// The CHECK constraint, not application code, is what makes
		// "refused with nowhere to retry from" unrepresentable.
		await expect(
			h
				.db()
				.updateTable("app_deployments")
				.set({ state: "incomplete", resume_phase: null })
				.where("id", "=", created.deployment.id)
				.execute(),
		).rejects.toThrow();
	});
});

describe("ownership mappings", () => {
	it("records the remote app and the revision it was built from, atomically with the uploaded state", async () => {
		const scope = await seed();
		const view = await publish(scope, "hq-1", 7);

		const remote = activeRemoteApp(view);
		expect(remote).toMatchObject({
			remoteId: "hq-1",
			ownership: "nova-created",
			pushedRevision: 7,
		});
		expect(view.deployment.state).toBe("uploaded");
		expect(view.deployment.phases.upload?.status).toBe("succeeded");
	});

	it("a recreate under a new remote id supersedes rather than deletes, so what was left behind stays nameable", async () => {
		// A different remote id arises when the mapped app was deleted on
		// CommCare HQ and the next publish created a fresh one.
		const scope = await seed();
		await publish(scope, "hq-1", 7);
		const second = await publish(scope, "hq-2", 9);

		expect(activeRemoteApp(second)?.remoteId).toBe("hq-2");
		expect(second.superseded.map((r) => r.remoteId)).toEqual(["hq-1"]);
	});

	it("keeps exactly one live mapping per Nova resource", async () => {
		const scope = await seed();
		const view = await publish(scope, "hq-1", 7);
		await publish(scope, "hq-2", 9);

		const live = await h
			.db()
			.selectFrom("app_deployment_resources")
			.selectAll()
			.where("deployment_id", "=", view.deployment.id)
			.where("superseded_at", "is", null)
			.execute();
		expect(live).toHaveLength(1);
	});

	it("the mainline republish updates the live mapping in place — same remote app, no supersession", async () => {
		const scope = await seed();
		await publish(scope, "hq-1", 7);
		const again = await publish(scope, "hq-1", 8, 4);

		expect(again.superseded).toHaveLength(0);
		expect(activeRemoteApp(again)).toMatchObject({
			remoteId: "hq-1",
			pushedRevision: 8,
			remoteRevision: 4,
		});
	});

	it("records the revision the import reported, in the insert arm and the republish arm alike", async () => {
		const scope = await seed();
		// A create answers with no version, so the mapping starts without one
		// and the next observation fills it.
		const first = await publish(scope, "hq-1", 7);
		expect(activeRemoteApp(first)?.remoteRevision).toBeNull();
		expect(activeRemoteApp(first)?.remoteObservedAt).toBeNull();

		// An in-place update answers with the bumped version. The same-remote-id
		// write lands in the conflict arm, which must carry the columns too —
		// an insert-only write would silently drop the reported version.
		const again = await publish(scope, "hq-1", 8, 5);
		expect(activeRemoteApp(again)?.remoteRevision).toBe(5);
		expect(activeRemoteApp(again)?.remoteObservedAt).not.toBeNull();
	});

	it("clears observations that described what the target held before the publish", async () => {
		// True on both publish shapes: build/release answers described an older
		// version (in-place update) or a different app entirely (recreate).
		const scope = await seed();
		const first = await publish(scope, "hq-1", 7);
		await applyDeploymentObservation(scope, TARGET, {
			observedRemoteId: "hq-1",
			observedPushedAt: pushedAtToken(first),
			outcomes: [
				["upload", { status: "succeeded", at: AT }],
				["build", { status: "succeeded", at: AT }],
			],
			remoteRevision: 2,
		});

		const republished = await publish(scope, "hq-1", 8, 3);
		expect(republished.deployment.phases.build).toBeNull();
		expect(republished.deployment.state).toBe("uploaded");

		await applyDeploymentObservation(scope, TARGET, {
			observedRemoteId: "hq-1",
			observedPushedAt: pushedAtToken(republished),
			outcomes: [["build", { status: "succeeded", at: AT }]],
			remoteRevision: 4,
		});

		const recreated = await publish(scope, "hq-2", 9);
		expect(recreated.deployment.phases.build).toBeNull();
		expect(recreated.deployment.state).toBe("uploaded");
	});
});

describe("pushed Project data", () => {
	const TABLE = "018f0000-0000-7000-8000-000000000001";
	const OTHER_TABLE = "018f0000-0000-7000-8000-000000000002";
	const COLORADO = "018f0000-0000-7000-8000-0000000000b1";
	const DENVER = "018f0000-0000-7000-8000-0000000000b2";

	async function pushPlaces(
		scope: DeploymentScope,
		places: readonly {
			readonly novaResourceId: string;
			readonly remoteId: string;
			readonly siteCode: string;
		}[],
	) {
		return recordPushedResources(
			scope,
			TARGET,
			places.map((place) => ({
				kind: "location" as const,
				novaResourceId: place.novaResourceId,
				remoteId: place.remoteId,
				ownership: "nova-created" as const,
				pushedIdentity: place.siteCode,
				adoptedBy: null,
				pushedRevision: null,
				remoteRevision: null,
			})),
			{ status: "complete", kinds: ["location"], pushedAt: AT },
		);
	}

	async function pushTable(
		scope: DeploymentScope,
		over: Partial<Parameters<typeof recordPushedResources>[2][number]> = {},
	) {
		return recordPushedResources(
			scope,
			TARGET,
			[
				{
					kind: "lookup-table",
					novaResourceId: TABLE,
					remoteId: "hq-districts",
					ownership: "nova-created",
					pushedIdentity: "districts",
					adoptedBy: null,
					pushedRevision: null,
					remoteRevision: null,
					...over,
				},
			],
			{ status: "complete", kinds: ["lookup-table"], pushedAt: AT },
		);
	}

	function partialMapping(
		novaResourceId: string,
		remoteId: string,
		pushedIdentity: string,
	) {
		return {
			kind: "lookup-table",
			novaResourceId,
			remoteId,
			ownership: "nova-created",
			pushedIdentity,
			adoptedBy: null,
			pushedRevision: null,
			remoteRevision: null,
		} as const;
	}

	it("files the table beside the app and fills the data rung", async () => {
		const scope = await seed();
		await create(scope);

		const view = await pushTable(scope);

		expect(view.deployment.state).toBe("resources");
		expect(view.active).toEqual([
			expect.objectContaining({
				kind: "lookup-table",
				novaResourceId: TABLE,
				remoteId: "hq-districts",
				ownership: "nova-created",
				pushedIdentity: "districts",
				adoptedAt: null,
				adoptedBy: null,
			}),
		]);
	});

	it("keeps what a stopped push landed, and claims nothing more", async () => {
		/* CommCare HQ answers a workbook it half took with `warning`
		 * (`views.py::UploadFixtureAPIResponse.response_codes`). Those
		 * tables ARE on the project space, so the mapping is written — but
		 * the push said nothing about the tables it never reached, so
		 * nothing is superseded, and it did not succeed, so no rung folds. */
		const scope = await seed();
		await create(scope);

		const first = await recordPushedResources(
			scope,
			TARGET,
			[partialMapping(TABLE, "hq-districts", "districts")],
			{ status: "partial" },
		);
		expect(first.deployment.state).toBe("preflight");

		const view = await recordPushedResources(
			scope,
			TARGET,
			[partialMapping(OTHER_TABLE, "hq-regions", "regions")],
			{ status: "partial" },
		);

		expect(
			view.active
				.filter((resource) => resource.kind === "lookup-table")
				.map((resource) => resource.pushedIdentity)
				.sort(),
		).toEqual(["districts", "regions"]);
		expect(view.superseded).toEqual([]);
		expect(view.deployment.state).toBe("preflight");
	});

	it("does not walk a live deployment backward when its data is re-pushed", async () => {
		/* A republish pushes the tables again before the app. The mappings
		 * are target information and are written either way; the RUNG is
		 * attempt information, and folding it plainly would report an app
		 * that is already uploaded as not yet sent. */
		const scope = await seed();
		await publish(scope, "hq-1", 7);

		const view = await pushTable(scope);

		expect(view.deployment.state).toBe("uploaded");
		expect(
			view.active.find((resource) => resource.kind === "lookup-table"),
		).toMatchObject({ remoteId: "hq-districts" });
	});

	it("supersedes the old table when a rename makes a new one", async () => {
		const scope = await seed();
		await create(scope);
		await pushTable(scope);

		const renamed = await pushTable(scope, {
			remoteId: "hq-areas",
			pushedIdentity: "areas",
		});

		/* The old table is still sitting on the project space under the old
		 * name, and the row is what makes it nameable. */
		expect(renamed.superseded).toEqual([
			expect.objectContaining({
				remoteId: "hq-districts",
				pushedIdentity: "districts",
			}),
		]);
		expect(
			renamed.active.find((resource) => resource.kind === "lookup-table"),
		).toMatchObject({ remoteId: "hq-areas", pushedIdentity: "areas" });
	});

	it("re-pushing the same table updates the live row rather than superseding it", async () => {
		const scope = await seed();
		await create(scope);
		await pushTable(scope);

		const again = await pushTable(scope);

		expect(again.superseded).toHaveLength(0);
		expect(
			again.active.filter((resource) => resource.kind === "lookup-table"),
		).toHaveLength(1);
	});

	it("keeps the app's mapping and a table's apart, even under one id", async () => {
		/* The two kinds are separate rows and the unique index is keyed by
		 * kind, so an app and a table that happened to share a Nova id do
		 * not collide. */
		const scope = await seed();
		await publish(scope, "hq-1", 7);

		const view = await pushTable(scope, { novaResourceId: scope.appId });

		expect(activeRemoteApp(view)?.remoteId).toBe("hq-1");
		expect(
			view.active.find((resource) => resource.kind === "lookup-table"),
		).toMatchObject({ remoteId: "hq-districts" });
	});

	it("records who took over a table Nova did not create", async () => {
		const scope = await seed();
		await create(scope);

		const view = await pushTable(scope, {
			ownership: "adopted",
			adoptedBy: "u1",
		});

		const table = view.active.find(
			(resource) => resource.kind === "lookup-table",
		);
		expect(table).toMatchObject({ ownership: "adopted", adoptedBy: "u1" });
		expect(table?.adoptedAt).not.toBeNull();
	});

	it("supersedes a table the app has stopped reading", async () => {
		/* Dropping the last select that read a table leaves the table on the
		 * project space under Nova's claim. Nova deletes nothing on CommCare
		 * HQ, but it must stop claiming it and start reporting it, and only
		 * a superseded row is ever reported. */
		const scope = await seed();
		await create(scope);
		await pushTable(scope);

		/* The next publish's plan names a different table, so the first one
		 * is no longer part of this app. */
		const view = await recordPushedResources(
			scope,
			TARGET,
			[
				{
					kind: "lookup-table",
					novaResourceId: OTHER_TABLE,
					remoteId: "hq-regions",
					ownership: "nova-created",
					pushedIdentity: "regions",
					adoptedBy: null,
					pushedRevision: null,
					remoteRevision: null,
				},
			],
			{ status: "complete", kinds: ["lookup-table"], pushedAt: AT },
		);

		expect(
			view.active
				.filter((resource) => resource.kind === "lookup-table")
				.map((resource) => resource.novaResourceId),
		).toEqual([OTHER_TABLE]);
		expect(
			view.superseded.find((resource) => resource.novaResourceId === TABLE),
		).toMatchObject({ kind: "lookup-table", pushedIdentity: "districts" });
	});

	it("keeps an adoption attributed to whoever actually made it", async () => {
		/* The republish carries a fresh timestamp and whoever clicked today,
		 * and writing that straight through would reassign a decision one
		 * member made to another who only pressed Publish. The ledger exists
		 * so the decision is auditable, so the FIRST attribution stands. */
		const scope = await seed();
		await create(scope);

		const first = await pushTable(scope, {
			ownership: "adopted",
			adoptedBy: "u1",
		});
		const adoptedAt = first.active.find(
			(resource) => resource.kind === "lookup-table",
		)?.adoptedAt;
		expect(adoptedAt).not.toBeNull();

		const second = await pushTable(scope, {
			ownership: "adopted",
			adoptedBy: "someone-else",
		});

		expect(
			second.active.find((resource) => resource.kind === "lookup-table"),
		).toMatchObject({
			ownership: "adopted",
			adoptedBy: "u1",
			adoptedAt,
		});
	});

	it("clears the attribution when a resource stops being adopted", async () => {
		/* The row's CHECK ties `adopted` to exactly the rows naming a member
		 * and a time, so the columns have to go in the same statement the
		 * ownership changes. Keeping a stale `adoptedBy` would violate it. */
		const scope = await seed();
		await create(scope);
		await pushTable(scope, { ownership: "adopted", adoptedBy: "u1" });

		const view = await pushTable(scope, { ownership: "nova-created" });

		expect(
			view.active.find((resource) => resource.kind === "lookup-table"),
		).toMatchObject({
			ownership: "nova-created",
			adoptedBy: null,
			adoptedAt: null,
		});
	});

	it("refuses an adoption nobody is named for, and a creation somebody is", async () => {
		/* The ledger's CHECK says the same thing; refusing here names the
		 * call that was wrong instead of surfacing a constraint violation. */
		const scope = await seed();
		await create(scope);

		await expect(pushTable(scope, { ownership: "adopted" })).rejects.toThrow(
			/who adopted it/,
		);
		await expect(pushTable(scope, { adoptedBy: "u1" })).rejects.toThrow(
			/no such decision/,
		);
	});

	it("writes every table of one push together", async () => {
		const scope = await seed();
		await create(scope);
		const second = "018f0000-0000-7000-8000-000000000002";

		const view = await recordPushedResources(
			scope,
			TARGET,
			[
				{
					kind: "lookup-table",
					novaResourceId: TABLE,
					remoteId: "hq-districts",
					ownership: "nova-created",
					pushedIdentity: "districts",
					adoptedBy: null,
					pushedRevision: null,
					remoteRevision: null,
				},
				{
					kind: "lookup-table",
					novaResourceId: second,
					remoteId: "hq-statuses",
					ownership: "nova-created",
					pushedIdentity: "statuses",
					adoptedBy: null,
					pushedRevision: null,
					remoteRevision: null,
				},
			],
			{ status: "complete", kinds: ["lookup-table"], pushedAt: AT },
		);

		expect(
			view.active
				.filter((resource) => resource.kind === "lookup-table")
				.map((resource) => resource.pushedIdentity)
				.sort(),
		).toEqual(["districts", "statuses"]);
	});

	it("files a place under its own kind, keyed by its site code", async () => {
		const scope = await seed();
		await create(scope);

		const view = await pushPlaces(scope, [
			{
				novaResourceId: COLORADO,
				remoteId: "hq-colorado",
				siteCode: "colorado",
			},
		]);

		expect(view.deployment.state).toBe("resources");
		expect(view.active).toEqual([
			expect.objectContaining({
				kind: "location",
				novaResourceId: COLORADO,
				remoteId: "hq-colorado",
				pushedIdentity: "colorado",
				ownership: "nova-created",
			}),
		]);
	});

	it("supersedes a place the app stopped carrying, and leaves tables alone", async () => {
		/* Archiving a place leaves whatever Nova pushed on the project
		 * space. Nova deletes nothing there, so the mapping is superseded
		 * and the left-behind report names it. A push that speaks only for
		 * places must not disturb the table mappings beside them. */
		const scope = await seed();
		await create(scope);
		await pushTable(scope);
		await pushPlaces(scope, [
			{
				novaResourceId: COLORADO,
				remoteId: "hq-colorado",
				siteCode: "colorado",
			},
			{ novaResourceId: DENVER, remoteId: "hq-denver", siteCode: "denver" },
		]);

		const view = await pushPlaces(scope, [
			{
				novaResourceId: COLORADO,
				remoteId: "hq-colorado",
				siteCode: "colorado",
			},
		]);

		expect(
			view.active
				.filter((resource) => resource.kind === "location")
				.map((resource) => resource.novaResourceId),
		).toEqual([COLORADO]);
		expect(
			view.superseded.find((resource) => resource.novaResourceId === DENVER),
		).toMatchObject({ kind: "location", pushedIdentity: "denver" });
		expect(
			view.active.filter((resource) => resource.kind === "lookup-table"),
		).toHaveLength(1);
	});

	it("keeps a partial push's places live and leaves the rung unfilled", async () => {
		/* `patch_list` is atomic per batch, so a tree that stops partway
		 * really did leave places over there. Superseding what this call did
		 * not name would report places nobody has reached yet as left
		 * behind, and folding the rung would call a stopped push a success. */
		const scope = await seed();
		await create(scope);
		const place = (novaResourceId: string, siteCode: string) => ({
			kind: "location" as const,
			novaResourceId,
			remoteId: `hq-${siteCode}`,
			ownership: "nova-created" as const,
			pushedIdentity: siteCode,
			adoptedBy: null,
			pushedRevision: null,
			remoteRevision: null,
		});

		const first = await recordPushedResources(
			scope,
			TARGET,
			[place(COLORADO, "colorado"), place(DENVER, "denver")],
			{ status: "partial" },
		);

		// The places really are on the project space, so they are recorded;
		// the phase did not succeed, so the rung stays where it was.
		expect(first.deployment.state).toBe("preflight");
		expect(
			first.active
				.filter((resource) => resource.kind === "location")
				.map((resource) => resource.novaResourceId)
				.sort(),
		).toEqual([COLORADO, DENVER].sort());

		const second = await recordPushedResources(
			scope,
			TARGET,
			[place(COLORADO, "colorado")],
			{ status: "partial" },
		);

		// A place this call did not name may simply not have been reached
		// yet, so nothing is superseded and nothing is reported as left
		// behind on the strength of a push that stopped.
		expect(second.deployment.state).toBe("preflight");
		expect(second.superseded).toHaveLength(0);
		expect(
			second.active.filter((resource) => resource.kind === "location"),
		).toHaveLength(2);
	});

	it("stores only the kinds the ledger knows", async () => {
		const scope = await seed();
		const view = await create(scope);

		await expect(
			h
				.db()
				.insertInto("app_deployment_resources")
				.values({
					deployment_id: view.deployment.id,
					kind: "user-role" as never,
					nova_resource_id: "role-1",
					remote_id: "hq-role",
					ownership: "nova-created",
					pushed_revision: null,
					pushed_at: null,
					remote_revision: null,
					remote_observed_at: null,
				})
				.execute(),
		).rejects.toThrow();
	});
});

describe("provisioned workers", () => {
	const AMINA = "018f0000-0000-7000-8000-0000000000c1";
	const JOSEPH = "018f0000-0000-7000-8000-0000000000c2";

	async function provision(
		scope: DeploymentScope,
		workers: readonly {
			readonly personaUuid: string;
			readonly username: string;
		}[],
		stillUsed: readonly string[],
	) {
		return recordPushedResources(
			scope,
			TARGET,
			workers.map((worker) => ({
				kind: "worker" as const,
				novaResourceId: worker.personaUuid,
				remoteId: `hq-${worker.username}`,
				ownership: "nova-created" as const,
				pushedIdentity: `${worker.username}@acme.commcarehq.org`,
				adoptedBy: null,
				pushedRevision: null,
				remoteRevision: null,
			})),
			{ status: "reconciled", kind: "worker", stillUsed },
		);
	}

	it("files the account without folding a rung", async () => {
		/* Provisioning is not a publish step. A deployment that has reached
		 * `uploaded` must not be walked backward to `resources` by somebody
		 * making an account, and one still at `preflight` must not be
		 * carried forward by it either. */
		const scope = await seed();
		await create(scope);

		const view = await provision(
			scope,
			[{ personaUuid: AMINA, username: "amina" }],
			[AMINA, JOSEPH],
		);

		expect(view.deployment.state).toBe("preflight");
		expect(view.active).toEqual([
			expect.objectContaining({
				kind: "worker",
				novaResourceId: AMINA,
				remoteId: "hq-amina",
				pushedIdentity: "amina@acme.commcarehq.org",
			}),
		]);
	});

	it("leaves the personas this call did not name alone", async () => {
		/* Naming one persona says nothing about the others, so the "not
		 * named here" rule a complete push uses would supersede accounts
		 * that are perfectly live. */
		const scope = await seed();
		await create(scope);
		await provision(
			scope,
			[
				{ personaUuid: AMINA, username: "amina" },
				{ personaUuid: JOSEPH, username: "joseph" },
			],
			[AMINA, JOSEPH],
		);

		const view = await provision(
			scope,
			[{ personaUuid: AMINA, username: "amina" }],
			[AMINA, JOSEPH],
		);

		expect(
			view.active
				.filter((resource) => resource.kind === "worker")
				.map((resource) => resource.novaResourceId)
				.sort(),
		).toEqual([AMINA, JOSEPH].sort());
		expect(view.superseded).toHaveLength(0);
	});

	it("stops claiming the account of a persona the app no longer has", async () => {
		/* Nova never retires a worker — CommCare HQ's own delete takes down
		 * every case they own — so the account is still there. Superseding
		 * the mapping is what makes the left-behind report name it. */
		const scope = await seed();
		await create(scope);
		await provision(
			scope,
			[
				{ personaUuid: AMINA, username: "amina" },
				{ personaUuid: JOSEPH, username: "joseph" },
			],
			[AMINA, JOSEPH],
		);

		const view = await provision(scope, [], [AMINA]);

		expect(
			view.active
				.filter((resource) => resource.kind === "worker")
				.map((resource) => resource.novaResourceId),
		).toEqual([AMINA]);
		expect(
			view.superseded.find((resource) => resource.novaResourceId === JOSEPH),
		).toMatchObject({
			kind: "worker",
			pushedIdentity: "joseph@acme.commcarehq.org",
		});
	});

	it("supersedes the old account when a persona takes a new username", async () => {
		/* A username is create-once on CommCare HQ, so a new one is a new
		 * account. The old one stays where it is and is named from its own
		 * superseded row. */
		const scope = await seed();
		await create(scope);
		await provision(
			scope,
			[{ personaUuid: AMINA, username: "amina" }],
			[AMINA],
		);

		const view = await provision(
			scope,
			[{ personaUuid: AMINA, username: "amina.b" }],
			[AMINA],
		);

		expect(
			view.active.find((resource) => resource.kind === "worker"),
		).toMatchObject({ pushedIdentity: "amina.b@acme.commcarehq.org" });
		expect(
			view.superseded.find((resource) => resource.kind === "worker"),
		).toMatchObject({ pushedIdentity: "amina@acme.commcarehq.org" });
	});
});

describe("observation writes", () => {
	it("folds outcomes, stamps last_observed_at, and records the remote revision", async () => {
		const scope = await seed();
		const live = await publish(scope, "hq-1", 7);

		const { view, applied } = await applyDeploymentObservation(scope, TARGET, {
			observedRemoteId: "hq-1",
			observedPushedAt: pushedAtToken(live),
			outcomes: [
				["upload", { status: "succeeded", at: AT }],
				["build", { status: "succeeded", at: AT }],
				["release", { status: "pending", at: AT, reason: "Not released." }],
			],
			remoteRevision: 3,
		});

		expect(applied).toBe(true);
		expect(view.deployment.state).toBe("built");
		expect(view.deployment.lastObservedAt).not.toBeNull();
		expect(activeRemoteApp(view)).toMatchObject({
			pushedRevision: 7,
			remoteRevision: 3,
		});
	});

	it("discards an observation once a recreate replaced the app it asked about", async () => {
		/* The interleaving the old cross-transaction lock existed for:
		 * Check status reads the record, spends seconds asking CommCare HQ
		 * about hq-1, and a publish lands hq-2 in between. The answers
		 * describe the app the publish just replaced, so the guarded write
		 * throws them away instead of overwriting the fresh record. */
		const scope = await seed();
		const first = await publish(scope, "hq-1", 7);
		await publish(scope, "hq-2", 9);

		const { view, applied } = await applyDeploymentObservation(scope, TARGET, {
			observedRemoteId: "hq-1",
			observedPushedAt: pushedAtToken(first),
			outcomes: [
				["upload", { status: "succeeded", at: AT }],
				["build", { status: "succeeded", at: AT }],
				["release", { status: "succeeded", at: AT }],
				["probe", { status: "succeeded", at: AT }],
			],
			remoteRevision: 12,
		});

		expect(applied).toBe(false);
		expect(view.deployment.state).toBe("uploaded");
		expect(view.deployment.lastObservedAt).toBeNull();
		expect(activeRemoteApp(view)?.remoteRevision).toBeNull();
	});

	it("discards an observation begun before a republish updated the same remote app", async () => {
		/* An in-place update keeps the remote id across a republish, so the id
		 * alone can no longer catch this interleaving: Check status reads the
		 * record, spends seconds asking CommCare HQ about hq-1, and a republish
		 * lands hq-1 AGAIN in between. The per-publish `pushed_at` token is
		 * what tells the two publishes apart. The first publish's token is
		 * rewound by SQL so the two cannot collide within one millisecond. */
		const scope = await seed();
		const firstView = await publish(scope, "hq-1", 7);
		await h
			.db()
			.updateTable("app_deployment_resources")
			.set({ pushed_at: AT })
			.where("deployment_id", "=", firstView.deployment.id)
			.execute();
		const before = await readDeployment(scope, TARGET);
		const staleToken = before === null ? null : pushedAtToken(before);
		expect(staleToken).toBe(AT);

		await publish(scope, "hq-1", 8, 5);

		const { view, applied } = await applyDeploymentObservation(scope, TARGET, {
			observedRemoteId: "hq-1",
			observedPushedAt: staleToken,
			outcomes: [
				["upload", { status: "succeeded", at: AT }],
				["build", { status: "succeeded", at: AT }],
			],
			remoteRevision: 12,
		});

		expect(applied).toBe(false);
		expect(view.deployment.state).toBe("uploaded");
		expect(view.deployment.lastObservedAt).toBeNull();
	});
});

describe("reads", () => {
	it("serves the two target rules from the four columns they consume", async () => {
		const scope = await seed();
		await publish(scope, "hq-1", 7);

		// Preview names a project space; an attachment link needs a whole
		// origin as well, so `server` rides along in the same read.
		const records = await readDeploymentPreviewRecords(scope);
		expect(records).toEqual([
			{
				state: "uploaded",
				resumePhase: null,
				server: "production",
				domain: "acme",
			},
		]);
	});

	it("answers null for a target the app never reached", async () => {
		const scope = await seed();
		await expect(readDeployment(scope, TARGET)).resolves.toBeNull();
	});
});

describe("tenancy", () => {
	it("hides a deployment from a Project the caller is not in", async () => {
		const scope = await seed();
		await create(scope);

		await expect(
			readDeploymentsForApp({ ...scope, projectId: "other-project" }),
		).resolves.toHaveLength(0);
	});

	it("refuses a write once the caller loses membership", async () => {
		const scope = await seed();
		await create(scope);
		await sql`DELETE FROM auth_member WHERE "userId" = 'u1'`.execute(h.db());

		await expect(
			foldDeploymentAttempt(scope, TARGET, "upload", {
				status: "failed",
				at: AT,
				failure: {
					code: "hq_rejected_upload",
					message: "refused",
					details: [],
				},
			}),
		).rejects.toThrow();
	});
});
