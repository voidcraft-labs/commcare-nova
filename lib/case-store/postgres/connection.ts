// lib/case-store/postgres/connection.ts
//
// Cloud SQL Postgres connection for the case store, runtime-only.
//
// ## Canonical pattern: `@google-cloud/cloud-sql-connector` + `pg.Pool`
//
// This file follows the canonical Google-recommended pattern for
// connecting Node.js applications running on Cloud Run to Cloud SQL
// Postgres with private IP and IAM authentication. Source:
// `https://docs.cloud.google.com/sql/docs/postgres/connect-run`
// and the connector's README at
// `https://github.com/GoogleCloudPlatform/cloud-sql-nodejs-connector`
// (verified 2026-05-03).
//
// `@google-cloud/cloud-sql-connector` returns a `stream` factory
// we hand to `pg.Pool`. The connector handles certificate
// management, IAM token rotation, and private-IP resolution against
// the SQL Admin API. The stream factory emits a TLS 1.3 socket that
// `pg.Pool` consumes as if it were a regular TCP connection.
//
// The alternative path — direct `pg.Pool` to the private IP plus
// manual `google-auth-library` token fetching for the password
// callback — was rejected because it duplicates the connector's
// certificate-rotation, IAM-token-refresh, and admin-API-resolution
// logic in this file. The connector is the documented canonical
// path; reaching for raw `google-auth-library` would require a
// merits-based justification this surface does not have.
//
// ## Pool sizing — runtime invariant
//
// The pool's `max` is pinned against the deployment's connection
// budget. Three deployment numbers compose into the invariant:
//
//   - `CLOUD_SQL_MAX_CONNECTIONS = 25` — Cloud SQL `db-f1-micro`
//     default `max_connections` (pinned explicitly on the instance
//     in the runbook's Phase 2 so future tier-up math is auditable).
//   - `CLOUD_SQL_RESERVED_CONNECTIONS = 5` — connections reserved
//     for `postgres` superuser, replication, and admin tooling.
//   - `CLOUD_RUN_MAX_INSTANCES = 5` — the Cloud Run service's
//     `--max-instances` cap, set in Phase 6 of the runbook.
//
// The pool's `max` is `4` so the worst case
// `CLOUD_RUN_MAX_INSTANCES * POOL_MAX_PER_INSTANCE = 20` fits
// exactly within `CLOUD_SQL_MAX_CONNECTIONS - CLOUD_SQL_RESERVED_CONNECTIONS = 20`.
// The numbers are exposed as named constants so a future scaling
// change to any one of them surfaces the math in one read.
//
// ## Environment variable contract
//
// Cloud Run wires three environment variables in Phase 6 of the
// provisioning runbook
// (`docs/superpowers/runbooks/2026-05-02-plan-2-task-0-cloud-sql-provisioning.md`):
//
//   - `NOVA_DB_NAME` — the application database name (`nova_cases`).
//   - `NOVA_DB_USER` — the IAM database user identity for the Cloud
//     Run runtime service account, in Cloud SQL's truncated form
//     (`51003905459-compute@developer`, no `.gserviceaccount.com`
//     suffix per the connector's IAM-auth contract for service
//     accounts on Postgres).
//   - `NOVA_DB_INSTANCE_CONNECTION_NAME` — the Cloud SQL instance
//     reference (`commcare-nova:us-central1:nova-cases`). The
//     connector resolves this to the private IP on demand via the
//     SQL Admin API.
//
// Phase 6 also wires `NOVA_DB_HOST` (the captured private IP). This
// file does not consume it — the connector resolves the address
// from `instanceConnectionName` + `ipType: 'PRIVATE'`.
//
// Missing or empty required variables throw at module-init time
// with a clear error naming which variable is missing. The
// Postgres-strict null discipline applies here: a missing
// configuration value is structurally invalid, not a defaultable
// state.
//
// ## No local-dev mode
//
// This file targets Cloud Run as the only execution environment.
// Three reasons:
//
//   1. The Cloud SQL instance is `--no-assign-ip`. `cloud-sql-proxy
//      --private-ip` from a developer laptop does not work for
//      private-IP-only instances (the proxy authenticates via the
//      Admin API but makes a direct TCP connection to the IP, which
//      is unreachable from outside the VPC). Verified in the
//      runbook §2.12.
//   2. Test isolation: the `lib/case-store/sql/__tests__` testcontainers
//      harness boots a real Postgres in Docker per `vitest run` and
//      wires its own `Kysely<Database>` instance with the same type
//      contract. Tests never touch this module's runtime instance.
//   3. Ad-hoc DB inspection: Cloud SQL Studio in the Google Cloud
//      Console reaches the private-IP instance via the Admin API
//      plane, no local network setup. Runbook §2.12 documents the
//      flow.
//
// A "fall back to localhost in development" branch would create a
// silent two-mode runtime that masks production-only configuration
// failures.
//
// ## Process-scoped lazy singleton
//
// Cloud Run reuses container processes across requests; one
// `Connector` + one `pg.Pool` + one `Kysely<Database>` per process
// is correct. Module-load eagerness would crash Next.js builds
// (which import modules without runtime env), so the singleton is
// lazy via `getCaseStoreDatabase()` — env validation, connector
// construction, and pool wiring happen on first call only.
//
// ## SIGTERM cleanup
//
// Cloud Run delivers SIGTERM with a ~10 s grace window before
// killing a container. A graceful shutdown closes the connector
// and ends the pool so the process exits with no leaked sockets
// or running cert-refresh timers. The `closeCaseStoreDatabase`
// export is the supervisor's entry point — call it from any
// process-shutdown handler that wants the polite exit.

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
import type { Database } from "../sql/database";

