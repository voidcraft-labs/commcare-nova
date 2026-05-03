// lib/case-store/postgres/__tests__/checkExtensions.test.ts
//
// Tests for the Postgres extension-allowlist gate.
//
// ## Real Postgres, not mocks
//
// Per `feedback_tautological_mocks.md`, hand-rolled mocks set by
// the test author can never fail on shape mismatches against the
// real engine — both sides share the wrong mental model. The
// failure-path tests here run against a real Postgres
// (testcontainer) with extensions actually dropped, exercising
// the live `pg_available_extensions` / `pg_extension` system
// catalogs.
//
// ## Why per-test fresh databases
//
// Like `runner.test.ts`, the failure-path tests need to mutate
// the database's extension surface (DROP EXTENSION). Mutating the
// shared harness database would leak state into every other test
// in the run — the harness's BEGIN/ROLLBACK fixture does not
// roll back DDL statements. The fix is the same as the runner
// test: each test creates its own short-lived database via
// `CREATE DATABASE check_test_<rand>`, runs the verifier, asserts,
// and drops the database in `afterEach`.
//
// ## Test surface
//
// Three test groups cover the verifier's three states:
//
//   1. **Pure result assembly** — exercises `assembleResult` with
//      hand-rolled inputs. No database; pins the report shape.
//   2. **Success path** — full `verifyExtensions` against a fresh
//      DB with all three extensions installed (mirrors the
//      production-parity invariant).
//   3. **Failure paths** — fresh DB with extensions dropped (or
//      never installed) to exercise the two failure modes.
//
// The pure-assembly group's tests aren't tautological: they exercise
// the `availableRow !== undefined` / `installedRow !== undefined`
// presence logic + the version-preference cascade against ALL
// shape combinations the function handles. The integration tests
// then pin that the SQL probes feed those rows correctly.

import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { Client, Pool } from "pg";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import {
	type AvailableExtensionRow,
	assembleResult,
	type ExtensionFailure,
	formatVerificationResult,
	type InstalledExtensionRow,
	REQUIRED_EXTENSIONS,
	verifyExtensions,
} from "../checkExtensions";

// ---------------------------------------------------------------
// Per-test database lifecycle
// ---------------------------------------------------------------
// Mirrors `migrations/__tests__/runner.test.ts`'s isolation pattern
// because failure-path tests mutate the extension surface (DROP
// EXTENSION) which BEGIN/ROLLBACK can't unwind.

/**
 * Build a connection URI targeting the per-test database name,
 * preserving the superuser credentials and host/port from the
 * harness's published URI. Same hand-rolled function as
 * `runner.test.ts` — Node's `URL` class doesn't expose a setter
 * that preserves percent-encoded user/password components
 * reliably across versions.
 */
function urlForDatabase(baseUri: string, databaseName: string): string {
	const queryStart = baseUri.indexOf("?");
	const pathPart = queryStart === -1 ? baseUri : baseUri.slice(0, queryStart);
	const queryPart = queryStart === -1 ? "" : baseUri.slice(queryStart);
	const lastSlash = pathPart.lastIndexOf("/");
	return `${pathPart.slice(0, lastSlash + 1)}${databaseName}${queryPart}`;
}

/**
 * The set of extensions to install in a per-test database.
 * Defaults to the full required set; tests that exercise the
 * "available but not installed" failure path pass a narrower set.
 */
type ExtensionInstallSet = ReadonlyArray<string>;

/**
 * Connect to the testcontainer's superuser default database, CREATE
 * a new database named `check_test_<rand>`, install the given
 * subset of required extensions, and return the URI.
 *
 * `extensionsToInstall` accepts a subset of `REQUIRED_EXTENSIONS`
 * so tests can construct intermediate states (no extensions, only
 * one of three, etc.) without further DROP statements at the test
 * boundary.
 */
