// lib/case-store/sql/__tests__/setup.ts
//
// Per-test fixture for the case-store Postgres harness.
//
// Pairs with `globalSetup.ts`. globalSetup runs in the
// orchestrator process and boots one container per `vitest run`;
// this file runs in each worker process and gives every test a
// fresh `Kysely<Database>` instance bound to a Postgres
// transaction. The test body executes its writes against the live
// container, and the fixture's cleanup rolls the transaction back
// so writes never escape the test.
//
// ## Fixture lifecycle
//
// Vitest's `test.extend` provides a managed cleanup model. Each
// fixture wraps its cleanup logic in try/finally around `use()`
// so that a failing test still triggers ROLLBACK — without the
// finally, an exception in the test body would leak rows into the
// next test.
//
// Two fixtures are exposed:
//
//   - `db` — a `Kysely<Database>` instance that routes every query
//     through a single dedicated `pg.PoolClient` already inside a
//     BEGIN / ROLLBACK envelope. Tests use this for all typed
//     reads / writes; the type system already knows the schema, so
//     callers can chain `.insertInto`, `.selectFrom`, etc. without
//     further setup.
//   - `pgClient` — the same `pg.PoolClient` exposed directly. Used
//     for raw SQL the typed builder can't compile (extension
//     installation, `information_schema` probes, `EXPLAIN
//     ANALYZE`). Both fixtures share a single connection so they
//     share the transaction's visibility — a write through `db`
//     is immediately visible to a raw query through `pgClient`,
//     and vice versa.
//
// ## Why one connection, not two
//
// Kysely's `startTransaction().execute()` is the canonical way to
// get a `Transaction<DB>` but it allocates the connection itself
// from the configured pool — leaving no handle on the underlying
// pg client. To expose `pgClient` as a working escape hatch we
// instead check out a `pg.PoolClient` ourselves, run BEGIN on it,
// and hand it to a Kysely instance configured with a
// single-connection driver. Both fixtures point at the same
// client; both see the same in-flight transaction.
//
// ## Worker-scoped pool
//
// Vitest 4 runs each test file in a fresh worker by default but
// can recycle workers across files when `pool: "threads"` mode is
// active. We give each worker its own `pg.Pool`; pool checkouts
// per test stay tiny (one connection in flight per concurrent
// test). The pool is closed via `afterAll` in this file. Vitest
// fires `afterAll` once per test file and one final time when the
// worker process is about to exit; `pool.end()` is idempotent on
// a closed pool, so re-firing across multiple test files in the
// same worker is safe.

import {
	type Insertable,
	Kysely,
	PostgresDialect,
	type PostgresPool,
	type PostgresPoolClient,
} from "kysely";
import type { PoolClient } from "pg";
import { Pool } from "pg";
import { afterAll, test as baseTest, inject } from "vitest";
import type { CasesTable, Database } from "../database";

// ---------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------
//
// Tests import everything from this module — the fixture itself,
// expect, the Database type, and any helper builders below. That
// keeps fixture + assertion in a single import line and makes the
// fixture surface easy to evolve without ripple changes across
// every test file.

export { expect } from "vitest";
export type { Database } from "../database";

// ---------------------------------------------------------------
// Worker-scoped pool
// ---------------------------------------------------------------

/**
 * Connection URI provided by globalSetup. Read once per worker
 * via `inject()` at module load. globalSetup is guaranteed to
 * have run before any worker imports this file — Vitest blocks
 * worker startup on globalSetup completion.
 */
const connectionString = inject("postgresTestUrl");

/**
 * Worker-scoped `pg.Pool`. One pool per worker process; callers
 * acquire transactions through the `db` / `pgClient` fixtures
 * rather than touching the pool directly.
 *
 * `max: 5` is a conservative ceiling — each test holds one
 * connection for the duration of its transaction, so concurrent
 * tests within a worker need that many connections. Raising it
 * costs nothing; lowering risks deadlock if Vitest ever
 * schedules multiple tests concurrently per worker.
 */
const pool = new Pool({ connectionString, max: 5 });

/**
 * Worker teardown — close the pool when this test file's worker
 * exits. Idempotent across multiple test files in the same
 * worker (a closed pool's `end()` resolves immediately).
 */
afterAll(async () => {
	await pool.end();
});

// ---------------------------------------------------------------
// Single-connection adapter for Kysely's PostgresDialect
// ---------------------------------------------------------------
//
// PostgresDialect is constructed against an object that
// implements Kysely's `PostgresPool` interface — `connect()`
// returns a client and `end()` closes the pool. We wrap the
// already-checked-out `pg.PoolClient` so every Kysely query
// routes back to the same connection, and so the BEGIN we ran
// before constructing the wrapper is visible to every query.

/**
 * Wrap a single `pg.PoolClient` as a one-connection
 * `PostgresPool`. The wrapper's `connect()` always returns the
 * same client; `release()` is a no-op so Kysely's per-query
 * release doesn't hand the connection back to the real pool
 * before the test fixture's cleanup runs.
 */
