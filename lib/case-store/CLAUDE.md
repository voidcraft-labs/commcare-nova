# lib/case-store — Postgres case store

The runtime storage layer for case data:

- `sql/database.ts` — Kysely `Database` type definitions for the three
  case-store tables (`cases`, `case_type_schemas`, `case_indices`). The
  compile-time contract every typed query binds against. Source of
  column names and column types; spec lines cited per column.
- `sql/{compileTerm,compilePredicate,compileExpression,compileRelationPath,compileLiteral}.ts`
  — the AST → Kysely compiler stack. Lowers `Predicate` /
  `ValueExpression` / `RelationPath` AST nodes (from
  `lib/domain/predicate`) into typed-builder calls Postgres
  executes natively. Compiler-stack contract documented in
  `sql/CLAUDE.md`; public surface exposed through the barrel at
  `sql/index.ts`.
- `sql/__tests__/` — the testcontainers harness shared by every
  AST-to-Kysely compiler test in this package and by future
  Postgres-backed integration tests.

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

`globalSetup.ts` seeds the three table DDL surfaces but does NOT seed
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
lines 254-284. Three surfaces stay in lockstep:

1. The spec's SQL block (source of truth)
2. `sql/database.ts` (Kysely type contract)
3. `sql/__tests__/globalSetup.ts`'s `SCHEMA_DDL` (live engine seed)

Any change to one requires updating the other two in the same change.
The compile-only test in `sql/__tests__/database.test.ts` catches
type-level drift; the harness smoke tests catch DDL-level drift.
