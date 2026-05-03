// lib/case-store/sql/__tests__/globalSetup.ts
//
// Vitest globalSetup hook for the case-store Postgres harness.
//
// One container per `vitest run`, NOT one per file.
// ----------------------------------------------------------------
//
// Vitest's globalSetup runs in the orchestrator process exactly
// once per test run, before any worker spawns. It is therefore the
// only correct host for an expensive shared resource like a real
// Postgres container — booting one per test file would cost
// 5-15 s of `pg_ctl init` + extension installation per file and
// make the watch loop unusable.
//
// The orchestrator boots the container, installs the required
// extensions, runs the production migration set (which creates
// every case-store table), and publishes the connection URI
// through `project.provide()`. Worker processes pick the URI up
// via `inject()` from the per-test fixture in `setup.ts`. Per-
// test isolation is the worker's job: every test wraps its body
// in a Kysely transaction that the fixture rolls back on
// teardown, so writes never persist across tests even though the
// database itself is shared.
//
// ## Container reaping
//
// Testcontainers runs a Ryuk sidecar that reaps orphaned
// containers when the parent process dies — including hard kills
// (SIGKILL, OS panic, IDE shutdown). Vitest's `teardown` hook also
// stops the container on a clean exit. Together those two paths
// cover every termination mode without a manual signal handler.
//
// ## Image choice
//
// `imresamu/postgis:18-3.6.1-alpine3.23` is a community multi-arch
// rebuild of the official `postgis/postgis` Dockerfile, maintained
// by Imre Samu (a member of the @postgis GitHub org). It builds
// FROM the official `postgres:18-alpine3.23` and layers the
// PostGIS extension on top, so the Postgres binary set, contrib
// extensions, and locale handling are upstream-official; only the
// PostGIS install layer is the rebuild's contribution. The image
// ships:
//
//   - Postgres 18 (Cloud SQL's default major since 2025-09-25;
//     the `postgres:18-alpine3.23` base floats to the current
//     stable minor — 18.3 at last rebuild, two minors ahead of
//     Cloud SQL's 18.1 pin, which is fine because Postgres minor
//     releases are bug-fix-only by policy)
//   - PostGIS 3.6.1 (the `postgis` extension required for the
//     `within-distance` operator)
//   - `pg_trgm` and `fuzzystrmatch` (stock Postgres contribs)
//   - `linux/amd64` AND `linux/arm64` manifests
//
// Why not the official `postgis/postgis` image: it publishes
// `linux/amd64` only at every major version (verified against
// Docker Hub for v16, v17, and v18). Apple Silicon dev machines
// would run it under amd64 emulation — slow container init and a
// non-native runtime in tests. The imresamu rebuild publishes
// native arm64 manifests so the testcontainer runs at full speed
// on every supported architecture.
//
// Why not bare `postgres:18-alpine3.23`: it doesn't ship PostGIS,
// which the `within-distance` operator needs. Installing PostGIS
// at container init via `apk add` would re-pay the install cost
// on every cold start, and the package versions across Alpine
// repos drift independently of the Postgres minor.
//
// Supply-chain note: the image reference is digest-pinned (see
// `IMAGE_TAG` below). The tag string is mutable upstream; the
// SHA-256 content digest is not. An upstream account compromise
// can't push a malicious image into our test runs without a
// conscious digest bump in this file.
//
// ## Schema seeding strategy — migrations are the source of truth
//
// The harness boots the container, installs three required
// Postgres extensions (`pg_trgm`, `fuzzystrmatch`, `postgis`)
// that the case-store compilers' operators depend on, and then
// runs the production migration set from
// `lib/case-store/migrations/` end-to-end via the shared
// `runMigration(db, "latest")` core. Test code therefore exercises
// the same DDL the production Cloud SQL instance will receive —
// no second source of truth to drift, no harness-only schema
// shape that masks a migration bug.
//
// Extensions stay in the harness (NOT in a migration) because
// `CREATE EXTENSION` requires the `cloudsqlsuperuser` role on
// production Cloud SQL. The runbook §Phase 5 installs them via
// Cloud SQL Studio under the briefly-opened `postgres` superuser
// account; the migration runner runs as the IAM-authenticated
// runtime SA, which doesn't have superuser privileges. Installing
// extensions here mirrors what `postgres` did in production
// without giving the test harness a non-production privilege
// shape.
//
// Two surfaces stay in lockstep:
//
//   1. `lib/case-store/migrations/0001_init.ts` + `0002_indices.ts`
//      (the source of truth — runs in production AND in tests)
//   2. `lib/case-store/sql/database.ts` (the Kysely type contract)
//
// The compile-only test in `database.test.ts` catches type drift;
// the harness's smoke tests catch DDL drift on the live engine.
// A schema change updates ONE migration file plus the type;
// nothing else.

