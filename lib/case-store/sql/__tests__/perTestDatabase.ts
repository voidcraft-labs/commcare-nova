// lib/case-store/sql/__tests__/perTestDatabase.ts
//
// Per-test database helper. The harness's BEGIN/ROLLBACK fixture
// can't host tests whose code-under-test calls `db.transaction()`
// — Kysely lowers it to a literal `BEGIN` and Postgres rejects
// nested BEGIN inside the outer transaction. The
// `PostgresCaseStore` methods all transact, so its tests get
// short-lived per-test databases instead.
//
// `databaseNamePrefix` shows in `pg_database` while the test runs
// so an operator listing distinguishes stuck tests by call site.
// The random suffix avoids collisions across workers.
//
// Extensions install into every per-test database for production
// parity (the case-store compilers depend on all three).

import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { Client, Pool } from "pg";
import { afterEach, beforeEach, inject } from "vitest";
import { compilerBugMessage } from "@/lib/domain/predicate/errors";

/**
 * Stable handle returned by `setupPerTestDatabase`. Field values
 * mutate in place across tests so a single capture at file scope
 * points at the current test's fresh database. Reading outside a
 * test body throws (the getters require an active per-test state).
 */
export interface PerTestDatabaseHandle {
	readonly databaseName: string;
	readonly uri: string;
	readonly db: Kysely<unknown>;
	readonly pool: Pool;
}

export interface PerTestDatabaseOptions {
	/** Postgres identifier rules: alphanumeric + underscore, lowercase, no leading digit. */
	databaseNamePrefix: string;
}

const REQUIRED_EXTENSIONS = ["pg_trgm", "fuzzystrmatch", "postgis"] as const;

/**
 * Wire `beforeEach` / `afterEach` to create + drop a fresh
 * Postgres database around each test. The teardown try/finally
 * runs `DROP DATABASE` even when `db.destroy()` throws —
 * otherwise a destroy failure would strand the per-test database
 * in `pg_database` for the rest of the run.
 */
export function setupPerTestDatabase(
	options: PerTestDatabaseOptions,
): PerTestDatabaseHandle {
	// `null` outside a test body — getters throw if accessed there
	// rather than silently returning the previous test's state.
	let active: {
		databaseName: string;
		uri: string;
		db: Kysely<unknown>;
		pool: Pool;
	} | null = null;

	beforeEach(async () => {
		const created = await createIsolatedDatabase(options.databaseNamePrefix);
		const built = buildIsolatedDb(created.uri);
		active = {
			databaseName: created.databaseName,
			uri: created.uri,
			db: built.db,
			pool: built.pool,
		};
	});

	afterEach(async () => {
		const captured = active;
		// Clear first so a stray handle access in an `afterAll`
		// surfaces the "outside a test" error rather than seeing
		// the previous test's state.
		active = null;
		if (captured === null) {
			return;
		}
		try {
			await captured.db.destroy();
		} finally {
			await dropIsolatedDatabase(captured.databaseName);
		}
	});

	const requireActive = () => {
		if (active === null) {
			throw new Error(
				compilerBugMessage({
					where: "case-store.setupPerTestDatabase",
					invariant:
						"`PerTestDatabaseHandle` accessed outside a Vitest test body",
					detail:
						"The handle's `db` / `pool` / `uri` / `databaseName` fields are populated in `beforeEach` and cleared in `afterEach`. Reading them at module scope or inside a top-level describe block returns `null`.\n\nHint: read the handle inside an `it(...)` callback or a sibling `beforeEach` registered after `setupPerTestDatabase` runs.",
				}),
			);
		}
		return active;
	};

	return {
		get databaseName() {
			return requireActive().databaseName;
		},
		get uri() {
			return requireActive().uri;
		},
		get db() {
			return requireActive().db;
		},
		get pool() {
			return requireActive().pool;
		},
	};
}

/**
 * Swap the database name in a Postgres URI while preserving
 * credentials, host, port, and query string. Hand-rolled because
 * Node's `URL` class doesn't reliably preserve percent-encoded
 * user/password components across versions.
 */
function urlForDatabase(baseUri: string, databaseName: string): string {
	const queryStart = baseUri.indexOf("?");
	const pathPart = queryStart === -1 ? baseUri : baseUri.slice(0, queryStart);
	const queryPart = queryStart === -1 ? "" : baseUri.slice(queryStart);
	const lastSlash = pathPart.lastIndexOf("/");
	return `${pathPart.slice(0, lastSlash + 1)}${databaseName}${queryPart}`;
}

/**
 * `CREATE DATABASE <prefix><rand>` against the superuser
 * connection from globalSetup, then install the three required
 * extensions (`pg_trgm`, `fuzzystrmatch`, `postgis`) the case-store
 * compiler stack depends on.
 */
async function createIsolatedDatabase(
	databaseNamePrefix: string,
): Promise<{ databaseName: string; uri: string }> {
	const baseUri = inject("postgresTestUrl");
	const databaseName = `${databaseNamePrefix}${Math.random().toString(36).slice(2, 10)}`;

	const adminClient = new Client({ connectionString: baseUri });
	await adminClient.connect();
	try {
		await adminClient.query(`CREATE DATABASE ${databaseName}`);
	} finally {
		await adminClient.end();
	}

	const targetUri = urlForDatabase(baseUri, databaseName);
	const targetClient = new Client({ connectionString: targetUri });
	await targetClient.connect();
	try {
		for (const extension of REQUIRED_EXTENSIONS) {
			// Identifier interpolation is safe — every value comes
			// from the static `REQUIRED_EXTENSIONS` tuple.
			await targetClient.query(`CREATE EXTENSION IF NOT EXISTS "${extension}"`);
		}
	} finally {
		await targetClient.end();
	}

	return { databaseName, uri: targetUri };
}

/**
 * `WITH (FORCE)` (PG 13+) terminates any open connection to the
 * target so a leaked client doesn't keep the drop blocked. The
 * per-test handle's `db.destroy()` runs first; this is the
 * belt-and-suspenders fallback.
 */
async function dropIsolatedDatabase(databaseName: string): Promise<void> {
	const baseUri = inject("postgresTestUrl");
	const adminClient = new Client({ connectionString: baseUri });
	await adminClient.connect();
	try {
		await adminClient.query(
			`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`,
		);
	} finally {
		await adminClient.end();
	}
}

/**
 * `max: 1` — a single test thread issues sequential reads; a
 * larger pool would be wasted overhead.
 */
function buildIsolatedDb(uri: string): {
	db: Kysely<unknown>;
	pool: Pool;
} {
	const pool = new Pool({ connectionString: uri, max: 1 });
	const db = new Kysely<unknown>({
		dialect: new PostgresDialect({
			pool: pool as unknown as PostgresPool,
		}),
	});
	return { db, pool };
}
