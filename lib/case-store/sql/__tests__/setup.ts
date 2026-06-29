// lib/case-store/sql/__tests__/setup.ts
//
// Per-test fixture for the case-store Postgres harness. Pairs
// with `globalSetup.ts` (which boots one container per `vitest
// run`); this file runs in each worker and gives every test a
// `Kysely<Database>` instance inside a BEGIN / ROLLBACK envelope.
//
// Two fixtures share one connection so writes through `db` are
// immediately visible to raw queries through `pgClient` and vice
// versa. `pgClient` is the escape hatch for queries Kysely can't
// compile (extension installation, `information_schema` probes,
// `EXPLAIN ANALYZE`).
//
// ## Why one connection, not two
//
// Kysely's `startTransaction().execute()` allocates from the pool
// internally — no handle on the underlying pg client, no working
// `pgClient` escape hatch. We check out a `pg.PoolClient`
// ourselves, run BEGIN on it, and wrap it in a Kysely instance
// via a single-connection adapter so both fixtures see the same
// transaction.

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

// Tests import everything from this module — fixture + `expect`
// + helpers — in one import line.
export { expect } from "vitest";
export type { Database } from "../database";

/** globalSetup blocks worker startup, so this is always defined by import time. */
const connectionString = inject("postgresTestUrl");

/** `max: 5` leaves headroom for `test.concurrent` opt-ins. */
const pool = new Pool({ connectionString, max: 5 });

afterAll(async () => {
	// `pool.end()` is idempotent on closed pools, so re-firing
	// across multiple test files in the same worker is safe.
	await pool.end();
});

/**
 * Wrap a single `pg.PoolClient` as a one-connection
 * `PostgresPool` so every Kysely query routes through the same
 * connection (and the BEGIN that ran before constructing the
 * wrapper is visible to every query). `release()` is a no-op so
 * Kysely's per-query release doesn't return the connection to the
 * real pool before the fixture's ROLLBACK runs.
 */
function singleConnectionPool(client: PoolClient): PostgresPool {
	const wrappedClient: PostgresPoolClient = {
		// `Function.prototype.bind` erases pg's `query` overloads; the
		// cast restores the callable surface Kysely's
		// `PostgresPoolClient` type expects.
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
		// Kysely 0.29's PostgresDriver reads `pool.options` when it
		// constructs a connection (passed through as `poolOptions`).
		// Forward the real worker pool's options so the wrapper behaves
		// identically to the pool it stands in for.
		options: pool.options,
	};
}

export interface CaseStoreFixtures {
	db: Kysely<Database>;
	/** Raw `pg.PoolClient` underlying `db`'s transaction. */
	pgClient: PoolClient;
}

/**
 * Test entry point with the harness's per-test fixtures. Test
 * files import `test` from here instead of `vitest` directly.
 *
 * The try/finally around `use()` is load-bearing — a thrown
 * assertion skips any code after `use()`, but `finally` always
 * fires. Without it a failing test would leak writes into the
 * next test's view.
 */
export const test = baseTest.extend<CaseStoreFixtures>({
	// biome-ignore lint/correctness/noEmptyPattern: Vitest requires an object destructuring pattern as the fixture's first argument; an empty `{}` is the documented form when the fixture takes no upstream dependencies.
	pgClient: async ({}, use) => {
		const client = await pool.connect();
		try {
			await client.query("BEGIN");
			try {
				await use(client);
			} finally {
				await client.query("ROLLBACK");
			}
		} finally {
			client.release();
		}
	},

	db: async ({ pgClient }, use) => {
		const driver = new Kysely<Database>({
			dialect: new PostgresDialect({
				pool: singleConnectionPool(pgClient),
			}),
		});

		try {
			await use(driver);
		} finally {
			// `pgClient` owns connection release; this destroys
			// the wrapper Kysely instance only.
			await driver.destroy();
		}
	},
});

/**
 * Typed `cases` row literal with sensible defaults. Override keys
 * type-check against `Insertable<CasesTable>` so typos fail
 * compilation. Default is a fresh-open case; closed-case tests
 * set `closed_on` / `status` in overrides.
 */
export function makeCaseRow(
	overrides: Partial<Insertable<CasesTable>> = {},
): Insertable<CasesTable> {
	const now = new Date("2026-05-02T12:00:00Z");
	const baseRow = {
		case_id: crypto.randomUUID(),
		app_id: "app-test",
		case_type: "patient",
		project_id: "project-test",
		owner_id: "owner-test",
		status: "open",
		opened_on: now,
		modified_on: now,
		closed_on: null,
		// Non-empty default satisfies `case_name`'s `length > 0`
		// CHECK without every call site spelling it out.
		case_name: "test-case",
		parent_case_id: null,
		// `JSONColumnType`'s insert side is a JSON string — Kysely
		// hands it to pg, which casts to JSONB.
		properties: JSON.stringify({}),
	} satisfies Insertable<CasesTable>;
	return { ...baseRow, ...overrides };
}