import {
	PostgreSqlContainer,
	type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { Client, Pool } from "pg";
import type { TestProject } from "vitest/node";
import { runMigration } from "../../migrations/runner";

// -- Provided-context type augmentation -----------------------------
//
// Vitest's `inject()` is typed against the `ProvidedContext`
// interface; tests that read `inject("postgresTestUrl")` get a
// string, not an `unknown`. The augmentation lives next to the
// publisher to keep the contract single-source.
declare module "vitest" {
	export interface ProvidedContext {
		/**
		 * Postgres connection URI for the harness's shared
		 * container. `postgresql://user:pass@host:port/db` shape.
		 * Workers connect via `pg.Pool({ connectionString: uri })`
		 * (see `setup.ts`).
		 */
		postgresTestUrl: string;
	}
}

// -- Container configuration ----------------------------------------

/**
 * Image reference for the harness container — digest-pinned.
 *
 * Format: `<repo>:<tag>@sha256:<digest>`. Docker resolves
 * `<repo>:<tag>` for human-readable display in `docker ps` and
 * pull logs but verifies the pulled content against the digest,
 * so the tag is a navigation aid and the digest is the security
 * boundary. The "Supply-chain note" in the file-level comment
 * above explains why we pin by digest rather than by floating tag.
 *
 * The tag decomposes as:
 *   - `18`         — Postgres major (Cloud SQL default since
 *                    2025-09-25; the `postgres:18-alpine3.23`
 *                    base floats to the current 18.x minor at
 *                    rebuild time)
 *   - `3.6.1`      — PostGIS extension version
 *   - `alpine3.23` — Alpine Linux base image
 *
 * The pinned digest above corresponds to the multi-arch index
 * for that tag as last pushed 2026-04-27. Both `linux/amd64` and
 * `linux/arm64` manifests are reachable through the index, so
 * Docker's manifest negotiation pulls the native variant for the
 * host architecture without us specifying a per-arch digest.
 *
 * Bumping: pull the new tag's manifest index digest from
 * `https://hub.docker.com/v2/repositories/imresamu/postgis/tags/<tag>`
 * (the top-level `digest` field — NOT the per-arch
 * `images[].digest` values, which would lock the harness to one
 * architecture). Replace both the tag and the digest below in
 * lockstep so the human-readable navigation aid stays accurate.
 */
const IMAGE_TAG =
	"imresamu/postgis:18-3.6.1-alpine3.23@sha256:8990ecd2e7d5744904830ea8b0e4ee90981ad65f08c331cf060da43c46712bac";

/**
 * Test database name. Single shared database — per-test isolation
 * comes from BEGIN/ROLLBACK at the worker level, not from
 * separate databases.
 */
const DATABASE_NAME = "case_store_test";

/**
 * Postgres extensions the case-store compilers depend on. The
 * harness installs these into the test database; absence is a
 * fatal failure — the compilers cannot be tested without them
 * (`pg_trgm` for fuzzy match, `fuzzystrmatch` for phonetic match,
 * `postgis` for geographic-distance predicates). Cloud SQL
 * allowlists all three; production parity is non-negotiable.
 *
 * Extensions are NOT migrations because `CREATE EXTENSION`
 * requires the `cloudsqlsuperuser` role on production Cloud SQL.
 * The runbook installs them via Studio under the postgres
 * superuser at provisioning time, not via the application's
 * IAM-auth migration runner. Mirroring that split in the harness
 * keeps the migration runner's privilege shape production-
 * accurate.
 */
const REQUIRED_EXTENSIONS = ["pg_trgm", "fuzzystrmatch", "postgis"] as const;

// -- Setup orchestration --------------------------------------------

/**
 * Mutable state held at module scope so the `teardown` named
 * export — which Vitest calls separately from `setup` — can stop
 * the container that `setup` started. Module scope is the
 * canonical handoff between Vitest's two lifecycle hooks; closing
 * over the variable in a default-export setup function would also
 * work but the named-export shape mirrors the docs example one-
 * to-one.
 */
let runningContainer: StartedPostgreSqlContainer | null = null;

/**
 * Vitest globalSetup entry point. Boots the container, installs
 * extensions, runs the production migration set, and publishes
 * the connection URI for worker processes to consume.
 *
 * Vitest passes the orchestrator's `TestProject` instance; we use
 * `project.provide("postgresTestUrl", ...)` to make the URI
 * available to `inject()` calls in the worker fixtures.
 *
 * @param project - Vitest's orchestrator project handle.
 */
export async function setup(project: TestProject): Promise<void> {
	// Boot the container. `withDatabase` sets the initial database
	// name; `start()` waits for `pg_isready`.
	const container = await new PostgreSqlContainer(IMAGE_TAG)
		.withDatabase(DATABASE_NAME)
		.start();

	runningContainer = container;
	const connectionString = container.getConnectionUri();

	// -- Install extensions via raw `pg.Client`. ----------------------
	//
	// The container's default postgres user is a superuser inside
	// the testcontainer (matching the briefly-opened postgres role
	// the production runbook §Phase 5 uses), so `CREATE EXTENSION`
	// succeeds without IAM auth. Single client, single connection;
	// closes immediately after the install.
	const extClient = new Client({ connectionString });
	await extClient.connect();
	try {
		for (const extension of REQUIRED_EXTENSIONS) {
			await extClient.query(`CREATE EXTENSION IF NOT EXISTS "${extension}"`);
		}
	} finally {
		await extClient.end();
	}

	// -- Run the production migration set. ---------------------------
	//
	// The migration runner constructs its own `Migrator` from
	// `FileMigrationProvider`; we hand it a one-shot `Kysely<unknown>`
	// backed by a small `pg.Pool` and tear that pool down before
	// publishing the URI to workers. The migration runner DOES NOT
	// own pool lifecycle — the caller does — and the harness's
	// per-test `pg.Pool` (created in `setup.ts`) is a separate pool
	// that workers own.
	//
	// `max: 1` mirrors the production migration CLI at
	// `scripts/migrate/run.ts`. The migration runs inside a single
	// Kysely transaction, and Postgres's migration lock is
	// `pg_advisory_xact_lock` — a transaction-scoped advisory lock
	// acquired on the transaction's already-checked-out connection.
	// Kysely's pre-transaction probes (ensureMigrationTablesExist +
	// lock-row probe) are sequential awaits that release the
	// connection between calls, so one connection suffices.
	//
	// `db.destroy()` calls the underlying pool's `end()` exactly
	// once via Kysely's dialect-destroy contract, so we don't
	// double-end the pool here. Idempotency is NOT preserved by
	// pg.Pool (`Called end on pool more than once`), so the cleanup
	// path closes via `db.destroy()` only.
	const migrationPool = new Pool({ connectionString, max: 1 });
	const migrationDb = new Kysely<unknown>({
		dialect: new PostgresDialect({
			pool: migrationPool as unknown as PostgresPool,
		}),
	});
	try {
		const outcome = await runMigration(migrationDb, "latest");
		if (!outcome.success) {
			// The migration runner returned a failure — surface the
			// detail in the orchestrator's stderr so the entire run
			// fails fast with a clear cause. Throwing here aborts
			// globalSetup, which Vitest treats as a fatal harness
			// error.
			const message =
				outcome.error instanceof Error
					? outcome.error.message
					: String(outcome.error);
			throw new Error(`testcontainer migration runner failed: ${message}`);
		}
	} finally {
		await migrationDb.destroy();
	}

	// Publish the connection URI for workers. `project.provide` is
	// the only sanctioned channel for cross-process state in
	// Vitest 4 — env vars work too but lose the type-augmentation
	// guarantee on the consumer side.
	project.provide("postgresTestUrl", connectionString);
}

/**
 * Vitest globalSetup teardown. Called after every test file has
 * finished running on a clean exit, or before process exit on a
 * watch-mode shutdown. On hard kills the Ryuk sidecar reaps
 * orphans, so this hook is the polite path, not the only one.
 */
export async function teardown(): Promise<void> {
	if (runningContainer !== null) {
		await runningContainer.stop();
		runningContainer = null;
	}
}
