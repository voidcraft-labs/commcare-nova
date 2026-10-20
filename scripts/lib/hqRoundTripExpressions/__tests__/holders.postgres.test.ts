/**
 * Run holders in the expressions cutover's window: `--settle-holders` settles
 * each lapsed or paused holder through the production reapers, refunding its
 * hold, and leaves a live one alone, which the write then refuses.
 */

import { describe, expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { readPlannedFleet } from "../fleet";
import { runMigrate } from "../run";
import {
	databaseImage,
	fixtureApp,
	seedPreStepApp,
	seedStoredSchemas,
} from "./postgresSeed";

const h = setupAppStateTestDb("hq_expr_holders_", {
	authSchema: "migrated",
});

const OWNER = "owner-expr-holders";
const PROJECT = "project-expr-holders";
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
	await seedPreStepApp(
		h.db(),
		fixtureApp("choices", { appId, projectId: PROJECT, owner: OWNER }),
	);
	const planned = await readPlannedFleet(h.db(), { appId });
	const target = planned.targets.get(appId);
	if (target === undefined) throw new Error(`${appId} has no target.`);
	await seedStoredSchemas(
		h.db(),
		appId,
		target,
		planned.plan.apps.find((app) => app.appId === appId)?.schemaChanges ?? [],
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

function holdersLine(result: Awaited<ReturnType<typeof runMigrate>>) {
	return result.report.all().find((line) => line.section === "holders");
}

describe("holders in the expressions cutover's window", () => {
	it("settles a lapsed edit, a stale build, an abandoned paused build and a stale session, refunding each hold, and then the write proceeds", async () => {
		await h.seedProjectMember(OWNER, PROJECT, "owner");
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
		expect(holdersLine(blocked)).toMatchObject({ live: 0, lapsedOrPaused: 4 });

		const settled = await runMigrate(h.db(), { mode: "settle-holders" });
		expect(settled.outcome).toEqual({ outcome: "ok" });
		expect(holdersLine(settled)).toMatchObject({
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

		const dryRun = await runMigrate(h.db(), { mode: "dry-run" });
		expect(dryRun.outcome).toEqual({ outcome: "ok" });
		const rehearsal = await runMigrate(h.db(), { mode: "rehearse" });
		expect(rehearsal.outcome).toEqual({ outcome: "ok" });
	}, 60_000);

	it("leaves a live holder alone, and the write refuses with nothing written while it is there", async () => {
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
		expect(holdersLine(settled)).toMatchObject({ settledApps: 0, live: 1 });
		expect(await h.readConsumed(OWNER, PERIOD)).toBe(1);
		const image = await databaseImage(h.db());
		const digest = (await runMigrate(h.db(), { mode: "dry-run" })).report
			.all()
			.find((line) => line.section === "fleet")?.planDigest as string;
		for (const options of [
			{ mode: "rehearse" as const },
			{ mode: "execute" as const, expectPlanDigest: digest },
		]) {
			const refused = await runMigrate(h.db(), options);
			expect(refused.outcome).toEqual({
				outcome: "stopped",
				stoppedBy: ["holder"],
			});
			expect(refused.exitCode).toBe(1);
		}
		/* The rehearsal applied no new DDL here: this database is fully
		 * migrated already, so the image compares data alone. */
		expect(await databaseImage(h.db())).toBe(image);
	}, 60_000);
});
