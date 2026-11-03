/**
 * Run holders in the case-writes cutover's window (step 4's cases at
 * `a8af778e`, adapted to this cutover's `source.ts`, `run.ts` and
 * `ledger.ts`), from `main`'s migration prefix.
 *
 * Contract: `--settle-holders` settles each lapsed or paused holder through
 * the production reapers, refunding its hold, and leaves a live one alone,
 * which the write then refuses with nothing written; what it counts as
 * settled is what each reaper reports it reaped, so the line agrees with the
 * census after it.
 *
 * The plausible failures: a settle that clears a holder by hand (no refund,
 * or a live holder cleared), a write that proceeds past a live holder, a
 * count that claims a reap the reaper refused.
 */

import { describe, expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { settleHolders } from "../holders";
import { type RunResult, runMigrate } from "../run";
import { PUBLISH_PLACEMENT_MIGRATION } from "../types";
import { databaseImage, seedPreStepApp } from "./postgresSeed";
import { seedStoredSchemas } from "./storedSchemas";

/* From main's migration prefix: the writer applies the window's ledger
 * itself and refuses any other. */
const h = setupAppStateTestDb("case_writes_holders_", {
	authSchema: "migrated",
	caseStoreMigrationsBefore: PUBLISH_PLACEMENT_MIGRATION,
});

const OWNER = "owner-case-writes-holders";
const PROJECT = "project-case-writes-holders";
const FIXTURE = "targeted-migration-attachment";
const PERIOD = "2026-10";
const LONG_AGO = new Date("2026-01-01T00:00:00Z");

/** A pre-step app holding a run whose reservation is unsettled. */
async function seedHeld(
	appId: string,
	lease: {
		status: "complete" | "generating";
		awaitingInput?: boolean;
		lockExpiresAt?: Date;
		updatedAt?: Date;
	},
): Promise<void> {
	await seedPreStepApp(h.db(), {
		fixtureId: FIXTURE,
		appId,
		projectId: PROJECT,
		owner: OWNER,
	});
	await seedStoredSchemas(h.db(), appId, FIXTURE);
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

function holdersLine(result: RunResult) {
	return result.report.all().find((line) => line.section === "holders");
}

function planDigestOf(result: RunResult): string {
	const digest = result.report
		.all()
		.find((line) => line.section === "fleet")?.planDigest;
	if (typeof digest !== "string")
		throw new Error("The dry run printed no planDigest.");
	return digest;
}

describe("holders in the case-writes cutover's window", () => {
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
		expect(blocked.outcome).toEqual({
			outcome: "stopped",
			stoppedBy: ["holder"],
		});

		const settled = await runMigrate(h.db(), { mode: "settle-holders" });
		expect(settled.outcome).toEqual({ outcome: "ok" });
		expect(holdersLine(settled)).toMatchObject({
			settledApps: 3,
			settledSessions: 1,
			settleFailed: 0,
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
		const image = await databaseImage(h.db());
		const rehearsal = await runMigrate(h.db(), { mode: "rehearse" });
		expect(rehearsal.outcome).toEqual({ outcome: "ok" });
		expect(await databaseImage(h.db())).toBe(image);
	}, 120_000);

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
		expect(holdersLine(settled)).toMatchObject({
			settledApps: 0,
			live: 1,
			liveApps: ["app-a-live-edit"],
		});
		expect(await h.readConsumed(OWNER, PERIOD)).toBe(1);
		const image = await databaseImage(h.db());
		const digest = planDigestOf(await runMigrate(h.db(), { mode: "dry-run" }));
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
		expect(await databaseImage(h.db())).toBe(image);
	}, 120_000);

	it("counts only the sessions the reaper reaped, so the settle line agrees with the census after it", async () => {
		await h.seedProjectMember(OWNER, PROJECT, "owner");
		await h.seedCreditMonth(OWNER, PERIOD, {
			allowance: 100,
			consumed: 1,
			bonus: 0,
		});
		const session = await h.seedDesignSession({
			owner_user_id: OWNER,
			project_id: PROJECT,
			run_id: "run-live-session",
			run_holder_nonce: crypto.randomUUID(),
			run_actor_user_id: OWNER,
			run_lease_expires_at: new Date(Date.now() + 600_000),
			reservation: {
				period: PERIOD,
				reserved: 1,
				settled: false,
				userId: OWNER,
				runId: "run-live-session",
			},
		});
		/* Read an hour ahead, the session's lease has lapsed; the reaper
		 * re-proves its staleness on the locked row at the real time, finds
		 * it live and leaves it. */
		const settled = await settleHolders(Date.now() + 3_600_000);
		expect(settled).toEqual({ appsSettled: 0, sessionsSettled: 0, failed: 0 });
		expect(await h.readDesignSessionRow(session)).toMatchObject({
			run_id: "run-live-session",
		});
		expect(await h.readConsumed(OWNER, PERIOD)).toBe(1);
	}, 60_000);
});
