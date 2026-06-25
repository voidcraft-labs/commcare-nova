// scripts/migrate.ts
//
// Production migration entrypoint. Runs once per deploy as the
// `commcare-nova-migrate` Cloud Run Job (see cloudbuild.yaml), BEFORE traffic
// shifts to the new revision — a non-zero exit fails the build, so code never
// ships ahead of a failed schema change. Replaces the former `atlas migrate
// apply` Job command.
//
// Bundled into a single self-contained CJS file by esbuild during the Docker
// build (the Next.js standalone runner has no full node_modules, so the
// migrator's deps — kysely, pg, the Cloud SQL connector — are bundled in). The
// Job runs it with `node migrate.cjs`.
//
// Reuses `getCaseStoreDatabase()` so the migrate Job talks to Cloud SQL through
// the exact same `@google-cloud/cloud-sql-connector` + IAM path the runtime
// uses — one connection code path, prod parity. The Job's env therefore wires
// `NOVA_DB_INSTANCE_CONNECTION_NAME` (the connector's input), not the raw
// `NOVA_DB_HOST` Atlas needed. Kysely's `Migrator` is sequential, so this Job
// holds just ONE Cloud SQL connection at a time — it fits within the connection
// budget even while the old revision is still serving during the pre-traffic
// window.

import type { Kysely } from "kysely";
import { runCaseStoreMigrations } from "@/lib/case-store/migrate";
import {
	closeCaseStoreDatabase,
	getCaseStoreDatabase,
} from "@/lib/case-store/postgres/connection";

async function main(): Promise<void> {
	const db = await getCaseStoreDatabase();
	// `getCaseStoreDatabase()` is typed `Kysely<Database>`; the migrator takes the
	// schema-agnostic `Kysely<unknown>` (it only issues raw `sql` + DDL).
	await runCaseStoreMigrations(db as unknown as Kysely<unknown>);
	console.log("[migrate] case-store migrations applied");
}

/** Cap on best-effort teardown; the OS reclaims the socket on exit anyway. */
const TEARDOWN_TIMEOUT_MS = 10_000;

/**
 * Tear down and exit with `code`. The migration's outcome (and `code`) is
 * already decided in `main()`; this only releases the pool, so it must NEVER
 * change the exit code. It guards both failure modes: a teardown ERROR is
 * caught, and a teardown that never RESOLVES (a hung `pool.end()` /
 * `connector.close()`) is bounded by `TEARDOWN_TIMEOUT_MS` — otherwise the Job
 * would run to cloudbuild's `--task-timeout` and `gcloud run jobs execute
 * --wait` would report a committed migration as a failed deploy.
 */
async function finish(code: number): Promise<never> {
	try {
		await Promise.race([
			closeCaseStoreDatabase(),
			new Promise((resolve) => setTimeout(resolve, TEARDOWN_TIMEOUT_MS)),
		]);
	} catch (err) {
		console.error("[migrate] teardown error (ignored):", err);
	}
	process.exit(code);
}

main().then(
	() => finish(0),
	(err: unknown) => {
		console.error("[migrate] failed:", err);
		return finish(1);
	},
);
