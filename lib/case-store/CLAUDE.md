# lib/case-store — Postgres case store

The runtime storage layer for case data:

- `sql/database.ts` — Kysely `Database` type definitions for the four
  case-store tables (`cases`, `case_type_schemas`, `case_indices`,
  `cases_quarantine`). The compile-time contract every typed query
  binds against. Source of column names and column types; spec lines
  cited per column.
- `sql/{compileTerm,compilePredicate,compileExpression,compileRelationPath,compileLiteral}.ts`
  — the AST → Kysely compiler stack. Lowers `Predicate` /
  `ValueExpression` / `RelationPath` AST nodes (from
  `lib/domain/predicate`) into typed-builder calls Postgres
  executes natively. Compiler-stack contract documented in
  `sql/CLAUDE.md`; public surface exposed through the barrel at
  `sql/index.ts`.
- `migrations/` — schema migrations. `0001_init.ts` creates the four
  tables; `0002_indices.ts` creates the per-spec static indexes;
  `runner.ts` wraps Kysely's canonical `Migrator` + `FileMigrationProvider`.
  See "Migrations" below for the production / test split.
- `postgres/connection.ts` — Cloud SQL runtime singleton (Plan 2 Task 0).
  Lazy `Kysely<Database>` backed by `pg.Pool` + `@google-cloud/cloud-sql-connector`.
- `sql/__tests__/` — the testcontainers harness shared by every
  AST-to-Kysely compiler test in this package and by future
  Postgres-backed integration tests.

## Migrations

Schema migrations live at `lib/case-store/migrations/`. The directory
contains:

- `0001_init.ts` / `0002_indices.ts` — the migration files. Each
  exports `up(db: Kysely<unknown>)` and `down(db: Kysely<unknown>)`
  per Kysely's documented canonical pattern at
  `https://kysely.dev/docs/migrations`. Naming convention is
  `<NNNN>_<descriptive-name>.ts`; Kysely orders alphanumerically
  so the four-digit prefix is the canonical ordering anchor.
- `runner.ts` — shared core. `runMigration(db, action)` constructs
  Kysely's `Migrator` + `FileMigrationProvider` against this folder
  and runs the chosen action (`latest` / `down` / `status`). One
  function, two callers (production + tests), no duplication.

### Why `Kysely<unknown>` and not `Kysely<Database>`

Migrations run against a schema that is mid-creation. Before the
first migration, the database has no tables; the `Database` type
describes a fully-migrated schema. Typing the runner against the
full type would let migration code call `.selectFrom("cases")`
against a database where `cases` doesn't yet exist — a runtime
crash with no compile-time signal. `Kysely<unknown>` matches the
canonical Kysely migration pattern (every doc example uses
`Kysely<any>`) and forces migration code through the schema
builder (`db.schema.createTable`, `db.schema.createIndex`) which
is the right surface regardless of pre/post-migration shape.

### Production: Cloud Run job

Production migrations run as a Cloud Run job, NOT from a developer
laptop. Cloud SQL is private-IP-only (`--no-assign-ip`) and
`cloud-sql-proxy --private-ip` from a developer laptop does not
reach the instance — see the Plan 2 Task 0 runbook §2.12 for the
verification.

The Cloud Run job (`db-migrate` in `us-central1`) is built from
`Dockerfile.migrate` at the repo root. The image bundles only the
runner + migration files (compiled to JS via `tsc`) and the
production deps; no Next.js, no devDependencies. The job attaches
to the same `default`/`default` network/subnet as the main service
via Direct VPC Egress, runs as the runtime service account, and
inherits the same IAM-auth path the main service uses.

Three npm scripts wrap the job:

| Script | Action |
|---|---|
| `npm run db:migrate:deploy` | Build the image via Cloud Build + deploy/update the `db-migrate` Cloud Run job |
| `npm run db:migrate` | Execute the job with action `latest` (apply all pending migrations) |
| `npm run db:rollback` | Execute the job with action `down` (roll back the most-recently-applied migration) |
| `npm run db:status` | Execute the job with action `status` (read-only — report current migration state) |