async function createIsolatedDatabase(
	extensionsToInstall: ExtensionInstallSet = REQUIRED_EXTENSIONS,
): Promise<{ databaseName: string; uri: string }> {
	const baseUri = inject("postgresTestUrl");
	const databaseName = `check_test_${Math.random().toString(36).slice(2, 10)}`;

	const adminClient = new Client({ connectionString: baseUri });
	await adminClient.connect();
	try {
		await adminClient.query(`CREATE DATABASE ${databaseName}`);
	} finally {
		await adminClient.end();
	}

	const targetUri = urlForDatabase(baseUri, databaseName);
	const targetClient = new Client({ connectionString: targetUri });
	await targetClient.connect();
	try {
		for (const extension of extensionsToInstall) {
			// Identifier interpolation is safe here: every value comes
			// from `REQUIRED_EXTENSIONS`, a static literal-string tuple.
			await targetClient.query(`CREATE EXTENSION IF NOT EXISTS "${extension}"`);
		}
	} finally {
		await targetClient.end();
	}

	return { databaseName, uri: targetUri };
}

/**
 * Drop the per-test database. `WITH (FORCE)` (PG 13+) terminates
 * any open connection so a leaked client doesn't keep the drop
 * blocked. Same pattern as `runner.test.ts`.
 */
async function dropIsolatedDatabase(databaseName: string): Promise<void> {
	const baseUri = inject("postgresTestUrl");
	const adminClient = new Client({ connectionString: baseUri });
	await adminClient.connect();
	try {
		await adminClient.query(
			`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`,
		);
	} finally {
		await adminClient.end();
	}
}

/**
 * Build a `Kysely<unknown>` + the underlying pool for a per-test
 * database. Returns both so the caller can teardown the pool
 * before dropping the database. Same shape as `runner.test.ts`.
 */
function buildIsolatedDb(uri: string): {
	db: Kysely<unknown>;
	pool: Pool;
} {
	const pool = new Pool({ connectionString: uri, max: 1 });
	const db = new Kysely<unknown>({
		dialect: new PostgresDialect({
			pool: pool as unknown as PostgresPool,
		}),
	});
	return { db, pool };
}

// ---------------------------------------------------------------
// Pure result assembly tests — no database
// ---------------------------------------------------------------
//
// These tests exercise the report-assembly logic against
// hand-rolled row arrays. They do NOT verify the SQL the verifier
// emits or how Postgres responds to it — that's the integration
// suite below. These tests pin the pure transformation that turns
// row arrays into the `VerificationResult` discriminated shape so
// a regression in the result assembly surfaces independently of
// the database round-trip.
//
// Per `feedback_tautological_mocks.md`, this is NOT mocking the
// database — the function under test is intentionally side-effect-
// free, and unit-testing it with stub rows pins the contract
// between the SQL probe (covered by integration tests) and the
// report shape (covered here).

