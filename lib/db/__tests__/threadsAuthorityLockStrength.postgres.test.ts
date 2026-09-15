/**
 * The lock STRENGTH a transcript writer holds on its authority row, on a
 * real Postgres with three concurrent sessions.
 *
 * `threads.ts::lockThreadTargetAuthority` holds the app row, the
 * design-session row, or both `FOR SHARE`, then the thread row `FOR UPDATE`.
 * The contract: while a transcript write is mid-flight, its authority row
 * still admits the run's other share-mode traffic — the `FOR SHARE` app read
 * behind every authorization (`loadAppInTransaction`) and the
 * `FOR KEY SHARE` an appended `chat_stream_chunks` row takes through its
 * design-session foreign key (`appendStreamChunks`). An exclusive authority
 * lock parks both behind the write; each parked statement then holds a
 * pooled connection, which is how one long transcript rewrite exhausts a
 * small per-instance pool and fails unrelated requests on their acquire
 * timeout.
 *
 * Each case parks the snapshot on a held thread row (its second lock), waits
 * until Postgres reports it blocked, probes the authority row from a third
 * session with the production readers and writers, then releases the thread
 * row and lets the snapshot land. A probe that waits is a failure, not a
 * hang: the per-test database carries a server-side `statement_timeout` for
 * every session the probes and the snapshot open, so a parked statement is
 * cancelled by Postgres (its connection stays usable and its transaction
 * rolls back cleanly) rather than abandoned by a client-side timer, and the
 * holder is released in `finally` either way.
 */
import type { UIMessage } from "ai";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { loadAppInTransaction } from "../canonicalCommitKernel";
import type { GenerationTarget } from "../generationTargets";
import { __setAppDbForTests } from "../pg";
import { appendStreamChunks } from "../streamChunks";
import {
	loadThread,
	persistResponseSnapshot,
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
	probe: (contenders: ReturnType<typeof createPerTestAppDb>) => Promise<void>,
): Promise<void> {
	const contenders = createPerTestAppDb(h.uri());
	const holder = new Client({ connectionString: h.uri() });
	const observer = new Client({ connectionString: h.uri() });
	/* Settled, never rejecting: the snapshot is owned from the moment it
	 * starts, so a cancellation while a probe is still running is reported
	 * below rather than escaping as an unhandled rejection. */
	let outcome: Promise<PromiseSettledResult<void>[]> | undefined;
	try {
		await holder.connect();
		await observer.connect();
		/* Every session the contender pool opens from here on (the snapshot's
		 * and the probes') inherits the bound; the holder and observer, already
		 * open, keep waiting on purpose. */
		const bound = await observer.query<{ statement: string }>(
			"SELECT format('ALTER DATABASE %I SET statement_timeout = %L', current_database(), $1::text) AS statement",
			[PROBE_STATEMENT_TIMEOUT],
		);
		await observer.query(bound.rows[0]?.statement ?? "");
		await holder.query("BEGIN");
		await holder.query(
			"SELECT thread_id FROM threads WHERE thread_id = $1 FOR UPDATE",
			[threadId],
		);
		const holderPid = (
			await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
		).rows[0]?.pid;
		expect(holderPid).toBeTypeOf("number");

		__setAppDbForTests(contenders.appDb);
		outcome = Promise.allSettled([
			persistResponseSnapshot({
				target,
				threadId,
				streamId: STREAM,
				expectedProjectId: PROJECT,
				responseMessage: assistantMsg("m2", "step one"),
				clearMarker: false,
			}),
		]);
		/* The snapshot has taken its authority lock and is now waiting on the
		 * thread row: exactly one backend is blocked by the holder. */
		await vi.waitFor(
			async () => {
				const blocked = await observer.query<{ count: number }>(
					"SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))",
					[holderPid],
				);
				expect(blocked.rows[0]?.count).toBe(1);
			},
			{ timeout: 5_000 },
		);

		await probe(contenders);
	} finally {
		await holder.query("ROLLBACK").catch(() => undefined);
		await holder.end();
		await outcome;
		__setAppDbForTests(h.db());
		await contenders.destroy();
		await observer.end();
	}
	const [landed] = (await outcome) ?? [];
	if (landed?.status === "rejected") throw landed.reason;
	/* The write was parked, not skipped: it landed once the row freed. */
	const doc = await loadThread(target, threadId);
	expect(doc?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
	expect(doc?.active_stream_id).toBe(STREAM);
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

			await whileSnapshotParked(target, "thread-app-lock", (contenders) =>
				probeAppAuthorizationRead(contenders, appId),
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

			await whileSnapshotParked(target, "thread-session-lock", (contenders) =>
				probeStreamChunkAppend(contenders, target, runId),
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
				},
			);
		},
		CASE_TIMEOUT_MS,
	);
});