The deploy step is heavy (Cloud Build → Artifact Registry push →
job redeploy); the execute step is fast (~10 s round-trip). Run
deploy when the migration code or the schema files change; run
execute every time a new migration set is ready. The deploy script
lives at `scripts/migrate/deploy-job.sh`; the execute wrapper is
at `scripts/migrate/execute-job.sh`. The CLI entry point inside
the job container is `scripts/migrate/run.ts`.

### Tests: testcontainers harness

Tests run the same migrations against a per-`vitest run` Postgres
container (`imresamu/postgis:18-3.6.1-alpine3.23`, digest-pinned)
that globalSetup boots. The harness:

1. Boots the container and waits for `pg_isready`.
2. Installs the three required extensions (`pg_trgm`,
   `fuzzystrmatch`, `postgis`) as the container's superuser. These
   are NOT migrations — `CREATE EXTENSION` requires
   `cloudsqlsuperuser` on production, and the runtime SA running
   migrations doesn't have superuser. The runbook's Phase 5
   installs them under `postgres` superuser at provisioning time;
   the harness mirrors that split.
3. Runs the production migration set via `runMigration(db, "latest")`
   from the same shared core production uses. Test code therefore
   exercises the same DDL the live Cloud SQL instance receives —
   no second source of truth to drift.

Two surfaces stay in lockstep:

1. `lib/case-store/migrations/0001_init.ts` + `0002_indices.ts`
   (the source of truth — runs in production AND in tests)
2. `sql/database.ts` (the Kysely type contract)

A schema change updates ONE migration file plus the type;
nothing else. The compile-only test in `sql/__tests__/database.test.ts`
catches type drift; the harness smoke tests catch DDL drift.

### Migration runner tests

`migrations/__tests__/runner.test.ts` exercises the runner end-to-
end against a per-test database (created via `CREATE DATABASE
runner_test_<rand>` against the testcontainer's superuser URI,
dropped on `afterEach`). Per-test isolation here can't reuse the
harness's BEGIN/ROLLBACK fixture: the tests exercise migrate-from-
empty + roll-back-to-empty paths, neither of which is reachable
from inside an already-migrated database, and re-running
migrations against the shared database would conflict with the
`kysely_migration` ledger globalSetup already initialized.

## Testcontainers harness

A real Postgres engine boots once per `vitest run` and every test in
this package executes against it. The harness lives entirely under
`sql/__tests__/`; consumers import the fixture from `setup.ts`. See
"Writing new tests" below for the canonical usage shape.

### Container-per-run, transaction-per-test

The harness pins to two non-negotiable rules. Future test authors:
do not invent variants.

1. **One container per `vitest run`, NOT one per test file.**
   Vitest's `globalSetup` runs in the orchestrator process exactly
   once per run; the harness boots a `PostgreSqlContainer` there and
   publishes the connection URI via `project.provide()`. Every worker
   reads the same URI through `inject()`. Per-file boots cost 5-15 s
   each on `pg_ctl init` + extension install and make the watch loop
   unusable; the harness is single-source by construction so no test
   file can boot its own.

2. **Per-test isolation comes from BEGIN/ROLLBACK, NOT separate
   schemas / databases.** The `db` fixture in `setup.ts` opens a
   transaction in `beforeEach`-equivalent setup and rolls it back in
   the `try/finally` cleanup wrapper. Writes in test A never reach
   test B even though both tests run against the same physical
   database. Don't bypass this with raw `pg.Client.connect()` — your
   writes will leak across tests and the harness's contract breaks
   silently.

   Migration-runner tests are the documented exception: they need
   migrate-from-empty paths that BEGIN/ROLLBACK can't supply, so
   they create their own per-test database and drop it on cleanup.
   That pattern is **only** for runner-internal tests — every other
   test in this package uses the BEGIN/ROLLBACK fixture.

The `harness-isolation.test.ts` sibling file exists specifically to
catch a regression that splits one of these two rules: it inserts
sentinel UUIDs in `harness.test.ts`, rolls them back, then asserts in
the sibling file that those same UUIDs return zero rows. A regression
to per-file containers OR per-test commits surfaces as a failing
sibling test, not a silent leak.

### Image and extensions

