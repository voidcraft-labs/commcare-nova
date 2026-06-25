// lib/case-store/sql/__tests__/applyMigrations.ts
//
// In-process migration application for the testcontainers harness — the shared
// global database (`globalSetup.ts`) and per-test databases
// (`setupPerTestDatabase`). Builds a short-lived Kysely on the given Postgres
// URI and runs the SAME `runCaseStoreMigrations` production runs, so tests
// exercise the exact migration set the deploy applies (the parity guarantee the
// former `atlas migrate apply` shell-out gave — kept after the move to Kysely's
// in-process `Migrator`, now with no `atlas` binary on PATH required and no
// per-call subprocess spawn).

import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { Pool } from "pg";
import { runCaseStoreMigrations } from "@/lib/case-store/migrate";

/**
 * Apply all pending case-store migrations against the database at `uri`. The
 * throwaway pool is destroyed before returning so a per-test call leaves no
 * open handle for the async-leak detector to flag.
 */
export async function applyMigrations(uri: string): Promise<void> {
	const pool = new Pool({ connectionString: uri, max: 1 });
	const db = new Kysely<unknown>({
		dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
	});
	try {
		await runCaseStoreMigrations(db);
	} finally {
		await db.destroy();
	}
}
