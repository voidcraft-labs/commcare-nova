/**
 * The deployment store against real Postgres.
 *
 * What this proves that a mocked test cannot: the migration's constraints
 * actually hold. The partial unique index makes "two live mappings for one
 * Nova resource" unrepresentable, and the CHECK pairs `incomplete` with a
 * resume phase. Deployments moving with their app is proved next door, in
 * `lib/db/__tests__/projectMove.integration.test.ts`.
 */

import { sql } from "kysely";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { __setAppPoolForTests } from "@/lib/db/pg";
import { activeRemoteApp } from "../resources";
import { applyPhaseOutcome } from "../stateMachine";
import {
	type DeploymentScope,
	ensureDeployment,
	readDeployment,
	readDeploymentsForApp,
	recordRemoteResource,
	recordRemoteRevision,
	saveDeploymentProgress,
	withDeploymentTargetLock,
} from "../store";

const h = setupAppStateTestDb("deployments_");

const AT = "2026-08-06T00:00:00.000Z";
const TARGET = { server: "production" as const, domain: "acme" };

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

describe("creating a deployment", () => {
	it("starts in preflight and is idempotent per target", async () => {
		const scope = await seed();

		const first = await ensureDeployment(scope, TARGET);
		const second = await ensureDeployment(scope, TARGET);

		expect(first.deployment.state).toBe("preflight");
		expect(first.deployment.resumePhase).toBeNull();
		expect(second.deployment.id).toBe(first.deployment.id);
		expect(await readDeploymentsForApp(scope)).toHaveLength(1);
	});

	it("keeps one deployment per project space, not per publish", async () => {
		const scope = await seed();
		await ensureDeployment(scope, TARGET);
		await ensureDeployment(scope, { server: "production", domain: "other" });
		await ensureDeployment(scope, { server: "india", domain: "acme" });

		expect(await readDeploymentsForApp(scope)).toHaveLength(3);
	});
});

