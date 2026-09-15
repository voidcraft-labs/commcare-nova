/**
 * The lock STRENGTH a transcript writer holds on its authority row, on a
 * real Postgres with three concurrent sessions.
 *
 * `threads.ts::lockThreadTargetAuthority` holds the app row, the
 * design-session row, or both `FOR SHARE`, then the thread row `FOR UPDATE`
 * (its docblock owns the why). The contract under test has two halves.
 * While a transcript write is mid-flight, its authority row still admits
 * the run's other share-mode traffic — the `FOR SHARE` app read behind
 * every authorization (`loadAppInTransaction`) and the `FOR KEY SHARE` an
 * appended `chat_stream_chunks` row takes through its design-session
 * foreign key (`appendStreamChunks`). And the same row still refuses a
 * holder transition until the write lands: an UPDATE of the authority row
 * (what every claim, release, and settle ends in) waits on the parked
 * snapshot, which is the proof `threadTargetHolderMatches` relies on. A
 * weaker lock (`FOR KEY SHARE`, or none) passes the first half and fails the
 * second.
 *
 * Each case parks a barrier snapshot behind a held thread row (its second
 * lock) with the shared `whileBlocked` barrier, probes the authority row from
 * a third session with the production reader and writer while Postgres
 * reports the snapshot blocked, then releases the row and lets the snapshot
 * land. A probe that waits is a failure, not a hang: the per-test database
 * carries a server-side `statement_timeout` for every session the probes and
 * the snapshot open, so a parked statement is cancelled by Postgres (its
 * connection stays usable and its transaction rolls back cleanly) rather
 * than abandoned by a client-side timer.
 *
 * The last case covers what share strength gives up: the authority row no
 * longer serializes writers of a thread whose row does not exist yet, so the
 * per-thread identity lock (`lockThreadIdentity`) must. Two same-holder
 * writers creating one fresh thread are parked on that identity from a third
 * session, released together, and must both land: one inserts, the other
 * merges.
 */