function singleConnectionPool(client: PoolClient): PostgresPool {
	const wrappedClient: PostgresPoolClient = {
		query: client.query.bind(client) as PostgresPoolClient["query"],
		release: () => {
			// no-op — the test fixture's cleanup releases the
			// real connection back to the worker pool. Letting
			// Kysely release it per-query would unwind our BEGIN
			// scope on the first await.
		},
	};
	return {
		connect: async () => wrappedClient,
		end: async () => {
			// no-op — the worker pool's `afterAll` owns lifecycle.
		},
	};
}

// ---------------------------------------------------------------
// Fixture types
// ---------------------------------------------------------------

/**
 * The fixture object every test in this harness receives.
 *
 * `db` is the primary fixture — a Kysely instance routing through
 * a single connection that's already inside a BEGIN. Tests
 * execute queries through `db`; the harness rolls back at
 * teardown so writes never persist beyond the test boundary.
 *
 * `pgClient` is the escape hatch for queries Kysely can't
 * compile (extension installation, `EXPLAIN ANALYZE`, raw
 * `information_schema` probes). Both fixtures share the same
 * underlying connection, so they share the transaction's
 * visibility.
 */
export interface CaseStoreFixtures {
	/** Kysely instance bound to `Database`, transaction-scoped. */
	db: Kysely<Database>;
	/** The raw `pg.PoolClient` underlying `db`'s transaction. */
	pgClient: PoolClient;
}

// ---------------------------------------------------------------
// Fixture wiring
// ---------------------------------------------------------------

/**
 * Test entry point — extends Vitest's base test with the
 * harness's per-test fixtures. Test files import `test` from
 * this module instead of `vitest` directly so they pick up the
 * fixtures automatically.
 *
 * Fixture ordering: `pgClient` checks out a connection from the
 * worker pool, runs BEGIN, and hands the client to the test.
 * `db` depends on `pgClient` and wraps it in a Kysely instance.
 * Cleanup runs in reverse order — `db` destroys the wrapper
 * Kysely instance first; then `pgClient` runs ROLLBACK and
 * releases the connection.
 *
 * The try/finally around `use()` is load-bearing: a thrown
 * assertion inside the test body skips any code after `use()`,
 * but the `finally` always fires. Without this guard a failing
 * test would leak its writes into the next test's view.
 */
export const test = baseTest.extend<CaseStoreFixtures>({
	// Vitest's fixture function MUST destructure its first argument
	// (the framework parses the source AST and rejects bare param
	// names — see `FixtureParseError` at vitest/dist/runner/fixture).
	// `pgClient` has no fixture deps, so we destructure `task` —
	// the per-test handle Vitest exposes on every fixture context —
	// purely to satisfy the parse check. `task` is unused; the
	// underscore-prefix tells Biome not to flag it.
	pgClient: async ({ task: _task }, use) => {
		const client = await pool.connect();
		try {
			await client.query("BEGIN");
			try {
				await use(client);
			} finally {
				// Rollback on every path — pass and fail alike. On
				// pass we discard the test's writes (per-test
				// isolation contract); on fail we discard them too,
				// to keep the next test's view clean.
				await client.query("ROLLBACK");
			}
		} finally {
			client.release();
		}
	},

	db: async ({ pgClient }, use) => {
		// Wrap the already-transactional `pg.PoolClient` in a
		// Kysely instance via the single-connection adapter. Every
		// query routes through `pgClient`, so the BEGIN that ran
		// before constructing this wrapper is visible to every
		// query and the ROLLBACK in `pgClient`'s cleanup discards
		// every write.
		const driver = new Kysely<Database>({
			dialect: new PostgresDialect({
				pool: singleConnectionPool(pgClient),
			}),
		});

		try {
			await use(driver);
		} finally {
			// Destroy the wrapper Kysely instance to release any
			// internal state. The underlying connection isn't
			// touched — the `pgClient` fixture owns release.
			await driver.destroy();
		}
	},
});

// ---------------------------------------------------------------
// Convenience builders
// ---------------------------------------------------------------
//
// Helpers that compose the most common test fixtures into typed
// row literals. Each test that needs a case row constructs one
// via `makeCaseRow({ overrides... })` rather than restating every
// column. Keeping these in the fixture module means downstream
// compiler tests don't reinvent them.

/**
 * Build a fully typed `cases` row literal with sensible defaults
 * for every column. Pass an `overrides` object to vary specific
 * fields — typing pulls from `Insertable<CasesTable>` so a typo
 * in an override key fails compilation.
 *
 * The default case opens fresh ("open" status, non-null
 * `opened_on`, null `closed_on`) which is the most common test
 * shape. Closed-case tests set `closed_on` and `status` in the
 * overrides.
 */
export function makeCaseRow(
	overrides: Partial<Insertable<CasesTable>> = {},
): Insertable<CasesTable> {
	const now = new Date("2026-05-02T12:00:00Z");
	const baseRow = {
		case_id: crypto.randomUUID(),
		app_id: "app-test",
		case_type: "patient",
		owner_id: "owner-test",
		status: "open",
		opened_on: now,
		modified_on: now,
		closed_on: null,
		parent_case_id: null,
		// `JSONColumnType` accepts a JSON string on insert — Kysely
		// hands the string straight to pg, which casts to JSONB.
		properties: JSON.stringify({}),
	} satisfies Insertable<CasesTable>;
	return { ...baseRow, ...overrides };
}
