// lib/case-store/sql/__tests__/perTestDatabase.ts
//
// Per-test database helper. The harness's BEGIN/ROLLBACK fixture
// cannot host every test shape — the canonical example is
// `lib/case-store/postgres/__tests__/store.test.ts`, whose
// `PostgresCaseStore` methods call `db.transaction()`, which
// Kysely's PostgresDriver lowers to a literal `BEGIN`. Postgres
// rejects nested BEGIN inside an outer transaction
// (`WARNING: there is already a transaction in progress`) and the
// inner SQL leaks into the outer transaction's state, corrupting
// per-test isolation. The fix: each test creates its own short-
// lived database, runs against it, drops it on cleanup.
//
// ## Contract
//
// `setupPerTestDatabase(options)` returns a `beforeEach`-/
// `afterEach`-managed handle exposing a `Kysely<unknown>`, the
// underlying `pg.Pool`, and the connection URI. The handle's
// fields are reset between tests; teardown drops the per-test
// database (`WITH (FORCE)`) and closes the Kysely instance whether
// the test passed or failed.
//
// `databaseNamePrefix` is the operator-facing identifier in
// `pg_database` while a test runs. Each test file passes its own
// prefix so a `pg_database` listing during a run distinguishes
// stuck tests by call site. The random suffix avoids collisions if
// multiple workers race to create databases.
//
// The helper installs the three required extensions (`pg_trgm`,
// `fuzzystrmatch`, `postgis`) into every per-test database before
// the test body runs — production parity. Extensions are not
// configurable per call site; the case-store's compiler stack
// depends on all three.

import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { Client, Pool } from "pg";
import { afterEach, beforeEach, inject } from "vitest";
import { compilerBugMessage } from "@/lib/domain/predicate/errors";

// ---------------------------------------------------------------
// Public API — the helper test files consume
// ---------------------------------------------------------------

/**
 * Per-test handle returned by `setupPerTestDatabase`. The fields
 * are getters backed by the helper's per-test state; calling them
 * outside a `beforeEach`-managed test body throws (rather than
 * silently returning a stale or `undefined` value).
 *
 * Tests capture the handle once at file or describe-block scope,
 * then read `handle.db` / `handle.pool` inside `it(...)` bodies —
 * the getter's per-call resolution returns the current test's
 * fresh database / pool.
 */
export interface PerTestDatabaseHandle {
	/** The auto-generated database name (`<prefix><rand>`). */
	readonly databaseName: string;
	/** The full connection URI targeting the per-test database. */
	readonly uri: string;
	/** Kysely<unknown> bound to the per-test database. */
	readonly db: Kysely<unknown>;
	/** The underlying pg.Pool. Tests use this for raw catalog probes. */
	readonly pool: Pool;
}

/**
 * Configuration for `setupPerTestDatabase`. Test files pass their
 * own prefix; the helper handles the Vitest lifecycle wiring
 * (beforeEach create + afterEach drop) and exposes the per-test
 * handle to the test body.
 */
export interface PerTestDatabaseOptions {
	/**
	 * Operator-facing name prefix for the per-test database. Pinned
	 * in `pg_database` while the test runs; helpful when diagnosing
	 * a stuck CI run by name. Must satisfy Postgres identifier rules
	 * (alphanumeric + underscore; lowercase; no leading digit).
	 */
	databaseNamePrefix: string;
}

/**
 * The three Postgres extensions every per-test database carries.
 * Production parity: these are exactly the extensions production
 * Cloud SQL has installed (Task 0 runbook §Phase 5) and the same
 * set the testcontainer harness's `globalSetup.ts` installs into
 * its shared database. Per-test databases are otherwise blank, so
 * the helper installs them right after `CREATE DATABASE`.
 */
const REQUIRED_EXTENSIONS = ["pg_trgm", "fuzzystrmatch", "postgis"] as const;

/**
 * Wire `beforeEach` / `afterEach` hooks that create + drop a fresh
 * per-test Postgres database, returning a stable reference whose
 * fields are populated by `beforeEach`. Tests dereference the
 * handle inside their body (`handle.db`, `handle.pool`).
 *
 * Teardown is wrapped in try/finally so a Kysely `db.destroy()`
 * failure still triggers the `DROP DATABASE` — without that,
 * a destroy throw would leak the per-test database into the
 * superuser instance, polluting `pg_database` for every
 * subsequent test in the run.
 *
 * Returns the handle reference so tests can capture it once at
 * file scope; the field values are mutated in place by `beforeEach`,
 * so the same reference points at the right database in every
 * test.
 */