`imresamu/postgis:18-3.6.1-alpine3.23` is the harness's pinned image
(referenced by SHA-256 digest, not by floating tag). Postgres 18
matches Cloud SQL's default major (since 2025-09-25); PostGIS 3.6.1
matches Cloud SQL's bundled PostGIS 3.6.0 (Cloud SQL release notes,
2025-10-27) within one patch. The image is built FROM the official
`postgres:18-alpine3.23` and layers PostGIS on top, so the Postgres
binary set is upstream-official; only the PostGIS layer is the
maintainer's contribution. The full rationale (multi-arch parity,
why-not the official `postgis/postgis` amd64-only image, why-not bare
`postgres:18-alpine3.23` + apk install) lives in `globalSetup.ts`'s
`## Image choice` block.

The harness installs three extensions the case-store compilers depend
on:

- `pg_trgm` — `match(mode: fuzzy)` operator (Postgres `%` similarity)
- `fuzzystrmatch` — phonetic match (Soundex / Metaphone)
- `postgis` — `within-distance` operator (`ST_DWithin`)

Validation of `cases.properties` against `case_type_schemas[appId,
case_type].schema` runs in TypeScript at every API route writing to
`cases`. The API route is the trust boundary; the database is internal.
There is no in-database trigger and no `pg_jsonschema` dependency —
Cloud SQL doesn't allowlist that extension and the validator we already
have in TypeScript (`lib/domain/predicate/jsonSchema.ts` + `ajv`) lives
at the right layer for our architecture.

### `case_type_schemas` seeding lives at the per-test layer

`globalSetup.ts` runs the schema migrations but does NOT seed
any `case_type_schemas` rows. Test bodies that need a typed JSON
Schema row (schema-aware compiler tests, schema-sync round-trip tests)
insert it themselves via the `db` fixture — the row is wrapped in the
test's transaction and rolls back along with everything else. That
keeps the harness's global state minimal: tests that don't care
about the schema row don't pay for it; tests that do care construct
exactly the schema they need.

### Writing new tests

```ts
import { test, expect, makeCaseRow } from "./setup";

test("predicate compiler emits the expected JOIN", async ({ db }) => {
	// Set up rows for the test
	await db.insertInto("cases").values([
		makeCaseRow({ case_id: "...", properties: JSON.stringify({ ... }) }),
	]).execute();

	// Run the compiler against the same `db` (transaction-scoped)
	const compiled = compilePredicate(predicate, ...);
	const rows = await db
		.selectFrom("cases")
		.where(compiled.where)
		.execute();

	expect(rows).toHaveLength(1);
});
```

The `pgClient` fixture is the escape hatch for queries Kysely cannot
compile (`EXPLAIN ANALYZE`, raw extension probes, `SET` statements):

```ts
test("EXPLAIN includes a Bitmap Heap Scan", async ({ pgClient }) => {
	const result = await pgClient.query("EXPLAIN SELECT * FROM cases WHERE ...");
	expect(result.rows.some(...)).toBe(true);
});
```

Both fixtures share the same Postgres connection — they see each
other's writes within the same transaction.

### Hot-loop expectation

Steady-state watch-loop iteration on a single test file should re-run
in well under one second after the container is up. The container
itself takes 5-15 s to boot on a cold start; once running, Vitest's
worker reload + the per-test BEGIN/ROLLBACK round-trip is sub-second
on a modern laptop. If you ever observe per-file boots in `docker ps`,
that's a regression — file a fix against `globalSetup.ts`'s
container-singleton contract.

## Spec source

All DDL is sourced from `docs/superpowers/specs/2026-04-30-case-list-search-design.md`
lines 254-284 (the four base tables + indexes) and lines 309-340
(the `cases_quarantine` shape from "Schema migration policy"). Two
surfaces stay in lockstep:

1. The migration files at `migrations/0001_init.ts` and
   `0002_indices.ts` (the runtime source of truth — runs in
   production via the Cloud Run job AND in tests via globalSetup)
2. `sql/database.ts` (the Kysely type contract)

Any change to one requires updating the other in the same change.
The compile-only test in `sql/__tests__/database.test.ts` catches
type-level drift; the harness smoke tests catch DDL-level drift.