describe("phase progress", () => {
	it("stores a refusal with the phase a retry resumes at", async () => {
		const scope = await seed();
		const created = await ensureDeployment(scope, TARGET);

		const refused = applyPhaseOutcome(created.deployment, "release", {
			status: "failed",
			at: AT,
			failure: {
				code: "build_not_installable",
				message: "Nova couldn't reach CommCare HQ.",
				details: [],
			},
		});
		const saved = await saveDeploymentProgress(
			scope,
			created.deployment.id,
			refused,
		);

		expect(saved.deployment.state).toBe("incomplete");
		expect(saved.deployment.resumePhase).toBe("release");
		expect(saved.deployment.phases.release?.status).toBe("failed");
	});

	it("refuses a state and resume phase that disagree", async () => {
		const scope = await seed();
		const created = await ensureDeployment(scope, TARGET);

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

	it("moves last_observed_at only when an observation reached CommCare HQ", async () => {
		const scope = await seed();
		const created = await ensureDeployment(scope, TARGET);

		const quiet = await saveDeploymentProgress(scope, created.deployment.id, {
			state: "uploaded",
			resumePhase: null,
			phases: created.deployment.phases,
		});
		expect(quiet.deployment.lastObservedAt).toBeNull();

		const observed = await saveDeploymentProgress(
			scope,
			created.deployment.id,
			{ state: "built", resumePhase: null, phases: created.deployment.phases },
			{ observed: true },
		);
		expect(observed.deployment.lastObservedAt).not.toBeNull();
	});
});

describe("ownership mappings", () => {
	async function publish(
		scope: DeploymentScope,
		remoteId: string,
		seq: number,
	) {
		const deployment = await ensureDeployment(scope, TARGET);
		return recordRemoteResource(scope, deployment.deployment.id, {
			kind: "app",
			novaResourceId: scope.appId,
			remoteId,
			ownership: "nova-created",
			pushedRevision: seq,
			progress: {
				state: "uploaded",
				resumePhase: null,
				phases: deployment.deployment.phases,
			},
		});
	}

	it("records the remote app and the revision it was built from", async () => {
		const scope = await seed();
		const view = await publish(scope, "hq-1", 7);

		const remote = activeRemoteApp(view);
		expect(remote).toMatchObject({
			remoteId: "hq-1",
			ownership: "nova-created",
			pushedRevision: 7,
		});
		expect(view.deployment.state).toBe("uploaded");
	});

	it("supersedes rather than deletes, so what was left behind stays nameable", async () => {
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

	it("republishing to the SAME remote app is not a supersession", async () => {
		const scope = await seed();
		await publish(scope, "hq-1", 7);
		const again = await publish(scope, "hq-1", 8);

		expect(again.superseded).toHaveLength(0);
		expect(activeRemoteApp(again)?.pushedRevision).toBe(8);
	});

	it("clears observations that described the previous remote app", async () => {
		const scope = await seed();
		const first = await publish(scope, "hq-1", 7);
		await saveDeploymentProgress(
			scope,
			first.deployment.id,
			applyPhaseOutcome(first.deployment, "build", {
				status: "succeeded",
				at: AT,
			}),
		);

		const second = await publish(scope, "hq-2", 9);
		expect(second.deployment.phases.build).toBeNull();
	});

	it("keeps what Nova pushed and what CommCare HQ holds as separate facts", async () => {
		const scope = await seed();
		const view = await publish(scope, "hq-1", 7);
		await recordRemoteRevision(scope, view.deployment.id, {
			kind: "app",
			novaResourceId: scope.appId,
			remoteRevision: 3,
		});

		const reread = await readDeployment(scope, TARGET);
		expect(activeRemoteApp(reread as never)).toMatchObject({
			pushedRevision: 7,
			remoteRevision: 3,
		});
	});
});

describe("tenancy", () => {
	it("hides a deployment from a Project the caller is not in", async () => {
		const scope = await seed();
		await ensureDeployment(scope, TARGET);

		await expect(
			readDeploymentsForApp({ ...scope, projectId: "other-project" }),
		).resolves.toHaveLength(0);
	});

	it("refuses a write once the caller loses membership", async () => {
		const scope = await seed();
		const created = await ensureDeployment(scope, TARGET);
		await sql`DELETE FROM auth_member WHERE "userId" = 'u1'`.execute(h.db());

		await expect(
			saveDeploymentProgress(scope, created.deployment.id, {
				state: "uploaded",
				resumePhase: null,
				phases: created.deployment.phases,
			}),
		).rejects.toThrow();
	});
});

describe("serializing one app's publishes to one project space", () => {
	/* The reason this needs REAL Postgres: the guarantee is a session
	 * advisory lock held across several transactions, and a mocked store
	 * proves nothing about it. Publishing spans preflight, the import that
	 * mints a CommCare HQ app, and the write that records it — so two
	 * publishes overlapping meant TWO apps on the project space and a record
	 * naming whichever committed last.
	 *
	 * These run on their OWN pool. The harness pool is `max: 1`, which would
	 * serialize the two holders at connection checkout and let every
	 * assertion below pass with the advisory lock deleted — a test proving
	 * the pool size, not the lock. With room for both to connect, ordering
	 * can only come from the lock itself. */
	let lockPool: Pool | undefined;

	beforeEach(() => {
		lockPool = new Pool({ connectionString: h.uri(), max: 4 });
		__setAppPoolForTests(lockPool);
	});

	afterEach(async () => {
		__setAppPoolForTests(null);
		await lockPool?.end();
		lockPool = undefined;
	});

	/** Resolves once `body` is known to be running inside the lock. */
	function heldLock(scope: DeploymentScope, target: typeof TARGET) {
		let release!: () => void;
		let entered!: () => void;
		const inside = new Promise<void>((resolve) => {
			release = resolve;
		});
		const hasEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const done = withDeploymentTargetLock(scope, target, async () => {
			entered();
			await inside;
		});
		return { done, hasEntered, release };
	}

	it("makes a second holder wait for the first, with connections to spare", async () => {
		const scope = await seed();
		const first = heldLock(scope, TARGET);
		await first.hasEntered;

		let secondRan = false;
		const second = withDeploymentTargetLock(scope, TARGET, async () => {
			secondRan = true;
		});
		// Long enough that a missing lock would let it through: the pool has
		// three free connections and nothing else is contending.
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(secondRan).toBe(false);

		first.release();
		await Promise.all([first.done, second]);
		expect(secondRan).toBe(true);
	});

	it("lets two DIFFERENT project spaces of one app publish at once", async () => {
		const scope = await seed();
		const acme = heldLock(scope, TARGET);
		await acme.hasEntered;

		// A different target must not queue behind `acme`.
		await expect(
			withDeploymentTargetLock(
				scope,
				{ server: "production", domain: "other-space" },
				async () => "ran",
			),
		).resolves.toBe("ran");

		acme.release();
		await acme.done;
	});

	it("lets two different APPS publish to the same project space at once", async () => {
		const first = await seed("app-1");
		const second = await seed("app-2", "proj-1");
		const held = heldLock(first, TARGET);
		await held.hasEntered;

		await expect(
			withDeploymentTargetLock(second, TARGET, async () => "ran"),
		).resolves.toBe("ran");

		held.release();
		await held.done;
	});

	it("releases the lock when the body throws, so the next publish is not wedged", async () => {
		const scope = await seed();

		await expect(
			withDeploymentTargetLock(scope, TARGET, async () => {
				throw new Error("CommCare HQ refused the upload");
			}),
		).rejects.toThrow(/refused the upload/);

		// A leaked lock would hang here instead of resolving.
		await expect(
			withDeploymentTargetLock(scope, TARGET, async () => "ok"),
		).resolves.toBe("ok");
	});
});
