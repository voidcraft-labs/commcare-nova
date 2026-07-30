// lib/case-store/postgres/connection.ts
//
// Cloud SQL Postgres connection for the case store, runtime-only.
// Follows Google's canonical pattern for Cloud Run → Cloud SQL with
// private IP + IAM auth via `@google-cloud/cloud-sql-connector` +
// `pg.Pool` (`https://docs.cloud.google.com/sql/docs/postgres/connect-run`).
// The connector returns a TLS-handshake-aware `stream` factory pg.Pool
// consumes as if it were a regular TCP socket; certificate rotation,
// IAM token refresh, and private-IP resolution against the SQL Admin
// API live inside the connector. Reaching for raw `google-auth-library`
// would duplicate that logic without merits-based justification.
//
// One `Connector` + one `pg.Pool` + one `Kysely<Database>` per
// process. Lazy via `getCaseStoreDatabase()` — module-load
// eagerness would crash Next.js builds (which import modules
// without runtime env). `closeCaseStoreDatabase` is the SIGTERM
// teardown entry point; Kysely owns the pool's lifecycle through
// its dialect, so the close path destroys Kysely and then closes
// the connector.
//
// ## Three connection modes
//
// **Production** targets Cloud Run → Cloud SQL: the connector resolves the
// instance's private IP via the SQL Admin API and authenticates with IAM.
// Cloud Run never sets `NOVA_DB_IP_TYPE`, so the private IP is always the
// production path.
//
// **Laptop inspection** sets `NOVA_DB_IP_TYPE=PUBLIC` (the
// `scripts/inspect-*.ts --prod` flag does this): the connector resolves the
// instance's public IP instead — reachable from outside the VPC — and
// authenticates with the caller's own IAM identity via ADC. The public IP
// has NO authorized networks, so connector/proxy traffic (SQL Admin API +
// IAM-minted TLS) is the only way in; the raw Postgres port is not exposed.
//
// **Local dev** is an EXPLICIT opt-in via `NOVA_DB_LOCAL_URL`: when that var
// is set, `initialize()` connects to a plain Postgres at that URL — the
// docker-compose container `npm run dev` boots (`compose.yaml` at the repo
// root) — with no connector, IAM, or IP resolution. It is NOT a
// silent `NODE_ENV` fallback: production never sets the var, so a missing
// `NOVA_DB_*` there still fails loudly via `readCaseStoreEnvConfig`. That is
// the distinction the earlier "no localhost fallback" rule was protecting —
// an unconditional fallback masks production misconfiguration; an explicit
// opt-in URL that prod never sets does not.
//
// Tests use the testcontainers harness under
// `lib/case-store/sql/__tests__/`. Ad-hoc prod DB inspection runs through
// `scripts/inspect-*.ts --prod`, or Cloud SQL Studio in the Google Cloud
// Console for raw SQL.

import {
	AuthTypes,
	Connector,
	IpAddressTypes,
} from "@google-cloud/cloud-sql-connector";
import {
	Kysely,
	type KyselyConfig,
	PostgresDialect,
	type PostgresPool,
} from "kysely";
import type { ClientConfig, PoolConfig } from "pg";
import { Pool } from "pg";
import type { Database } from "../sql/database.js";

// `Database` is the type contract every typed query in
// `lib/case-store/sql/` binds against. Re-exported here so the
// runtime-instance and the type contract sit on one import path.

export type { Database } from "../sql/database.js";

// Production connection-budget invariant — named constants, not magic
// numbers. The service, migration Job, and capture-cleanup Job share one Cloud
// SQL instance and can overlap during a deploy. The cleanup role admits its
// active lock/work pair plus one graceful advisory-lock probe; further
// contenders fail at connection admission. The deployment numbers below
// therefore compose into one global guarantee:
//
//   service revisions + migration + active cleanup + losing cleanup probe
//   <= Cloud SQL max_connections - ordinary/system headroom
//
// `enforceConnectionBudget` (below) fails loudly if any constant drifts.

/** Cloud SQL `db-f1-micro` `max_connections`. */
export const CLOUD_SQL_MAX_CONNECTIONS = 25;

/** Cloud SQL/PostgreSQL settings audited before every database Job. */
export const CLOUD_SQL_SUPERUSER_RESERVED_CONNECTIONS = 3;
export const CLOUD_SQL_RESERVED_CONNECTIONS = 0;

