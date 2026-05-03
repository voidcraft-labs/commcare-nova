// lib/case-store/postgres/checkExtensions.ts
//
// Shared core for the Postgres extension-allowlist gate (Plan 2
// Task 2). Verifies that the three extensions Plan 1's compiler
// stack depends on are both ALLOWLISTED on the target Cloud SQL
// instance (`pg_available_extensions`) AND INSTALLED in the
// connected database (`pg_extension`). Returns a structured report
// with per-extension state plus an aggregate `passed` flag.
//
// ## Why this lives in `lib/`, not in `scripts/`
//
// Two call sites consume the same verification logic:
//
//   1. The production CLI at `scripts/check-extensions/run.ts`
//      invokes this function against the live Cloud SQL instance
//      via a Cloud Run job. The job is built from
//      `Dockerfile.check-extensions` and deployed via
//      `scripts/check-extensions/deploy-job.sh`; the runtime
//      invocation is `scripts/check-extensions/execute-job.sh`
//      (wrapped by `npm run db:check-extensions`).
//   2. The test harness at `__tests__/checkExtensions.test.ts`
//      invokes this function against the testcontainers Postgres
//      instance (per-test fresh databases via `CREATE DATABASE
//      check_test_<rand>` so failure paths can `DROP EXTENSION`
//      cleanly without affecting the shared harness database).
//
// One shared core means a regression in either the SQL probes or
// the report assembly surfaces in both call sites; no duplication
// to keep in sync.
//
// ## Architectural lock — production parity is non-negotiable
//
// Plan 1's Postgres compiler emits SQL that uses the three
// extensions' operators / functions natively:
//
//   - `pg_trgm`     — `match` modes "fuzzy" / "starts-with" /
//                     "fuzzy-date" emit `%` similarity / planner-
//                     recognised LIKE / IN-list permutations
//                     against trigram indexes.
//   - `fuzzystrmatch` — `match` mode "phonetic" emits
//                       `dmetaphone(...)` calls.
//   - `postgis`     — `within-distance` emits `ST_GeogFromText` +
//                     `ST_DWithin`.
//
// Without any one of these, the corresponding compiler-emitted SQL
// fails at execution time with `function does not exist` or
// `operator does not exist`. There is NO graceful-degradation path
// in the runtime — the compiler doesn't branch on extension
// availability. Per `feedback_max_subset_no_dimagi_litter.md`, Nova
// targets the maximum CCHQ feature subset; per
// `feedback_postgres_strict_ast_null_semantics.md`, missing
// foundation infra halts rather than degrades.
//
// The script is therefore a structural pre-flight gate: it verifies
// at deploy time that the production environment has the same
// extension surface every test runs against. If the gate fails,
// the operator re-provisions the Cloud SQL instance with the
// missing extensions installed (see runbook §Phase 5) and re-runs
// the check until it passes.
//
// ## No "generated TypeScript constant" of availability
//
// An earlier iteration of Plan 2 Task 2 mentioned recording
// availability in a generated TypeScript constant. Rejected: the
// architectural lock is "halt if missing", not "branch on
// availability." Plan 1's compilers already assume all three
// extensions are present; downstream code has nothing to consume
// from such a constant. The script itself is the gate; success is
// silent (exit 0); failure aborts the pipeline.
//
// ## The two probe queries
//
// The verification runs two queries in sequence:
//
//   - `pg_available_extensions` (`name`, `default_version`,
//     `installed_version`) — what Cloud SQL's allowlist exposes to
//     this database. A row missing here means Cloud SQL has been
//     configured to disable that extension; the operator must
//     re-provision the instance with the extension allowed.
//   - `pg_extension` (`extname`, `extversion`) — what has been
//     `CREATE EXTENSION`-ed into THIS database. A row missing here
//     (when the allowlist row is present) means the extension is
//     allowlisted but not yet installed; the operator runs Phase 5's
//     `CREATE EXTENSION` block (which requires `cloudsqlsuperuser`).
//
// Both queries scope the row set to the three required names via
// an `IN (...)` filter so the verifier sees exactly the rows it
// needs to inspect. Ordering by name keeps the report
// deterministic for diff-friendly logs.
//
// ## Single-throw aggregation
//
// Per Task 0's pattern (`readCaseStoreEnvConfig` aggregates every
// missing env var into one error rather than failing on the first
// gap), `verifyExtensions` reports EVERY missing extension in one
// pass. The operator sees the full picture from one run and
// re-provisions accordingly, rather than discovering gaps one
// restart at a time.

