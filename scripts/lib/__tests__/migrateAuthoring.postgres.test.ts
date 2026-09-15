import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { readAppPlan } from "@/lib/agent/planning/store";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { claimAndReserveDesignSessionRun } from "@/lib/db/designSessions";
import {
	migrateLegacyAuthoring,
	scanLegacyAuthoring,
} from "../migrateAuthoring";
import contract from "./fixtures/design-contract-v4.json";

const h = setupAppStateTestDb("migrate_authoring_", {
	authSchema: "migrated",
	poolMax: 3,
});
const actor = "owner-test";
const project = "migration-project";

async function legacy(appId: string | null = null) {
	const sessionId = await h.seedDesignSession({
		authoring_version: 0,
		owner_user_id: actor,
		project_id: project,
		app_id: appId,
		state: appId ? "materialized" : "active",
	});
	const revisionId = randomUUID();
	await h
		.db()
		.insertInto("design_revisions")
		.values({
			id: revisionId,
			design_session_id: sessionId,
			revision: 1,
			parent_revision_id: null,
			lifecycle: "accepted",
			artifact_digest: "a".repeat(64),
			contract_digest: "b".repeat(64),
			source_package_digest: "c".repeat(64),
			producer_model: "historical",
			prompt_version: "historical",
			created_by_run_id: "old-run",
			envelope: JSON.stringify({ payload: contract }),
		})
		.execute();
	const threadId = randomUUID();
	await h
		.db()
		.insertInto("threads")
		.values({
			thread_id: threadId,
			app_id: null,
			design_session_id: sessionId,
			thread_type: "build",
			summary: "Visits",
			run_id: "old-run",
			active_stream_id: null,
			active_holder_nonce: null,
			created_at: "2026-09-12T12:00:00Z",
			updated_at: "2026-09-12T12:00:01Z",
			messages: JSON.stringify([
				{
					id: "source",
					role: "user",
					parts: [{ type: "text", text: "Track visits." }],
				},
			]),
		})
		.execute();
	return { sessionId, revisionId, threadId };
}
async function history(sessionId: string) {
	return {
		revisions: await h
			.db()
			.selectFrom("design_revisions")
			.selectAll()
			.where("design_session_id", "=", sessionId)
			.execute(),
		usage: await h
			.db()
			.selectFrom("run_summaries")
			.selectAll()
			.where("design_session_id", "=", sessionId)
			.execute(),
		messages: (
			await h.db().selectFrom("threads").select("messages").execute()
		).map((row) => row.messages),
	};
}

it("scans without changing data, imports the earlier design once and resumes from an unreviewed Markdown plan", async () => {
	const { sessionId } = await legacy();
	const before = await history(sessionId);
	await expect(
		claimAndReserveDesignSessionRun(
			sessionId,
			"before-migration",
			actor,
			1,
			project,
		),
	).rejects.toThrow("migration");
	expect(await scanLegacyAuthoring()).toEqual([
		{ sessionId, appId: null, status: "ready" },
	]);
	expect(await history(sessionId)).toEqual(before);
	expect(await migrateLegacyAuthoring(sessionId)).toMatchObject({
		status: "migrated",
	});
	expect(await migrateLegacyAuthoring(sessionId)).toMatchObject({
		status: "current",
	});
	expect(await scanLegacyAuthoring()).toEqual([]);
	expect(await history(sessionId)).toEqual(before);
	await claimAndReserveDesignSessionRun(
		sessionId,
		"resumed",
		actor,
		1,
		project,
	);
	const plan = await readAppPlan({
		sessionId,
		actorUserId: actor,
		projectId: project,
	});
	expect(plan).toMatchObject({
		revision: 1,
		editor: "migration",
		reviewedRevision: null,
	});
	expect(plan?.markdown).toContain(contract.charter.objective);
	expect(plan?.markdown).toContain(contract.workflows[0]?.name);
});

it.each(["complete", "error"] as const)(
	"preserves the %s app, source and history, retaining unfinished work for the new architect",
	async (status) => {
		const appId = await h.seedApp({
			owner: actor,
			project_id: project,
			status,
		});
		const { sessionId, threadId } = await legacy(appId);
		const before = {
			app: await h.readAppRow(appId),
			history: await history(sessionId),
		};
		expect(await migrateLegacyAuthoring(sessionId)).toMatchObject({
			status: "migrated",
		});
		expect({
			app: await h.readAppRow(appId),
			history: await history(sessionId),
		}).toEqual(before);
		expect(
			await h
				.db()
				.selectFrom("design_sessions")
				.select(["state", "authoring_version"])
				.where("id", "=", sessionId)
				.executeTakeFirst(),
		).toEqual({
			state: status === "complete" ? "retired" : "materialized",
			authoring_version: 1,
		});
		expect(
			await h
				.db()
				.selectFrom("threads")
				.select(["app_id", "design_session_id"])
				.where("thread_id", "=", threadId)
				.executeTakeFirst(),
		).toEqual(
			status === "complete"
				? { app_id: appId, design_session_id: null }
				: { app_id: null, design_session_id: sessionId },
		);
	},
);

it("refuses held work and paid responses without an accounting receipt", async () => {
	const busy = await h.seedDesignSession({
		authoring_version: 0,
		owner_user_id: actor,
		project_id: project,
		run_id: "old-run",
		run_holder_nonce: randomUUID(),
		run_actor_user_id: actor,
		run_lease_expires_at: new Date(Date.now() + 60_000),
	});
	expect(await migrateLegacyAuthoring(busy)).toMatchObject({ status: "busy" });
	const { sessionId } = await legacy();
	const contextId = randomUUID();
	await h
		.db()
		.insertInto("design_model_contexts")
		.values({
			id: contextId,
			design_session_id: sessionId,
			context_kind: "design",
			generation: 0,
			supersedes_context_id: null,
			model_id: "historical",
			prompt_version: "historical",
			context_version: "old",
			toolset_digest: "a".repeat(64),
			revision: 0,
		})
		.execute();
	await h
		.db()
		.insertInto("design_model_steps")
		.values({
			context_id: contextId,
			step_key: "paid",
			event_kind: "completed",
			event_digest: "b".repeat(64),
			request_digest: null,
			response_digest: "c".repeat(64),
			usage: JSON.stringify({ inputTokens: 20, outputTokens: 10 }),
			created_by_run_id: "old-run",
		})
		.execute();
	expect(await migrateLegacyAuthoring(sessionId)).toMatchObject({
		status: "unaccounted-usage",
	});
	expect(
		await h.db().selectFrom("authoring_plans").selectAll().execute(),
	).toEqual([]);
});

it("rolls back the imported plan and thread changes when the final format update fails", async () => {
	const { sessionId } = await legacy();
	const before = await history(sessionId);
	await h
		.pool()
		.query(`CREATE FUNCTION reject_authoring_cutover() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
		IF NEW.authoring_version = 1 THEN RAISE EXCEPTION 'injected final update fault'; END IF;
		RETURN NEW; END $$;
		CREATE TRIGGER reject_authoring_cutover BEFORE UPDATE ON design_sessions FOR EACH ROW EXECUTE FUNCTION reject_authoring_cutover()`);
	await expect(migrateLegacyAuthoring(sessionId)).rejects.toThrow(
		"injected final update fault",
	);
	expect(
		await h.db().selectFrom("authoring_plans").selectAll().execute(),
	).toEqual([]);
	expect(await history(sessionId)).toEqual(before);
	expect(await scanLegacyAuthoring()).toMatchObject([
		{ sessionId, status: "ready" },
	]);
});