/** Ordinary-login room left outside Nova's four capped workload roles. */
export const CLOUD_SQL_ORDINARY_LOGIN_HEADROOM_CONNECTIONS = 1;

/** Two ordinary slots plus PostgreSQL's three true-superuser-only slots. */
export const CLOUD_SQL_CAPACITY_HEADROOM_CONNECTIONS =
	CLOUD_SQL_ORDINARY_LOGIN_HEADROOM_CONNECTIONS +
	CLOUD_SQL_SUPERUSER_RESERVED_CONNECTIONS;

/** Cloud Run `--max-instances` for `commcare-nova`. */
export const CLOUD_RUN_MAX_INSTANCES = 4;

/**
 * Per-serving-instance `pg.Pool` `max`. For the current shape, including the
 * dedicated relay LISTEN connection: `4 * (3 + 1) = 16`.
 *
 * Capacity note: these 3 pooled connections now carry the WHOLE app-state
 * workload (apps/blueprint/credits/events/threads/media reads and writes, the
 * relay's per-poke SELECTs, presence heartbeats + sweeps) alongside the
 * case-store, preview, and auth traffic they always carried. Under many
 * concurrent open streams the pool can saturate; `POOL_CONNECTION_TIMEOUT_MS`
 * then fails queries fast rather than queueing to the request ceiling. The
 * headroom lever is the Cloud SQL side — raise the instance's
 * `max_connections` flag (and `CLOUD_SQL_MAX_CONNECTIONS` here) or tier up —
 * BEFORE raising `CLOUD_RUN_MAX_INSTANCES` or the pool size.
 */
export const POOL_MAX_PER_INSTANCE = 3;

/** The migration Job is sequential and may hold at most one DB connection. */
export const MIGRATION_POOL_MAX_PER_EXECUTION = 1;

/**
 * The active cleanup execution holds one advisory-lock session plus at most
 * one pooled work connection.
 */
export const CAPTURE_CLEANUP_POOL_MAX_PER_EXECUTION = 2;

/**
 * A concurrently dispatched cleanup execution checks the advisory lock using
 * one connection, observes the active owner, and exits without doing work.
 * During initial election the same three-slot peak can instead be one owner
 * probe plus two losing probes; the owner prewarms its work connection only
 * after those losers destroy their sessions.
 */
export const CAPTURE_CLEANUP_LOCK_CONTENDER_CONNECTIONS = 1;

/** The canonical-identity audit is a single-session, read-only workload. */
export const AUDIT_POOL_MAX_PER_EXECUTION = 1;

/**
 * Hard PostgreSQL per-login-role limits. Unlike Cloud Run's scaling maximum,
 * these are enforced at connection admission and apply cluster-wide. Role
 * attributes are not inherited: migration's runtime membership does not change
 * its cap, and the isolated cleanup login likewise counts against its own role
 * and limit.
 */
export const RUNTIME_DB_ROLE_CONNECTION_LIMIT = 16;
export const MIGRATION_DB_ROLE_CONNECTION_LIMIT = 1;
export const CAPTURE_CLEANUP_DB_ROLE_CONNECTION_LIMIT = 3;
export const AUDIT_DB_ROLE_CONNECTION_LIMIT = 1;

/**
 * A one-off `scripts/* --prod` process consumes the residual ordinary-login
 * slot, never a serving-workload allocation. PostgreSQL's other three
 * headroom slots are true-superuser-only.
 */
export const OPERATOR_POOL_MAX_PER_PROCESS = 1;

/**
 * Dedicated LISTEN connections per Cloud Run instance. The realtime relay
 * (`lib/db/streamListener.ts`) holds ONE `pg.Client` OUTSIDE the pool — LISTEN
 * can't ride a pooled connection Kysely reclaims per query — so every
 * instance's peak demand is `POOL_MAX_PER_INSTANCE + this`.
 */
export const LISTENER_CONNECTIONS_PER_INSTANCE = 1;

/**
 * The one schema where the serving role may create objects. `cases` needs to
 * remain runtime-owned because Phase B creates and drops indexes concurrently;
 * isolating it keeps that unavoidable CREATE capability away from fixed,
 * auth, and control objects in `public`.
 *
 * `public` stays first so migrations and Better Auth continue to create fixed
 * objects there. After privilege convergence moves `cases`, existing
 * unqualified queries resolve it from the second schema. Local databases skip
 * convergence, leave `cases` in `public`, and use the same path.
 */