import type { Kysely } from "kysely";
import { sql } from "kysely";

// ---------------------------------------------------------------
// Required extension set
// ---------------------------------------------------------------

/**
 * The three Postgres extensions Plan 1's compiler stack depends on.
 * Verbatim against `lib/case-store/sql/__tests__/globalSetup.ts`'s
 * `REQUIRED_EXTENSIONS` constant — the test harness installs this
 * exact set into every per-`vitest run` container; production
 * Cloud SQL must mirror it.
 *
 * Exposed as a typed tuple so the report's per-extension entries
 * can be keyed against this list at compile time.
 */
export const REQUIRED_EXTENSIONS = [
	"pg_trgm",
	"fuzzystrmatch",
	"postgis",
] as const;

/** The literal-union type of the three required extension names. */
export type RequiredExtension = (typeof REQUIRED_EXTENSIONS)[number];

// ---------------------------------------------------------------
// Report shapes
// ---------------------------------------------------------------

/**
 * One row from `pg_available_extensions`, narrowed to the columns
 * this verifier inspects. `installed_version` is `null` when the
 * extension is allowlisted but no `CREATE EXTENSION` has run in
 * the current database — the verifier cross-checks against
 * `pg_extension` separately so the two states (not allowlisted vs
 * allowlisted-but-not-installed) stay distinguishable.
 */
export interface AvailableExtensionRow {
	name: string;
	default_version: string;
	installed_version: string | null;
}

/**
 * One row from `pg_extension`, narrowed to the columns this
 * verifier inspects. Presence of a row here means
 * `CREATE EXTENSION <name>` has run in the current database.
 */
export interface InstalledExtensionRow {
	extname: string;
	extversion: string;
}

/**
 * Per-extension verification state. The two flags map directly to
 * the two probe queries — `available` from
 * `pg_available_extensions`, `installed` from `pg_extension` — so a
 * caller can distinguish "Cloud SQL disabled it" (allowlist gap)
 * from "no one ran CREATE EXTENSION" (install gap).
 */
export interface ExtensionState {
	/** The extension name. One of `REQUIRED_EXTENSIONS`. */
	name: RequiredExtension;
	/** True iff the row appears in `pg_available_extensions`. */
	available: boolean;
	/** True iff the row appears in `pg_extension`. */
	installed: boolean;
	/**
	 * The installed version, when known. Read from `pg_extension.extversion`
	 * when `installed === true`; otherwise from `pg_available_extensions.default_version`
	 * when `available === true`; otherwise `null`. Useful for
	 * pinning version drift between production and the testcontainer.
	 */
	version: string | null;
}

/**
 * The aggregate verification result. Callers branch on `passed`;
 * the diagnostic CLI uses `states` to print the human-readable
 * table and `failures` to print the operator-facing remediation
 * message.
 */
export interface VerificationResult {
	/** True iff every required extension is both available AND installed. */
	passed: boolean;
	/** Per-extension state, ordered to match `REQUIRED_EXTENSIONS`. */
	states: ReadonlyArray<ExtensionState>;
	/**
	 * The subset of `states` whose verification failed. Each entry
	 * names the extension and which side of the gate it tripped
	 * (allowlist or install). Empty when `passed === true`.
	 */
	failures: ReadonlyArray<ExtensionFailure>;
}

/**
 * A single verification gap. The `gap` discriminator distinguishes
 * the two failure modes so the caller's error message can name the
 * right remediation:
 *
 *   - `not-allowlisted` → operator must re-provision the Cloud SQL
 *     instance with the extension allowlisted (runbook §Phase 2).
 *   - `not-installed` → operator must run `CREATE EXTENSION` as
 *     `postgres` superuser (runbook §Phase 5).
 */
export type ExtensionFailure =
	| { name: RequiredExtension; gap: "not-allowlisted" }
	| { name: RequiredExtension; gap: "not-installed" };

// ---------------------------------------------------------------
// Probe queries — typed against a `Kysely<unknown>`
// ---------------------------------------------------------------

