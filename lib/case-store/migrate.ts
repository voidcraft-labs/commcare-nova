// lib/case-store/migrate.ts
//
// Applies the case-store schema migrations via Kysely's `Migrator`. One code
// path for every environment that needs the schema: the production migrate
// entrypoint (the `commcare-nova-migrate` Cloud Run Job), `npm run dev`, and
// the testcontainers harness. Tests run the EXACT migrations production runs —
// the parity guarantee the old Atlas shell-out gave, kept after the move to
// Kysely's in-process migrator.
//
// ## Self-adoption of Atlas-migrated databases
//
// The project previously applied these same migrations through Atlas, whose
// revision ledger (`atlas_schema_revisions`) Kysely doesn't read. A database
// that Atlas already migrated therefore has the `cases` tables but no
// `kysely_migration` ledger; a naive `migrateToLatest` would try to re-run the
// baseline and fail on the existing tables. `adoptAtlasBaselineIfNeeded` seeds
// the ledger with the already-applied baseline names when it detects that
// signature (`cases` exists + ledger empty), so the very first Kysely run on
// such a database skips the baseline and applies only what is genuinely new.
// This covers both production at cutover AND every developer's existing local
// `nova-cases-data` volume — no manual one-off step.

import { type Kysely, sql } from "kysely";
import { Migrator } from "kysely/migration";
import { compilerBugMessage } from "@/lib/domain/predicate/errors";
import {
	ATLAS_BASELINE_MIGRATION_NAMES,
	caseStoreMigrationProvider,
} from "./migrations";

async function regclassExists(
	db: Kysely<unknown>,
	qualifiedName: string,
): Promise<boolean> {
	const result = await sql<{
		reg: string | null;
	}>`SELECT to_regclass(${qualifiedName}) AS reg`.execute(db);
	return result.rows[0]?.reg != null;
}

/**
 * Seed Kysely's `kysely_migration` ledger with the Atlas-era baseline names
 * when (and only when) the database was migrated by Atlas but is not yet
 * Kysely-managed. Idempotent and a no-op on a fresh database (where
 * `migrateToLatest` creates everything) and on an already-Kysely-managed one.
 */
async function adoptAtlasBaselineIfNeeded(db: Kysely<unknown>): Promise<void> {
	// Fresh database — no Atlas-era schema to adopt. `migrateToLatest` creates
	// the ledger and runs every migration normally.
	if (!(await regclassExists(db, "public.cases"))) return;

	// Already Kysely-managed (the ledger exists and tracks at least one
	// migration) — nothing to adopt.
	if (await regclassExists(db, "public.kysely_migration")) {
		const counted = await sql<{
			n: number;
		}>`SELECT count(*)::int AS n FROM kysely_migration`.execute(db);
		if ((counted.rows[0]?.n ?? 0) > 0) return;
	}

	// Atlas-migrated, not yet Kysely-managed: create the ledger tables with
	// Kysely's documented schema, then mark the baseline applied. `ifNotExists`
	// keeps this safe if `migrateToLatest` ever creates them first.
	await db.schema
		.createTable("kysely_migration")
		.ifNotExists()
		.addColumn("name", "varchar(255)", (col) => col.notNull().primaryKey())
		.addColumn("timestamp", "varchar(255)", (col) => col.notNull())
		.execute();
	await db.schema
		.createTable("kysely_migration_lock")
		.ifNotExists()
		.addColumn("id", "varchar(255)", (col) => col.notNull().primaryKey())
		.addColumn("is_locked", "integer", (col) => col.notNull().defaultTo(0))
		.execute();

	const timestamp = new Date().toISOString();
	for (const name of ATLAS_BASELINE_MIGRATION_NAMES) {
		await sql`INSERT INTO kysely_migration (name, timestamp) VALUES (${name}, ${timestamp}) ON CONFLICT (name) DO NOTHING`.execute(
			db,
		);
	}
}

/**
 * Apply all pending case-store migrations to the latest version. Throws on the
 * first failed migration with the offending name, so a non-zero exit fails the
 * deploy's migrate Job before the new revision ships (the guarantee the Atlas
 * Cloud Run Job gave).
 */
export async function runCaseStoreMigrations(
	db: Kysely<unknown>,
): Promise<void> {
	await adoptAtlasBaselineIfNeeded(db);

	const migrator = new Migrator({ db, provider: caseStoreMigrationProvider });
	const { error, results } = await migrator.migrateToLatest();

	const failed = results?.find((r) => r.status === "Error");
	if (error !== undefined || failed !== undefined) {
		throw new Error(
			compilerBugMessage({
				where: "case-store.runCaseStoreMigrations",
				invariant: failed
					? `migration "${failed.migrationName}" failed`
					: "the case-store migrator failed",
				detail: `${
					error instanceof Error
						? error.message
						: String(error ?? "(no error object)")
				}\n\nApplied this run: ${
					results?.map((r) => `${r.migrationName} (${r.status})`).join(", ") ??
					"(none)"
				}\n\nHint: a failed migration usually means an authoring-time SQL error in the new migration module, or a destructive change that should go through expand-contract across deploys.`,
			}),
		);
	}
}