export const CASE_RUNTIME_SCHEMA = "nova_case_runtime";
export const DATABASE_SEARCH_PATH = `public,${CASE_RUNTIME_SCHEMA}`;
export const DATABASE_CONNECTION_OPTIONS = `-c search_path=${DATABASE_SEARCH_PATH}`;

/**
 * Cap on how long a query waits to ACQUIRE a pooled connection before erroring.
 * Without it `pg.Pool` queues indefinitely; since the auth migration funnels a
 * per-request `isUserActive` read onto this small shared pool (which also serves
 * case-store/preview queries), a saturated pool could otherwise hang requests to
 * the route's 300s ceiling. A bounded timeout fails fast instead — the auth read
 * is fail-open on error (`sessionUserIsActive` allows the request), and
 * case-store queries surface a clear error rather than stalling.
 */
export const POOL_CONNECTION_TIMEOUT_MS = 10_000;

/**
 * Connection-budget invariant. Throws when the service or any maintenance
 * workload can collectively overrun Cloud SQL's cap. Fires once per process on
 * the first `getCaseStoreDatabase()` call — first-call rather than module-load
 * so a non-runtime import (Next.js build, type-only test import)
 * doesn't trigger the throw. Exported so the unit test calls this
 * exact function rather than re-deriving the formula.
 */
export function enforceConnectionBudget(): void {
	const applicationBudget =
		CLOUD_SQL_MAX_CONNECTIONS - CLOUD_SQL_CAPACITY_HEADROOM_CONNECTIONS;
	const perInstance = POOL_MAX_PER_INSTANCE + LISTENER_CONNECTIONS_PER_INSTANCE;
	const servicePeak = CLOUD_RUN_MAX_INSTANCES * perInstance;
	const cleanupPeak =
		CAPTURE_CLEANUP_POOL_MAX_PER_EXECUTION +
		CAPTURE_CLEANUP_LOCK_CONTENDER_CONNECTIONS;
	const hardLoginPeak =
		RUNTIME_DB_ROLE_CONNECTION_LIMIT +
		MIGRATION_DB_ROLE_CONNECTION_LIMIT +
		CAPTURE_CLEANUP_DB_ROLE_CONNECTION_LIMIT +
		AUDIT_DB_ROLE_CONNECTION_LIMIT;
	if (
		servicePeak > RUNTIME_DB_ROLE_CONNECTION_LIMIT ||
		MIGRATION_POOL_MAX_PER_EXECUTION > MIGRATION_DB_ROLE_CONNECTION_LIMIT ||
		cleanupPeak > CAPTURE_CLEANUP_DB_ROLE_CONNECTION_LIMIT ||
		AUDIT_POOL_MAX_PER_EXECUTION > AUDIT_DB_ROLE_CONNECTION_LIMIT ||
		hardLoginPeak > applicationBudget ||
		OPERATOR_POOL_MAX_PER_PROCESS >
			CLOUD_SQL_ORDINARY_LOGIN_HEADROOM_CONNECTIONS
	) {
		// Inline Elm-style throw — header / indented diagnostic / narrative /
		// Hint. Configuration violations don't fit `compilerBugMessage`
		// (this is operator misconfiguration, not an internal invariant)
		// but match the same voice for consistency with the rest of the
		// case-store error surface.
		throw new Error(
			[
				"Cloud SQL connection budget exceeded.",
				"",
				`    service demand:     ${CLOUD_RUN_MAX_INSTANCES} (instances) * (${POOL_MAX_PER_INSTANCE} (pool max) + ${LISTENER_CONNECTIONS_PER_INSTANCE} (listener)) = ${servicePeak}`,
				`    runtime role limit: ${RUNTIME_DB_ROLE_CONNECTION_LIMIT}`,
				`    migration demand / role limit: ${MIGRATION_POOL_MAX_PER_EXECUTION} / ${MIGRATION_DB_ROLE_CONNECTION_LIMIT}`,
				`    cleanup demand / role limit:   ${cleanupPeak} / ${CAPTURE_CLEANUP_DB_ROLE_CONNECTION_LIMIT}`,
				`    audit demand / role limit:     ${AUDIT_POOL_MAX_PER_EXECUTION} / ${AUDIT_DB_ROLE_CONNECTION_LIMIT}`,
				`    hard login peak:    ${RUNTIME_DB_ROLE_CONNECTION_LIMIT} + ${MIGRATION_DB_ROLE_CONNECTION_LIMIT} + ${CAPTURE_CLEANUP_DB_ROLE_CONNECTION_LIMIT} + ${AUDIT_DB_ROLE_CONNECTION_LIMIT} = ${hardLoginPeak}`,
				`    available budget:   ${CLOUD_SQL_MAX_CONNECTIONS} - ${CLOUD_SQL_CAPACITY_HEADROOM_CONNECTIONS} = ${applicationBudget}`,
				`    residual headroom:  ${CLOUD_SQL_ORDINARY_LOGIN_HEADROOM_CONNECTIONS} ordinary + ${CLOUD_SQL_SUPERUSER_RESERVED_CONNECTIONS} true-superuser-only`,
				"",
				"Cloud Run's service/revision maxima are soft outer controls. The",
				"hard ceiling is PostgreSQL CONNECTION LIMIT on each direct login",
				"role: runtime includes pooled + LISTEN sessions; migration gets one;",
				"cleanup gets its active lock/work pair plus one losing probe; audit",
				"gets one read-only session. Those non-inherited login-role limits",
				"must leave the ordinary operator slot and three true-superuser-",
				"reserved slots untouched.",
				"Crossing the budget can stall every Cloud Run instance against the",
				"shared connection cap.",
				"",
				"Hint: tier up Cloud SQL (raises `CLOUD_SQL_MAX_CONNECTIONS`), reduce",
				"`CLOUD_RUN_MAX_INSTANCES`, a workload pool maximum, or its audited",
				"login-role CONNECTION LIMIT so every layer stays consistent.",
			].join("\n"),
		);
	}
}

