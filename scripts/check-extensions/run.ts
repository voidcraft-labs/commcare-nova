// scripts/check-extensions/run.ts
//
// Production CLI entry for the Postgres extension-allowlist gate.
// The script bundled into the Cloud Run job's container image
// (`Dockerfile.check-extensions`) and the canonical entry point
// for `npm run db:check-extensions`.
//
// ## Why a Cloud Run job, not a developer-laptop invocation
//
// Plan 2 Task 0 provisioned Cloud SQL with `--no-assign-ip`
// (private-IP-only). Both `cloud-sql-proxy --private-ip` AND
// `@google-cloud/cloud-sql-connector` route auth through the SQL
// Admin API but make a direct TCP connection to the resolved
// private IP — the connector docs at
// `https://github.com/googlecloudplatform/cloud-sql-nodejs-connector#specifying-ip-address-type`
// are explicit: "If you choose to use Private IP or PSC, your
// application must be within the correct VPC network." From a
// developer laptop outside the VPC, the resolved IP is unreachable
// regardless of which auth path the script takes.
//
// The Cloud Run job pattern shipped in Plan 2 Task 1 (`db-migrate`)
// is the canonical path for one-shot scripts that need to reach
// Cloud SQL. This script mirrors that shape: same Direct VPC
// Egress, same IAM-auth runtime SA, same connector + `pg.Pool({
// max: 1 })` wiring. The runbook §2.12 documented this
// architectural conclusion at provisioning time; Plan 2 Task 1
// productionized the pattern; this script reuses it.
//
// ## Connection-source switch
//
// The runner reads two paths the same `verifyExtensions` core
// against either source:
//
//   1. `NOVA_DATABASE_URL` (libpq connection string) → direct
//      `pg.Pool({ connectionString })`. The path tests use against
//      the testcontainers harness; the path a developer runs
//      against any Postgres they have direct network access to
//      (Cloud SQL Studio's psql output, a local Postgres for
//      experimentation, etc.). When this var is set, the connector
//      is NOT consulted.
//   2. `NOVA_DB_*` env vars (the production three-variable contract
//      from `lib/case-store/postgres/connection.ts`) → connector +
//      `pg.Pool` with `clientOpts.stream` set from the connector.
//      This is the path the Cloud Run job takes; same shape as the
//      migration runner at `scripts/migrate/run.ts`.
//
// The switch is `if (NOVA_DATABASE_URL) <direct path> else <connector
// path>`. There is no auto-fallback the other direction — if a
// developer sets `NOVA_DATABASE_URL` and forgets to clear it, the
// script honors it; the explicit override beats the implicit
// connector path.
//
// ## No "generated TypeScript constant" of availability
//
// Plan 2 Task 2's task description mentioned recording extension
// availability in a generated TypeScript constant. Rejected per
// `feedback_max_subset_no_dimagi_litter.md`: the architectural
// lock is "halt if missing," not "branch on availability." Plan 1's
// compilers already assume all three extensions are present;
// downstream code has nothing to consume from such a constant. The
// script itself is the gate; success is silent (exit 0); failure
// aborts the pipeline with a clear remediation message.
//
// ## Exit codes
//
//   - 0: every required extension is both available + installed.
//   - 1: at least one extension fails the gate. The formatted
//        report (printed to stderr) names every gap and the
//        operator's next-step remediation.

import {
	AuthTypes,
	Connector,
	IpAddressTypes,
} from "@google-cloud/cloud-sql-connector";
import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { Pool } from "pg";
import {
	formatVerificationResult,
	verifyExtensions,
} from "../../lib/case-store/postgres/checkExtensions.js";
import { readCaseStoreEnvConfig } from "../../lib/case-store/postgres/connection.js";

// ---------------------------------------------------------------
// Connection construction — two sources, one Kysely<unknown>
// ---------------------------------------------------------------

/**
 * The shape the runner passes through `verifyExtensions`. Two
 * disposable handles: the `Kysely<unknown>` instance the
 * verification reads through, and an optional `Connector` that
 * needs explicit `.close()` on the connector path.
 *
 * The connector handle is undefined on the libpq-direct path
 * (`NOVA_DATABASE_URL`), where the script never constructs a
 * connector.
 */
