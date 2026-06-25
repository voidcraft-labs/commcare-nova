// lib/case-store/sql/__tests__/applyMigrations.ts
//
// In-process migration application for the testcontainers harness's SHARED
// global database, by URI. `globalSetup.ts` is the sole caller — it has the
// container URI but no Kysely handle yet. Per-test-database suites instead call
// `runCaseStoreMigrations(dbHandle.db)` directly (reusing the handle's open
// pool), so this URI-based helper exists only for that one handle-less site.
// Builds a short-lived Kysely on the URI and runs the SAME
// `runCaseStoreMigrations` production runs, so tests exercise the exact
// migration set the deploy applies (the parity guarantee the former `atlas
// migrate apply` shell-out gave — now with no `atlas` binary on PATH and no
// per-call subprocess spawn).

import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { Pool } from "pg";
import { runCaseStoreMigrations } from "@/lib/case-store/migrate";

/**
 * Apply all pending case-store migrations against the database at `uri`. The
 * throwaway pool is destroyed before returning so the call leaves no open
 * handle for the async-leak detector to flag.
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