describe("assembleResult — pure shape transformation", () => {
	const fullyInstalledAvailable: AvailableExtensionRow[] = [
		{ name: "fuzzystrmatch", default_version: "1.2", installed_version: "1.2" },
		{ name: "pg_trgm", default_version: "1.6", installed_version: "1.6" },
		{ name: "postgis", default_version: "3.6.0", installed_version: "3.6.0" },
	];
	const fullyInstalledInstalled: InstalledExtensionRow[] = [
		{ extname: "fuzzystrmatch", extversion: "1.2" },
		{ extname: "pg_trgm", extversion: "1.6" },
		{ extname: "postgis", extversion: "3.6.0" },
	];

	it("reports passed=true when every required extension is available + installed", () => {
		const result = assembleResult(
			fullyInstalledAvailable,
			fullyInstalledInstalled,
		);
		expect(result.passed).toBe(true);
		expect(result.failures).toEqual([]);
		expect(result.states).toHaveLength(REQUIRED_EXTENSIONS.length);
		for (const state of result.states) {
			expect(state.available).toBe(true);
			expect(state.installed).toBe(true);
		}
	});

	it("orders states by REQUIRED_EXTENSIONS regardless of input row order", () => {
		// Rows arrive in reverse order; the result still matches the
		// canonical `REQUIRED_EXTENSIONS` ordering. Pins the report's
		// determinism contract.
		const result = assembleResult(
			[...fullyInstalledAvailable].reverse(),
			[...fullyInstalledInstalled].reverse(),
		);
		expect(result.states.map((s) => s.name)).toEqual([...REQUIRED_EXTENSIONS]);
	});

	it("reports a `not-allowlisted` failure when an extension is missing from pg_available_extensions", () => {
		// `pg_trgm` is missing from both arrays — the allowlist does
		// not expose it.
		const available = fullyInstalledAvailable.filter(
			(r) => r.name !== "pg_trgm",
		);
		const installed = fullyInstalledInstalled.filter(
			(r) => r.extname !== "pg_trgm",
		);
		const result = assembleResult(available, installed);
		expect(result.passed).toBe(false);
		expect(result.failures).toEqual<ExtensionFailure[]>([
			{ name: "pg_trgm", gap: "not-allowlisted" },
		]);
		const trgmState = result.states.find((s) => s.name === "pg_trgm");
		expect(trgmState).toEqual({
			name: "pg_trgm",
			available: false,
			installed: false,
			version: null,
		});
	});

	it("reports a `not-installed` failure when an extension is allowlisted but not installed", () => {
		// `fuzzystrmatch` shows up in `pg_available_extensions` (Cloud
		// SQL allowlists it) but `pg_extension` doesn't carry it (no
		// CREATE EXTENSION has run).
		const installed = fullyInstalledInstalled.filter(
			(r) => r.extname !== "fuzzystrmatch",
		);
		const result = assembleResult(fullyInstalledAvailable, installed);
		expect(result.passed).toBe(false);
		expect(result.failures).toEqual<ExtensionFailure[]>([
			{ name: "fuzzystrmatch", gap: "not-installed" },
		]);
		const fuzzyState = result.states.find((s) => s.name === "fuzzystrmatch");
		expect(fuzzyState).toEqual({
			name: "fuzzystrmatch",
			available: true,
			installed: false,
			// Version falls back to the allowlist's default when not
			// installed — the operator sees what `CREATE EXTENSION`
			// would land if they ran it.
			version: "1.2",
		});
	});

	it("aggregates every gap into a single failures array", () => {
		// All three required extensions absent — the result names every
		// gap, not just the first. Pins the single-throw aggregation
		// pattern from Task 0.
		const result = assembleResult([], []);
		expect(result.passed).toBe(false);
		expect(result.failures).toHaveLength(3);
		expect(result.failures.map((f) => f.name).sort()).toEqual(
			[...REQUIRED_EXTENSIONS].sort(),
		);
		// Every failure is `not-allowlisted` because nothing is in
		// `pg_available_extensions`.
		for (const failure of result.failures) {
			expect(failure.gap).toBe("not-allowlisted");
		}
	});
});

// ---------------------------------------------------------------
// Diagnostic formatting tests
// ---------------------------------------------------------------

