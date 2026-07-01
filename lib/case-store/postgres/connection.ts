// lib/case-store/postgres/connection.ts
//
// Cloud SQL Postgres connection for the case store, runtime-only.
// Follows Google's canonical Cloud Run → Cloud SQL pattern: the platform
// mounts the Cloud SQL Auth Proxy as a Unix socket at
// `/cloudsql/<instanceConnectionName>` (wired by `--add-cloudsql-instances`
// in `cloudbuild.yaml`), and `pg.Pool` talks to that socket like a local
// file. The proxy owns the mTLS + ephemeral-certificate rotation in its own
// platform layer — nothing in this process runs a cert-refresh timer, so
// Cloud Run CPU throttling between requests can't starve it.
//
// Authentication is manual IAM database auth: the Postgres password is a
// short-lived Google access token fetched inline by `google-auth-library`
// (from the local metadata server) at connection time. The token is cached
// and refreshed by the library near its hour expiry; because pg only calls
// the password function while opening a connection — which happens on the
// live request path, CPU unthrottled — there is no background work to freeze.
//
// One `pg.Pool` + one `Kysely<Database>` per process. Lazy via
// `getCaseStoreDatabase()` — module-load eagerness would crash Next.js builds
// (which import modules without runtime env). `closeCaseStoreDatabase` is the
// SIGTERM teardown entry point; Kysely owns the pool's lifecycle through its
// dialect, so the close path just destroys Kysely (which drains the pool).
//
// ## Two connection modes
//
// **Production** targets Cloud Run → Cloud SQL over the `/cloudsql/…` socket
// with manual IAM auth. The instance is IAM-auth enabled
// (`cloudsql.iam_authentication`); the runtime service account holds
// `roles/cloudsql.client` and exists as an IAM database user.
//
// **Local dev** is an EXPLICIT opt-in via `NOVA_DB_LOCAL_URL`: when that var
// is set, `initialize()` connects to a plain Postgres at that URL — the
// docker-compose container `npm run dev` boots (`compose.yaml` at the repo
// root) — with no socket, IAM, or token fetch. It is NOT a silent `NODE_ENV`
// fallback: production never sets the var, so a missing `NOVA_DB_*` there
// still fails loudly via `readCaseStoreEnvConfig`. That is the distinction the
// earlier "no localhost fallback" rule was protecting — an unconditional
// fallback masks production misconfiguration; an explicit opt-in URL that prod
// never sets does not.
//
// Tests use the testcontainers harness under
// `lib/case-store/sql/__tests__/`. Ad-hoc prod DB inspection runs through
// Cloud SQL Studio in the Google Cloud Console.

import { GoogleAuth } from "google-auth-library";
import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import type { PoolConfig } from "pg";
import { Pool } from "pg";
import type { Database } from "../sql/database.js";

// `Database` is the type contract every typed query in
// `lib/case-store/sql/` binds against. Re-exported here so the
// runtime-instance and the type contract sit on one import path.

export type { Database } from "../sql/database.js";

/**
 * OAuth scope for manual IAM database login. The access token minted under
 * this scope is what Cloud SQL accepts as the Postgres password for the IAM
 * database user. NOT `sqlservice.admin` — that scope is for the Admin API
 * (managing instances), not for logging in to the database.
 */
const IAM_DB_LOGIN_SCOPE = "https://www.googleapis.com/auth/sqlservice.login";

// Pool-sizing invariant — named constants, not magic numbers. The
// three deployment numbers below compose into the budget guarantee:
// `CLOUD_RUN_MAX_INSTANCES * POOL_MAX_PER_INSTANCE` ≤
// `CLOUD_SQL_MAX_CONNECTIONS - CLOUD_SQL_RESERVED_CONNECTIONS`.
// `enforceConnectionBudget` (below) fails loudly if the math drifts.

/** Cloud SQL `db-f1-micro` `max_connections`. */
export const CLOUD_SQL_MAX_CONNECTIONS = 25;

/** Connections held back for `postgres` superuser, admin tooling, replication. */
export const CLOUD_SQL_RESERVED_CONNECTIONS = 5;

/** Cloud Run `--max-instances` for `commcare-nova`. */
export const CLOUD_RUN_MAX_INSTANCES = 5;

