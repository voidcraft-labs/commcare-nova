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
// `postgis/postgis:16-3.4` is the official Postgres-with-PostGIS
// image: stock Postgres 16 binary set, which means the contrib
// extensions `pg_trgm` and `fuzzystrmatch` ship in-image, plus
// PostGIS 3.4 preinstalled. Anything else (vanilla `postgres`
// image, Supabase image, Crunchy image) loses one of those three
// without a custom Dockerfile. The fourth extension the case-store
// cares about — `pg_jsonschema` — is a Cloud SQL allowlist concern,
// not a harness concern; the harness installs it when the running
// image happens to ship it (Supabase) and logs a single warning
// when it doesn't (postgis/postgis). The case-store compilers
// don't depend on the JSON-schema trigger; they need pg_trgm /
// fuzzystrmatch / postgis for query operators (fuzzy match,
// phonetic match, geographic distance).
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
 * Image tag for the harness container.
 *
 * `postgis/postgis:16-3.4` ships:
 *   - Postgres 16 (matches Cloud SQL's supported major version)
 *   - PostGIS 3.4 (the `postgis` extension required for the
 *     `within-distance` operator)
 *   - `pg_trgm` and `fuzzystrmatch` (stock Postgres 16 contribs)
 *
 * Pinned major+minor so test runs are deterministic across
 * developer machines. Patch versions still float — security
 * fixes land transparently.
 */
const IMAGE_TAG = "postgis/postgis:16-3.4";

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
 * `postgis` for geographic-distance predicates).
 */
const REQUIRED_EXTENSIONS = ["pg_trgm", "fuzzystrmatch", "postgis"] as const;

/**
 * `pg_jsonschema` is allowlist-gated on Cloud SQL (spec § "Cloud
 * SQL extension allowlist for `pg_jsonschema`", line 545). The
 * harness installs it when the running image happens to ship it
 * and logs a single line otherwise. Absence is NOT a fatal
 * failure — the AST-to-Kysely compiler tests don't exercise the
 * JSON-Schema trigger.
 */
const OPTIONAL_EXTENSIONS = ["pg_jsonschema"] as const;

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

		// Optional extensions: install if `pg_available_extensions`
		// reports them, log a single line otherwise. globalSetup
		// runs in the orchestrator process before any worker
		// initializes its `@/lib/logger` mock. Either channel writes
		// to the orchestrator's stderr identically; `console.warn`
		// keeps this module free of an internal-package import.
		for (const extension of OPTIONAL_EXTENSIONS) {
			const { rows } = await client.query<{ name: string }>(
				`SELECT name FROM pg_available_extensions WHERE name = $1`,
				[extension],
			);
			if (rows.length > 0) {
				await client.query(`CREATE EXTENSION IF NOT EXISTS "${extension}"`);
			} else {
				console.warn(
					`[case-store harness] optional extension '${extension}' not available on image '${IMAGE_TAG}'; skipping.`,
				);
			}
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
