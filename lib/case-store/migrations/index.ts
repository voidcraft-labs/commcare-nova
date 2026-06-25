// Case-store migration set + provider.
//
// Static (import-based) `MigrationProvider` rather than Kysely's
// `FileMigrationProvider`: the migrations run in three environments — the
// production migrate entrypoint (bundled by esbuild into a single CJS file,
// where `fs`-walking a `migrationFolder` path would not resolve), the
// testcontainers harness, and `npm run dev` — and a static import map works
// identically in all three with no filesystem assumptions. Adding a migration
// is one import + one record entry here.
//
// Keys are the migration names Kysely records in its `kysely_migration`
// ledger; they sort lexicographically, so the timestamp prefix preserves
// apply order. They MUST match the names the self-adoption step seeds for the
// pre-Kysely (Atlas-migrated) baseline — see `lib/case-store/migrate.ts`.

import type { Migration, MigrationProvider } from "kysely/migration";
import * as baseline from "./20260505152732_baseline";
import * as addCaseNameColumn from "./20260506022302_add_case_name_column";

/** Migration name → module, in apply order (lexicographic by key). */
export const caseStoreMigrations: Record<string, Migration> = {
	"20260505152732_baseline": baseline,
	"20260506022302_add_case_name_column": addCaseNameColumn,
};

/** The two baseline names already applied on Atlas-migrated databases. */
export const ATLAS_BASELINE_MIGRATION_NAMES = [
	"20260505152732_baseline",
	"20260506022302_add_case_name_column",
] as const;

export const caseStoreMigrationProvider: MigrationProvider = {
	getMigrations: async () => caseStoreMigrations,
};
