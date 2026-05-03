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
// The orchestrator boots the container, seeds the schema, and
// publishes the connection URI through `project.provide()`. Worker
// processes pick the URI up via `inject()` from the per-test
// fixture in `setup.ts`. Per-test isolation is the worker's job:
// every test wraps its body in a Kysely transaction that the
// fixture rolls back on teardown, so writes never persist across
// tests even though the database itself is shared.
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
// ## DDL seeding strategy
//
// Hardcoded DDL, sourced verbatim from the spec at
// `docs/superpowers/specs/2026-04-30-case-list-search-design.md`
// lines 254-284. The Kysely Database type at
// `lib/case-store/sql/database.ts` already cites the same lines
// per column; this file is the runtime mirror of that contract.
// Auto-derivation from the Kysely type was rejected because the
// Database type intentionally hides nullability + `NOT NULL`
// constraints behind `ColumnType<...>` wrappers, and reverse-
// engineering DDL from those wrappers would re-implement the
// migrator surface for no test value.
//
// Any change to the DDL must update three surfaces in lockstep:
//
//   1. spec lines 254-284 (the source-of-truth SQL block)
//   2. `lib/case-store/sql/database.ts` (the Kysely type)
//   3. this file's `SCHEMA_DDL` constant
//
// The compile-only test in `database.test.ts` catches type drift;
// this harness's smoke test catches DDL drift on the live engine.

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
 */
const REQUIRED_EXTENSIONS = ["pg_trgm", "fuzzystrmatch", "postgis"] as const;

// -- Schema DDL -----------------------------------------------------
//
// Three CREATE TABLE statements, two CREATE INDEX statements.
// Verbatim from spec lines 254-284. Every column is annotated
// against the spec line that defines it so any cross-surface
// edit can trace both lockstep changes in a single read.

const SCHEMA_DDL = `
-- ---------------------------------------------------------------
-- cases — spec lines 254-265
-- ---------------------------------------------------------------
CREATE TABLE cases (
  case_id        UUID PRIMARY KEY,            -- spec 255
  app_id         TEXT NOT NULL,               -- spec 256
  case_type      TEXT NOT NULL,               -- spec 257
  owner_id       TEXT,                        -- spec 258
  status         TEXT,                        -- spec 259
  opened_on      TIMESTAMPTZ,                 -- spec 260
  modified_on    TIMESTAMPTZ,                 -- spec 261
  closed_on      TIMESTAMPTZ,                 -- spec 262
  parent_case_id UUID,                        -- spec 263
  properties     JSONB NOT NULL               -- spec 264
);

-- ---------------------------------------------------------------
-- case_type_schemas — spec lines 267-272
-- ---------------------------------------------------------------
CREATE TABLE case_type_schemas (
  app_id    TEXT NOT NULL,                    -- spec 268
  case_type TEXT NOT NULL,                    -- spec 269
  schema    JSONB NOT NULL,                   -- spec 270
  PRIMARY KEY (app_id, case_type)             -- spec 271
);

-- ---------------------------------------------------------------
-- case_indices — spec lines 274-283
-- ---------------------------------------------------------------
CREATE TABLE case_indices (
  case_id      UUID NOT NULL,                 -- spec 275
  ancestor_id  UUID NOT NULL,                 -- spec 276
  identifier   TEXT NOT NULL,                 -- spec 277
  relationship TEXT NOT NULL,                 -- spec 278
  depth        INT NOT NULL,                  -- spec 279
  PRIMARY KEY (case_id, ancestor_id, identifier)  -- spec 280
);
CREATE INDEX ON case_indices (ancestor_id, identifier);  -- spec 282
CREATE INDEX ON case_indices (case_id, identifier);      -- spec 283
`;

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
 * extensions, seeds the schema, and publishes the connection URI
 * for worker processes to consume.
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

	const client = new Client({
		connectionString: container.getConnectionUri(),
	});
	await client.connect();
	try {
		// Install required extensions. `IF NOT EXISTS` guards against
		// the rare case where an image ships an extension preinstalled
		// in the template database — it's a no-op then.
		for (const extension of REQUIRED_EXTENSIONS) {
			await client.query(`CREATE EXTENSION IF NOT EXISTS "${extension}"`);
		}

		// Seed the schema. Single statement string; pg's protocol
		// happily parses multi-statement SQL when there are no
		// parameters.
		await client.query(SCHEMA_DDL);
	} finally {
		await client.end();
	}

	// Publish the connection URI for workers. `project.provide` is
	// the only sanctioned channel for cross-process state in
	// Vitest 4 — env vars work too but lose the type-augmentation
	// guarantee on the consumer side.
	project.provide("postgresTestUrl", container.getConnectionUri());
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