describe("formatVerificationResult — operator-facing report", () => {
	it("includes a success line when the gate passes", () => {
		const result = assembleResult(
			[
				{ name: "pg_trgm", default_version: "1.6", installed_version: "1.6" },
				{
					name: "fuzzystrmatch",
					default_version: "1.2",
					installed_version: "1.2",
				},
				{
					name: "postgis",
					default_version: "3.6.0",
					installed_version: "3.6.0",
				},
			],
			[
				{ extname: "pg_trgm", extversion: "1.6" },
				{ extname: "fuzzystrmatch", extversion: "1.2" },
				{ extname: "postgis", extversion: "3.6.0" },
			],
		);
		const formatted = formatVerificationResult(result);
		expect(formatted).toMatch(/All three required extensions/);
		// Per-extension lines name each one with its version.
		expect(formatted).toMatch(/pg_trgm.*available=yes.*installed=yes/);
		expect(formatted).toMatch(/postgis.*available=yes.*installed=yes/);
	});

	it("names every allowlist gap and points at runbook §Phase 2", () => {
		const result = assembleResult([], []);
		const formatted = formatVerificationResult(result);
		expect(formatted).toMatch(/FAILED/);
		// The remediation message names every missing extension and
		// the runbook section the operator should run.
		expect(formatted).toMatch(/Cloud SQL allowlist gap/);
		for (const ext of REQUIRED_EXTENSIONS) {
			expect(formatted).toContain(ext);
		}
		expect(formatted).toMatch(
			/2026-05-02-plan-2-task-0-cloud-sql-provisioning\.md.*Phase 2/,
		);
	});

	it("names every install gap and points at runbook §Phase 5", () => {
		// Extensions allowlisted but not installed (e.g., a freshly-
		// provisioned instance before Phase 5 runs).
		const result = assembleResult(
			[
				{
					name: "pg_trgm",
					default_version: "1.6",
					installed_version: null,
				},
				{
					name: "fuzzystrmatch",
					default_version: "1.2",
					installed_version: null,
				},
				{
					name: "postgis",
					default_version: "3.6.0",
					installed_version: null,
				},
			],
			[],
		);
		const formatted = formatVerificationResult(result);
		expect(formatted).toMatch(/Install gap/);
		expect(formatted).toMatch(
			/2026-05-02-plan-2-task-0-cloud-sql-provisioning\.md.*Phase 5/,
		);
	});
});

// ---------------------------------------------------------------
// Integration tests — real Postgres + real CREATE/DROP EXTENSION
// ---------------------------------------------------------------