/**
 * Run the two extension-probe queries against the supplied Kysely
 * instance and return their raw row arrays. Exposed as a separate
 * pure-IO function so tests can swap in a stub row source for
 * unit-level verification of `assembleResult` without booting a
 * full Postgres.
 *
 * The queries:
 *   - `SELECT name, default_version, installed_version FROM
 *      pg_available_extensions WHERE name IN ($1, $2, $3) ORDER BY
 *      name` — what Cloud SQL allowlists.
 *   - `SELECT extname, extversion FROM pg_extension WHERE extname IN
 *      ($1, $2, $3) ORDER BY extname` — what `CREATE EXTENSION` has
 *      run in the current database.
 *
 * Both queries IN-filter against the required set so the row count
 * tops out at three regardless of how many extensions the engine
 * has on the broader catalog.
 *
 * `Kysely<unknown>` because the `pg_available_extensions` and
 * `pg_extension` views are PG system catalogs not declared in the
 * application's `Database` type. The runner uses `sql<...>`-typed
 * raw queries through Kysely's tagged-template interface — this is
 * the canonical Kysely escape hatch for system-catalog reads
 * (`https://kysely.dev/docs/recipes/raw-sql`) and the only sql-
 * tagged usage in this surface; the application compilers stay on
 * the typed-builder API.
 */
export async function fetchExtensionRows(db: Kysely<unknown>): Promise<{
	available: ReadonlyArray<AvailableExtensionRow>;
	installed: ReadonlyArray<InstalledExtensionRow>;
}> {
	// `sql.join(values)` parameter-binds each list element as a
	// separate $1/$2/$3 binding — the canonical Kysely pattern for
	// IN-clauses with raw SQL (verified against
	// `https://kysely.dev/docs/recipes/raw-sql`). The tuple is
	// converted to a mutable array because `sql.join`'s signature
	// expects a non-readonly iterable.
	const extensionParams = [...REQUIRED_EXTENSIONS];
	const availableQuery = sql<AvailableExtensionRow>`
		SELECT name, default_version, installed_version
		FROM pg_available_extensions
		WHERE name IN (${sql.join(extensionParams)})
		ORDER BY name
	`;
	const installedQuery = sql<InstalledExtensionRow>`
		SELECT extname, extversion
		FROM pg_extension
		WHERE extname IN (${sql.join(extensionParams)})
		ORDER BY extname
	`;

	const [availableResult, installedResult] = await Promise.all([
		availableQuery.execute(db),
		installedQuery.execute(db),
	]);

	return {
		available: availableResult.rows,
		installed: installedResult.rows,
	};
}

// ---------------------------------------------------------------
// Pure result assembly
// ---------------------------------------------------------------

/**
 * Compose a `VerificationResult` from the two probe-query row
 * arrays. Pure function — no IO, no Kysely. Tests exercise this
 * with hand-rolled inputs to pin the report shape; the integration
 * tests at `__tests__/checkExtensions.test.ts` exercise the full
 * `verifyExtensions` path against a real Postgres.
 *
 * The function iterates the canonical `REQUIRED_EXTENSIONS` tuple
 * (rather than the input rows) so the report's order is
 * deterministic and the per-extension lookup is constant-time
 * regardless of how the database returned the rows. Missing rows
 * are handled by the lookup returning undefined — the boolean
 * `available` / `installed` flags fall out of the presence check.
 *
 * Per Task 0's single-throw aggregation pattern, every gap goes
 * into `failures` so the caller can build one error message naming
 * every problem at once.
 */
export function assembleResult(
	available: ReadonlyArray<AvailableExtensionRow>,
	installed: ReadonlyArray<InstalledExtensionRow>,
): VerificationResult {
	// Index the two row arrays by name for constant-time lookup.
	// `Map` rather than a plain object so dynamic-key access doesn't
	// collide with `Object.prototype` keys (`__proto__`, `constructor`,
	// etc.) — system catalogs return whatever extension names the
	// operator has installed, and a `Record<string, ...>` lookup of
	// `__proto__` would walk the prototype chain instead of returning
	// `undefined` like a Map does.
	const availableByName = new Map<string, AvailableExtensionRow>(
		available.map((row) => [row.name, row]),
	);
	const installedByName = new Map<string, InstalledExtensionRow>(
		installed.map((row) => [row.extname, row]),
	);

	const states: ExtensionState[] = [];
	const failures: ExtensionFailure[] = [];

	for (const name of REQUIRED_EXTENSIONS) {
		const availableRow = availableByName.get(name);
		const installedRow = installedByName.get(name);

		// Version preference: the actually-installed version trumps the
		// allowlist's default, because `CREATE EXTENSION` may have
		// pinned a non-default version. Falls back to the allowlist's
		// default when allowlisted but not installed; null when neither
		// applies.
		let version: string | null;
		if (installedRow !== undefined) {
			version = installedRow.extversion;
		} else if (availableRow !== undefined) {
			version = availableRow.default_version;
		} else {
			version = null;
		}

		states.push({
			name,
			available: availableRow !== undefined,
			installed: installedRow !== undefined,
			version,
		});

		// Aggregate every failure, not just the first — the operator
		// gets the full picture in one pass.
		if (availableRow === undefined) {
			// Allowlist gap. `not-installed` is implied but the operator's
			// remediation is the allowlist re-provision step, so the
			// surfaced gap names that side directly.
			failures.push({ name, gap: "not-allowlisted" });
		} else if (installedRow === undefined) {
			// Allowlisted but no CREATE EXTENSION has run.
			failures.push({ name, gap: "not-installed" });
		}
	}

	return {
		passed: failures.length === 0,
		states,
		failures,
	};
}

