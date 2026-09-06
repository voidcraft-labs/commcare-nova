import { describe, expect, it } from "vitest";
import { whileBlocked } from "@/__tests__/helpers/postgresBarrier";
import {
	claimAndReserveRun,
	hasActiveGeneration,
	listApps,
	listAppsAcrossProjects,
	listAppsByOwner,
	reserveForNewBuild,
} from "../apps";
import {
	claimAndReserveDesignSessionRun,
	createAndClaimDesignSessionRun,
} from "../designSessions";
import { getCurrentPeriod } from "../period";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("scan_cleanup_");
const ACTOR = "scan-owner";
const PROJECT = "scan-project";
const NONCE = "00000000-0000-4000-8000-000000000001";
const OLD = "00000000-0000-4000-8000-000000000002";
const NEW = "00000000-0000-4000-8000-000000000003";
const expired = new Date("2020-01-01T00:00:00Z");

async function seedAbandoned(kind: "app" | "design-session" | "edit") {
	const period = getCurrentPeriod();
	await h.seedCreditMonth(ACTOR, period, {
		allowance: 1000,
		consumed: 100,
		bonus: 0,
	});
	const reservation = {
		period,
		reserved: 100,
		settled: false,
		userId: ACTOR,
		runId: "old-run",
	};
	if (kind === "design-session") {
		await h.seedDesignSession({
			id: OLD,
			owner_user_id: ACTOR,
			project_id: PROJECT,
			run_id: "old-run",
			run_holder_nonce: NONCE,
			run_actor_user_id: ACTOR,
			run_lease_expires_at: expired,
			updated_at: expired,
			reservation,
		});
	} else {
		await h.seedApp({
			id: OLD,
			owner: ACTOR,
			project_id: PROJECT,
			status: kind === "edit" ? "complete" : "generating",
			run_id: "old-run",
			run_holder_nonce: NONCE,
			updated_at: expired,
			reservation,
			...(kind === "edit" && {
				run_lock: { runId: "old-run", actorUserId: ACTOR, expireAt: expired },
			}),
		});
	}
}

const admissions = [
	"advisory scan",
	"app claim",
	"new app reservation",
	"new design session",
	"design session claim",
] as const;

describe("admission owns its post-commit stale cleanup", () => {
	for (const kind of ["app", "design-session"] as const) {
		it.each(admissions)(
			`%s waits for the stale ${kind} refund`,
			async (entry) => {
				await seedAbandoned(kind);
				if (entry === "app claim" || entry === "new app reservation") {
					await h.seedApp({
						id: NEW,
						owner: ACTOR,
						project_id: PROJECT,
						status: entry === "app claim" ? "complete" : "generating",
						...(entry === "new app reservation" && {
							run_id: "new-run",
							run_holder_nonce: NONCE,
						}),
					});
				} else if (entry === "design session claim") {
					await h.seedDesignSession({
						id: NEW,
						owner_user_id: ACTOR,
						project_id: PROJECT,
					});
				}
				const table = kind === "app" ? "apps" : "design_sessions";
				const result = await whileBlocked(
					h,
					(pg) =>
						pg.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [OLD]),
					async () => {
						switch (entry) {
							case "advisory scan":
								return hasActiveGeneration(ACTOR);
							case "app claim":
								return claimAndReserveRun(
									NEW,
									"build",
									"new-run",
									ACTOR,
									20,
									PROJECT,
									NONCE,
								);
							case "new app reservation":
								return reserveForNewBuild(
									NEW,
									ACTOR,
									20,
									"new-run",
									PROJECT,
									NONCE,
								);
							case "new design session":
								return createAndClaimDesignSessionRun({
									projectId: PROJECT,
									actorUserId: ACTOR,
									runId: "new-run",
									cost: 20,
									holderNonce: NONCE,
								});
							case "design session claim":
								return claimAndReserveDesignSessionRun(
									NEW,
									"new-run",
									ACTOR,
									20,
									PROJECT,
									NONCE,
								);
						}
					},
					async (settled, pg) => {
						expect(settled).toBe(false);
						const credits = await pg.query(
							"SELECT consumed FROM credit_months WHERE user_id = $1",
							[ACTOR],
						);
						// New admission has COMMITTED before the old row is reaped. Reaping
						// inside that transaction would deadlock on its own actor gate.
						expect(credits.rows).toEqual([
							{ consumed: entry === "advisory scan" ? 100 : 120 },
						]);
					},
				);
				if (entry === "advisory scan") expect(result).toBe(false);
				expect(await h.readConsumed(ACTOR, getCurrentPeriod())).toBe(
					entry === "advisory scan" ? 0 : 20,
				);
				if (kind === "app") {
					expect(await h.readAppRow(OLD)).toMatchObject({
						status: "error",
						res_settled: true,
						res_run_id: null,
					});
				} else {
					expect(await h.readDesignSessionRow(OLD)).toMatchObject({
						state: "active",
						run_id: null,
						res_run_id: null,
						res_reserved: null,
					});
				}
			},
		);
	}
});

describe("listing owns stale cleanup without changing its snapshot cursor", () => {
	for (const kind of ["app", "edit"] as const) {
		it.each(["project", "owner", "projects"] as const)(
			`%s listing waits for the stale ${kind}`,
			async (scope) => {
				await seedAbandoned(kind);
				await h.seedApp({
					id: NEW,
					owner: ACTOR,
					project_id: PROJECT,
					status: "complete",
					updated_at: new Date("2021-01-01T00:00:00Z"),
				});
				const options = { limit: 1, sort: "updated_asc" as const };
				const list = (cursor?: string) => {
					const query = { ...options, cursor };
					return scope === "project"
						? listApps(PROJECT, query)
						: scope === "owner"
							? listAppsByOwner(ACTOR, query)
							: listAppsAcrossProjects([PROJECT], query);
				};
				const page = await whileBlocked(
					h,
					(pg) =>
						pg.query("SELECT id FROM apps WHERE id = $1 FOR UPDATE", [OLD]),
					() => list(),
					async (settled) => {
						expect(settled).toBe(false);
					},
				);
				expect(page.apps).toHaveLength(1);
				expect(page.apps[0]).toMatchObject({
					id: OLD,
					status: kind === "app" ? "error" : "complete",
					updated_at: expired.toISOString(),
				});
				expect(await h.readConsumed(ACTOR, getCurrentPeriod())).toBe(0);
				expect(await h.readAppRow(OLD)).toMatchObject({
					res_settled: true,
					lock_run_id: null,
				});
				expect(page.nextCursor).toBeTypeOf("string");
				const next = await list(page.nextCursor);
				expect(next.apps.map((app) => app.id)).toEqual([NEW]);
			},
		);
	}
});