// Workload selection is a production deployment contract, not an optimization.
// A missing or misspelled value must not let a Job silently inherit the
// serving pool's larger maximum.

export const CASE_STORE_WORKLOADS = [
	"service",
	"migration",
	"capture-cleanup",
	"audit",
	"operator",
] as const;

export type CaseStoreWorkload = (typeof CASE_STORE_WORKLOADS)[number];

export const NOVA_DB_WORKLOAD_ENV = "NOVA_DB_WORKLOAD";

/**
 * Resolve the process's database workload. Local development may omit the
 * variable and receives the serving default; every Cloud SQL process must
 * declare its workload explicitly.
 */
export function readCaseStoreWorkload(
	env: Readonly<Partial<Record<string, string>>> = process.env,
): CaseStoreWorkload {
	const raw = env[NOVA_DB_WORKLOAD_ENV];
	if (raw === undefined || raw.length === 0) {
		const localUrl = env.NOVA_DB_LOCAL_URL;
		if (localUrl !== undefined && localUrl.length > 0) {
			return "service";
		}
		throw new Error(
			[
				"Cloud SQL case store is missing its workload declaration.",
				"",
				`    ${NOVA_DB_WORKLOAD_ENV}: ${JSON.stringify(raw)}`,
				"",
				"Serving, migration, capture-cleanup, audit, and operator processes have",
				"different",
				"pool maxima that participate in the production connection budget.",
				"A non-local process must identify itself explicitly; silently using",
				"the serving pool could exhaust Cloud SQL during overlapping work.",
				"",
				`Hint: set ${NOVA_DB_WORKLOAD_ENV} to exactly one of: ${CASE_STORE_WORKLOADS.join(
					", ",
				)}.`,
			].join("\n"),
		);
	}
	if ((CASE_STORE_WORKLOADS as readonly string[]).includes(raw)) {
		return raw as CaseStoreWorkload;
	}
	throw new Error(
		[
			"Cloud SQL case store got an unrecognized workload declaration.",
			"",
			`    ${NOVA_DB_WORKLOAD_ENV}: ${JSON.stringify(raw)}`,
			"",
			`Only these exact values are accepted: ${CASE_STORE_WORKLOADS.join(", ")}.`,
		].join("\n"),
	);
}

/** Return the pool maximum owned by one declared workload execution. */
export function poolMaxForWorkload(workload: CaseStoreWorkload): number {
	switch (workload) {
		case "service":
			return POOL_MAX_PER_INSTANCE;
		case "migration":
			return MIGRATION_POOL_MAX_PER_EXECUTION;
		case "capture-cleanup":
			return CAPTURE_CLEANUP_POOL_MAX_PER_EXECUTION;
		case "audit":
			return AUDIT_POOL_MAX_PER_EXECUTION;
		case "operator":
			return OPERATOR_POOL_MAX_PER_PROCESS;
	}
}

