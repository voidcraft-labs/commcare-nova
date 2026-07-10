/**
 * A per-test `AppDatabase` handle (Kysely over a bounded `pg.Pool`) whose
 * teardown is quiesce-then-destroy — it never races `Pool.end()` against a
 * client the pool is still connecting.
 *
 * The routes under test issue fire-and-forget reads (`void pump()` /
 * `void emitRoster()`), so a checkout — and the fresh physical connection the
 * pool spawns for it — can straggle past the test's end by design. pg-pool
 * dequeues the waiting checkout BEFORE its fresh client finishes connecting,
 * so `Pool.end()` called inside that window orphans the client: the connect
 * completes after `ending`, the client is handed to a checkout the ending
 * pool never reaps, and `end()` waits forever on a client list that never
 * empties. A starved CI runner stretches that window from microseconds to
 * seconds, which is what made the relay suites' teardown hook time out
 * nondeterministically. `destroy()` therefore waits until every spawned
 * client is idle — progress-bound on small local SELECTs, not on a timer
 * bound a starved runner fires late — and only then ends the pool.
 *
 * The teardown stays GRACEFUL on purpose: hard-destroying a socket skips the
 * stream's `end` event, which strands pg-protocol's stream-end promise and
 * trips the async-leak gate.
 */

import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { Pool } from "pg";
import type { AppDatabase } from "@/lib/db/pg";

export interface PerTestAppDb {
	readonly appDb: Kysely<AppDatabase>;
	/** Quiesce the pool (no mid-connect or checked-out client), then end it. */
	destroy(): Promise<void>;
}

export function createPerTestAppDb(uri: string): PerTestAppDb {
	/* The bounds cap a straggler's own connect/query so quiescence below is
	 * reachable even against a wedged server. */
	const pool = new Pool({
		connectionString: uri,
		max: 4,
		connectionTimeoutMillis: 10_000,
		query_timeout: 10_000,
	});
	/* Swallow the connection-termination noise teardown provokes (the per-test
	 * DROP DATABASE (FORCE)) — the same expected-teardown-noise the harness's
	 * own pools swallow (see `perTestDatabase.ts`). Both levels are needed: the
	 * pool emits for an idle client, a checked-out client emits on itself, and
	 * an unlistened `error` event crashes the worker. */
	pool.on("error", () => {});
	pool.on("connect", (client) => {
		client.on("error", () => {});
	});
	const appDb = new Kysely<AppDatabase>({
		dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
	});
	return {
		appDb,
		async destroy() {
			/* Quiesce: no queued waiter, no client mid-connect or checked out.
			 * (`totalCount` includes connecting clients; a checkout destined for a
			 * still-connecting client has already left `waitingCount`, so both
			 * halves of the condition are needed.) */
			while (pool.waitingCount > 0 || pool.totalCount !== pool.idleCount) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			await appDb.destroy().catch(() => {});
		},
	};
}
