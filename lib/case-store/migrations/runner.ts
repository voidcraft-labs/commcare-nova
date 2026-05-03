// lib/case-store/migrations/runner.ts
//
// Migration runner core. Wraps Kysely's canonical `Migrator` +
// `FileMigrationProvider` pattern (documented at
// `https://kysely.dev/docs/migrations`) with a single-shape,
// caller-agnostic surface that both production (the Cloud Run
// migration job) and tests (the testcontainers harness's
// `globalSetup.ts`) consume.
//
// ## One core function, two call sites
//
// `runMigration(db, action)` is the only function that constructs
// the `Migrator`. Production builds the `Kysely<unknown>` instance
// from `@google-cloud/cloud-sql-connector` + `pg.Pool({ max: 1 })`
// (a migration is a single transaction, no concurrency budget);
// tests build it from the testcontainer URI via `pg.Pool` directly.
// Neither call site duplicates Migrator wiring; both pass an
// already-connected `Kysely<unknown>` and let the runner
// orchestrate.
//
// ## Why `Kysely<unknown>` and not `Kysely<Database>`
//
// Migrations run against a schema that is mid-creation. Before
// the first migration, the database has no tables; the
// `Database` type from `lib/case-store/sql/database.ts` describes
// a fully-migrated schema. Typing the runner against the full
// `Database` would let migration code call `.selectFrom("cases")`
// against a database where `cases` doesn't yet exist — a runtime
// crash with no compile-time signal. `Kysely<unknown>` matches
// the canonical Kysely migration pattern (every doc example uses
// `Kysely<any>`; we use `unknown` for the same intent without
// disabling the structural-narrowing rules elsewhere) and forces
// migration code to use the schema builder (`db.schema.createTable`,
// `db.schema.createIndex`, etc.), which is the right surface
// regardless of pre/post-migration shape.
//
// ## Migration discovery
//
// `FileMigrationProvider` reads `lib/case-store/migrations/`'s
// directory entries and dynamically imports any `.ts` / `.js`
// / `.mjs` / `.mts` file whose default export (or top-level
// exports) match the `Migration` interface. The file naming
// convention is `<NNNN>_<descriptive-name>.ts` where `NNNN` is
// a zero-padded sequence number — Kysely orders alphanumerically,
// so `0001_init.ts` runs before `0002_indices.ts`.
//
// In production, the Cloud Run job's image bundles compiled JS
// alongside the runner; in tests, Vitest's transform pipeline
// loads the `.ts` files (the migrations folder carries a scoped
// `package.json` declaring `"type": "module"` so Node treats
// each `.ts` as ESM during dynamic import). Both paths flow
// through `FileMigrationProvider`'s default ordering; the
// runner doesn't need a separate path discriminator.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	FileMigrationProvider,
	type Kysely,
	type MigrationResult,
	type MigrationResultSet,
	Migrator,
} from "kysely";

// ---------------------------------------------------------------
// Action type — three operations, one shape
// ---------------------------------------------------------------

/**
 * The three migration operations this runner exposes. Both call
 * sites (production Cloud Run job, test harness) accept any of
 * these via the npm-script entry point.
 *
 * - `latest`: apply every pending migration in order. The
 *   canonical "bring the database up to current" operation; the
 *   default for the harness's `globalSetup` and for the
 *   production deploy hook.
 * - `down`: roll back the most recently applied migration. Used
 *   for emergency rollback or for the runner test that exercises
 *   the symmetric `down()` body.
 * - `status`: report the current migration state without
 *   mutating. Returns the same shape as `migrateToLatest` /
 *   `migrateDown` but with `direction === "Up"` rows for already-
 *   applied migrations and no error.
 */
export type MigrationAction = "latest" | "down" | "status";

// ---------------------------------------------------------------
// Migration folder resolution
// ---------------------------------------------------------------

/**
 * Resolve the absolute path to the migrations folder this runner
 * targets. The folder lives next to this file (`runner.ts` and
 * `0001_init.ts` / `0002_indices.ts` are siblings under
 * `lib/case-store/migrations/`); the resolution uses
 * `import.meta.url` so the path works whether the runner runs
 * from the source tree (tests via Vitest's transform) or from a
 * bundled Cloud Run job image.
 *
 * Public so test code can assert the resolved folder, and so
 * any caller wanting to construct its own `Migrator` against a
 * different folder has a single source for the canonical
 * location.
 */
