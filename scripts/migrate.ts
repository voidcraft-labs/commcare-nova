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
// migrator's deps — kysely, pg, the Cloud SQL connector, and Better Auth's
// migrator — are bundled in). To keep the bundle lean it imports
// `authMigrateOptions` (MCP-free), NOT `lib/auth.ts` (whose `novaMcpPlugin`
// pulls the whole MCP graph). The Job runs it with `node migrate.cjs`.
//
// Reuses `getCaseStoreDatabase()` so the migrate Job talks to Cloud SQL through
// the exact same `@google-cloud/cloud-sql-connector` + IAM path the runtime
// uses — one connection code path, prod parity. The Job's env therefore wires
// `NOVA_DB_INSTANCE_CONNECTION_NAME` (the connector's input), not the raw
// `NOVA_DB_HOST` Atlas needed. Kysely's `Migrator` is sequential, so this Job
// declares `NOVA_DB_WORKLOAD=migration` and its pool holds just ONE Cloud SQL
// connection at a time. The migration role's non-inherited login limit is one;
// the separately invoked privileged bootstrap owns that steady-state policy.

import { getMigrations } from "better-auth/db/migration";
import type { Kysely } from "kysely";
import { runAuthAppMigrations } from "@/lib/auth/migrate";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import { withSchemaContext } from "@/lib/case-store";
import { runCaseStoreMigrationsWithReport } from "@/lib/case-store/migrate";
import { CANONICAL_IDENTITY_FOUNDATION_MIGRATION_NAME } from "@/lib/case-store/migrations";
import {
	closeCaseStoreDatabase,
	getCaseStoreDatabase,
	getCaseStorePool,
} from "@/lib/case-store/postgres/connection";
import {
	convergeDatabasePrivileges,
	readDatabasePrivilegeRoleConfig,
	terminateAndAssertNoRuntimeDatabaseSessions,
} from "@/lib/db/privilegeConvergence";
import { runCanonicalRuntimeDatabaseProbe } from "@/lib/db/runtimeDatabaseProbe";
import { runCaseStatusFilterRepair } from "@/scripts/lib/caseStatusFilterRepair";
import { runXPathCarrierCompatibilityRepair } from "@/scripts/lib/xpathCarrierCompatibilityRepair";

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (
		args.length > 0 &&
		(args.length !== 1 || args[0] !== "--terminate-runtime-sessions-only")
	) {
		throw new Error(`Unknown migration argument(s): ${args.join(", ")}`);
	}
	if (args[0] === "--terminate-runtime-sessions-only") {
		const privilegeRoles = readDatabasePrivilegeRoleConfig();
		if (privilegeRoles === null) {
			throw new Error(
				"Runtime-session termination is a production-only recovery operation.",
			);
		}
		const db = await getCaseStoreDatabase();
		const terminated = await terminateAndAssertNoRuntimeDatabaseSessions(
			db as unknown as Kysely<unknown>,
			privilegeRoles.runtimeRole,
		);
		console.log(
			`[migrate] recovery runtime-session fence stable; terminated=${terminated}`,
		);
		return;
	}

	const pool = await getCaseStorePool();
	const db = await getCaseStoreDatabase();
	// `getCaseStoreDatabase()` is typed `Kysely<Database>`; the migrator takes the
	// schema-agnostic `Kysely<unknown>` (it only issues raw `sql` + DDL).
	const caseStoreMigrationReport = await runCaseStoreMigrationsWithReport(
		db as unknown as Kysely<unknown>,
	);
	console.log("[migrate] case-store migrations applied");
	const schemaStore = await withSchemaContext();
	await schemaStore.drainAllPendingIndexConvergence();
	console.log("[migrate] case-schema expression indexes converged");

	// Better Auth's own migrator creates / updates the `auth_*` tables. It is
	// introspection-based and idempotent (creates missing tables, adds missing
	// columns; never drops), so it is safe to run on every deploy. Reuses the
	// SAME shared pool; `authMigrateOptions` is the MCP-free schema config so
	// this stays out of the heavy MCP graph in the bundle.
	const { runMigrations } = await getMigrations(authMigrateOptions(pool));
	await runMigrations();
	console.log("[migrate] auth migrations applied");

	// Nova-owned auth tables Better Auth's migrator doesn't manage (the OAuth
	// grant-revocation watermark). Own ledger; same shared handle.
	await runAuthAppMigrations(db as unknown as Kysely<unknown>);
	console.log("[migrate] auth-app migrations applied");

	// The built-in case-status lifecycle gate deliberately has no compatibility
	// reader. Repair the three scan-proven historical program-stage filters as
	// semantic Blueprint mutations before the absolute runtime probe evaluates
	// the fleet. This is idempotent and no-ops once the cutover has landed.
	const statusFilterRepair = await runCaseStatusFilterRepair();
	console.log(
		JSON.stringify({
			severity: "INFO",
			message: "[migrate] case-status filter cutover converged",
			...statusFilterRepair,
		}),
	);

	// The XForm XPath carrier gate deliberately has no compatibility reader.
	// Clear the two exact legacy here() geopoint defaults found by the production
	// scan before the new runtime revision begins loading apps through that gate.
	const xpathCarrierRepair = await runXPathCarrierCompatibilityRepair();
	console.log(
		JSON.stringify({
			severity: "INFO",
			message: "[migrate] XPath carrier compatibility converged",
			...xpathCarrierRepair,
		}),
	);

	// Migrations create objects before they can be classified. Re-audit and
	// converge ownership/grants only after every schema owner has finished.
	// Local dev opts out explicitly via NOVA_DB_LOCAL_URL; production missing
	// either the migration or runtime identity fails the migration job closed.
	const privilegeRoles = readDatabasePrivilegeRoleConfig();
	if (privilegeRoles === null) {
		console.log(
			"[migrate] privilege convergence skipped for explicit local DB",
		);
	} else {
		await convergeDatabasePrivileges(
			db as unknown as Kysely<unknown>,
			privilegeRoles,
		);
		console.log("[migrate] database privileges converged");

		if (
			caseStoreMigrationReport.appliedMigrationNames.includes(
				CANONICAL_IDENTITY_FOUNDATION_MIGRATION_NAME,
			)
		) {
			const terminated = await terminateAndAssertNoRuntimeDatabaseSessions(
				db as unknown as Kysely<unknown>,
				privilegeRoles.runtimeRole,
			);
			console.log(
				`[migrate] canonical cutover runtime-session fence stable; terminated=${terminated}`,
			);
		}

		const runtimeProbe = await runCanonicalRuntimeDatabaseProbe(
			db as unknown as Kysely<unknown>,
			privilegeRoles.runtimeRole,
		);
		console.log(
			JSON.stringify({
				severity: "INFO",
				message: "[migrate] runtime database probe passed",
				...runtimeProbe,
			}),
		);
	}
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
