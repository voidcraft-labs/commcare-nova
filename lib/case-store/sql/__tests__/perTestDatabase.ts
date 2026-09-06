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
import { Client, Pool, type PoolClient, type PoolConfig } from "pg";
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
	/** Build shared expensive preconditions once, then clone them per test.
	 * The behavior or migration under test must still run in each test body. */
	prepareTemplate?: (db: Kysely<unknown>, pool: Pool) => Promise<void>;
	/**
	 * Explicitly identify this isolated database as the local migration target.
	 *
	 * Exact migrations fail closed when production database-role identities are
	 * absent. Tests that run those migrations must opt into the same local
	 * authority used by `npm run dev`; merely running under Vitest is not
	 * authority to bypass a production invariant. The fixture also owns and
	 * closes any application connection opened through this local URL before
	 * dropping the database.
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
				try {
					if (options.establishLocalMigrationAuthority)
						await closeApplicationConnection();
				} finally {
					if (previous === undefined) delete process.env.NOVA_DB_LOCAL_URL;
					else process.env.NOVA_DB_LOCAL_URL = previous;
					await built.destroy();
				}
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
		destroy: () => Promise<void>;
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
			destroy: built.destroy,
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
			try {
				if (options.establishLocalMigrationAuthority)
					await closeApplicationConnection();
			} finally {
				await captured.destroy();
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
export function buildIsolatedDb<Database = unknown>(
	uri: string,
	poolOptions: Pick<
		PoolConfig,
		"max" | "connectionTimeoutMillis" | "query_timeout"
	> = {},
): {
	db: Kysely<Database>;
	pool: Pool;
	destroy(): Promise<void>;
} {
	const pool = new Pool({ connectionString: uri, max: 1, ...poolOptions });
	const failures: Error[] = [];
	const failed = new WeakSet<PoolClient>();
	const observe = (error: Error, client: PoolClient) => {
		if (failed.has(client)) return;
		failed.add(client);
		failures.push(error);
	};
	// A forced drop is not permission to hide unfinished test work. Both idle
	// pool errors and checked-out client errors fail the owning teardown.
	pool.on("error", observe);
	pool.on("connect", (client) =>
		client.on("error", (error) => observe(error, client)),
	);
	const db = new Kysely<Database>({
		dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
	});
	return {
		db,
		pool,
		async destroy() {
			try {
				await db.destroy();
			} finally {
				if (!pool.ended) await pool.end();
			}
			if (failures.length > 0)
				throw new AggregateError(failures, "Test database connection failed");
		},
	};
}

/** The local URL permits production factories to open their own cached pool.
 * Close that real pool before dropping its database or changing the URL; it
 * otherwise survives into the next test and receives a forced-disconnect error. */
async function closeApplicationConnection(): Promise<void> {
	const { closeCaseStoreDatabase } = await import("../../postgres/connection");
	await closeCaseStoreDatabase();
}