/**
 * Per-Cloud-Run-instance `pg.Pool` `max`. For the current shape:
 * `5 * 4 = 20 = 25 - 5`. Fits exactly.
 */
export const POOL_MAX_PER_INSTANCE = 4;

/**
 * Cap on how long a query waits to ACQUIRE a pooled connection before erroring.
 * Without it `pg.Pool` queues indefinitely; since the auth migration funnels a
 * per-request `isUserActive` read onto this 4-connection pool (which also serves
 * case-store/preview queries), a saturated pool could otherwise hang requests to
 * the route's 300s ceiling. A bounded timeout fails fast instead — the auth read
 * is fail-open on error (`sessionUserIsActive` allows the request), and
 * case-store queries surface a clear error rather than stalling.
 */
export const POOL_CONNECTION_TIMEOUT_MS = 10_000;

/**
 * Connection-budget invariant. Throws when the four constants drift
 * into a configuration that would let Cloud Run instances overrun
 * Cloud SQL's cap. Fires once per process on the first
 * `getCaseStoreDatabase()` call — first-call rather than module-load
 * so a non-runtime import (Next.js build, type-only test import)
 * doesn't trigger the throw. Exported so the unit test calls this
 * exact function rather than re-deriving the formula.
 */
export function enforceConnectionBudget(): void {
	const applicationBudget =
		CLOUD_SQL_MAX_CONNECTIONS - CLOUD_SQL_RESERVED_CONNECTIONS;
	const peakDemand = CLOUD_RUN_MAX_INSTANCES * POOL_MAX_PER_INSTANCE;
	if (peakDemand > applicationBudget) {
		// Inline Elm-style throw — header / indented diagnostic / narrative /
		// Hint. Configuration violations don't fit `compilerBugMessage`
		// (this is operator misconfiguration, not an internal invariant)
		// but match the same voice for consistency with the rest of the
		// case-store error surface.
		throw new Error(
			[
				"Cloud SQL connection budget exceeded.",
				"",
				`    peak demand:        ${CLOUD_RUN_MAX_INSTANCES} (instances) * ${POOL_MAX_PER_INSTANCE} (pool max) = ${peakDemand}`,
				`    available budget:   ${CLOUD_SQL_MAX_CONNECTIONS} - ${CLOUD_SQL_RESERVED_CONNECTIONS} = ${applicationBudget}`,
				"",
				"`pg.Pool` `max` × Cloud Run `--max-instances` must stay at or below",
				"Cloud SQL `max_connections` minus the reserved-for-postgres slot count.",
				"Crossing the budget can stall every Cloud Run instance against the",
				"shared connection cap.",
				"",
				"Hint: tier up Cloud SQL (raises `CLOUD_SQL_MAX_CONNECTIONS`), reduce",
				"`CLOUD_RUN_MAX_INSTANCES`, or reduce `POOL_MAX_PER_INSTANCE` so the four",
				"constants in `lib/case-store/postgres/connection.ts` stay consistent.",
			].join("\n"),
		);
	}
}

// Environment variable contract.
//
// Cloud Run wires three required env vars at deploy time:
// `NOVA_DB_NAME` (the database name), `NOVA_DB_USER` (the IAM
// database user identity for the Cloud Run runtime SA, in Cloud
// SQL's truncated form without `.gserviceaccount.com`), and
// `NOVA_DB_INSTANCE_CONNECTION_NAME` (the `project:region:instance`
// string — wired into `--add-cloudsql-instances` and used to form
// the socket path `/cloudsql/<name>`).
// Defensive about both "absent key" and "key present but empty
// string" because Cloud Run's `--update-env-vars` flag accepts
// empty values silently — a defaultable runtime would mask the
// misconfiguration.

/** The env vars read at runtime. Single source for validator + tests. */
export const REQUIRED_ENV_VARS = [
	"NOVA_DB_NAME",
	"NOVA_DB_USER",
	"NOVA_DB_INSTANCE_CONNECTION_NAME",
] as const;

export type RequiredEnvVar = (typeof REQUIRED_ENV_VARS)[number];

/** The validated env block. Property names match the underlying env vars. */
export interface CaseStoreEnvConfig {
	NOVA_DB_NAME: string;
	NOVA_DB_USER: string;
	NOVA_DB_INSTANCE_CONNECTION_NAME: string;
}

