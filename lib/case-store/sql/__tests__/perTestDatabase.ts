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
// Clone closed templates built once per run: extensions only by default,
// production-migrated schema when explicitly requested by behavior tests.

import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { Client, Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, inject } from "vitest";
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
	/** Clone the production migration result for behavior tests; omit for migration tests. */
	schema?: "migrated";
	/** Build expensive migration preconditions once, then clone them per test.
	 * The migration under test must still run in each test body. */
	prepareTemplate?: (db: Kysely<unknown>, pool: Pool) => Promise<void>;
	/**
	 * Explicitly identify this isolated database as the local migration target.
	 *
	 * Exact migrations fail closed when production database-role identities are
	 * absent. Tests that run those migrations must opt into the same local
	 * authority used by `npm run dev`; merely running under Vitest is not
	 * authority to bypass a production invariant.
	 */
	establishLocalMigrationAuthority?: true;
}

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
	let suiteTemplate: string | undefined;
	if (options.prepareTemplate) {
		const prepare = options.prepareTemplate;
		beforeAll(async () => {
			const created = await createIsolatedDatabase(
				`${options.databaseNamePrefix}template_`,
				options.schema,
			);
			suiteTemplate = created.databaseName;
			const built = buildIsolatedDb(created.uri);
			const previous = process.env.NOVA_DB_LOCAL_URL;
			try {
				if (options.establishLocalMigrationAuthority) {
					process.env.NOVA_DB_LOCAL_URL = created.uri;
				}
				await prepare(built.db, built.pool);
			} finally {
				if (previous === undefined) delete process.env.NOVA_DB_LOCAL_URL;
				else process.env.NOVA_DB_LOCAL_URL = previous;
				await built.db.destroy();
				if (!built.pool.ended) await built.pool.end();
			}
			const admin = new Client({ connectionString: postgresTestUrl() });
			try {
				await admin.connect();
				await admin.query(
					`ALTER DATABASE ${suiteTemplate} ALLOW_CONNECTIONS false`,
				);
			} finally {
				await admin.end();
			}
		});
		afterAll(async () => {
			if (suiteTemplate !== undefined)
				await dropIsolatedDatabase(suiteTemplate);
		});
	}
	// `null` outside a test body — getters throw if accessed there
	// rather than silently returning the previous test's state.
	let active: {
		databaseName: string;
		uri: string;
		db: Kysely<unknown>;
		pool: Pool;
		previousLocalDatabaseUrl: string | undefined;
	} | null = null;

	beforeEach(async () => {
		const created = await createIsolatedDatabase(
			options.databaseNamePrefix,
			options.schema,
			suiteTemplate,
		);
		const built = buildIsolatedDb(created.uri);
		const previousLocalDatabaseUrl = process.env.NOVA_DB_LOCAL_URL;
		if (options.establishLocalMigrationAuthority === true) {
			process.env.NOVA_DB_LOCAL_URL = created.uri;
		}
		active = {
			databaseName: created.databaseName,
			uri: created.uri,
			db: built.db,
			pool: built.pool,
			previousLocalDatabaseUrl,
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
			// Kysely initializes its driver lazily. Tests that use the exposed
			// `pool` directly can open a connection without ever initializing
			// `db`, in which case `db.destroy()` intentionally no-ops and leaves
			// the shared pool alive. Close that path explicitly; when Kysely did
			// initialize, its destroy already marks the pool ended.
			if (!captured.pool.ended) {
				await captured.pool.end();
			}
		} finally {
			try {
				await dropIsolatedDatabase(captured.databaseName);
			} finally {
				if (options.establishLocalMigrationAuthority === true) {
					if (captured.previousLocalDatabaseUrl === undefined) {
						delete process.env.NOVA_DB_LOCAL_URL;
					} else {
						process.env.NOVA_DB_LOCAL_URL = captured.previousLocalDatabaseUrl;
					}
				}
			}
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

/** Clone an immutable template into a database owned by this test. */
async function createIsolatedDatabase(
	databaseNamePrefix: string,
	schema?: "migrated",
	preparedTemplate?: string,
): Promise<{ databaseName: string; uri: string }> {
	const baseUri = postgresTestUrl();
	const databaseName = `${databaseNamePrefix}${Math.random().toString(36).slice(2, 10)}`;

	const adminClient = new Client({ connectionString: baseUri });
	try {
		await adminClient.connect();
		const template =
			preparedTemplate ??
			(schema === "migrated"
				? inject("postgresMigratedTemplate")
				: inject("postgresExtensionsTemplate"));
		await adminClient.query(
			`CREATE DATABASE ${databaseName} TEMPLATE ${template}`,
		);
	} finally {
		await adminClient.end();
	}

	const targetUri = urlForDatabase(baseUri, databaseName);
	return { databaseName, uri: targetUri };
}

/**
 * `WITH (FORCE)` (PG 13+) terminates any open connection to the
 * target so a leaked client doesn't keep the drop blocked. The
 * per-test handle's `db.destroy()` runs first; this is the
 * belt-and-suspenders fallback.
 */
async function dropIsolatedDatabase(databaseName: string): Promise<void> {
	const baseUri = postgresTestUrl();
	const adminClient = new Client({ connectionString: baseUri });
	try {
		await adminClient.connect();
		await adminClient.query(
			`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`,
		);
	} finally {
		await adminClient.end();
	}
}

/** Refuse a misplaced fixture before pg can fall back to local credentials. */
export function postgresTestUrl(): string {
	const uri = inject("postgresTestUrl");
	if (!uri) {
		throw new Error(
			"This fixture needs the Postgres test project. Name its test *.postgres.test.ts so Vitest provisions the isolated database.",
		);
	}
	return uri;
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
	// Absorb the connection-termination error the teardown drop provokes.
	// `afterEach` runs `DROP DATABASE ... WITH (FORCE)` (see
	// `dropIsolatedDatabase`) as a fallback even after `db.destroy()`, and
	// FORCE terminates any connection still open to the target — a checked-out
	// leak, or one still closing when the drop lands under a loaded runner. pg
	// re-emits that as a pool `'error'` (`terminating connection due to
	// administrator command`); with no listener Node escalates it to an
	// uncaughtException that fails the whole `vitest run`, and under
	// a late worker teardown its timing can affect another file. The drop is intentional, so a
	// terminated idle connection here is expected teardown noise, not a fault
	// the harness should surface. (An error on an ACTIVE query still rejects
	// that query — this listener only catches idle-client errors.)
	pool.on("error", () => {});
	const db = new Kysely<unknown>({
		dialect: new PostgresDialect({
			pool: pool as unknown as PostgresPool,
		}),
	});
	return { db, pool };
}