// ---------------------------------------------------------------
// Re-exports — single import line for downstream consumers
// ---------------------------------------------------------------
//
// `Database` is the type contract every typed query in
// `lib/case-store/sql/` binds against. Re-exporting it here keeps
// the runtime-instance shape (the Kysely instance returned from
// `getCaseStoreDatabase`) and the type contract reachable from
// one import path.

export type { Database } from "../sql/database";

// ---------------------------------------------------------------
// Pool-sizing invariant — named constants, not magic numbers
// ---------------------------------------------------------------
//
// The three numbers below are the deployment-time guarantee that
// keeps the application from exhausting Cloud SQL's connection
// budget. Encoding them as named constants — rather than burying
// the math in a comment — means a future contributor changing any
// one number sees the relationship immediately and the
// `enforceConnectionBudget` runtime check fails loudly if the math
// breaks.

/**
 * Cloud SQL `db-f1-micro` `max_connections`. Pinned explicitly on
 * the Cloud SQL instance in the runbook's Phase 2 (matches the
 * tier default; the explicit pin keeps the value auditable across
 * future tier-up commands).
 */
export const CLOUD_SQL_MAX_CONNECTIONS = 25;

/**
 * Connections held back for the `postgres` superuser, Cloud SQL
 * admin tooling, and replication. Subtract from
 * `CLOUD_SQL_MAX_CONNECTIONS` to get the application-available
 * budget.
 */
export const CLOUD_SQL_RESERVED_CONNECTIONS = 5;

/**
 * Cloud Run `--max-instances` for the `commcare-nova` service. Set
 * in Phase 6 of the runbook. A future raise of this number must
 * land alongside a re-tune of `POOL_MAX_PER_INSTANCE` or a Cloud
 * SQL tier-up; the runtime budget check below catches a silent
 * desync.
 */
export const CLOUD_RUN_MAX_INSTANCES = 5;

/**
 * Per-Cloud-Run-instance `pg.Pool` `max`. Sized so
 * `CLOUD_RUN_MAX_INSTANCES * POOL_MAX_PER_INSTANCE` fits within
 * `CLOUD_SQL_MAX_CONNECTIONS - CLOUD_SQL_RESERVED_CONNECTIONS`.
 *
 * For the current shape: `5 * 4 = 20 = 25 - 5`. Fits exactly.
 */
export const POOL_MAX_PER_INSTANCE = 4;

/**
 * Connection-budget invariant. Throws at module load if the four
 * constants above ever drift into a configuration that would let
 * Cloud Run instances collectively overrun Cloud SQL's connection
 * cap. The check runs eagerly because the constants are static —
 * a budget violation is a deploy-time bug, not a runtime one.
 *
 * Exported so the unit test can call this exact function rather
 * than re-deriving the same formula. A regression in either the
 * constants or this function's logic surfaces as a failed test.
 */
export function enforceConnectionBudget(): void {
	const applicationBudget =
		CLOUD_SQL_MAX_CONNECTIONS - CLOUD_SQL_RESERVED_CONNECTIONS;
	const peakDemand = CLOUD_RUN_MAX_INSTANCES * POOL_MAX_PER_INSTANCE;
	if (peakDemand > applicationBudget) {
		throw new Error(
			`Cloud SQL connection budget exceeded: peak demand ` +
				`${CLOUD_RUN_MAX_INSTANCES} (instances) * ${POOL_MAX_PER_INSTANCE} (pool max) = ${peakDemand} ` +
				`> available budget ${CLOUD_SQL_MAX_CONNECTIONS} - ${CLOUD_SQL_RESERVED_CONNECTIONS} = ${applicationBudget}. ` +
				`Either tier up Cloud SQL (raises CLOUD_SQL_MAX_CONNECTIONS), reduce CLOUD_RUN_MAX_INSTANCES, ` +
				`or reduce POOL_MAX_PER_INSTANCE so the four constants in lib/case-store/postgres/connection.ts stay consistent.`,
		);
	}
}