/**
 * Read the required env vars from `process.env` and verify each is
 * present and non-empty. Aggregates every gap into one error so a
 * misdeployment surfaces as one diagnostic, not a chain of `pg`
 * driver failures across restart cycles. Tests pass a stub `env`.
 */
export function readCaseStoreEnvConfig(
	env: Readonly<Partial<Record<string, string>>> = process.env,
): CaseStoreEnvConfig {
	const missing: RequiredEnvVar[] = [];
	for (const name of REQUIRED_ENV_VARS) {
		const value = env[name];
		if (value === undefined || value.length === 0) {
			missing.push(name);
		}
	}
	if (missing.length > 0) {
		throw new Error(
			[
				"Cloud SQL case store is missing required environment variables.",
				"",
				`    missing: ${missing.join(", ")}`,
				"",
				"Cloud Run accepts an empty env-var value silently via",
				"`--update-env-vars`, so a typo or a stale revision can leave the",
				"deployed pod with one or more variables absent. The socket path",
				"requires all three: `NOVA_DB_NAME`, `NOVA_DB_USER`,",
				"`NOVA_DB_INSTANCE_CONNECTION_NAME`.",
				"",
				"Hint: re-run the `gcloud run services update` command that wires",
				"the Cloud SQL env vars onto the live revision.",
			].join("\n"),
		);
	}
	// All three are populated by the loop above; the `as string`
	// casts stand on the missing-list invariant.
	return {
		NOVA_DB_NAME: env.NOVA_DB_NAME as string,
		NOVA_DB_USER: env.NOVA_DB_USER as string,
		NOVA_DB_INSTANCE_CONNECTION_NAME:
			env.NOVA_DB_INSTANCE_CONNECTION_NAME as string,
	};
}

/**
 * Compose a `pg.PoolConfig` for the Cloud Run built-in Cloud SQL socket.
 * Pure helper — tests exercise it directly with hand-rolled inputs.
 *
 * `host` is the `/cloudsql/<instance>` socket directory the platform proxy
 * mounts; pg treats a `/`-prefixed host as a Unix socket, so no `ssl` block is
 * needed (the proxy owns the mTLS transport). `password` is the manual-IAM
 * token callback — pg invokes it per new connection, so every handshake
 * presents a fresh access token as the Postgres password.
 */
export function buildPoolConfig(
	env: CaseStoreEnvConfig,
	password: PoolConfig["password"],
): PoolConfig {
	return {
		host: `/cloudsql/${env.NOVA_DB_INSTANCE_CONNECTION_NAME}`,
		user: env.NOVA_DB_USER,
		database: env.NOVA_DB_NAME,
		password,
		max: POOL_MAX_PER_INSTANCE,
		connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
	};
}

/**
 * Build the manual-IAM password callback bound to a `GoogleAuth` client. pg
 * calls it on each new connection; `google-auth-library` caches the access
 * token and only re-hits the metadata server near its ~1h expiry, so the
 * steady-state cost is a cache read. A missing token is fatal — a connection
 * with no password can't authenticate — so it throws rather than handing pg an
 * empty credential that would surface as an opaque auth failure.
 */
export function iamTokenPassword(auth: GoogleAuth): () => Promise<string> {
	return async () => {
		const token = await auth.getAccessToken();
		if (!token) {
			throw new Error(
				[
					"Cloud SQL IAM auth could not obtain an access token.",
					"",
					"`GoogleAuth.getAccessToken()` returned empty. The runtime service",
					"account must resolve Application Default Credentials and hold",
					"`roles/cloudsql.client`, and the instance must have IAM database",
					"authentication enabled.",
				].join("\n"),
			);
		}
		return token;
	};
}

// Process-scoped lazy singleton.

interface CaseStoreHandles {
	db: Kysely<Database>;
	/**
	 * The underlying `pg.Pool`. Exposed via `getCaseStorePool()` so Better Auth
	 * shares this ONE pool rather than opening a second — the connection budget
	 * (`enforceConnectionBudget`) is sized for a single pool per instance.
	 * Kysely owns its lifecycle (`db.destroy()` ends it on teardown); Better
	 * Auth, having not created it, never closes it.
	 */
	pool: Pool;
}