// Environment variable contract.
//
// Every non-local process wires its `NOVA_DB_WORKLOAD` declaration plus three
// required connector env vars:
// `NOVA_DB_NAME` (the database name), `NOVA_DB_USER` (the IAM
// database user identity for the Cloud Run runtime SA, in Cloud
// SQL's truncated form without `.gserviceaccount.com`), and
// `NOVA_DB_INSTANCE_CONNECTION_NAME` (the instance reference the
// connector resolves to a private IP via the SQL Admin API).
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
				"deployed pod with one or more variables absent. The connector path",
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
 * Resolve which of the instance's IPs the connector targets, from the
 * OPTIONAL `NOVA_DB_IP_TYPE` env var. Absent (or empty — Cloud Run's
 * `--update-env-vars` accepts empty values silently) means `PRIVATE`:
 * Cloud Run never sets the var, so production always rides the private
 * IP. Laptop tooling (`scripts/inspect-*.ts --prod`) sets `PUBLIC` to
 * reach the instance from outside the VPC; authentication is IAM via
 * the connector either way. Tests pass a stub `env`.
 */
export function readCaseStoreIpType(
	env: Readonly<Partial<Record<string, string>>> = process.env,
): IpAddressTypes.PUBLIC | IpAddressTypes.PRIVATE {
	const raw = env.NOVA_DB_IP_TYPE;
	if (raw === undefined || raw.length === 0) {
		return IpAddressTypes.PRIVATE;
	}
	if (raw === "PUBLIC") {
		return IpAddressTypes.PUBLIC;
	}
	if (raw === "PRIVATE") {
		return IpAddressTypes.PRIVATE;
	}
	throw new Error(
		[
			"Cloud SQL case store got an unrecognized NOVA_DB_IP_TYPE.",
			"",
			`    NOVA_DB_IP_TYPE: ${JSON.stringify(raw)}`,
			"",
			"The connector can target the instance's private IP (the Cloud Run",
			"path) or its public IP (the laptop inspection path). Only the",
			"uppercase literals `PRIVATE` and `PUBLIC` are accepted; leaving the",
			"variable unset means `PRIVATE`.",
			"",
			"Hint: unset NOVA_DB_IP_TYPE, or set it to exactly `PUBLIC` when",
			"running the inspect scripts against production from a laptop.",
		].join("\n"),
	);
}

/**
 * The shape `Connector.getOptions` returns for a pg-driver
 * connection. Exposed structurally so the test harness can pass a
 * stub without booting a real connector.
 */
export interface ConnectorClientOptions {
	stream: PoolConfig["stream"];
}

/**
 * Compose a `pg.PoolConfig` from the connector's stream factory,
 * validated env block, and declared workload. Pure helper — tests exercise it
 * directly with hand-rolled inputs.
 *
 * `password` is omitted intentionally: IAM authentication uses the
 * connector's stream factory to present the Cloud-Run runtime SA's
 * identity via TLS, and Postgres skips password negotiation. Adding
 * password auth would require reading the file-level rationale first.
 */
export function buildPoolConfig(
	clientOpts: ConnectorClientOptions,
	env: CaseStoreEnvConfig,
	workload: CaseStoreWorkload,
): PoolConfig {
	return {
		stream: clientOpts.stream,
		user: env.NOVA_DB_USER,
		database: env.NOVA_DB_NAME,
		options: DATABASE_CONNECTION_OPTIONS,
		max: poolMaxForWorkload(workload),
		connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
	};
}

// Process-scoped lazy singleton.

