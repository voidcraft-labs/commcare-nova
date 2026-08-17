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
	it("serves Preview's rule from the three columns it consumes", async () => {
		const scope = await seed();
		await publish(scope, "hq-1", 7);

		const records = await readDeploymentPreviewRecords(scope);
		expect(records).toEqual([
			{ state: "uploaded", resumePhase: null, domain: "acme" },
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
