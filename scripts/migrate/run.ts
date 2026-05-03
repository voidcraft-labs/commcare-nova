// scripts/migrate/run.ts
//
// Production migration CLI. The entry point bundled into the
// Cloud Run migration job's container image. Local execution is
// not supported — the migration runner needs IAM-authenticated
// network access to Cloud SQL, and a developer laptop has no
// path to a `--no-assign-ip` instance (see the runbook §2.12 +
// Plan 2 Task 1's "migration runner runs as a Cloud Run job"
// rationale).
//
// ## Composition
//
// 1. Parse the action argument (`latest` / `down` / `status`).
// 2. Build a `Kysely<unknown>` against Cloud SQL using the same
//    `@google-cloud/cloud-sql-connector` + `pg.Pool` shape as
//    `lib/case-store/postgres/connection.ts`, but with `max: 1`
//    — a migration is a single transaction; a larger pool is
//    wasted.
// 3. Run `runMigration(db, action)` from
//    `lib/case-store/migrations/runner.ts` (the shared core).
// 4. Print the formatted outcome to stdout (success path) or
//    stderr (failure path). Exit 0 / 1.
//
// The connector + pool wiring is intentionally NOT extracted to
// a shared helper between this script and `connection.ts`. The
// two have orthogonal lifecycles: `connection.ts` is a long-
// running runtime singleton (process-scoped, lazy, SIGTERM
// teardown); this script is a one-shot CLI that exits as soon
// as the migration completes. Sharing the lazy-singleton pattern
// here would force a graceful-shutdown path the script doesn't
// need; sharing the explicit `max: 1` pool here would force the
// runtime to serialize all queries onto one connection. The two
// intents are different enough that duplicating the ~10 lines
// of connector + pool construction is the right call.
//
// What IS shared: `readCaseStoreEnvConfig` — the env-var
// validator runs identically in both call sites; reusing the
// validator means a missing env var produces the same error
// message everywhere.

import {
	AuthTypes,
	Connector,
	IpAddressTypes,
} from "@google-cloud/cloud-sql-connector";
import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { Pool } from "pg";
import {
	formatMigrationOutcome,
	type MigrationAction,
	runMigration,
} from "../../lib/case-store/migrations/runner.js";
import { readCaseStoreEnvConfig } from "../../lib/case-store/postgres/connection.js";

// ---------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------

/**
 * Recognised CLI actions. The runner accepts the same three
 * values; we re-validate at the CLI boundary so a bad argument
 * produces a usage error before any database connection is
 * attempted.
 */
const VALID_ACTIONS: ReadonlyArray<MigrationAction> = [
	"latest",
	"down",
	"status",
];

/**
 * Parse the migration action from `process.argv`. Returns the
 * action when valid; throws with usage when missing or invalid.
 *
 * The CLI contract is `node run.js <action>` — no flags, no
 * aliases. Keeps the Cloud Run job's `--args` invocation
 * unambiguous.
 */
function parseAction(argv: ReadonlyArray<string>): MigrationAction {
	// argv[0] is the node binary, argv[1] is this script. Action
	// is at index 2.
	const candidate = argv[2];
	if (
		candidate === undefined ||
		!VALID_ACTIONS.includes(candidate as MigrationAction)
	) {
		throw new Error(
			`usage: migrate <${VALID_ACTIONS.join("|")}>; got "${candidate ?? "(missing)"}"`,
		);
	}
	return candidate as MigrationAction;
}

// ---------------------------------------------------------------
// Cloud SQL connection — one-shot, max: 1
// ---------------------------------------------------------------

/**
 * Build a `Kysely<unknown>` plus the connector that owns its TLS
 * stream factory. The pg.Pool is held internally by Kysely's
 * dialect; calling `db.destroy()` ends it via the dialect-destroy
 * contract, so the script doesn't need a separate handle. Returns
 * the two visible handles the caller's `finally` block needs to
 * tear down.
 *
 * `max: 1` because every migration runs in a single transaction
 * — a larger pool is wasted. The connector flag set mirrors
 * `connection.ts` exactly (private IP, IAM auth) so the
 * production migration job uses the same network + auth path as
 * the runtime app: any provisioning gap surfaces in both call
 * sites identically.
 */
async function buildCloudSqlDb(): Promise<{
	db: Kysely<unknown>;
	connector: Connector;
}> {
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

// ---------------------------------------------------------------
// CLI orchestration
// ---------------------------------------------------------------

/**
 * Entry point. Builds the Cloud SQL connection, runs the chosen
 * action, prints the formatted outcome, and exits 0 / 1.
 *
 * Connection teardown runs in `finally` so a thrown error inside
 * `runMigration` (network blip, IAM gap, schema collision) still
 * closes the pool and the connector; otherwise the Cloud Run job
 * would hang on SIGTERM.
 */
async function main(): Promise<void> {
	const action = parseAction(process.argv);

	// Resource handles declared outside try so finally can teardown
	// even if buildCloudSqlDb itself succeeds but runMigration
	// throws.
	let resources: Awaited<ReturnType<typeof buildCloudSqlDb>> | undefined;

	try {
		resources = await buildCloudSqlDb();
		const outcome = await runMigration(resources.db, action);
		const formatted = formatMigrationOutcome(outcome);
		if (outcome.success) {
			console.log(formatted);
		} else {
			console.error(formatted);
			process.exit(1);
		}
	} finally {
		if (resources !== undefined) {
			// Teardown order: `db.destroy()` first (which delegates
			// to the dialect, which calls `pool.end()` once); then
			// the connector (stops cert-refresh timer + frees admin-
			// API resources). Calling `pool.end()` separately would
			// throw `Called end on pool more than once`.
			await resources.db.destroy();
			resources.connector.close();
		}
	}
}

// Top-level entry. The `void main().catch(...)` shape lets the
// async chain resolve cleanly under Node's ESM loader and exits
// non-zero on a thrown error so the Cloud Run job's exit code
// reflects the migration outcome.
void main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`migration failed: ${message}`);
	process.exit(1);
});