interface CaseStoreHandles {
	/**
	 * The Cloud SQL connector — `null` on the local-dev path
	 * (`NOVA_DB_LOCAL_URL`), where a plain `pg.Pool` connects directly and
	 * there is no connector to construct or close.
	 */
	connector: Connector | null;
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
 * fires here BEFORE workload/env validation and connector construction, so
 * a budget misconfiguration surfaces with the dedicated diagnostic
 * rather than as a downstream connector failure. Placement inside
 * `initialize` reuses the lazy singleton's once-only mutex.
 */
async function initialize(): Promise<CaseStoreHandles> {
	enforceConnectionBudget();
	const workload = readCaseStoreWorkload();

	// Local-dev path (explicit opt-in). When `NOVA_DB_LOCAL_URL` is set,
	// connect to a plain Postgres at that URL — the docker-compose container
	// `npm run dev` boots — with no Cloud SQL connector, IAM, or private-IP
	// resolution. Guarded on the var's presence, NOT on `NODE_ENV`: production
	// never sets it, so the Cloud SQL branch below (and its loud
	// `readCaseStoreEnvConfig` validation) still owns every non-local run. See
	// the file header for why an explicit opt-in is sound where a silent
	// fallback wasn't.
	const localUrl = process.env.NOVA_DB_LOCAL_URL;
	if (localUrl !== undefined && localUrl.length > 0) {
		const pool = new Pool({
			connectionString: localUrl,
			options: DATABASE_CONNECTION_OPTIONS,
			max: poolMaxForWorkload(workload),
			connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
		});
		const dialect = new PostgresDialect({
			pool: pool as unknown as PostgresPool,
		});
		return { connector: null, db: new Kysely<Database>({ dialect }), pool };
	}

	const env = readCaseStoreEnvConfig();
	const connector = new Connector();
	const clientOpts = await connector.getOptions({
		instanceConnectionName: env.NOVA_DB_INSTANCE_CONNECTION_NAME,
		ipType: readCaseStoreIpType(),
		authType: AuthTypes.IAM,
	});
	const pool = new Pool(buildPoolConfig(clientOpts, env, workload));
	// Kysely's `PostgresPool` is a subset of pg.Pool; the cast is
	// the standard Kysely pattern.
	const dialect = new PostgresDialect({
		pool: pool as unknown as PostgresPool,
	});
	const config: KyselyConfig = { dialect };
	const db = new Kysely<Database>(config);
	return { connector, db, pool };
}

/**
 * Get the singleton handles. First call constructs the connector + pool +
 * Kysely chain; subsequent calls return the cached set. Async because
 * `Connector.getOptions` resolves the instance via the SQL Admin API on first
 * call. Concurrent first-callers share one init via `initInFlight`.
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
 * Build a `pg.ClientConfig` for a DEDICATED connection OUTSIDE the pool — the
 * realtime relay's LISTEN client (`lib/db/streamListener.ts`), which can't ride
 * a pooled connection Kysely reclaims per query. Shares the pool's config
 * source: the local-dev URL when `NOVA_DB_LOCAL_URL` is set, otherwise the SAME
 * Cloud SQL connector + IAM identity the pool uses — it REUSES the already-
 * initialized connector (via `getHandles`) so a reconnecting listener never
 * spins up a second one. No `max`: a `pg.Client` is one connection, counted in
 * the budget via `LISTENER_CONNECTIONS_PER_INSTANCE`.
 */
export async function buildDedicatedClientConfig(): Promise<ClientConfig> {
	const workload = readCaseStoreWorkload();
	if (workload !== "service") {
		throw new Error(
			"buildDedicatedClientConfig: dedicated realtime LISTEN connections belong only to the service workload.",
		);
	}
	const localUrl = process.env.NOVA_DB_LOCAL_URL;
	if (localUrl !== undefined && localUrl.length > 0) {
		return {
			connectionString: localUrl,
			options: DATABASE_CONNECTION_OPTIONS,
		};
	}
	const { connector } = await getHandles();
	if (connector === null) {
		// The non-local path always constructs a connector; a null here would
		// mean the handles were built on the local-dev branch while
		// `NOVA_DB_LOCAL_URL` has since been cleared — an inconsistent runtime.
		throw new Error(
			"buildDedicatedClientConfig: the Cloud SQL connector is absent on a non-local run.",
		);
	}
	const env = readCaseStoreEnvConfig();
	const clientOpts = await connector.getOptions({
		instanceConnectionName: env.NOVA_DB_INSTANCE_CONNECTION_NAME,
		ipType: readCaseStoreIpType(),
		authType: AuthTypes.IAM,
	});
	return {
		stream: clientOpts.stream,
		user: env.NOVA_DB_USER,
		database: env.NOVA_DB_NAME,
		options: DATABASE_CONNECTION_OPTIONS,
	};
}

/**
 * Tear down the singleton. Destroys the Kysely instance (which
 * drains the pool via PostgresDriver) and closes the connector
 * (which stops the cert-refresh timer). Idempotent.
 *
 * Kysely owns the pool's lifecycle once wrapped in the dialect —
 * calling `pool.end()` here a second time would throw "Called end
 * on pool more than once" from pg.
 */
export async function closeCaseStoreDatabase(): Promise<void> {
	if (handles === null) {
		return;
	}
	const captured = handles;
	handles = null;
	await captured.db.destroy();
	// `null` on the local-dev path — only the Cloud SQL connector owns a
	// cert-refresh timer that needs stopping.
	captured.connector?.close();
}
