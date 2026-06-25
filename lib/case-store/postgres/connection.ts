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
// ## Two connection modes
//
// **Production** targets Cloud Run → Cloud SQL: the instance is
// `--no-assign-ip`, so the connector resolves a private IP via the SQL
// Admin API and authenticates with IAM. `cloud-sql-proxy --private-ip`
// from a laptop can't reach that IP (it's outside the VPC).
//
// **Local dev** is an EXPLICIT opt-in via `NOVA_DB_LOCAL_URL`: when that var
// is set, `initialize()` connects to a plain Postgres at that URL — the
// docker-compose container `npm run dev` boots (`compose.yaml` at the repo
// root) — with no connector, IAM, or private-IP resolution. It is NOT a
// silent `NODE_ENV` fallback: production never sets the var, so a missing
// `NOVA_DB_*` there still fails loudly via `readCaseStoreEnvConfig`. That is
// the distinction the earlier "no localhost fallback" rule was protecting —
// an unconditional fallback masks production misconfiguration; an explicit
// opt-in URL that prod never sets does not.
//
// Tests use the testcontainers harness under
// `lib/case-store/sql/__tests__/`. Ad-hoc prod DB inspection runs through
// Cloud SQL Studio in the Google Cloud Console.

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
import type { PoolConfig } from "pg";
import { Pool } from "pg";
import type { Database } from "../sql/database.js";

// `Database` is the type contract every typed query in
// `lib/case-store/sql/` binds against. Re-exported here so the
// runtime-instance and the type contract sit on one import path.

export type { Database } from "../sql/database.js";

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
 * Resolve the pool `max` for THIS process. Defaults to `POOL_MAX_PER_INSTANCE`
 * (the serving-instance budget `enforceConnectionBudget` is sized for). The
 * transient migrate Job overrides it via `NOVA_DB_POOL_MAX` to a small value:
 * the sequential migrator needs ~1 connection, and a low cap keeps it from
 * competing with the still-live old revision's pool for Cloud SQL's connection
 * budget during the pre-traffic-shift deploy window. Ignores absent / non-
 * positive values so a typo can't silently shrink the serving pool.
 */
function resolvePoolMax(): number {
	const raw = process.env.NOVA_DB_POOL_MAX;
	if (raw === undefined || raw.length === 0) return POOL_MAX_PER_INSTANCE;
	const parsed = Number(raw);
	return Number.isInteger(parsed) && parsed > 0
		? parsed
		: POOL_MAX_PER_INSTANCE;
}

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
 * The shape `Connector.getOptions` returns for a pg-driver
 * connection. Exposed structurally so the test harness can pass a
 * stub without booting a real connector.
 */
export interface ConnectorClientOptions {
	stream: PoolConfig["stream"];
}

/**
 * Compose a `pg.PoolConfig` from the connector's stream factory
 * and the validated env block. Pure helper — tests exercise it
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
): PoolConfig {
	return {
		stream: clientOpts.stream,
		user: env.NOVA_DB_USER,
		database: env.NOVA_DB_NAME,
		max: resolvePoolMax(),
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
}

let handles: CaseStoreHandles | null = null;
/** Concurrent first-call requests share one init rather than racing. */
let initInFlight: Promise<CaseStoreHandles> | null = null;

/**
 * Build the singleton handles. The connection-budget invariant
 * fires here BEFORE env validation and connector construction, so
 * a budget misconfiguration surfaces with the dedicated diagnostic
 * rather than as a downstream connector failure. Placement inside
 * `initialize` reuses the lazy singleton's once-only mutex.
 */
async function initialize(): Promise<CaseStoreHandles> {
	enforceConnectionBudget();

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
			max: resolvePoolMax(),
		});
		const dialect = new PostgresDialect({
			pool: pool as unknown as PostgresPool,
		});
		return { connector: null, db: new Kysely<Database>({ dialect }) };
	}

	const env = readCaseStoreEnvConfig();
	const connector = new Connector();
	const clientOpts = await connector.getOptions({
		instanceConnectionName: env.NOVA_DB_INSTANCE_CONNECTION_NAME,
		ipType: IpAddressTypes.PRIVATE,
		authType: AuthTypes.IAM,
	});
	const pool = new Pool(buildPoolConfig(clientOpts, env));
	// Kysely's `PostgresPool` is a subset of pg.Pool; the cast is
	// the standard Kysely pattern.
	const dialect = new PostgresDialect({
		pool: pool as unknown as PostgresPool,
	});
	const config: KyselyConfig = { dialect };
	const db = new Kysely<Database>(config);
	return { connector, db };
}

/**
 * Get the singleton `Kysely<Database>` instance. First call
 * constructs the connector + pool + Kysely chain; subsequent calls
 * return the cached instance. Async because `Connector.getOptions`
 * resolves the instance via the SQL Admin API on first call.
 */
export async function getCaseStoreDatabase(): Promise<Kysely<Database>> {
	if (handles !== null) {
		return handles.db;
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
		return handles.db;
	}
	// Another caller is mid-init; await the same promise.
	const ready = await initInFlight;
	return ready.db;
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
