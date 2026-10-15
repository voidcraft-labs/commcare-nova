/**
 * Run holders in the cutover's window: `--settle-holders` settles each
 * lapsed or paused holder through the production reapers, refunding its
 * hold, and leaves a live one alone, which the write then refuses.
 */

import { describe, expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { runMigrate } from "../run";
import { fixtureApp, seedFixtureApp } from "./fixtures/seed";

const h = setupAppStateTestDb("hq_cutover_holders_", {
	authSchema: "migrated",
});

const OWNER = "owner-holders";
const PROJECT = "project-holders";
const PERIOD = "2026-10";
const LONG_AGO = new Date("2026-01-01T00:00:00Z");

async function seedHeld(
	appId: string,
	lease: {
		status: "complete" | "generating";
		awaitingInput?: boolean;
		lockExpiresAt?: Date;
		updatedAt?: Date;
	},
): Promise<void> {
	await seedFixtureApp(
		h.db(),
		fixtureApp("navigation-base", { appId, projectId: PROJECT, owner: OWNER }),
	);
	const runId = `run-${appId}`;
	await h
		.db()
		.updateTable("apps")
		.set({
			status: lease.status,
			awaiting_input: lease.awaitingInput ?? false,
			run_id: runId,
			run_holder_nonce: crypto.randomUUID(),
			res_period: PERIOD,
			res_reserved: 1,
			res_settled: false,
			res_user_id: OWNER,
			res_run_id: runId,
			...(lease.lockExpiresAt !== undefined && {
				lock_run_id: runId,
				lock_actor_user_id: OWNER,
				lock_expire_at: lease.lockExpiresAt,
			}),
			...(lease.updatedAt !== undefined && { updated_at: lease.updatedAt }),
		})
		.where("id", "=", appId)
		.execute();
}

describe("holders in the window", () => {
	it("settles a lapsed edit, a stale build and an abandoned paused build, refunding each hold, and then the write proceeds", async () => {
		await h.seedProjectMember(OWNER, PROJECT, "owner");
		await h.seedCreditMonth(OWNER, PERIOD, {
			allowance: 100,
			consumed: 3,
			bonus: 0,
		});
		await seedHeld("app-a-lapsed-edit", {
			status: "complete",
			lockExpiresAt: LONG_AGO,
		});
		await seedHeld("app-b-stale-build", {
			status: "generating",
			updatedAt: LONG_AGO,
		});
		await seedHeld("app-c-paused-build", {
			status: "generating",
			awaitingInput: true,
			updatedAt: LONG_AGO,
		});
		await h.seedCreditMonth(OWNER, PERIOD, {
			allowance: 100,
			consumed: 4,
			bonus: 0,
		});
		const session = await h.seedDesignSession({
			owner_user_id: OWNER,
			project_id: PROJECT,
			run_id: "run-stale-session",
			run_holder_nonce: crypto.randomUUID(),
			run_actor_user_id: OWNER,
			run_lease_expires_at: LONG_AGO,
			reservation: {
				period: PERIOD,
				reserved: 1,
				settled: false,
				userId: OWNER,
				runId: "run-stale-session",
			},
		});

		const blocked = await runMigrate(h.db(), { mode: "dry-run" });
		expect(
			blocked.report.all().find((line) => line.section === "holders"),
		).toMatchObject({ live: 0, lapsedOrPaused: 4 });

		const settled = await runMigrate(h.db(), { mode: "settle-holders" });
		expect(settled.outcome).toEqual({ outcome: "ok" });
		expect(
			settled.report.all().find((line) => line.section === "holders"),
		).toMatchObject({
			settledApps: 3,
			settledSessions: 1,
			live: 0,
			lapsedOrPaused: 0,
			unsettledHolds: 0,
		});
		expect(await h.readConsumed(OWNER, PERIOD)).toBe(0);
		expect(await h.readDesignSessionRow(session)).toMatchObject({
			run_id: null,
			res_period: null,
		});

		const rehearsal = await runMigrate(h.db(), { mode: "rehearse" });
		expect(rehearsal.outcome).toEqual({ outcome: "ok" });
	}, 30_000);

	it("leaves a live holder alone, and the write refuses while it is there", async () => {
		await h.seedProjectMember(OWNER, PROJECT, "owner");
		await h.seedCreditMonth(OWNER, PERIOD, {
			allowance: 100,
			consumed: 1,
			bonus: 0,
		});
		await seedHeld("app-a-live-edit", {
			status: "complete",
			lockExpiresAt: new Date(Date.now() + 600_000),
		});
		const settled = await runMigrate(h.db(), { mode: "settle-holders" });
		expect(
			settled.report.all().find((line) => line.section === "holders"),
		).toMatchObject({ settledApps: 0, live: 1 });
		expect(await h.readConsumed(OWNER, PERIOD)).toBe(1);
		const rehearsal = await runMigrate(h.db(), { mode: "rehearse" });
		expect(rehearsal.outcome).toEqual({
			outcome: "stopped",
			stoppedBy: ["holder"],
		});
	}, 30_000);
});
