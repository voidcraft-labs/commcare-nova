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
// `NOVA_DB_HOST` Atlas needed.

import { runCaseStoreMigrations } from "@/lib/case-store/migrate";
import {
	closeCaseStoreDatabase,
	getCaseStoreDatabase,
} from "@/lib/case-store/postgres/connection";

async function main(): Promise<void> {
	const db = await getCaseStoreDatabase();
	await runCaseStoreMigrations(
		db as unknown as Parameters<typeof runCaseStoreMigrations>[0],
	);
	// Phase 1 (Better Auth → Postgres) adds the auth-table migration here:
	//   await getMigrations(getAuthMigratorOptions()).runMigrations();
	// Better Auth's migrator is introspection-based and idempotent, so it runs
	// alongside the case-store migrations with no ledger of its own.
	console.log("[migrate] case-store migrations applied");
}

main()
	.then(async () => {
		await closeCaseStoreDatabase();
		process.exit(0);
	})
	.catch(async (err: unknown) => {
		console.error("[migrate] failed:", err);
		await closeCaseStoreDatabase().catch(() => {});
		process.exit(1);
	});
