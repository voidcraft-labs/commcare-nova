/**
 * The record of each member's key the cutover sent: only an execute run
 * that commits leaves a key-readers row, one per member, server and domain
 * whose key it sent, a refused one included, spanning the run's first send
 * to its last; a dry run, a rehearsal, a run refused on its digest and a run
 * a transient read stopped leave none, and every run's report lists each
 * use. The reads are handed to the plan as the Job's reader hands them, with
 * the uses it recorded; what the reader records is `hqRead.test.ts`'s.
 */

import { sql } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import {
	type AppStateTestDb,
	setupAppStateTestDb,
} from "@/lib/db/__tests__/appStateTestDb";
import type { DeploymentReads, KeyUse } from "../hqRead";
import type { BuildPlanOptions } from "../plan";
import { runMigrate } from "../run";
import { fixtureApp, seedFixtureApp } from "./fixtures/seed";

const FIRST_CUTOVER_MIGRATION = "20261015000000_hq_round_trip_fold_horizon";
const PROJECT = "project-keys";
const DOMAIN = "field-ops";
const APP = "app-keys";
const CREATOR = "member-a-creator";
const SECOND = "member-b";
const NO_KEY = "member-c-no-key";

let h: AppStateTestDb;

function useHarness(prefix: string, before?: string) {
	const harness = setupAppStateTestDb(prefix, {
		authSchema: "migrated",
		...(before !== undefined && { caseStoreMigrationsBefore: before }),
	});
	beforeEach(() => {
		h = harness;
	});
}

async function storeKey(userId: string): Promise<void> {
	await sql`
		INSERT INTO user_settings (user_id, commcare_username, commcare_api_key, commcare_server, approved_domains)
		VALUES (${userId}, ${`${userId}@example.org`}, 'ciphertext', 'production',
			${JSON.stringify([{ name: DOMAIN, displayName: "Field ops" }])}::jsonb)
	`.execute(h.db());
}

async function seed(): Promise<void> {
	for (const member of [CREATOR, SECOND, NO_KEY]) {
		await h.seedProjectMember(member, PROJECT, "editor");
	}
	await storeKey(CREATOR);
	await storeKey(SECOND);
	await seedFixtureApp(
		h.db(),
		fixtureApp("navigation-base", {
			appId: APP,
			projectId: PROJECT,
			owner: CREATOR,
		}),
	);
	const seq = await sql<{ seq: string }>`
		SELECT mutation_seq::text AS seq FROM apps WHERE id = ${APP}
	`.execute(h.db());
	const deployment = await sql<{ id: string }>`
		INSERT INTO app_deployments (app_id, project_id, server, domain, state, phases, created_by)
		VALUES (${APP}, ${PROJECT}, 'production', ${DOMAIN}, 'uploaded', '{}'::jsonb, ${CREATOR})
		RETURNING id::text AS id
	`.execute(h.db());
	await sql`
		INSERT INTO app_deployment_resources (deployment_id, kind, nova_resource_id, remote_id,
			ownership, pushed_revision, pushed_at)
		VALUES (${deployment.rows[0]?.id ?? ""}::uuid, 'app', ${APP}, 'hq-app', 'nova-created',
			${Number(seq.rows[0]?.seq ?? "1")}, now())
	`.execute(h.db());
}

/**
 * A reader that sends each qualifying member's key once, a second apart,
 * and is refused by every one, as HQ refuses a key it does not take.
 */
function refusingReader(
	start: string,
	seen: string[][] = [],
	outcome: DeploymentReads["source"] = { kind: "refused", status: 401 },
): BuildPlanOptions {
	return {
		readDeployment: async (_deployment, credentials) => {
			seen.push([...credentials]);
			const at = Date.parse(start);
			const keyUses: KeyUse[] = credentials.map((userId, index) => ({
				userId,
				firstUsedAt: new Date(at + index * 1_000).toISOString(),
				lastUsedAt: new Date(at + index * 1_000 + 500).toISOString(),
			}));
			return { source: outcome, formIds: null, keyUses, sourceAnswer: null };
		},
	};
}

async function keyReaders() {
	const rows = await sql<{
		user_id: string;
		server: string;
		domain: string;
		first_used_at: Date;
		last_used_at: Date;
	}>`
		SELECT user_id, server, domain, first_used_at, last_used_at
		FROM app_migration_notice_key_readers ORDER BY user_id
	`.execute(h.db());
	return rows.rows.map((row) => ({
		userId: row.user_id,
		server: row.server,
		domain: row.domain,
		firstUsedAt: row.first_used_at.toISOString(),
		lastUsedAt: row.last_used_at.toISOString(),
	}));
}

function keyUseLines(report: { all(): readonly Record<string, unknown>[] }) {
	return report
		.all()
		.filter((line) => line.section === "key-use")
		.map((line) => line.userId);
}

