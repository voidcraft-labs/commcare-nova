/**
 * The Designs-in-progress LIST query (§15.9) against a real per-test
 * Postgres — specifically its ordering clock. The list displays
 * `lastActivityAt` as the later of the session's own last write and its
 * newest conversation's, so it must ORDER (and cut the LIMIT) by that same
 * expression: a write that stamps only the thread (a bailed-history merge)
 * must not sort the design stale or push it off the list while its card
 * shows fresh activity.
 */
import { expect, it } from "vitest";
import { listDesignsInProgress } from "../designInProgress";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("design_in_progress_");
const ACTOR = "owner-test";
const PROJECT = "project-test";

async function seedThread(args: {
	sessionId: string;
	summary: string;
	updatedAt: Date;
}): Promise<void> {
	await h
		.db()
		.insertInto("threads")
		.values({
			thread_id: crypto.randomUUID(),
			app_id: null,
			design_session_id: args.sessionId,
			/* The thread clocks are server-written ISO-8601 text columns. */
			created_at: args.updatedAt.toISOString(),
			updated_at: args.updatedAt.toISOString(),
			thread_type: "build",
			summary: args.summary,
			run_id: "run-list",
			active_stream_id: null,
			active_holder_nonce: null,
			messages: JSON.stringify([]),
			clawed_back_ids: JSON.stringify([]),
		})
		.execute();
}

it("orders by the displayed activity clock, not the session clock alone", async () => {
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	const now = Date.now();
	/* Session A: fresher session clock, no conversation writes since. */
	const sessionA = await h.seedDesignSession({
		owner_user_id: ACTOR,
		project_id: PROJECT,
		updated_at: new Date(now - 60_000),
	});
	await seedThread({
		sessionId: sessionA,
		summary: "Referral tracker",
		updatedAt: new Date(now - 120_000),
	});
	/* Session B: stale session clock, but its conversation was written LAST —
	 * the bailed-history-merge shape that stamps only threads.updated_at. */
	const sessionB = await h.seedDesignSession({
		owner_user_id: ACTOR,
		project_id: PROJECT,
		updated_at: new Date(now - 600_000),
	});
	await seedThread({
		sessionId: sessionB,
		summary: "Nutrition visits",
		updatedAt: new Date(now - 10_000),
	});

	const list = await listDesignsInProgress({
		userId: ACTOR,
		projectId: PROJECT,
	});
	expect(list.map((entry) => entry.designSessionId)).toEqual([
		sessionB,
		sessionA,
	]);
	/* The ordering matches the clock each row displays. */
	const [first, second] = list;
	expect(first !== undefined && second !== undefined).toBe(true);
	if (first === undefined || second === undefined)
		throw new Error("unreachable");
	expect(first.lastActivityAt > second.lastActivityAt).toBe(true);
});

it("cuts the limit by the same clock", async () => {
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	const now = Date.now();
	const fresherSession = await h.seedDesignSession({
		owner_user_id: ACTOR,
		project_id: PROJECT,
		updated_at: new Date(now - 60_000),
	});
	const threadFreshSession = await h.seedDesignSession({
		owner_user_id: ACTOR,
		project_id: PROJECT,
		updated_at: new Date(now - 600_000),
	});
	await seedThread({
		sessionId: threadFreshSession,
		summary: "Written last via its conversation",
		updatedAt: new Date(now - 5_000),
	});

	/* limit 1: the thread-fresh design must survive the cut. Under
	 * session-clock ordering it would fall off entirely. */
	const list = await listDesignsInProgress({
		userId: ACTOR,
		projectId: PROJECT,
		limit: 1,
	});
	expect(list.map((entry) => entry.designSessionId)).toEqual([
		threadFreshSession,
	]);
	expect(fresherSession).toBeTruthy();
});
