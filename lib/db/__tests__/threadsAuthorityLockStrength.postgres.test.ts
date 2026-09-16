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
 * Two more cases cover the edges of the authority resolution. Share
 * strength does not serialize writers of a thread whose row does not exist
 * yet, so the per-thread identity lock (`lockThreadIdentity`) must: two
 * same-holder writers creating one fresh thread are parked on that identity
 * from a third session, released together, and must both land, one
 * inserting and the other merging. And a pre-app session can materialize
 * while a writer waits for its row: the writer, parked on the session row
 * held by the materialization, must resolve to the bound app's holder once
 * that commits rather than reading the cleared session authority as a lost
 * run, and it must give the session row back before it takes the app row
 * (the Project move holds the app row and then updates the sessions bound to
 * it, so the reverse order is a deadlock): parked on the app row after that
 * re-resolution, the writer must leave a holder transition on the session
 * row free to land.
 */
import type { UIMessage } from "ai";
import { Client } from "pg";
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
/**
 * Bound every statement of every session the contender pool opens from here
 * on (the parked writer's and the probes'). Sessions already open keep
 * waiting on purpose.
 */
async function boundStatements(): Promise<void> {
	const bound = await h
		.pool()
		.query<{ statement: string }>(
			"SELECT format('ALTER DATABASE %I SET statement_timeout = %L', current_database(), $1::text) AS statement",
			[PROBE_STATEMENT_TIMEOUT],
		);
	const statement = bound.rows[0]?.statement;
	if (statement === undefined) {
		throw new Error(
			"The per-test database did not report its name, so the statement bound could not be set.",
		);
	}
	await h.pool().query(statement);
}

/** Read one session's backend pid. */
async function backendPid(client: Client): Promise<number> {
	const row = await client.query<{ pid: number }>(
		"SELECT pg_backend_pid() AS pid",
	);
	const pid = row.rows[0]?.pid;
	if (typeof pid !== "number") throw new Error("Postgres reported no pid.");
	return pid;
}

/** How many backends are waiting on a lock `pid` holds. */
async function blockedBy(observer: Client, pid: number): Promise<number> {
	await observer.query("SELECT pg_stat_clear_snapshot()");
	const blocked = await observer.query<{ count: number }>(
		"SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))",
		[pid],
	);
	return blocked.rows[0]?.count ?? 0;
}

