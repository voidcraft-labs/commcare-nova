/**
 * Private agent work across the cutover: every open candidate is abandoned
 * and its pointer cleared, the saved app answers the next read, the next
 * edit opens a candidate at the new head, a pre-app build that held work ends
 * as a discarded one does, and each app that lost work is told so.
 */

import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import {
	beginWork,
	executeWorkTool,
	getWork,
} from "@/lib/agent/authoring/session";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { restoreApp, softDeleteApp } from "@/lib/db/apps";
import { runMigrate } from "../run";
import { readFixtureCarriers } from "./fixtures/preStep";
import { fixtureApp, seedFixtureApp } from "./fixtures/seed";

const h = setupAppStateTestDb("hq_cutover_private_work_", {
	authSchema: "migrated",
});

const OWNER = "owner-private-work";
const PROJECT = "project-private-work";
const host = { kind: "mcp" } as const;

async function seedApp(appId: string): Promise<void> {
	await seedFixtureApp(
		h.db(),
		fixtureApp("navigation-base", { appId, projectId: PROJECT, owner: OWNER }),
	);
}

/** Begin MCP work on an app and stage one unsaved rename in its candidate. */
async function stageUnsavedWork(appId: string): Promise<string> {
	const begun = await beginWork({
		actorUserId: OWNER,
		projectId: PROJECT,
		host,
		target: { appId },
		requestId: `begin-${appId}`,
	});
	await executeWorkTool({
		actorUserId: OWNER,
		host,
		workId: begun.workId,
		toolName: "updateApp",
		requestId: `rename-${appId}`,
		input: { name: "Unsaved rename" },
	});
	return begun.workId;
}

async function execute(): Promise<void> {
	const dryRun = await runMigrate(h.db(), { mode: "dry-run" });
	const digest = dryRun.report.all().find((line) => line.section === "fleet")
		?.planDigest as string;
	const executed = await runMigrate(h.db(), {
		mode: "execute",
		expectPlanDigest: digest,
	});
	expect(executed.outcome).toEqual({ outcome: "ok" });
}

describe("private work across the cutover", () => {
	it("abandons every open candidate, answers from the saved app and opens the next candidate at the new head", async () => {
		await h.seedProjectMember(OWNER, PROJECT, "owner");
		await seedApp("app-a-working");
		await seedApp("app-b-idle");
		await seedApp("app-c-deleted");
		const workId = await stageUnsavedWork("app-a-working");
		const deletedWork = await stageUnsavedWork("app-c-deleted");
		await softDeleteApp("app-c-deleted", OWNER);
		expect(await getWork({ actorUserId: OWNER, host, workId })).toMatchObject({
			pendingChanges: 1,
			savedRevision: 1,
		});

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

		const after = await getWork({ actorUserId: OWNER, host, workId });
		expect(after).toMatchObject({
			pendingChanges: 0,
			savedRevision: 2,
			revision: null,
		});
		expect(after.app).toMatchObject({
			name: readFixtureCarriers("navigation-base").root.app_name,
		});

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

		const notices = await sql<{ app_id: string; entries: unknown }>`
			SELECT app_id, entries FROM app_migration_notices ORDER BY app_id
		`.execute(h.db());
		// No app here is published anywhere, so the live ones are also told a
		// CCZ needs a project space; the deleted one is not.
		expect(notices.rows).toEqual([
			{
				app_id: "app-a-working",
				entries: [
					{
						kind: "document",
						reason: "ccz-needs-project-space",
						entity: { type: "app", nameAtMigration: expect.any(String) },
					},
					{
						kind: "document",
						reason: "unsaved-assistant-work-discarded",
						entity: { type: "app", nameAtMigration: expect.any(String) },
					},
				],
			},
			{
				app_id: "app-b-idle",
				entries: [
					{
						kind: "document",
						reason: "ccz-needs-project-space",
						entity: { type: "app", nameAtMigration: expect.any(String) },
					},
				],
			},
			{
				app_id: "app-c-deleted",
				entries: [
					{
						kind: "document",
						reason: "unsaved-assistant-work-discarded",
						entity: { type: "app", nameAtMigration: expect.any(String) },
					},
				],
			},
		]);

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
	}, 30_000);

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
				id: crypto.randomUUID(),
				design_session_id: working,
				design_revision_id: lineage.designRevisionId,
				design_revision_digest: lineage.designRevisionDigest,
				build_plan_id: lineage.buildPlanId,
				build_plan_digest: lineage.buildPlanDigest,
				slice_id: lineage.sliceId,
				attempt_id: lineage.attemptId,
				kind: "genesis",
				app_id: null,
				proposed_app_id: crypto.randomUUID(),
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
	}, 30_000);
});