// Eagerly enforce the budget at module load. The constants are
// static; if the math is broken, the failure should surface at
// deploy time before any request hits.
enforceConnectionBudget();

// ---------------------------------------------------------------
// Environment variable contract
// ---------------------------------------------------------------
//
// Three required variables are consumed by the connector path.
// `NOVA_DB_HOST` is also wired by Phase 6 but the connector
// resolves the private IP from `instanceConnectionName`, so this
// file does not read it (see file-level comment for the rationale).

/**
 * The set of environment variables this module reads at runtime.
 * Each maps to one field of the connector's `getOptions` /
 * `pg.Pool` configuration. Exposed as a constant so the validation
 * logic and the test harness pull from a single source.
 */
export const REQUIRED_ENV_VARS = [
	"NOVA_DB_NAME",
	"NOVA_DB_USER",
	"NOVA_DB_INSTANCE_CONNECTION_NAME",
] as const;

/**
 * Discriminated alias for the env-var name set. Lets the validator's
 * error messages name the missing variable in a typesafe way.
 */
export type RequiredEnvVar = (typeof REQUIRED_ENV_VARS)[number];

/**
 * The validated, non-empty configuration block read from the
 * environment. Each property is the same name as its underlying
 * env var so a misalignment between the env contract and the
 * runtime shape stays visible.
 */
export interface CaseStoreEnvConfig {
	NOVA_DB_NAME: string;
	NOVA_DB_USER: string;
	NOVA_DB_INSTANCE_CONNECTION_NAME: string;
}

/**
 * Read the required env vars from `process.env` and verify each is
 * present and non-empty. Throws an `Error` naming the first
 * missing variable; the message is unambiguous so a Cloud Run
 * misdeployment surfaces as one diagnostic, not a chain of `pg`
 * driver failures.
 *
 * Defensive about both "absent key" and "key present but empty
 * string" because Cloud Run's `--update-env-vars` flag accepts an
 * empty value silently and a defaultable runtime would mask the
 * misconfiguration.
 *
 * @param env - The env-like object to read from. Defaults to
 *   `process.env`. Tests pass a stub.
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
		// Aggregate every gap into one error so the operator sees the
		// full misconfiguration in a single failure instead of
		// drip-feeding through restart cycles.
		throw new Error(
			`Cloud SQL case store is missing required environment variables: ${missing.join(", ")}. ` +
				`Phase 6 of docs/superpowers/runbooks/2026-05-02-plan-2-task-0-cloud-sql-provisioning.md ` +
				`wires NOVA_DB_NAME, NOVA_DB_USER, and NOVA_DB_INSTANCE_CONNECTION_NAME on Cloud Run; ` +
				`re-run the gcloud run services update command from Phase 6 if the deployed revision is missing them.`,
		);
	}
	// All three are guaranteed populated by the loop above; the
	// `as string` casts stand on the missing-list invariant.
	return {
		NOVA_DB_NAME: env.NOVA_DB_NAME as string,
		NOVA_DB_USER: env.NOVA_DB_USER as string,
		NOVA_DB_INSTANCE_CONNECTION_NAME:
			env.NOVA_DB_INSTANCE_CONNECTION_NAME as string,
	};
}

// ---------------------------------------------------------------
// Pool config builder — pure helper for unit tests
// ---------------------------------------------------------------

/**
 * The shape returned by `Connector.getOptions` for a pg-driver
 * connection. Exposed structurally (not by importing the
 * connector's `DriverOptions`) so the test harness can pass a
 * stub `clientOpts` without booting a real connector.
 */
export interface ConnectorClientOptions {
	stream: PoolConfig["stream"];
}

/**
 * Compose a final `pg.PoolConfig` from the connector's stream
 * factory and the validated env block. The pool's `max`,
 * `database`, and `user` come from this file's invariants; `stream`
 * is the connector's TLS-handshake-aware socket factory.
 *
 * Pure function — no I/O, no env reads. The runtime module
 * composes `getOptions` + `readCaseStoreEnvConfig` + this builder;
 * tests exercise this builder directly with hand-rolled inputs.
 */
