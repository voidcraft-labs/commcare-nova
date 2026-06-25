// lib/case-store/migrate.ts
//
// Applies the case-store schema migrations via Kysely's `Migrator`. One code
// path for every environment that needs the schema: the production migrate
// entrypoint (the `commcare-nova-migrate` Cloud Run Job), `npm run dev`, and
// the testcontainers harness. Tests run the EXACT migrations production runs —
// the parity guarantee the old Atlas shell-out gave, kept after the move to
// Kysely's in-process migrator.
//
// ## Adopting the existing Atlas-migrated database
//
// The project previously applied these same migrations through Atlas, whose
// revision ledger Kysely doesn't read — so production and existing local
// `nova-cases-data` volumes carry the schema but no `kysely_migration` ledger.
// Rather than seed the ledger from a detection shim (which raced the migrator's
// own advisory lock and had to guess which baselines had already landed), the
// two baseline migration modules are IDEMPOTENT (`CREATE TABLE IF NOT EXISTS`,
// guarded constraint): replaying them against the pre-existing Atlas schema is a
// clean no-op, so the first `migrateToLatest` simply records them as applied.
// Fresh databases get the tables created; production at cutover and every dev
// volume converge with no shim, no hand-rolled ledger DDL, and no race (Kysely's
// advisory lock serializes the run). Migrations added AFTER these two are normal
// forward-only migrations — only the adoption baselines are idempotent.

import type { Kysely } from "kysely";
import { Migrator } from "kysely/migration";
import { caseStoreMigrationProvider } from "./migrations";

/**
 * Apply all pending case-store migrations to the latest version. Throws on the
 * first failed migration with the offending name, so a non-zero exit fails the
 * deploy's migrate Job before the new revision ships (the guarantee the Atlas
 * Cloud Run Job gave).
 */
export async function runCaseStoreMigrations(
	db: Kysely<unknown>,
): Promise<void> {
	const migrator = new Migrator({ db, provider: caseStoreMigrationProvider });
	const { error, results } = await migrator.migrateToLatest();

	const failed = results?.find((r) => r.status === "Error");
	if (error === undefined && failed === undefined) return;

	// Inline Elm-style throw (header / indented diagnostic / narrative / Hint). A
	// failed migration is operator/authoring error — a SQL mistake in the
	// migration module, or a destructive change that should go through
	// expand-contract — NOT an internal invariant, so it deliberately does NOT
	// use `compilerBugMessage` (matching `connection.ts`'s convention for
	// operator-facing failures).
	const applied =
		results?.map((r) => `${r.migrationName} (${r.status})`).join(", ") ??
		"(none)";
	const reason =
		error instanceof Error
			? error.message
			: String(error ?? "(no error object)");
	throw new Error(
		[
			failed
				? `Case-store migration "${failed.migrationName}" failed.`
				: "The case-store migrator failed.",
			"",
			`    reason:  ${reason}`,
			`    applied: ${applied}`,
			"",
			"A failed migration is almost always an authoring-time SQL error in the",
			"new migration module, or a destructive change that should move through",
			"expand-contract across deploys instead of landing in one migration.",
			"",
			"Hint: inspect the failing module under `lib/case-store/migrations/` and",
			"re-run `npm run db:migrate` against a scratch database to reproduce.",
		].join("\n"),
	);
}
