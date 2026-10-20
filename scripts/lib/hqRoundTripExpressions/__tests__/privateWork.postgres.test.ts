/**
 * Private agent work across the expressions cutover: every open candidate is
 * abandoned and its pointer cleared, the saved app answers the next read, the
 * next edit opens a candidate at the new head, a pre-app build that held work
 * ends as a discarded one does, one that held none is byte-identical, and each
 * app that lost work is told so.
 *
 * The open work is staged as the rows the pre-step revision left: no writer
 * at the head can stage a step over a pre-step document, which does not load
 * here.
 */

import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { executeWorkTool, getWork } from "@/lib/agent/authoring/session";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { restoreApp } from "@/lib/db/apps";
import { readPlannedFleet } from "../fleet";
import { runMigrate } from "../run";
import {
	fixtureApp,
	readFixtureCarriers,
	seedPreStepApp,
	seedStoredSchemas,
} from "./postgresSeed";

const h = setupAppStateTestDb("hq_expr_private_work_", {
	authSchema: "migrated",
});

const OWNER = "owner-expr-private-work";
const PROJECT = "project-expr-private-work";
const host = { kind: "mcp" } as const;
/** `choices` is a document every step of which leaves an export-ready app. */
const FIXTURE = "choices";

async function seedApp(appId: string, deletedAt?: Date): Promise<void> {
	await seedPreStepApp(h.db(), {
		...fixtureApp(FIXTURE, { appId, projectId: PROJECT, owner: OWNER }),
		...(deletedAt !== undefined && { deletedAt }),
	});
	const planned = await readPlannedFleet(h.db(), { appId });
	const target = planned.targets.get(appId);
	if (target === undefined) throw new Error(`${appId} has no target.`);
	await seedStoredSchemas(
		h.db(),
		appId,
		target,
		planned.plan.apps.find((app) => app.appId === appId)?.schemaChanges ?? [],
	);
}

/**
 * An MCP work session on an app holding one unsaved staged edit: its open
 * candidate, based at the app's pre-step sequence, and the session's pointer
 * to it. Returns the work id.
 */
async function stageUnsavedWork(appId: string): Promise<string> {
	const workId = randomUUID();
	const candidateId = randomUUID();
	await sql`
		INSERT INTO authoring_sessions (id, actor_user_id, project_id, origin, app_id, app_name,
			begin_request_id, begin_input_digest)
		VALUES (${workId}::uuid, ${OWNER}, ${PROJECT}, 'mcp', ${appId}, 'Choices',
			${`begin-${appId}`}, repeat('a', 64))
	`.execute(h.db());
	await sql`
		INSERT INTO authoring_workspaces (id, authoring_session_id, design_session_id, plan_revision,
			kind, app_id, proposed_app_id, base_seq, base_project_id, base_snapshot_digest,
			next_ordinal, exclusive_kind, owner_user_id, owner_run_id, status)
		VALUES (${candidateId}::uuid, ${workId}::uuid, NULL, NULL, 'app-edit', ${appId}, NULL, 1,
			${PROJECT}, repeat('b', 64), 1, NULL, ${OWNER}, NULL, 'open')
	`.execute(h.db());
	await sql`
		UPDATE authoring_sessions SET active_candidate_id = ${candidateId}::uuid
		WHERE id = ${workId}::uuid
	`.execute(h.db());
	return workId;
}

async function execute(): Promise<void> {
	const dryRun = await runMigrate(h.db(), { mode: "dry-run" });
	expect(dryRun.outcome).toEqual({ outcome: "ok" });
	const digest = dryRun.report.all().find((line) => line.section === "fleet")
		?.planDigest as string;
	const executed = await runMigrate(h.db(), {
		mode: "execute",
		expectPlanDigest: digest,
	});
	expect(executed.outcome).toEqual({ outcome: "ok" });
}

async function noticeReasons(appId: string): Promise<string[]> {
	const rows = await sql<{ entries: { reason: string }[] }>`
		SELECT entries FROM app_migration_notices
		WHERE app_id = ${appId} AND cutover = 'hq-round-trip-expressions'
	`.execute(h.db());
	return rows.rows.flatMap((row) => row.entries.map((entry) => entry.reason));
}