// ---------------------------------------------------------------
// Top-level verification entry point
// ---------------------------------------------------------------

/**
 * Probe the supplied Kysely instance for the three required
 * extensions and return the aggregated `VerificationResult`. The
 * canonical entry point for both production (the Cloud Run job
 * via `scripts/check-postgres-extensions.ts`) and tests (the
 * harness at `__tests__/checkExtensions.test.ts`).
 *
 * The function does NOT own the connection lifecycle — the caller
 * supplies an already-connected `Kysely<unknown>` and is responsible
 * for `db.destroy()` after this returns. Same contract as
 * `runMigration` from `lib/case-store/migrations/runner.ts`; both
 * functions live at the same composition layer.
 */
export async function verifyExtensions(
	db: Kysely<unknown>,
): Promise<VerificationResult> {
	const rows = await fetchExtensionRows(db);
	return assembleResult(rows.available, rows.installed);
}

// ---------------------------------------------------------------
// Diagnostic formatting — shared between CLI and harness
// ---------------------------------------------------------------

/**
 * Format a verification result as a human-readable report suitable
 * for the Cloud Run job's logs and the harness's diagnostic output.
 * Returns the formatted string; does not write to stdout.
 *
 * The shape pins one line per extension with the available /
 * installed flags + version, plus a closing summary that names
 * every gap when the gate fails. Operator-facing remediation
 * advice for each failure mode lives in the closing summary so a
 * red-line log on Cloud Run is self-explanatory without grepping
 * the runbook.
 */
export function formatVerificationResult(result: VerificationResult): string {
	const lines: string[] = [];
	lines.push("Cloud SQL extension allowlist gate:");
	for (const state of result.states) {
		const availableMark = state.available ? "yes" : "no";
		const installedMark = state.installed ? "yes" : "no";
		const versionStr = state.version ?? "(none)";
		lines.push(
			`  ${state.name.padEnd(14)} available=${availableMark.padEnd(3)} installed=${installedMark.padEnd(3)} version=${versionStr}`,
		);
	}

	if (result.passed) {
		lines.push(
			"All three required extensions are available + installed; the runtime compiler stack's hard dependencies are satisfied.",
		);
	} else {
		lines.push("");
		lines.push(
			"FAILED: the production parity invariant requires every extension above to be both available AND installed.",
		);
		// Group remediation by failure mode so the operator's next-step
		// list is unambiguous.
		const allowlistGaps = result.failures.filter(
			(f) => f.gap === "not-allowlisted",
		);
		const installGaps = result.failures.filter(
			(f) => f.gap === "not-installed",
		);
		if (allowlistGaps.length > 0) {
			lines.push(
				`  Cloud SQL allowlist gap (${allowlistGaps.map((f) => f.name).join(", ")}): re-provision the instance with the missing extensions enabled per docs/superpowers/runbooks/2026-05-02-plan-2-task-0-cloud-sql-provisioning.md §Phase 2.`,
			);
		}
		if (installGaps.length > 0) {
			lines.push(
				`  Install gap (${installGaps.map((f) => f.name).join(", ")}): run CREATE EXTENSION as the postgres superuser per docs/superpowers/runbooks/2026-05-02-plan-2-task-0-cloud-sql-provisioning.md §Phase 5.`,
			);
		}
	}

	return lines.join("\n");
}