interface CheckResources {
	db: Kysely<unknown>;
	connector?: Connector;
}

/**
 * Build a `Kysely<unknown>` against the testcontainer / direct
 * libpq path. Reads `NOVA_DATABASE_URL` and constructs a small
 * `pg.Pool` against it.
 *
 * `max: 1` because the verifier runs two reads end-to-end (no
 * concurrency budget required) and a smaller pool keeps the
 * footprint tight.
 */
function buildDirectDb(connectionString: string): CheckResources {
	const pool = new Pool({ connectionString, max: 1 });
	const db = new Kysely<unknown>({
		dialect: new PostgresDialect({
			pool: pool as unknown as PostgresPool,
		}),
	});
	return { db };
}

/**
 * Build a `Kysely<unknown>` against the production Cloud SQL
 * instance via `@google-cloud/cloud-sql-connector` + `pg.Pool`.
 * Mirrors `scripts/migrate/run.ts`'s connection shape — same
 * private-IP + IAM auth path the runtime app and migration job
 * already use.
 *
 * `max: 1` matches the migration job. The verifier issues two
 * sequential `SELECT`s; one connection is sufficient.
 */
async function buildCloudSqlDb(): Promise<CheckResources> {
	const env = readCaseStoreEnvConfig();
	const connector = new Connector();
	const clientOpts = await connector.getOptions({
		instanceConnectionName: env.NOVA_DB_INSTANCE_CONNECTION_NAME,
		ipType: IpAddressTypes.PRIVATE,
		authType: AuthTypes.IAM,
	});
	const pool = new Pool({
		stream: clientOpts.stream,
		user: env.NOVA_DB_USER,
		database: env.NOVA_DB_NAME,
		max: 1,
	});
	const db = new Kysely<unknown>({
		dialect: new PostgresDialect({
			pool: pool as unknown as PostgresPool,
		}),
	});
	return { db, connector };
}

/**
 * Pure dispatch helper. `NOVA_DATABASE_URL` always wins when set
 * (developer override / testcontainer path); otherwise the
 * connector path runs against Cloud SQL.
 */
async function buildDbForCurrentEnvironment(): Promise<CheckResources> {
	const directUrl = process.env.NOVA_DATABASE_URL;
	if (directUrl !== undefined && directUrl.length > 0) {
		return buildDirectDb(directUrl);
	}
	return buildCloudSqlDb();
}

// ---------------------------------------------------------------
// CLI orchestration
// ---------------------------------------------------------------

/**
 * Entry point. Builds the connection, runs the verification, prints
 * the formatted result, and exits 0 on success / 1 on failure.
 *
 * Connection teardown runs in `finally` so a thrown error inside
 * `verifyExtensions` (network blip, permission gap, etc.) still
 * closes the pool and the connector; otherwise the Cloud Run job
 * would hang on SIGTERM.
 */
async function main(): Promise<void> {
	let resources: CheckResources | undefined;
	try {
		resources = await buildDbForCurrentEnvironment();
		const result = await verifyExtensions(resources.db);
		const formatted = formatVerificationResult(result);
		if (result.passed) {
			console.log(formatted);
		} else {
			console.error(formatted);
			process.exit(1);
		}
	} finally {
		if (resources !== undefined) {
			// Teardown order: `db.destroy()` first (which delegates to
			// the dialect, which calls `pool.end()` once); then the
			// connector when present (stops cert-refresh timer + frees
			// admin-API resources). Calling `pool.end()` separately
			// would throw `Called end on pool more than once`.
			await resources.db.destroy();
			resources.connector?.close();
		}
	}
}

// Top-level entry. The `void main().catch(...)` shape lets the async
// chain resolve cleanly under Node's ESM loader and exits non-zero
// on a thrown error so the Cloud Run job's exit code reflects the
// gate's outcome.
void main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`extension check failed: ${message}`);
	process.exit(1);
});