export function getMigrationFolder(): string {
	const here = path.dirname(fileURLToPath(import.meta.url));
	return here;
}

// ---------------------------------------------------------------
// Migrator construction
// ---------------------------------------------------------------

/**
 * Build a `Migrator` against the supplied database handle. Pure
 * helper; no I/O until the caller invokes one of the
 * `migrateToLatest` / `migrateDown` / `getMigrations` methods on
 * the returned instance.
 *
 * `FileMigrationProvider` filters out the runner's own files
 * (`runner.ts`, anything inside `__tests__/`) by checking that
 * each entry exports a `Migration`-shaped object — the runner
 * itself doesn't, so it's silently skipped without an explicit
 * exclusion list.
 */
function buildMigrator(db: Kysely<unknown>): Migrator {
	return new Migrator({
		db,
		provider: new FileMigrationProvider({
			fs,
			path,
			migrationFolder: getMigrationFolder(),
		}),
	});
}

// ---------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------

/**
 * The shape returned to callers. Wraps Kysely's
 * `MigrationResultSet` plus a `success` flag derived from the
 * presence of an `error` so callers can branch without re-
 * inspecting the underlying union shape.
 *
 * The `results` array uses Kysely's per-migration outcome
 * record. For `latest` and `down`, it contains every migration
 * actually executed in the call. For `status`, it lists every
 * migration with `status === "NotExecuted"` for pending ones and
 * the all-applied set otherwise.
 */
export interface MigrationOutcome {
	/** Whether the action completed without a Kysely-reported error. */
	success: boolean;
	/** Per-migration results, mirroring Kysely's shape verbatim. */
	results: ReadonlyArray<MigrationResult>;
	/** The Kysely error, if any. Undefined on success. */
	error?: unknown;
}

/**
 * Execute a migration action against the supplied database.
 *
 * `latest`/`down` return after Kysely commits or rolls back the
 * underlying transaction. `status` queries the migration table
 * read-only and returns the current state. Both call sites pass
 * an already-connected `Kysely<unknown>`; the runner doesn't own
 * connection lifecycle — the caller's `pg.Pool` is the connection
 * authority, and the caller is responsible for `db.destroy()`
 * after the runner returns.
 */
export async function runMigration(
	db: Kysely<unknown>,
	action: MigrationAction,
): Promise<MigrationOutcome> {
	const migrator = buildMigrator(db);

	if (action === "status") {
		// `getMigrations()` returns one entry per discovered migration
		// with a `executedAt` field set when the migration is in the
		// `kysely_migration` ledger. Convert to the same `MigrationResult`
		// shape `migrateToLatest` returns so callers don't need a
		// per-action discriminator on the result type.
		const infos = await migrator.getMigrations();
		const results = infos.map<MigrationResult>((info) => ({
			migrationName: info.name,
			direction: "Up",
			status: info.executedAt !== undefined ? "Success" : "NotExecuted",
		}));
		return { success: true, results };
	}

	const resultSet: MigrationResultSet =
		action === "latest"
			? await migrator.migrateToLatest()
			: await migrator.migrateDown();

	return {
		success: resultSet.error === undefined,
		results: resultSet.results ?? [],
		error: resultSet.error,
	};
}

// ---------------------------------------------------------------
// Pretty-print helpers — shared across CLI and harness
// ---------------------------------------------------------------

/**
 * Format a migration outcome as a human-readable line per
 * migration, suitable for the production Cloud Run job's logs
 * and the harness's diagnostic output. Returns the formatted
 * string; does not write to stdout itself.
 *
 * The shape pins one migration per line with status, name, and
 * direction, plus a closing summary. A failure surfaces both at
 * the failed-migration line and in the trailing summary so the
 * Cloud Run job logs naming the bad migration are unambiguous.
 */
export function formatMigrationOutcome(outcome: MigrationOutcome): string {
	const lines: string[] = [];
	for (const result of outcome.results) {
		lines.push(
			`[${result.status}] ${result.migrationName} (${result.direction.toLowerCase()})`,
		);
	}
	if (outcome.error !== undefined) {
		const message =
			outcome.error instanceof Error
				? outcome.error.message
				: String(outcome.error);
		lines.push(`migration failed: ${message}`);
	} else {
		lines.push(
			outcome.results.length === 0
				? "no migrations to run"
				: `${outcome.results.length} migration(s) processed`,
		);
	}
	return lines.join("\n");
}