describe("a dry run against the database the window starts from", () => {
	useHarness("hq_cutover_keys_prefix_", FIRST_CUTOVER_MIGRATION);

	it("sends the keys, lists each use, and writes nothing, no table included", async () => {
		await seed();
		const before = await sql<{ row: string }>`
			SELECT string_agg(t::text, E'\\n' ORDER BY t.id) AS row FROM apps AS t
		`.execute(h.db());
		const result = await runMigrate(h.db(), {
			mode: "dry-run",
			plan: refusingReader("2026-10-14T09:00:00.000Z"),
		});
		expect(keyUseLines(result.report)).toEqual([CREATOR, SECOND]);
		const table = await sql<{ name: string | null }>`
			SELECT to_regclass('app_migration_notice_key_readers')::text AS name
		`.execute(h.db());
		expect(table.rows[0]?.name).toBeNull();
		const after = await sql<{ row: string }>`
			SELECT string_agg(t::text, E'\\n' ORDER BY t.id) AS row FROM apps AS t
		`.execute(h.db());
		expect(after.rows).toEqual(before.rows);
	}, 60_000);
});

describe("the key-readers record", () => {
	useHarness("hq_cutover_keys_");

	it("is written by an execute run alone: one row per member whose key it sent, a refused one included, and none for a member it skipped", async () => {
		await seed();
		const seen: string[][] = [];
		const dryRun = await runMigrate(h.db(), {
			mode: "dry-run",
			plan: refusingReader("2026-10-14T09:00:00.000Z", seen),
		});
		expect(await keyReaders()).toEqual([]);
		const digest = dryRun.report.all().find((line) => line.section === "fleet")
			?.planDigest as string;

		const rehearsal = await runMigrate(h.db(), {
			mode: "rehearse",
			plan: refusingReader("2026-10-15T09:00:00.000Z", seen),
		});
		expect(rehearsal.outcome).toEqual({ outcome: "ok" });
		expect(keyUseLines(rehearsal.report)).toEqual([CREATOR, SECOND]);
		expect(await keyReaders()).toEqual([]);

		const refused = await runMigrate(h.db(), {
			mode: "execute",
			expectPlanDigest: "0".repeat(64),
			plan: refusingReader("2026-10-15T09:30:00.000Z", seen),
		});
		expect(refused.outcome).toEqual({
			outcome: "stopped",
			stoppedBy: ["digest"],
		});
		expect(keyUseLines(refused.report)).toEqual([CREATOR, SECOND]);
		expect(await keyReaders()).toEqual([]);

		const executed = await runMigrate(h.db(), {
			mode: "execute",
			expectPlanDigest: digest,
			plan: refusingReader("2026-10-15T10:00:00.000Z", seen),
		});
		expect(executed.outcome).toEqual({ outcome: "ok" });
		expect(seen.every((credentials) => !credentials.includes(NO_KEY))).toBe(
			true,
		);
		expect(await keyReaders()).toEqual([
			{
				userId: CREATOR,
				server: "production",
				domain: DOMAIN,
				firstUsedAt: "2026-10-15T10:00:00.000Z",
				lastUsedAt: "2026-10-15T10:00:00.500Z",
			},
			{
				userId: SECOND,
				server: "production",
				domain: DOMAIN,
				firstUsedAt: "2026-10-15T10:00:01.000Z",
				lastUsedAt: "2026-10-15T10:00:01.500Z",
			},
		]);
	}, 120_000);

	it("leaves no row after a run a transient read stopped", async () => {
		await seed();
		const stopped = await runMigrate(h.db(), {
			mode: "rehearse",
			plan: refusingReader("2026-10-15T09:00:00.000Z", [], {
				kind: "transient",
				cause: "5xx",
			}),
		});
		expect(stopped.outcome).toEqual({
			outcome: "stopped",
			stoppedBy: ["transient"],
		});
		expect(keyUseLines(stopped.report)).toEqual([CREATOR, SECOND]);
		expect(await keyReaders()).toEqual([]);
	}, 60_000);

	it("records no member whose key only an earlier dry run sent", async () => {
		await seed();
		await runMigrate(h.db(), {
			mode: "dry-run",
			plan: refusingReader("2026-10-14T09:00:00.000Z"),
		});
		await sql`
			DELETE FROM auth_member
			WHERE "userId" = ${SECOND} AND "organizationId" = ${PROJECT}
		`.execute(h.db());
		const plan = refusingReader("2026-10-15T10:00:00.000Z");
		const dryRun = await runMigrate(h.db(), { mode: "dry-run", plan });
		const digest = dryRun.report.all().find((line) => line.section === "fleet")
			?.planDigest as string;
		const executed = await runMigrate(h.db(), {
			mode: "execute",
			expectPlanDigest: digest,
			plan,
		});
		expect(executed.outcome).toEqual({ outcome: "ok" });
		expect((await keyReaders()).map((row) => row.userId)).toEqual([CREATOR]);
	}, 120_000);
});
