/**
 * The advisory scan over a seeded pre-step database (step 5's part 09,
 * section 6 and the Tests row for this file), from `main`'s migration
 * prefix, run as a role holding only `SELECT`.
 *
 * Contract: the scan reads everything the plan decides from in one
 * read-only snapshot of plain `SELECT`s, prints the plan's content-free
 * lines with no digest, stops where the dry run would on a blocker, and
 * leaves the database byte-identical; once the cutover has committed it
 * reads the ledger and the markers and prints `already-applied` alone.
 *
 * The plausible failures it separates: a scan that takes a row lock (`FOR
 * SHARE` or `FOR UPDATE` needs the `UPDATE` privilege, so the role's read
 * fails), writes or applies DDL (the role holds no other privilege, and the
 * image would move), reads its fleet outside one snapshot, or reads past
 * the two reads once the cutover ran.
 */

import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import type { AppDatabase } from "@/lib/db/pg";
import type { ReportLine } from "../report";
import { runDebugDetails, runMigrate, runScan } from "../run";
import { PENDING_MIGRATIONS, PUBLISH_PLACEMENT_MIGRATION } from "../types";
import {
	databaseImage,
	PUBLISHED_FIXTURE,
	seedMutationEvents,
	seedPreStepFleet,
	seedPrivateWork,
	seedPublishedDeployments,
} from "./postgresSeed";
import { PRE_STEP_FIXTURE_IDS } from "./rawFixture";
import { seedStoredSchemas } from "./storedSchemas";

const h = setupAppStateTestDb("case_writes_scan_", {
	authSchema: "migrated",
	caseStoreMigrationsBefore: PUBLISH_PLACEMENT_MIGRATION,
});

const OWNER = "owner-case-writes-scan";
const PROJECT = "project-case-writes-scan";
/** The one fixture a blocker stops (part 09 §7.4's C9 arm under `forEach`). */
const BLOCKED = "pre-step-own-close-operation";
const WORK_FIXTURE = "targeted-migration-attachment";

function section(lines: readonly ReportLine[], name: string) {
	return lines.find((line) => line.section === name);
}

/** A fleet of the given fixtures, one more deleted, each with its stored
 *  schemas. */
async function seedFleet(fixtureIds: readonly string[]) {
	const db = h.db();
	await h.seedProjectMember(OWNER, PROJECT, "owner");
	const fleet = await seedPreStepFleet(db, {
		fixtureIds,
		projectId: PROJECT,
		owner: OWNER,
	});
	for (const [fixtureId, appId] of fleet.byFixture)
		await seedStoredSchemas(db, appId, fixtureId);
	const [first] = fixtureIds;
	if (first === undefined) throw new Error("No fixture to seed.");
	await seedStoredSchemas(db, fleet.deletedAppId, first);
	return fleet;
}

/** A client whose role may only read: any write, row lock or DDL fails. */
async function selectOnlyReader(): Promise<{
	reader: Kysely<AppDatabase>;
	close: () => Promise<void>;
}> {
	const role = `case_writes_scan_reader_${randomUUID().replaceAll("-", "")}`;
	await sql`CREATE ROLE ${sql.id(role)} NOLOGIN`.execute(h.db());
	await sql`GRANT USAGE ON SCHEMA public TO ${sql.id(role)}`.execute(h.db());
	await sql`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${sql.id(role)}`.execute(
		h.db(),
	);
	const pool = new Pool({
		connectionString: h.uri(),
		options: `-c role=${role}`,
		max: 1,
	});
	const reader = new Kysely<AppDatabase>({
		dialect: new PostgresDialect({ pool }),
	});
	return {
		reader,
		close: async () => {
			await reader.destroy();
			await sql`DROP OWNED BY ${sql.id(role)}`.execute(h.db());
			await sql`DROP ROLE ${sql.id(role)}`.execute(h.db());
		},
	};
}

