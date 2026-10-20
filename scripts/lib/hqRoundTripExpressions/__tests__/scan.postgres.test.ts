/**
 * The advisory scan over a seeded pre-step database (part 09 §15, the scan
 * row): its counts per step, blocker, holder and private work, and that it
 * runs whole as a role holding only `SELECT`, which proves it takes no lock
 * and writes nothing.
 */

import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import type { AppDatabase } from "@/lib/db/pg";
import { readPlannedFleet } from "../fleet";
import type { ReportLine } from "../report";
import { runScan } from "../run";
import {
	databaseImage,
	fixtureApp,
	readFixtureManifest,
	seedCase,
	seedPreStepApp,
	seedStoredSchemas,
} from "./postgresSeed";

const h = setupAppStateTestDb("hq_expr_scan_", { authSchema: "migrated" });

const OWNER = "owner-expr-scan";
const PROJECT = "project-expr-scan";

function section(lines: readonly ReportLine[], name: string) {
	return lines.filter((line) => line.section === name);
}

async function seedApp(id: string, appId: string): Promise<void> {
	await seedPreStepApp(
		h.db(),
		fixtureApp(id, { appId, projectId: PROJECT, owner: OWNER }),
	);
	const planned = await readPlannedFleet(h.db(), { appId });
	const target = planned.targets.get(appId);
	if (target === undefined) return;
	await seedStoredSchemas(
		h.db(),
		appId,
		target,
		planned.plan.apps.find((app) => app.appId === appId)?.schemaChanges ?? [],
	);
}

/** A client whose role may only read: any write, lock or DDL fails. */
async function selectOnlyReader(): Promise<{
	reader: Kysely<AppDatabase>;
	close: () => Promise<void>;
}> {
	const role = `expr_scan_reader_${randomUUID().replaceAll("-", "")}`;
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
	it("counts each step, blocker, holder and private work, as a role that may only read", async () => {
		await h.seedProjectMember(OWNER, PROJECT, "owner");
		await seedApp("choices", "app-a-choices");
		await seedApp("form-logic", "app-b-form-logic");
		await seedApp("untyped-case-query", "app-c-untyped");
		await seedApp("hidden-writer-mismatch", "app-d-mismatch");
		await seedApp("orphan-read-property", "app-e-orphan");
		const orphan = readFixtureManifest().find(
			(fixture) => fixture.id === "orphan-read-property",
		)?.context?.cases as
			| { caseType: string; properties: Record<string, unknown> }[]
			| undefined;
		for (const [index, value] of (orphan ?? []).entries()) {
			await seedCase(h.db(), {
				caseId: `orphan-${index}`,
				appId: "app-e-orphan",
				projectId: PROJECT,
				caseType: value.caseType,
				ownerId: OWNER,
				properties: value.properties,
			});
		}
		await seedApp("catalog-rules", "app-f-live");
		await h
			.db()
			.updateTable("apps")
			.set({
				run_id: "run-live",
				run_holder_nonce: randomUUID(),
				lock_run_id: "run-live",
				lock_actor_user_id: OWNER,
				lock_expire_at: new Date(Date.now() + 600_000),
			})
			.where("id", "=", "app-f-live")
			.execute();
		const workId = randomUUID();
		await sql`
			INSERT INTO authoring_sessions (id, actor_user_id, project_id, origin, app_id, app_name,
				begin_request_id, begin_input_digest)
			VALUES (${workId}::uuid, ${OWNER}, ${PROJECT}, 'mcp', 'app-a-choices', 'Choices',
				'begin', repeat('a', 64))
		`.execute(h.db());
		const candidateId = randomUUID();
		await sql`
			INSERT INTO authoring_workspaces (id, authoring_session_id, kind, app_id, base_seq,
				base_project_id, base_snapshot_digest, owner_user_id, status)
			VALUES (${candidateId}::uuid, ${workId}::uuid, 'app-edit', 'app-a-choices', 1,
				${PROJECT}, repeat('b', 64), ${OWNER}, 'open')
		`.execute(h.db());
		await sql`
			UPDATE authoring_sessions SET active_candidate_id = ${candidateId}::uuid
			WHERE id = ${workId}::uuid
		`.execute(h.db());

		const image = await databaseImage(h.db());
		const { reader, close } = await selectOnlyReader();
		try {
			const result = await runScan(reader);
			const lines = result.report.all();
			expect(lines.every((line) => line.mode === "scan")).toBe(true);
			expect(result.exitCode).toBe(1);
			expect(section(lines, "fleet")[0]).toMatchObject({
				apps: 6,
				appsDeleted: 0,
				planDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
				fleetSeqDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
				ledger: { foldHorizonApplied: true, pendingMigrations: [] },
			});
			expect(section(lines, "holders")[0]).toMatchObject({ live: 1 });
			expect(section(lines, "private-work")[0]).toMatchObject({
				openWorkspaces: 1,
				activeCandidates: 1,
			});
			const blockers = Object.fromEntries(
				section(lines, "blocker").map((line) => [line.code, line]),
			);
			expect(blockers["expression-parse-refused"]).toMatchObject({
				apps: ["app-c-untyped"],
				findingCodes: expect.arrayContaining(["case-query-untyped"]),
			});
			expect(blockers["target-gate"]).toMatchObject({
				apps: expect.arrayContaining(["app-d-mismatch"]),
				findingCodes: expect.arrayContaining([
					"HIDDEN_VALUE_WRITER_TYPE_MISMATCH",
				]),
			});
			expect(blockers["declared-property-has-stored-values"]).toMatchObject({
				apps: ["app-e-orphan"],
			});
			// Each step the clean fixtures witness counts its changes.
			const steps = (section(lines, "steps")[0]?.steps ?? []) as {
				step: string;
				classes: { class: string; apps: number; changes: number }[];
			}[];
			for (const step of [
				"catalog-rules",
				"record-expressions",
				"form-logic-lift",
				"repeat-read-first-row",
			]) {
				expect(
					steps
						.find((entry) => entry.step === step)
						?.classes.some((entry) => entry.changes > 0),
					`the report counts ${step}`,
				).toBe(true);
			}
			expect(section(lines, "outcome")[0]).toMatchObject({
				outcome: "stopped",
				stoppedBy: ["blocker", "holder"],
			});
		} finally {
			await close();
		}
		expect(await databaseImage(h.db())).toBe(image);
	}, 60_000);

	it("scans one app, and reports a clean fleet as ok", async () => {
		await h.seedProjectMember(OWNER, PROJECT, "owner");
		await seedApp("choices", "app-a-choices");
		await seedApp("untyped-case-query", "app-b-untyped");
		const { reader, close } = await selectOnlyReader();
		try {
			const one = await runScan(reader, { appId: "app-a-choices" });
			expect(section(one.report.all(), "fleet")[0]).toMatchObject({ apps: 1 });
			expect(one.outcome).toEqual({ outcome: "ok" });
			expect(one.exitCode).toBe(0);
		} finally {
			await close();
		}
	}, 60_000);
});