describe("private work across the expressions cutover", () => {
	it("abandons every open candidate, answers from the saved app and opens the next candidate at the new head", async () => {
		await h.seedProjectMember(OWNER, PROJECT, "owner");
		await seedApp("app-a-working");
		await seedApp("app-b-idle");
		await seedApp("app-c-deleted", new Date("2026-10-01T00:00:00Z"));
		const workId = await stageUnsavedWork("app-a-working");
		const deletedWork = await stageUnsavedWork("app-c-deleted");

		await execute();

		const sessions = await h
			.db()
			.selectFrom("authoring_sessions")
			.select("active_candidate_id")
			.execute();
		expect(sessions.map((row) => row.active_candidate_id)).toEqual([
			null,
			null,
		]);
		const workspaces = await h
			.db()
			.selectFrom("authoring_workspaces")
			.select("status")
			.execute();
		expect(workspaces.map((row) => row.status)).toEqual([
			"abandoned",
			"abandoned",
		]);

		// The saved app answers the next read, at the horizon's sequence.
		const after = await getWork({ actorUserId: OWNER, host, workId });
		expect(after).toMatchObject({
			pendingChanges: 0,
			savedRevision: 2,
			revision: null,
		});
		expect(after.app).toMatchObject({
			name: readFixtureCarriers(FIXTURE).root.app_name,
		});

		// The next edit opens a candidate at the new head.
		await executeWorkTool({
			actorUserId: OWNER,
			host,
			workId,
			toolName: "updateApp",
			requestId: "rename-after",
			input: { name: "Renamed after the cutover" },
		});
		const open = await h
			.db()
			.selectFrom("authoring_workspaces")
			.select(["status", "base_seq"])
			.where("status", "=", "open")
			.execute();
		expect(open).toEqual([{ status: "open", base_seq: "2" }]);

		// Each app that lost work is told so; the idle one is not.
		expect(await noticeReasons("app-a-working")).toContain(
			"unsaved-assistant-work-discarded",
		);
		expect(await noticeReasons("app-c-deleted")).toContain(
			"unsaved-assistant-work-discarded",
		);
		expect(await noticeReasons("app-b-idle")).not.toContain(
			"unsaved-assistant-work-discarded",
		);

		// A deleted app's work resumes at the new head once it is restored.
		await restoreApp("app-c-deleted", OWNER);
		await executeWorkTool({
			actorUserId: OWNER,
			host,
			workId: deletedWork,
			toolName: "updateApp",
			requestId: "rename-restored",
			input: { name: "Restored and renamed" },
		});
		const restored = await h
			.db()
			.selectFrom("authoring_workspaces")
			.select("base_seq")
			.where("status", "=", "open")
			.where("app_id", "=", "app-c-deleted")
			.execute();
		expect(restored).toEqual([{ base_seq: "2" }]);
	}, 60_000);

	it("ends a pre-app build that held open work as a discarded one, and leaves one that held none as it was", async () => {
		await h.seedProjectMember(OWNER, PROJECT, "owner");
		await seedApp("app-a-saved");
		const working = await h.seedDesignSession({
			owner_user_id: OWNER,
			project_id: PROJECT,
		});
		const lineage = await h.seedDesignLineage({ existingSessionId: working });
		await h
			.db()
			.insertInto("design_change_sets")
			.values({
				id: randomUUID(),
				design_session_id: working,
				design_revision_id: lineage.designRevisionId,
				design_revision_digest: lineage.designRevisionDigest,
				build_plan_id: lineage.buildPlanId,
				build_plan_digest: lineage.buildPlanDigest,
				slice_id: lineage.sliceId,
				attempt_id: lineage.attemptId,
				kind: "genesis",
				app_id: null,
				proposed_app_id: randomUUID(),
				base_seq: null,
				base_project_id: PROJECT,
				base_snapshot_digest: "d".repeat(64),
				revision: 0,
				next_ordinal: 0,
				exclusive_kind: null,
				owner_user_id: OWNER,
				owner_run_id: "run-pre-app",
				status: "open",
				committed_seq: null,
				committed_batch_id: null,
				committed_snapshot_digest: null,
			})
			.execute();
		const idle = await h.seedDesignSession({
			owner_user_id: OWNER,
			project_id: PROJECT,
		});
		const idleBefore = await h.readDesignSessionRow(idle);

		await execute();

		expect(await h.readDesignSessionRow(working)).toMatchObject({
			state: "abandoned",
		});
		expect(
			await h
				.db()
				.selectFrom("design_change_sets")
				.select("status")
				.where("design_session_id", "=", working)
				.execute(),
		).toEqual([{ status: "abandoned" }]);
		expect(
			await h
				.db()
				.selectFrom("design_slice_attempts")
				.select("status")
				.where("design_session_id", "=", working)
				.execute(),
		).toEqual([{ status: "superseded" }]);
		expect(await h.readDesignSessionRow(idle)).toEqual(idleBefore);
		// A notice belongs to an app, and a pre-app build has none.
		const discarded = await sql<{ app_id: string }>`
			SELECT app_id FROM app_migration_notices
			WHERE entries @> '[{"reason":"unsaved-assistant-work-discarded"}]'::jsonb
		`.execute(h.db());
		expect(discarded.rows).toEqual([]);
	}, 60_000);
});
