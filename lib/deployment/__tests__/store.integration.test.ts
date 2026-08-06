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
import { describe, expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { activeRemoteApp } from "../resources";
import { applyPhaseOutcome } from "../stateMachine";
import {
	adoptRemoteResource,
	type DeploymentScope,
	ensureDeployment,
	readDeployment,
	readDeploymentsForApp,
	recordRemoteResource,
	recordRemoteRevision,
	saveDeploymentProgress,
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

	it("refuses to let two apps in one Project claim the same CommCare HQ app", async () => {
		const scope = await seed("app-1");
		const other = await seed("app-2");
		await publish(scope, "hq-shared", 7);

		const deployment = await ensureDeployment(other, TARGET);
		await expect(
			recordRemoteResource(other, deployment.deployment.id, {
				kind: "app",
				novaResourceId: other.appId,
				remoteId: "hq-shared",
				ownership: "adopted",
				pushedRevision: null,
				requireUnclaimed: true,
				progress: {
					state: "uploaded",
					resumePhase: null,
					phases: deployment.deployment.phases,
				},
			}),
		).rejects.toThrow(/cannot share one CommCare HQ app/i);
	});

	it("lets exactly one of two SIMULTANEOUS adoptions of the same app win", async () => {
		/* The sequential case above would pass with the advisory lock
		 * removed, because the second adoption sees the first's committed
		 * row. This is the case the lock exists for: two DIFFERENT Nova apps
		 * claim one CommCare HQ app at once, so they lock two different
		 * `apps` rows, `FOR SHARE` does not conflict with `FOR SHARE`, and
		 * they write two different `deployment_id`s — nothing else in the
		 * schema would stop them both succeeding. */
		const first = await seed("app-1");
		const second = await seed("app-2");

		const results = await Promise.allSettled(
			[first, second].map((scope) =>
				adoptRemoteResource(scope, TARGET, {
					kind: "app",
					novaResourceId: scope.appId,
					remoteId: "hq-contended",
					ownership: "adopted",
					pushedRevision: null,
					requireUnclaimed: true,
					progress: (deployment) => ({
						state: "uploaded",
						resumePhase: null,
						phases: deployment.phases,
					}),
				}),
			),
		);

		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find((r) => r.status === "rejected");
		expect(String((rejected as PromiseRejectedResult).reason)).toMatch(
			/cannot share one CommCare HQ app/i,
		);
	});

	it("leaves no deployment behind when the claim is refused", async () => {
		/* Adoption creates the deployment and claims the app in ONE
		 * transaction. Two transactions would commit a `preflight` record
		 * naming a project space this app never reached, and it would show
		 * up in the builder and in `get_deployment` ever after. */
		const owner = await seed("app-1");
		const loser = await seed("app-2");
		await publish(owner, "hq-owned", 1);

		await expect(
			adoptRemoteResource(loser, TARGET, {
				kind: "app",
				novaResourceId: loser.appId,
				remoteId: "hq-owned",
				ownership: "adopted",
				pushedRevision: null,
				requireUnclaimed: true,
				progress: (deployment) => ({
					state: "uploaded",
					resumePhase: null,
					phases: deployment.phases,
				}),
			}),
		).rejects.toThrow(/cannot share one CommCare HQ app/i);

		await expect(readDeploymentsForApp(loser)).resolves.toHaveLength(0);
	});

	it("records who adopted an id this deployment had created itself", async () => {
		const scope = await seed();
		await publish(scope, "hq-1", 7);
		const deployment = await ensureDeployment(scope, TARGET);
		const adopted = await recordRemoteResource(
			scope,
			deployment.deployment.id,
			{
				kind: "app",
				novaResourceId: scope.appId,
				remoteId: "hq-1",
				ownership: "adopted",
				pushedRevision: null,
				requireUnclaimed: true,
				progress: {
					state: "uploaded",
					resumePhase: null,
					phases: deployment.deployment.phases,
				},
			},
		);

		const remote = activeRemoteApp(adopted);
		expect(remote?.ownership).toBe("adopted");
		expect(remote?.adoptedBy).toBe("u1");
		expect(remote?.adoptedAt).not.toBeNull();
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