export function setupPerTestDatabase(
	options: PerTestDatabaseOptions,
): PerTestDatabaseHandle {
	// The active per-test state. `null` outside a test body — getters
	// on the returned handle throw if accessed at that point. Without
	// this guard, accidentally reading the handle outside a Vitest
	// hook would silently return a stale value from a previous test
	// (or `undefined`) and produce a misleading downstream failure.
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
		// Drop the per-test database whether destroy succeeds or
		// throws. `db.destroy()` calls `pool.end()` exactly once via
		// the dialect-destroy contract; the inner try/finally pins
		// that the database always gets dropped, even on a destroy
		// failure (network blip mid-teardown, leaked connection from
		// the test body, etc.). Without this, a destroy throw would
		// strand the per-test database in `pg_database`.
		const captured = active;
		// Clear `active` first so a subsequent handle access surfaces
		// the "outside a test" error — without this, an accidental
		// reference inside an `afterAll` would still see the previous
		// test's state, masking the misuse.
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

	// The returned handle is a getter facade over `active`. Each
	// access reads the current per-test state — accessing outside a
	// test body throws with a clear diagnostic instead of silently
	// returning stale or undefined data.
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

// ---------------------------------------------------------------
// Internals — the per-test create/drop/build primitives
// ---------------------------------------------------------------

/**
 * Build a connection URI targeting the per-test database name,
 * preserving the superuser credentials and host/port from the
 * harness's published URI. Hand-rolled because Node's `URL` class
 * doesn't expose a setter that preserves percent-encoded user/
 * password components reliably across versions.
 */
function urlForDatabase(baseUri: string, databaseName: string): string {
	// `postgresql://user:pass@host:port/oldDb?params` →
	// `postgresql://user:pass@host:port/newDb?params`. Search
	// from the right so query strings (if any) remain intact;
	// search past the `:port` slash by anchoring on the last `/`
	// before any `?`.
	const queryStart = baseUri.indexOf("?");
	const pathPart = queryStart === -1 ? baseUri : baseUri.slice(0, queryStart);
	const queryPart = queryStart === -1 ? "" : baseUri.slice(queryStart);
	const lastSlash = pathPart.lastIndexOf("/");
	return `${pathPart.slice(0, lastSlash + 1)}${databaseName}${queryPart}`;
}

/**
 * Connect to the testcontainer's superuser default database (the
 * one `globalSetup.ts` created), `CREATE DATABASE
 * <prefix><rand>`, install the three required extensions, return
 * the URI.
 *
 * Extension install runs here (not in any migration) because
 * `CREATE EXTENSION` requires `cloudsqlsuperuser` on production
 * Cloud SQL and the IAM-auth runtime user couldn't run it if
 * tried. The harness's superuser inside the testcontainer can,
 * and mirroring the install here gives the per-test database
 * the same extension surface a freshly-provisioned Cloud SQL
 * instance has after Phase 5 runs.
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
			// Identifier interpolation is safe here: every value comes
			// from the static-literal `REQUIRED_EXTENSIONS` tuple.
			// No external input flows into this interpolation point.
			await targetClient.query(`CREATE EXTENSION IF NOT EXISTS "${extension}"`);
		}
	} finally {
		await targetClient.end();
	}

	return { databaseName, uri: targetUri };
}

/**
 * Drop the per-test database. `WITH (FORCE)` (PG 13+) terminates
 * any open connection to the target so a leaked client doesn't
 * keep the drop blocked. The per-test handle's `db.destroy()`
 * runs first; this is the belt-and-suspenders fallback.
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
 * Build a `Kysely<unknown>` + the underlying pool for a per-test
 * database. Returns both so the caller can teardown the pool
 * before dropping the database.
 *
 * `max: 1` keeps the per-test pool minimal — a single test thread
 * issues sequential reads on one connection; a larger pool would
 * be wasted overhead.
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