async function whileSnapshotParked(
	target: GenerationTarget,
	threadId: string,
	probe: (
		contenders: ReturnType<typeof createPerTestAppDb>,
		controller: Client,
		own: (transition: Promise<unknown>) => void,
	) => Promise<void>,
): Promise<void> {
	await boundStatements();
	const contenders = createPerTestAppDb(h.uri());
	__setAppDbForTests(contenders.appDb);
	/* A holder transition the probe started while parked, owned from the
	 * moment it starts; it may land only after the snapshot does. */
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
				await probe(contenders, controller, (started) => {
					transition = started;
				});
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
 * behind the holder itself. The pending UPDATE is handed to `own` before any
 * assertion, so the caller's teardown settles it on every outcome; it lands
 * after the snapshot does.
 */
async function probeHolderTransitionWaits(
	controller: Client,
	update: () => Promise<unknown>,
	own: (transition: Promise<unknown>) => void,
): Promise<void> {
	let settled = false;
	const transition = update().finally(() => {
		settled = true;
	});
	own(transition);
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
				async (contenders, controller, own) => {
					await probeAppAuthorizationRead(contenders, appId);
					await probeHolderTransitionWaits(
						controller,
						() =>
							contenders.appDb
								.updateTable("apps")
								.set({ updated_at: new Date() })
								.where("id", "=", appId)
								.execute(),
						own,
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
				async (contenders, controller, own) => {
					await probeStreamChunkAppend(contenders, target, runId);
					await probeHolderTransitionWaits(
						controller,
						() =>
							contenders.appDb
								.updateTable("design_sessions")
								.set({ updated_at: new Date() })
								.where("id", "=", sessionId)
								.execute(),
						own,
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

	it(
		"a writer parked on a session that materializes meanwhile resolves to the bound app's holder",
		async () => {
			const appId = "app-materialized-meanwhile";
			const runId = "run-materialized-meanwhile";
			const threadId = "thread-materialized-meanwhile";
			await seedHeldApp(appId, runId);
			const sessionId = await seedHeldSession(runId);
			const target: GenerationTarget = {
				kind: "design-session",
				designSessionId: sessionId,
			};
			const contenders = createPerTestAppDb(h.uri());
			__setAppDbForTests(contenders.appDb);
			try {
				const written = await whileBlocked(
					h,
					/* The materialization transfer in flight: it holds the session
					 * row, and the writer's unlocked mapping read still sees no app. */
					(pg) =>
						pg.query(
							"SELECT id FROM design_sessions WHERE id = $1 FOR UPDATE",
							[sessionId],
						),
					() =>
						upsertThreadTurn({
							target,
							threadId,
							runId,
							streamId: STREAM,
							holderNonce: NONCE,
							threadType: "build",
							messages: [userMsg("m1", "build me an app")],
							expectedProjectId: PROJECT,
						}),
					async (settled, pg) => {
						expect(settled).toBe(false);
						/* The transfer: bind the app and clear the session's own
						 * authority, exactly what materialization commits. */
						await pg.query(
							`UPDATE design_sessions
							 SET app_id = $1, state = 'materialized',
							     run_id = NULL, run_holder_nonce = NULL, run_actor_user_id = NULL,
							     run_mode = NULL, run_lease_expires_at = NULL,
							     res_period = NULL, res_reserved = NULL, res_settled = NULL,
							     res_user_id = NULL, res_run_id = NULL
							 WHERE id = $2`,
							[appId, sessionId],
						);
					},
					undefined,
					"COMMIT",
				);
				expect(written).toBe(true);
			} finally {
				__setAppDbForTests(h.db());
				await contenders.destroy();
			}
			const doc = await loadThread(target, threadId);
			expect(doc?.messages.map((m) => m.id)).toEqual(["m1"]);
			expect(doc?.active_stream_id).toBe(STREAM);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"a writer that re-resolves to the bound app gives the session row back before taking the app row",
		async () => {
			const appId = "app-released-session";
			const runId = "run-released-session";
			const threadId = "thread-released-session";
			await seedHeldApp(appId, runId);
			const sessionId = await seedHeldSession(runId);
			const target: GenerationTarget = {
				kind: "design-session",
				designSessionId: sessionId,
			};
			await boundStatements();
			const contenders = createPerTestAppDb(h.uri());
			__setAppDbForTests(contenders.appDb);
			/* Two holders: the materialization transfer on the session row, and
			 * a holder transition on the app row the writer re-resolves to. The
			 * transition's lock is `FOR NO KEY UPDATE`, what an UPDATE takes: it
			 * blocks the writer's share read but not the key share the transfer's
			 * own `app_id` foreign-key check needs. */
			const transfer = new Client({ connectionString: h.uri() });
			const appHolder = new Client({ connectionString: h.uri() });
			let outcome: Promise<PromiseSettledResult<boolean>[]> | undefined;
			try {
				await transfer.connect();
				await appHolder.connect();
				await appHolder.query("BEGIN");
				await appHolder.query(
					"SELECT id FROM apps WHERE id = $1 FOR NO KEY UPDATE",
					[appId],
				);
				const appHolderPid = await backendPid(appHolder);
				await transfer.query("BEGIN");
				await transfer.query(
					"SELECT id FROM design_sessions WHERE id = $1 FOR UPDATE",
					[sessionId],
				);
				const transferPid = await backendPid(transfer);

				outcome = Promise.allSettled([
					upsertThreadTurn({
						target,
						threadId,
						runId,
						streamId: STREAM,
						holderNonce: NONCE,
						threadType: "build",
						messages: [userMsg("m1", "build me an app")],
						expectedProjectId: PROJECT,
					}),
				]);
				/* The writer read no app and is parked on the session row. */
				await vi.waitFor(
					async () => expect(await blockedBy(transfer, transferPid)).toBe(1),
					{ timeout: 5_000 },
				);
				await transfer.query(
					`UPDATE design_sessions
					 SET app_id = $1, state = 'materialized',
					     run_id = NULL, run_holder_nonce = NULL, run_actor_user_id = NULL,
					     run_mode = NULL, run_lease_expires_at = NULL,
					     res_period = NULL, res_reserved = NULL, res_settled = NULL,
					     res_user_id = NULL, res_run_id = NULL
					 WHERE id = $2`,
					[appId, sessionId],
				);
				await transfer.query("COMMIT");
				/* The writer saw the binding, re-resolved, and is now parked on the
				 * app row. */
				await vi.waitFor(
					async () => expect(await blockedBy(appHolder, appHolderPid)).toBe(1),
					{ timeout: 5_000 },
				);
				/* The session row is free: a holder transition on it lands while
				 * the writer waits for the app. With the session lock still held
				 * this UPDATE would wait behind the writer until the statement
				 * bound cancelled it. */
				await contenders.appDb
					.updateTable("design_sessions")
					.set({ updated_at: new Date() })
					.where("id", "=", sessionId)
					.execute();
				await appHolder.query("ROLLBACK");
			} finally {
				await transfer.query("ROLLBACK").catch(() => undefined);
				await appHolder.query("ROLLBACK").catch(() => undefined);
				await transfer.end();
				await appHolder.end();
				if (outcome !== undefined) await outcome;
				__setAppDbForTests(h.db());
				await contenders.destroy();
			}
			const [landed] = (await outcome) ?? [];
			if (landed?.status === "rejected") throw landed.reason;
			expect(landed?.value).toBe(true);
			const doc = await loadThread(target, threadId);
			expect(doc?.messages.map((m) => m.id)).toEqual(["m1"]);
		},
		CASE_TIMEOUT_MS,
	);
});
