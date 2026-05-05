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
// ## Schema seeding strategy — `schema.sql` is the source of truth
//
// The harness boots the container, installs three required
// Postgres extensions (`pg_trgm`, `fuzzystrmatch`, `postgis`)
// that the case-store compilers' operators depend on, and then
// shells out to `atlas migrate apply --env testcontainer` to
// apply the migrations under `lib/case-store/migrations/` against
// the testcontainer's URI. Test code exercises the same DDL the
// production Cloud Run startup CMD applies against the live
// Cloud SQL instance — single migration directory, single source
// of truth, no harness-only schema shape that could mask a
// migration bug.
//
// Atlas (`https://atlasgo.io`) owns schema-as-code. The
// authoring side is `lib/case-store/schema.sql`; atlas's
// `migrate diff` autogenerates timestamped SQL migration files
// against a Postgres dev container. The applied migrations under
// `lib/case-store/migrations/` are committed verbatim and that
// directory is what production / tests apply, NOT `schema.sql`
// directly — replaying migrations rather than the desired-state
// schema lets the harness exercise the same forward-application
// path production sees.
//
// Extensions stay in the harness (NOT in a migration) because
// `CREATE EXTENSION` requires the `cloudsqlsuperuser` role on
// production Cloud SQL. The runbook §Phase 5 installs them via
// Cloud SQL Studio under the briefly-opened `postgres` superuser
// account; atlas runs as the IAM-authenticated runtime SA at
// Cloud Run startup and that user does not have superuser
// privileges. Installing extensions here mirrors what `postgres`
// did in production without giving the test harness a non-production
// privilege shape.
//
// `--allow-dirty` is passed on every atlas apply because the
// container has the postgis-managed `tiger` and `topology`
// schemas present before atlas runs — those are owned by the
// `postgis` extension that the harness pre-installs, not user
// data, and atlas's empty-database precondition check would
// otherwise reject the apply. Production carries the same
// pre-installed-extension shape (Phase 5 of the Task 0 runbook
// installs them at provisioning time), so the production CMD
// passes the same flag. Atlas's revisions ledger remains the
// authoritative version source after the first apply; the flag
// only suppresses the empty-DB precondition check.
//
// ## Atlas binary prerequisite
//
// `atlas` must be on `PATH` for the harness to run. Install via
// `brew install ariga/tap/atlas` (macOS) or
// `curl -sSf https://atlasgo.sh | sh` (Linux); on macOS systems
// where the brew tap fails on Command Line Tools incompatibility,
// download the community binary from `https://release.ariga.io/atlas/atlas-community-<os>-<arch>-latest`
// and place it on `PATH`. CI / contributor laptops without atlas
// on `PATH` see a clear `atlas: command not found` error here —
// no fallback to a per-test bundled binary; if you're seeing
// migration shell-out failures, install atlas first.
//
// Two surfaces stay in lockstep:
//
//   1. `lib/case-store/schema.sql` (the desired-state source) and
//      `lib/case-store/migrations/*.sql` (the autogenerated
//      forward-only migration set — the runtime source of truth
//      that runs in production AND in tests).
//   2. `lib/case-store/sql/database.ts` (the Kysely type contract)
//
// The compile-only test in `database.test.ts` catches type drift;
// the harness's smoke tests catch DDL drift on the live engine.
// A schema change updates `schema.sql` + `database.ts`, then runs
// `npm run db:diff` to autogenerate a new migration file.

import { spawnSync } from "node:child_process";
import {
	PostgreSqlContainer,
	type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Client } from "pg";
import type { TestProject } from "vitest/node";

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
 * superuser at provisioning time; atlas runs at Cloud Run startup
 * as the IAM-authenticated runtime SA which does not have
 * superuser privileges. Mirroring that split in the harness
 * keeps atlas's privilege shape production-accurate.
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
 * extensions, applies the production migration set via atlas,
 * and publishes the connection URI for worker processes to
 * consume.
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

	// -- Apply the production migration set via atlas. ----------------
	//
	// Atlas owns schema application. We shell out to `atlas migrate
	// apply --env testcontainer --url <connectionString>
	// --allow-dirty`. The `testcontainer` env in `atlas.hcl` points
	// at `lib/case-store/migrations/`; the `--url` flag overrides
	// the env's URL (which has no static value because the
	// testcontainer's port is dynamic per run). `--allow-dirty`
	// suppresses atlas's empty-DB precondition check — the
	// container has postgis's `tiger` and `topology` schemas
	// pre-installed by the extension-install step above, and atlas
	// would otherwise refuse to apply against a non-empty database.
	//
	// `stdio: "inherit"` lets atlas's progress + error output flow
	// straight into Vitest's orchestrator stderr — a migration
	// failure surfaces in the test run's first lines without us
	// proxying the message through a custom format.
	//
	// Status code: 0 on success, non-zero on any failure (lint
	// rejection, lock acquisition failure, network blip on the
	// container, missing migration file). Throwing here aborts
	// globalSetup, which Vitest treats as a fatal harness error.
	const result = spawnSync(
		"atlas",
		[
			"migrate",
			"apply",
			"--env",
			"testcontainer",
			"--url",
			connectionString,
			"--allow-dirty",
		],
		{ stdio: "inherit" },
	);
	if (result.error !== undefined) {
		const code = (result.error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			throw new Error(
				"atlas: command not found. Install Atlas via " +
					"`brew install ariga/tap/atlas` or " +
					"`curl -sSf https://atlasgo.sh | sh` and re-run.",
			);
		}
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(
			`atlas migrate apply failed with exit status ${result.status ?? "(null)"}`,
		);
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