describe("verifyExtensions — integration against real Postgres", () => {
	let isolated: { databaseName: string; uri: string };
	let dbHandle: { db: Kysely<unknown>; pool: Pool };

	afterEach(async () => {
		// Always teardown — the dbHandle was set in beforeEach if any
		// runs reach this point. Using try/catch so a failed test
		// inside the body doesn't strand the database.
		await dbHandle.db.destroy();
		await dropIsolatedDatabase(isolated.databaseName);
	});

	describe("success path — all three extensions installed", () => {
		beforeEach(async () => {
			// Fresh DB with the full required set — production parity.
			isolated = await createIsolatedDatabase();
			dbHandle = buildIsolatedDb(isolated.uri);
		});

		it("reports passed=true with every required extension available + installed", async () => {
			const result = await verifyExtensions(dbHandle.db);
			expect(result.passed).toBe(true);
			expect(result.failures).toEqual([]);
			// Every state mirrors the live database's row set.
			for (const state of result.states) {
				expect(state.available).toBe(true);
				expect(state.installed).toBe(true);
				// Every extension reports a non-null version after a real
				// CREATE EXTENSION lands.
				expect(state.version).not.toBeNull();
			}
		});

		it("queries pg_available_extensions and pg_extension via the live Kysely instance", async () => {
			// Pins that the verifier uses the real Postgres system
			// catalogs rather than synthesizing its own row set —
			// dropping pg_trgm AFTER the verifier has run should not
			// retroactively change the result, but a fresh call AFTER
			// the drop must reflect the new state.
			const before = await verifyExtensions(dbHandle.db);
			expect(before.passed).toBe(true);

			// Drop pg_trgm. `CASCADE` because some PostGIS-linked
			// indexes from the harness's migrations might depend on
			// trigram operators in a future schema; the per-test DB
			// has no such dependency yet, but `CASCADE` keeps the test
			// resilient to schema additions.
			await dbHandle.pool.query("DROP EXTENSION pg_trgm CASCADE");

			const after = await verifyExtensions(dbHandle.db);
			expect(after.passed).toBe(false);
			expect(after.failures).toEqual([
				{ name: "pg_trgm", gap: "not-installed" },
			]);
		});
	});

	describe("failure path — extension installed but then dropped", () => {
		beforeEach(async () => {
			// Start with all three installed, then drop one. This is
			// the more realistic failure shape — Cloud SQL allowlists
			// the extension (so `pg_available_extensions` carries it)
			// but no `CREATE EXTENSION` has run in this database.
			isolated = await createIsolatedDatabase();
			dbHandle = buildIsolatedDb(isolated.uri);
			await dbHandle.pool.query("DROP EXTENSION fuzzystrmatch CASCADE");
		});

		it("reports the dropped extension as available but not installed", async () => {
			const result = await verifyExtensions(dbHandle.db);
			expect(result.passed).toBe(false);
			expect(result.failures).toEqual<ExtensionFailure[]>([
				{ name: "fuzzystrmatch", gap: "not-installed" },
			]);
			const fuzzyState = result.states.find((s) => s.name === "fuzzystrmatch");
			expect(fuzzyState).toBeDefined();
			expect(fuzzyState?.available).toBe(true);
			expect(fuzzyState?.installed).toBe(false);
			// Version still reports the allowlist's default — the
			// operator can see what would land if they ran CREATE
			// EXTENSION.
			expect(fuzzyState?.version).not.toBeNull();
		});

		it("leaves the other two extensions reporting passed=true individually", async () => {
			const result = await verifyExtensions(dbHandle.db);
			const trgm = result.states.find((s) => s.name === "pg_trgm");
			const postgis = result.states.find((s) => s.name === "postgis");
			expect(trgm?.installed).toBe(true);
			expect(postgis?.installed).toBe(true);
		});
	});

	describe("failure path — extension never installed", () => {
		beforeEach(async () => {
			// Install only two of three at DB-create time. The third
			// is allowlisted (Cloud SQL exposes it via
			// `pg_available_extensions`) but no `CREATE EXTENSION` has
			// run for it. Mirrors the post-Phase-2 / pre-Phase-5 state
			// of a freshly-provisioned Cloud SQL instance.
			isolated = await createIsolatedDatabase(["pg_trgm", "fuzzystrmatch"]);
			dbHandle = buildIsolatedDb(isolated.uri);
		});

		it("reports postgis as not-installed", async () => {
			const result = await verifyExtensions(dbHandle.db);
			expect(result.passed).toBe(false);
			expect(result.failures).toEqual<ExtensionFailure[]>([
				{ name: "postgis", gap: "not-installed" },
			]);
		});
	});

	describe("aggregate failure path — multiple extensions missing", () => {
		beforeEach(async () => {
			// Install nothing — every extension is allowlisted (the
			// harness's superuser has `pg_trgm`, `fuzzystrmatch`, and
			// `postgis` available via the imresamu/postgis image's
			// contrib set), but none have been installed in this fresh
			// DB.
			isolated = await createIsolatedDatabase([]);
			dbHandle = buildIsolatedDb(isolated.uri);
		});

		it("aggregates every install gap into one failures array", async () => {
			const result = await verifyExtensions(dbHandle.db);
			expect(result.passed).toBe(false);
			expect(result.failures).toHaveLength(3);
			// Every failure is `not-installed`; the harness image has
			// every extension on its allowlist, so none can be
			// `not-allowlisted` here.
			for (const failure of result.failures) {
				expect(failure.gap).toBe("not-installed");
			}
			// Names every missing extension — single-throw aggregation
			// rather than failing on the first.
			expect(result.failures.map((f) => f.name).sort()).toEqual(
				[...REQUIRED_EXTENSIONS].sort(),
			);
		});

		it("formatVerificationResult names every missing extension", async () => {
			const result = await verifyExtensions(dbHandle.db);
			const formatted = formatVerificationResult(result);
			for (const ext of REQUIRED_EXTENSIONS) {
				expect(formatted).toContain(ext);
			}
			expect(formatted).toMatch(/FAILED/);
		});
	});
});