describe("the advisory scan", () => {
	it("prints the plan's lines as a role that may only read, stops on the blocker, and changes nothing", async () => {
		const fleet = await seedFleet(PRE_STEP_FIXTURE_IDS);
		const publishedAppId = fleet.byFixture.get(PUBLISHED_FIXTURE);
		const workAppId = fleet.byFixture.get(WORK_FIXTURE);
		const blockedAppId = fleet.byFixture.get(BLOCKED);
		if (
			publishedAppId === undefined ||
			workAppId === undefined ||
			blockedAppId === undefined
		)
			throw new Error("The fleet lacks a fixture the scan reads.");
		await seedPublishedDeployments(h.db(), {
			appId: publishedAppId,
			projectId: PROJECT,
		});
		await seedPrivateWork(h, {
			appId: workAppId,
			projectId: PROJECT,
			owner: OWNER,
		});
		await seedMutationEvents(h.db(), workAppId);
		const image = await databaseImage(h.db());
		const { reader, close } = await selectOnlyReader();
		try {
			const result = await runScan(reader);
			const lines = result.report.all();
			expect(result.outcome).toEqual({
				outcome: "stopped",
				stoppedBy: ["blocker"],
			});
			expect(result.exitCode).toBe(1);
			expect(lines.map((line) => line.mode)).toEqual(lines.map(() => "scan"));
			expect(section(lines, "fleet")).toMatchObject({
				apps: fleet.appIds.length,
				appsDeleted: 1,
				appsPlanned: fleet.appIds.length,
				appsBlocked: 1,
				planDigest: null,
				ledger: {
					horizonApplied: false,
					pendingMigrations: [...PENDING_MIGRATIONS],
				},
			});
			expect(section(lines, "placements")).toMatchObject({
				publishedApps: 1,
				deployments: { readable: 1, shell: 1, unread: 1 },
				appsHolding: [publishedAppId],
			});
			expect(section(lines, "private-work")).toMatchObject({
				openWorkspaces: 1,
				activeCandidates: 1,
				preAppSessions: 1,
				mutationEvents: 2,
				apps: [workAppId],
			});
			expect(section(lines, "holders")).toMatchObject({
				live: 0,
				lapsedOrPaused: 0,
				unsettledHolds: 0,
			});
			/* C9's blocker first, then what the judgement finds over the
			 * document it left; every one in the blocked app alone. */
			const blockers = lines.filter((line) => line.section === "blocker");
			expect(blockers[0]).toMatchObject({ code: "own-close-in-repeat" });
			for (const blocker of blockers)
				expect(blocker).toMatchObject({ apps: [blockedAppId] });
			expect(lines.at(-1)?.section).toBe("outcome");

			/* One app: the planned apps are that one, the fleet's counts every
			 * app. */
			const one = await runScan(reader, { appId: workAppId });
			expect(one.outcome).toEqual({ outcome: "ok" });
			expect(section(one.report.all(), "fleet")).toMatchObject({
				apps: fleet.appIds.length,
				appsPlanned: 1,
				appsBlocked: 0,
			});

			const details = await runDebugDetails(reader, blockedAppId);
			expect(details[0]).toContain(`app ${blockedAppId}`);
			expect(
				details.some((line) => line.startsWith("blocker own-close-in-repeat")),
			).toBe(true);
		} finally {
			await close();
		}
		expect(await databaseImage(h.db())).toBe(image);
	}, 180_000);

	it("once the cutover committed, reads the ledger and the markers alone and prints already-applied", async () => {
		await seedFleet([WORK_FIXTURE, PUBLISHED_FIXTURE]);
		const dryRun = await runMigrate(h.db(), { mode: "dry-run" });
		expect(dryRun.outcome).toEqual({ outcome: "ok" });
		const digest = section(dryRun.report.all(), "fleet")?.planDigest;
		if (typeof digest !== "string")
			throw new Error("The dry run printed no planDigest.");
		const executed = await runMigrate(h.db(), {
			mode: "execute",
			expectPlanDigest: digest,
		});
		expect(executed.outcome).toEqual({ outcome: "ok" });

		const { reader, close } = await selectOnlyReader();
		try {
			const scan = await runScan(reader);
			expect(scan.outcome).toEqual({ outcome: "already-applied" });
			expect(scan.exitCode).toBe(0);
			expect(scan.report.all().map((line) => line.section)).toEqual([
				"fleet",
				"outcome",
			]);
			expect(section(scan.report.all(), "fleet")).toMatchObject({
				ledger: { horizonApplied: true, pendingMigrations: [] },
				markers: { apps: 3, marked: 3 },
			});
		} finally {
			await close();
		}
		for (const mode of ["dry-run", "settle-holders", "rehearse"] as const) {
			const again = await runMigrate(h.db(), { mode });
			expect(again.outcome, mode).toEqual({ outcome: "already-applied" });
		}
	}, 180_000);
});