import type { UIMessage } from "ai";
import type { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { whileBlocked } from "@/__tests__/helpers/postgresBarrier";
import { loadAppInTransaction } from "../canonicalCommitKernel";
import type { GenerationTarget } from "../generationTargets";
import { __setAppDbForTests } from "../pg";
import { appendStreamChunks } from "../streamChunks";
import {
	loadThread,
	persistResponseSnapshot,
	threadIdentityLockScope,
	upsertThreadTurn,
} from "../threads";
import { setupAppStateTestDb } from "./appStateTestDb";
import { createPerTestAppDb } from "./perTestAppDb";

const h = setupAppStateTestDb("threads_lock_");
const ACTOR = "owner-test";
const PROJECT = "project-test";
const NONCE = "00000000-0000-4000-8000-0000000000f1";
const STREAM = "stream-parked";
/** The server-side bound on any statement a probe or the snapshot runs: far
 * above the sub-second park a correct lock allows, below the contender
 * pool's 10s client-side `query_timeout` so Postgres cancels first. */
const PROBE_STATEMENT_TIMEOUT = "8s";
/** Above the statement bound, so a parked probe fails on that bound with
 * its own error rather than on the test clock. */
const CASE_TIMEOUT_MS = 30_000;

function userMsg(id: string, text: string): UIMessage {
	return { id, role: "user", parts: [{ type: "text", text }] };
}

function assistantMsg(id: string, text: string): UIMessage {
	return { id, role: "assistant", parts: [{ type: "text", text }] };
}

function reservation(runId: string) {
	return {
		period: "2026-09",
		reserved: 100,
		settled: false,
		userId: ACTOR,
		runId,
	};
}

async function seedHeldApp(appId: string, runId: string): Promise<void> {
	await h.seedApp({
		id: appId,
		owner: ACTOR,
		status: "generating",
		run_id: runId,
		run_holder_nonce: NONCE,
		reservation: reservation(runId),
	});
}

/** A live pre-app session holding its own run. */
async function seedHeldSession(runId: string): Promise<string> {
	return h.seedDesignSession({
		owner_user_id: ACTOR,
		run_id: runId,
		run_holder_nonce: NONCE,
		run_actor_user_id: ACTOR,
		run_lease_expires_at: new Date(Date.now() + 600_000),
		reservation: reservation(runId),
	});
}

/** A session that materialized into `appId`: terminal, so it carries no
 * authority columns of its own (`design_sessions_terminal_clears_authority`);
 * the bound app row's holder admits its thread writes. */
async function seedMaterializedSession(appId: string): Promise<string> {
	return h.seedDesignSession({
		owner_user_id: ACTOR,
		state: "materialized",
		app_id: appId,
	});
}

async function seedLiveThread(
	target: GenerationTarget,
	threadId: string,
	runId: string,
): Promise<void> {
	const written = await upsertThreadTurn({
		target,
		threadId,
		runId,
		streamId: STREAM,
		holderNonce: NONCE,
		threadType: "build",
		messages: [userMsg("m1", "build me an app")],
		expectedProjectId: PROJECT,
	});
	expect(written).toBe(true);
}

/**
 * Park a barrier snapshot on `threadId` behind a held thread row, run
 * `probe` against the authority row from a third session while Postgres
 * reports the snapshot blocked, then release the row and land the snapshot.
 */
async function whileSnapshotParked(
	target: GenerationTarget,
	threadId: string,
	probe: (
		contenders: ReturnType<typeof createPerTestAppDb>,
		controller: Client,
	) => Promise<{ landed: Promise<unknown> } | undefined>,
): Promise<void> {
	/* Every session the contender pool opens from here on (the snapshot's
	 * and the probes') inherits the bound; the harness pool's session, already
	 * open, is not used while anything is parked. */
	const bound = await h
		.pool()
		.query<{ statement: string }>(
			"SELECT format('ALTER DATABASE %I SET statement_timeout = %L', current_database(), $1::text) AS statement",
			[PROBE_STATEMENT_TIMEOUT],
		);
	await h.pool().query(bound.rows[0]?.statement ?? "");
	const contenders = createPerTestAppDb(h.uri());
	__setAppDbForTests(contenders.appDb);
	/* A holder transition the probe started while parked; it may land only
	 * after the snapshot does. */
	let transition: Promise<unknown> | undefined;
	try {
		await whileBlocked(
			h,
			(pg) =>
				pg.query(
					"SELECT thread_id FROM threads WHERE thread_id = $1 FOR UPDATE",
					[threadId],
				),
			() =>
				persistResponseSnapshot({
					target,
					threadId,
					streamId: STREAM,
					expectedProjectId: PROJECT,
					responseMessage: assistantMsg("m2", "step one"),
					clearMarker: false,
				}),
			async (settled, controller) => {
				/* The snapshot holds its authority lock and waits on the thread
				 * row; the share-mode probes must not wait on it. */
				expect(settled).toBe(false);
				transition = (await probe(contenders, controller))?.landed;
			},
		);
		await transition;
	} finally {
		if (transition !== undefined) await Promise.allSettled([transition]);
		__setAppDbForTests(h.db());
		await contenders.destroy();
	}
	/* The write was parked, not skipped: it landed once the row freed. */
	const doc = await loadThread(target, threadId);
	expect(doc?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
	expect(doc?.active_stream_id).toBe(STREAM);
}

/**
 * Start a holder-transition UPDATE of the authority row and prove Postgres
 * parks it behind the snapshot (the backend the holder is blocking), not
 * behind the holder itself. Handed back still pending, behind a wrapper so
 * nothing awaits it before the release; it lands after the snapshot does.
 */
async function probeHolderTransitionWaits(
	controller: Client,
	update: () => Promise<unknown>,
): Promise<{ landed: Promise<unknown> }> {
	let settled = false;
	const transition = update().finally(() => {
		settled = true;
	});
	await vi.waitFor(async () => {
		await controller.query("SELECT pg_stat_clear_snapshot()");
		const waiting = await controller.query<{ count: number }>(
			`SELECT count(*)::int AS count
			 FROM pg_stat_activity AS waiter
			 WHERE waiter.datname = current_database()
			   AND EXISTS (
			     SELECT 1 FROM pg_stat_activity AS parked
			     WHERE parked.datname = current_database()
			       AND pg_backend_pid() = ANY(pg_blocking_pids(parked.pid))
			       AND parked.pid = ANY(pg_blocking_pids(waiter.pid))
			   )`,
		);
		expect(waiting.rows[0]?.count).toBe(1);
	});
	expect(settled).toBe(false);
	/* Wrapped so the async return does not adopt (and wait on) the pending
	 * transition itself. */
	return { landed: transition };
}

async function probeAppAuthorizationRead(
	contenders: ReturnType<typeof createPerTestAppDb>,
	appId: string,
): Promise<void> {
	const app = await contenders.appDb
		.transaction()
		.execute((tx) => loadAppInTransaction(tx, appId));
	expect(app?.project_id).toBe(PROJECT);
	expect(app?.status).toBe("generating");
}

async function probeStreamChunkAppend(
	contenders: ReturnType<typeof createPerTestAppDb>,
	target: GenerationTarget,
	runId: string,
): Promise<void> {
	await appendStreamChunks({
		streamId: STREAM,
		target,
		runId,
		firstIndex: 0,
		chunks: [{ type: "text-delta", id: "t1", delta: "hello" }],
		terminal: false,
	});
	const rows = await contenders.appDb
		.selectFrom("chat_stream_chunks")
		.select("first_index")
		.where("stream_id", "=", STREAM)
		.execute();
	expect(rows).toEqual([{ first_index: 0 }]);
}

describe("thread authority lock strength", () => {
	it(
		"an app-target snapshot in flight admits the app row's FOR SHARE authorization read",
		async () => {
			const appId = "app-lock-strength";
			const runId = "run-app-lock";
			await seedHeldApp(appId, runId);
			const target: GenerationTarget = { kind: "app", appId };
			await seedLiveThread(target, "thread-app-lock", runId);

			await whileSnapshotParked(
				target,
				"thread-app-lock",
				async (contenders, controller) => {
					await probeAppAuthorizationRead(contenders, appId);
					return probeHolderTransitionWaits(controller, () =>
						contenders.appDb
							.updateTable("apps")
							.set({ updated_at: new Date() })
							.where("id", "=", appId)
							.execute(),
					);
				},
			);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"a pre-app session snapshot in flight admits the session row's FOR KEY SHARE stream-chunk append",
		async () => {
			const runId = "run-session-lock";
			const sessionId = await seedHeldSession(runId);
			const target: GenerationTarget = {
				kind: "design-session",
				designSessionId: sessionId,
			};
			await seedLiveThread(target, "thread-session-lock", runId);

			await whileSnapshotParked(
				target,
				"thread-session-lock",
				async (contenders, controller) => {
					await probeStreamChunkAppend(contenders, target, runId);
					return probeHolderTransitionWaits(controller, () =>
						contenders.appDb
							.updateTable("design_sessions")
							.set({ updated_at: new Date() })
							.where("id", "=", sessionId)
							.execute(),
					);
				},
			);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"a materialized-session snapshot in flight admits both the app read and the session-keyed append",
		async () => {
			const appId = "app-materialized-lock";
			const runId = "run-materialized-lock";
			await seedHeldApp(appId, runId);
			const sessionId = await seedMaterializedSession(appId);
			const target: GenerationTarget = {
				kind: "design-session",
				designSessionId: sessionId,
			};
			await seedLiveThread(target, "thread-materialized-lock", runId);

			await whileSnapshotParked(
				target,
				"thread-materialized-lock",
				async (contenders) => {
					await probeAppAuthorizationRead(contenders, appId);
					await probeStreamChunkAppend(contenders, target, runId);
					return undefined;
				},
			);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"two same-holder writers creating the same fresh thread queue on its identity and both land",
		async () => {
			const appId = "app-fresh-thread-race";
			const runId = "run-fresh-thread-race";
			const threadId = "thread-fresh-race";
			await seedHeldApp(appId, runId);
			const target: GenerationTarget = { kind: "app", appId };
			const contenders = createPerTestAppDb(h.uri());
			__setAppDbForTests(contenders.appDb);
			const turn = (streamId: string, messages: UIMessage[]) =>
				upsertThreadTurn({
					target,
					threadId,
					runId,
					streamId,
					holderNonce: NONCE,
					threadType: "build",
					messages,
					expectedProjectId: PROJECT,
				});
			try {
				const results = await whileBlocked(
					h,
					(pg) =>
						pg.query(
							"SELECT pg_advisory_xact_lock(hashtextextended($1, 0::bigint))",
							[threadIdentityLockScope(threadId)],
						),
					() =>
						Promise.all([
							turn("stream-a", [userMsg("m1", "first")]),
							turn("stream-b", [
								userMsg("m1", "first"),
								userMsg("m2", "second"),
							]),
						]),
					async (settled, pg) => {
						expect(settled).toBe(false);
						/* Both writers hold the app row in share mode and are parked
						 * on the identity, not on each other. */
						await vi.waitFor(async () => {
							await pg.query("SELECT pg_stat_clear_snapshot()");
							const parked = await pg.query<{ count: number }>(
								"SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND pg_backend_pid() = ANY(pg_blocking_pids(pid))",
							);
							expect(parked.rows[0]?.count).toBe(2);
						});
					},
				);
				expect(results).toEqual([true, true]);
			} finally {
				__setAppDbForTests(h.db());
				await contenders.destroy();
			}
			const doc = await loadThread(target, threadId);
			expect(doc?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
		},
		CASE_TIMEOUT_MS,
	);
});