let handles: CaseStoreHandles | null = null;
/** Concurrent first-call requests share one init rather than racing. */
let initInFlight: Promise<CaseStoreHandles> | null = null;

/**
 * Build the singleton handles. The connection-budget invariant
 * fires here BEFORE env validation and pool construction, so a
 * budget misconfiguration surfaces with the dedicated diagnostic
 * rather than as a downstream driver failure. Placement inside
 * `initialize` reuses the lazy singleton's once-only mutex.
 */
async function initialize(): Promise<CaseStoreHandles> {
	enforceConnectionBudget();

	// Local-dev path (explicit opt-in). When `NOVA_DB_LOCAL_URL` is set,
	// connect to a plain Postgres at that URL — the docker-compose container
	// `npm run dev` boots — with no socket, IAM, or token fetch. Guarded on the
	// var's presence, NOT on `NODE_ENV`: production never sets it, so the Cloud
	// SQL branch below (and its loud `readCaseStoreEnvConfig` validation) still
	// owns every non-local run. See the file header for why an explicit opt-in
	// is sound where a silent fallback wasn't.
	const localUrl = process.env.NOVA_DB_LOCAL_URL;
	if (localUrl !== undefined && localUrl.length > 0) {
		const pool = new Pool({
			connectionString: localUrl,
			max: POOL_MAX_PER_INSTANCE,
			connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
		});
		const dialect = new PostgresDialect({
			pool: pool as unknown as PostgresPool,
		});
		return { db: new Kysely<Database>({ dialect }), pool };
	}

	const env = readCaseStoreEnvConfig();
	// One `GoogleAuth` per process; the token cache lives inside it and is
	// shared across every connection the pool opens. Construction is
	// side-effect-free — no network call happens until the first
	// `getAccessToken()` on the request path.
	const auth = new GoogleAuth({ scopes: [IAM_DB_LOGIN_SCOPE] });
	const pool = new Pool(buildPoolConfig(env, iamTokenPassword(auth)));
	// Kysely's `PostgresPool` is a subset of pg.Pool; the cast is
	// the standard Kysely pattern.
	const dialect = new PostgresDialect({
		pool: pool as unknown as PostgresPool,
	});
	const db = new Kysely<Database>({ dialect });
	return { db, pool };
}

/**
 * Get the singleton handles. First call constructs the pool + Kysely chain;
 * subsequent calls return the cached set. Async to preserve the public
 * `getCaseStore{Database,Pool}` contract (Better Auth awaits the shared pool)
 * and so a future async init step doesn't ripple through every caller.
 * Concurrent first-callers share one init via `initInFlight`.
 */
async function getHandles(): Promise<CaseStoreHandles> {
	if (handles !== null) {
		return handles;
	}
	if (initInFlight === null) {
		initInFlight = initialize();
		try {
			handles = await initInFlight;
		} finally {
			// Clear the in-flight slot so a failed init doesn't latch
			// a rejected promise — the next call retries.
			initInFlight = null;
		}
		return handles;
	}
	// Another caller is mid-init; await the same promise.
	return await initInFlight;
}

/**
 * Get the singleton `Kysely<Database>` instance — the case-store query handle.
 */
export async function getCaseStoreDatabase(): Promise<Kysely<Database>> {
	return (await getHandles()).db;
}

/**
 * Get the singleton `pg.Pool` backing the case store, so Better Auth can run
 * its own Kysely on the SAME pool (one pool per instance keeps the connection
 * budget intact — see `enforceConnectionBudget`). Kysely owns the pool's
 * lifecycle; do NOT call `pool.end()` on the returned handle.
 */
export async function getCaseStorePool(): Promise<Pool> {
	return (await getHandles()).pool;
}

/**
 * Tear down the singleton. Destroys the Kysely instance, which drains the pool
 * via PostgresDriver. Idempotent.
 *
 * Kysely owns the pool's lifecycle once wrapped in the dialect — calling
 * `pool.end()` here a second time would throw "Called end on pool more than
 * once" from pg.
 */
export async function closeCaseStoreDatabase(): Promise<void> {
	if (handles === null) {
		return;
	}
	const captured = handles;
	handles = null;
	await captured.db.destroy();
}