export function buildPoolConfig(
	clientOpts: ConnectorClientOptions,
	env: CaseStoreEnvConfig,
): PoolConfig {
	return {
		stream: clientOpts.stream,
		user: env.NOVA_DB_USER,
		database: env.NOVA_DB_NAME,
		max: POOL_MAX_PER_INSTANCE,
		// IAM authentication does not use a password; the connector's
		// stream factory presents the Cloud-Run runtime SA's identity
		// via the TLS handshake, and Postgres skips password
		// negotiation. Omit `password` entirely so a future contributor
		// adding password auth has to read the file-level rationale.
	};
}

// ---------------------------------------------------------------
// Process-scoped lazy singleton
// ---------------------------------------------------------------
//
// One `Connector` + one `pg.Pool` + one `Kysely<Database>` per
// process. Initialized on first call to `getCaseStoreDatabase`;
// torn down by `closeCaseStoreDatabase` on SIGTERM.

/**
 * The composed handles backing the singleton. Held together so
 * `closeCaseStoreDatabase` can tear all three down in the right
 * order (Kysely first, then pool, then connector).
 */
interface CaseStoreHandles {
	connector: Connector;
	pool: Pool;
	db: Kysely<Database>;
}

/**
 * Module-scope singleton. `null` before first init, populated on
 * first `getCaseStoreDatabase` call, set back to `null` by
 * `closeCaseStoreDatabase`.
 */
let handles: CaseStoreHandles | null = null;

/**
 * In-flight init promise. Concurrent first-call requests share
 * one initialization rather than racing to create separate
 * connector + pool pairs. Cleared after init resolves so
 * subsequent calls take the synchronous fast path through
 * `handles`.
 */
let initInFlight: Promise<CaseStoreHandles> | null = null;

/**
 * Build the singleton handles. Awaits the connector's
 * `getOptions` call, composes the pool config, and constructs the
 * Kysely instance. Called at most once per process under normal
 * operation; concurrent first-call requests share the in-flight
 * promise.
 */
async function initialize(): Promise<CaseStoreHandles> {
	const env = readCaseStoreEnvConfig();
	const connector = new Connector();
	const clientOpts = await connector.getOptions({
		instanceConnectionName: env.NOVA_DB_INSTANCE_CONNECTION_NAME,
		ipType: IpAddressTypes.PRIVATE,
		// IAM authentication. The connector's stream factory presents
		// the Cloud-Run runtime SA's identity via TLS so Postgres
		// authorizes the session without a password exchange.
		authType: AuthTypes.IAM,
	});
	// `clientOpts.stream` is the connector's TLS socket factory — the
	// shape pg.Pool accepts via its `stream` option.
	const pool = new Pool(buildPoolConfig(clientOpts, env));
	const dialect = new PostgresDialect({
		// Kysely's `PostgresPool` interface is a subset of pg.Pool;
		// the cast is the standard Kysely pattern (`pg`'s extra
		// methods are not narrowed off the type).
		pool: pool as unknown as PostgresPool,
	});
	const config: KyselyConfig = { dialect };
	const db = new Kysely<Database>(config);
	return { connector, pool, db };
}

/**
 * Get the module's singleton `Kysely<Database>` instance. First
 * call constructs the connector + pool + Kysely chain; subsequent
 * calls return the cached instance.
 *
 * Async because the connector's `getOptions` is async (it
 * resolves the instance via the SQL Admin API and warms the cert
 * cache on first call). The Promise resolves once the first call
 * completes; concurrent first-call requests share the in-flight
 * promise rather than racing to construct duplicate handles.
 *
 * The returned `Kysely<Database>` matches the shape every
 * compiler in `lib/case-store/sql/` binds against — same type
 * contract as the testcontainers harness's per-test `db` fixture
 * (see `lib/case-store/sql/__tests__/setup.ts`), so query code
 * written against the test fixture runs unchanged against the
 * Cloud SQL instance.
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
 * Tear down the singleton. Destroys the Kysely instance, drains
 * the pool, and closes the connector (which stops the cert-
 * refresh timer and any local proxy sockets).
 *
 * Idempotent — calling on an already-closed (or never-opened)
 * singleton is a no-op. Cloud Run's SIGTERM grace window is the
 * standard caller; tests that want to assert post-shutdown
 * behavior can also call this directly.
 */
export async function closeCaseStoreDatabase(): Promise<void> {
	if (handles === null) {
		return;
	}
	const captured = handles;
	handles = null;
	await captured.db.destroy();
	await captured.pool.end();
	captured.connector.close();
}
