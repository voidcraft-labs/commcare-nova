# lib/case-store — Postgres case store

The runtime storage layer for case data. Cloud SQL Postgres is the
live runtime; the AST→Kysely compiler from `lib/domain/predicate`
is the only evaluator. There is no in-memory variant, no parallel
JS evaluator, no parity tests.

## Public surface — barrel

External consumers import from the `@/lib/case-store` barrel: the `CaseStore` / `SchemaCaseStore` interfaces, row/arg/result types, the two production constructors (`withProjectContext(projectId, actorUserId)` — the tenant-bound reads/writes store; `withSchemaContext()` — the tenant-free, app-scoped schema-ops store), the typed error classes, and JSONB value types. The implementation, sample generator, and test harness stay package-private; tests reach them via subpath.

**One deliberate exception:** the connection layer's `getCaseStorePool()` (subpath `@/lib/case-store/postgres/connection`) is a runtime export the auth layer (`lib/auth.ts`, `lib/auth/db.ts`) imports so Better Auth runs on the SAME `pg.Pool` — one pool per instance is what keeps the connection budget (`enforceConnectionBudget`) intact. Do not route it through the barrel or "tidy" it back to tests-only; the pool-sharing the budget depends on is the reason it's exposed.

## No preview mode — the running-app view shares the editor's rows

The flipbook UI's running-app view operates on the SAME `cases`
rows the editor inspects. There is no preview / production
duplication, no `InMemoryCaseStore`, no per-session lifecycle.
"Generate sample data" / "Reset sample data" are user actions
that write or replace real rows; the user toggles between
authoring and running modes against one shared row set.

## Tenant scoping is structural — `(app_id, project_id)`; `owner_id` is a second axis

Case data is shared at **Project** scope. Every tenant-bound
`CaseStore` carries a Project id resolved (and membership-gated) at
the request boundary; `withProjectContext(projectId, actorUserId)`
is the construction path, and every read/write internally adds
`WHERE project_id = <bound>` so a new method inherits the filter
automatically. The compiler stack (`./sql/`) handles the JOIN-side
`project_id` filter on every `cases` row inside relation walks (see
`./sql/compileRelationPath.ts`); `PostgresCaseStore` owns the
outer-scan filter on every method. The two halves combine to make
cross-Project reads structurally impossible.

`owner_id` is the **CommCare case-owner** — a SEPARATE axis written
on every insert (the acting user today), reserved for future
location-/group-based access carving. It is never a tenant filter and
never to be repurposed/dropped. The two axes are orthogonal:
`project_id` (tenant / sharing) × `owner_id` (case ownership).

**Schema changes are the deliberate exception — app-scoped,
tenant-free.** `applySchemaChange` / `dropSchema` (the
`SchemaCaseStore` slice, built by `withSchemaContext()`) migrate
EVERY member's rows of an app's case type, so their per-row
migrations filter `(app_id, case_type)` ONLY — no `project_id` /
`owner_id`. The schema-write callers (the cross-store saga, the
chat-completion materialize, the point-of-use heal) therefore bind
no tenant.

**Re-tenanting is the second, narrower exception — `retenant.ts`.**
`retenantAppCases({appId, toProjectId})` is the ONE write that crosses
the tenant boundary on purpose: it rewrites `cases.project_id` for an
app's rows when that app moves between Projects
(`lib/db/moveAppToProject.ts`). It keys on `app_id` alone and moves
every row not already in the destination, so it reconciles the rows to
wherever the app doc committed — the move flips the doc FIRST, then runs
this, so the doc is the source of truth and the cases follow it
(idempotent + crash-convergent). It is a standalone barrel export, not a
`CaseStore` method, so the single-tenant invariant of the bound store
stays intact; only `cases` carries `project_id`, so it is the whole job.

## Typed error contract

User-domain errors (`./errors.ts`) carry `instanceof` discrimination so routes map them to typed result arms. Non-obvious rules: `CaseNotFoundError`'s message deliberately does NOT distinguish "outside the bound Project" from "never existed" — tenant boundaries stay structural, never message-leaked. `CasePropertiesValidationError`'s structured `failures` surface in the response body, but the `(appId, caseType)` pair stays server-log-only. All classes use `readonly name = "<ClassName>"` initializers so the literal name survives bundler transforms. Every other throw in the package is an internal-invariant violation using the formatters at `lib/domain/predicate/errors.ts`.

## TypeScript validates writes — there is no in-database trigger

`PostgresCaseStore.insert` and `PostgresCaseStore.update`
validate the candidate `properties` payload against the case-
type's JSON Schema (the row in `case_type_schemas`) via `ajv`
BEFORE the write reaches Postgres. The schema row is fetched on
demand and the compiled validator is cached per
`(appId, caseType, schemaContent)`.

The API route is the trust boundary; the database is internal.
There is no in-database trigger and no `pg_jsonschema` dependency
— Cloud SQL doesn't allowlist that extension and the validator
we already have in TypeScript lives at the right layer for our
architecture.

## `applySchemaChange` runs in two phases

### Phase A (one Kysely transaction)

1. **Schema sync** — regenerate the JSON Schema via
   `caseTypeToJsonSchema` and UPSERT into `case_type_schemas`.
2. **Per-row migration** — only when `change` is supplied. The
   three arms are `rename(from, to)`, `retype(fromType, toType)`,
   and `narrow-options(removedOptions)`. Cast / option-set
   failures move to `cases_quarantine` with the original value +
   failure reason.

Phase A commits when both steps succeed and rolls back atomically
on failure. The schema row + data are always consistent.

### Phase B (no transaction; runs after Phase A commits)

3. **Per-property expression-index DDL** — always runs. Computes
   the desired index set from the blueprint's property
   declarations, reads the live index set from `pg_index` +
   `pg_class` (joined to capture `indisvalid`), and emits the
   matching `DROP INDEX CONCURRENTLY` / `CREATE INDEX CONCURRENTLY`
   statements for the diff. An INVALID artifact left by a prior
   failed CONCURRENTLY build flows through both `drops` and
   `creates` so a retry rebuilds it from scratch.

### Why two phases, not one transaction

PostgreSQL's `CREATE INDEX` (non-`CONCURRENTLY`) heap-scans with
`SnapshotAny` semantics, which includes recently-deleted but
not-yet-vacuumed tuples. Inside the same transaction as Phase A's
per-row migration, a retype that moves a non-castable row to
`cases_quarantine` (DELETE from `cases` + INSERT into
`cases_quarantine`) leaves a dead tuple in `cases`'s heap. A
subsequent in-transaction `CREATE INDEX` over the new typed
expression scans that dead tuple and fails the cast on its
pre-migration value — the `text → int` retype's `"abc"`
quarantined row trips `((properties->>'X')::integer)`, rolling
back the transaction and defeating quarantine.

`CREATE INDEX CONCURRENTLY` uses MVCC snapshot semantics strict
enough to ignore dead tuples and cannot run inside an outer
transaction — both align with Phase B's non-transactional shape.
As a side benefit, CONCURRENTLY does not hold `ACCESS EXCLUSIVE`
on `cases`, so reads + writes keep working while the index
builds.

### Phase B failure semantics

A failure mid-Phase-B throws, the schema row + per-row migration
are already committed, and the next `applySchemaChange` call
diffs against the catalog and re-emits whatever drops + creates
remain outstanding. The diff captures `pg_index.indisvalid` — a
`CREATE INDEX CONCURRENTLY` failure leaves the partially-built
index marked invalid, and the diff treats an INVALID entry as
"drop and recreate" so the next retry converges. Recovery is
idempotent: any number of retries lands the same final index
set. Missing or invalid indexes degrade query performance but
never correctness — the term compiler's emitted SQL falls back
to a sequential scan over the case-type partition.

The chat-completion boundary calls `applySchemaChange` once per
case type via the sibling helper at
`lib/db/materializeCaseStoreSchemas.ts` to close the gap the SA's
fire-and-forget chat-side `saveBlueprint` leaves open (the
freshly-generated case types have no `case_type_schemas` row
until that helper lands). The two awaited blueprint-write
boundaries (auto-save PUT, MCP tool calls) route through the
sibling saga at `lib/db/applyBlueprintChange.ts` instead — saga
for awaited writes (compensation on Firestore failure),
materialize-helper for chat completion (pure additive, no
compensation needed).

### Pre-flight identifier validation runs BEFORE Phase A

`computeDesiredIndexSet` runs synchronously at the top of
`applySchemaChange`, before the transaction opens. Property names
and case-type names compose into the index name through
`indexName`, which throws on identifier-shape violations
(characters outside `[A-Za-z0-9_-]`). A throw at this point leaves
`case_type_schemas` untouched.

Property and case-type names admit hyphens at the blueprint layer
(CommCare convention — `external-id` is real). The index NAME
carries neither name verbatim — the `(app, case_type)` scope and
the property each fold into a fixed-width SHA-256 tag
(`indexScopeTag` / `propertyIndexTag`), so a hyphen needs no
transform and the composed name can't overflow the 63-byte cap no
matter how long the names are. The JSONB key inside the indexed
expression preserves the hyphen verbatim via `sql.lit`.

### Expression indexes are app-scoped

`case_type_schemas` is keyed `(app_id, case_type)`, so a case type's *desired* index set is per-app — but a case-type NAME (`patient`, `person`) is not globally unique. Every per-property expression index is therefore scoped on BOTH halves: the name carries a leading `indexScopeTag(appId, caseType)` segment (`cases_<scopeTag>_<propertyTag>_<mode>` — both the `(app, case_type)` scope and the property fold into fixed-width SHA-256 tags, so the name is ≤ 40 bytes and can't overflow Postgres' 63-byte identifier cap regardless of how long the names are; only `<mode>` stays readable) and the partial predicate is `WHERE app_id = '<app>' AND case_type = '<type>'`. Without that, one global index spans every app's rows of a shared case-type name, and two apps that declare the same case-type + property with different `data_type`s collide on a single index whose cast rejects the other app's values at INSERT (the `::integer`-vs-`"17.01"` failure, cross-app variant). The `scopeTag` is a fixed-WIDTH (12-hex SHA-256) hash of the `(appId, caseType)` pair, which is what makes the catalog diff's name prefix (`cases_<scopeTag>_%`, in `readLiveIndexSet`) an EXACT scope match — distinct scopes hash to distinct tags, so the diff never bleeds across apps NOR across case types whose names are prefixes of each other (`patient` vs `patient_visit`) without ever parsing the partial predicate. It is deterministic, so the runtime composes the same name for a given scope on every write.

### Per-data-type index coverage

| Property `data_type` | Postgres index | Reasoning |
|---|---|---|
| `text` | `GIN ((properties->>'<key>')) gin_trgm_ops` partial on `(app_id, case_type)` | The text-property index slot. The `match` modes no longer route through it — `fuzzy` / `phonetic` evaluate token-wise (`levenshtein` / `soundex` over `unnest`ed tokens) and `starts-with` uses `starts_with(...)`, all of which scan sequentially at preview scale. Retained as the established text slot; dropping it is a separate schema decision |
| `int` / `decimal` | `BTREE (((properties->>'<key>')::<cast>))` partial on `(app_id, case_type)` | Covers `compare` / `between` against typed numerics. The two share the btree access method but compile to different casts (`::integer` vs `::numeric`), so their index NAMES split by cast (suffix `int` / `num`, not a shared `btree`) — the name-keyed catalog diff would otherwise treat an `int↔decimal` retype as a no-op and leave the stale-cast index in place, failing the next fractional insert at write time |
| `multi_select` | `GIN ((properties->'<key>')) jsonb_ops` partial on `(app_id, case_type)` | Covers `multi-select-contains` (`?` / `?\|` / `?&` / `@>`); `jsonb_path_ops` only covers `@>` and would force a sequential scan for `?` / `?\|` / `?&` |
| `single_select` | None | Equality on a small option set is fast without an expression index |
| `date` / `datetime` / `time` | None | The text-to-typed casts and the canonical `to_date(...)` / `to_timestamp(...)` builtins are STABLE in Postgres (DateStyle / TimeZone session dependency); expression indexes require IMMUTABLE expressions |
| `geopoint` | None | The `within-distance` arm builds a WKT string via `concat(...)` over `split_part(...)` reads to bridge the wire shape `"lat lon alt acc"` to PostGIS's WKT input; `concat(...)` over text args is STABLE so the full expression cannot be indexed |

## Sample-data

The generator is stateless and deterministic per `(appId, caseType.name, seed)`, and does NOT write to Postgres — `generateSampleData` routes rows through the package-private bulk-insert path so generated rows get the same JSON Schema validation + `case_indices` derivation as real inserts. Row `case_id`s are minted up-front in TS (`uuidv7()` — same RFC 9562 shape as the column default, so B-tree clustering is unchanged) so derived edges can reference them pre-INSERT. The bulk path stays package-private; the public interface keeps per-call `insert`, and a validation failure on any batched row rolls back the whole batch. `resetSampleData` runs drop-regenerate-validate-insert under ONE transaction so a mid-operation failure preserves the pre-call population. Per-row migrations bulk their writes the same way (constant round-trips regardless of row count).

## Running-app view binding

The flipbook's running-app screens read case data through the
binding helpers at `lib/preview/engine/caseDataBindingHelpers.ts`
(pure helpers accepting a `CaseStore`) plus the Server Actions
at `lib/preview/engine/caseDataBinding.ts` (resolve session
server-side, then `gatedCaseStore` — membership-gate the app's
Project and construct a `withProjectContext` store — and route
through). The
`pickBlueprintDoc` projection in the helpers package strips
function values off the doc-store state before the wire crosses
into a Server Action so React's RSC serializer accepts it.

The CommCare boundary keeps `lib/case-store/**` and
`lib/commcare/**` independent — a Biome `noRestrictedImports`
rule enforces the boundary.

## Local development

`npm run dev` boots a local Postgres via `compose.yaml` (the same
pinned postgis image the test harness and Cloud SQL use), applies the
migrations with `npm run db:migrate` (Kysely's `Migrator` via
`scripts/migrate.ts`), then starts Next.js — see the
`db:dev` script. The app connects to it through `NOVA_DB_LOCAL_URL`
(set in `.env`); when that var is present, `postgres/connection.ts`
uses a plain `pg.Pool` against it instead of the Cloud SQL connector.
It is an EXPLICIT opt-in, not a `NODE_ENV` fallback — production never
sets the var, so it still goes through the connector and its loud
`NOVA_DB_*` validation (the production-misconfig-masking that an
unconditional localhost fallback would cause is what the connection
layer guards against; an opt-in URL doesn't).

Data lives in the persistent `nova-cases-data` Docker volume, so
sample / case rows survive restarts. `npm run db:dev:down` stops the
container (volume persists); `docker compose down -v` wipes it. The
three required extensions (`pg_trgm` / `fuzzystrmatch` / `postgis`)
install once on first boot via `dev/init-extensions.sql`, mirroring
the prod / harness superuser split (the migrate runner connects as a
non-superuser and can't `CREATE EXTENSION`).

## Migrations

Kysely's `Migrator` owns migration application — `runCaseStoreMigrations`
in `lib/case-store/migrate.ts` is the single code path every environment
uses (the prod migrate Job, `npm run dev`, the testcontainers harness),
so tests apply the exact migrations production runs. Migrations are
forward-only TypeScript modules in `lib/case-store/migrations/`, each
exporting `up(db)` (and a teardown-only `down(db)`); `migrations/index.ts`
is a static import-based `MigrationProvider` (no `FileMigrationProvider`,
so it works the same inside the esbuild-bundled prod entrypoint, the
harness, and dev). Kysely records applied migration names in its
`kysely_migration` ledger and serializes concurrent runs with a Postgres
advisory lock.

### Authoring workflow

1. Add a timestamp-prefixed module to `lib/case-store/migrations/`
   (`<YYYYMMDDHHMMSS>_<slug>.ts`) exporting `up`/`down`. Raw DDL goes
   through `` sql`...`.execute(db) `` (one statement per call).
2. Register it in `migrations/index.ts`'s `caseStoreMigrations` record
   (keys sort lexicographically → apply order).
3. Update `lib/case-store/sql/database.ts` (the Kysely type contract) in
   the same commit. The compile-only `sql/__tests__/database.test.ts`
   and the harness smoke tests catch drift between the two.

There is no declarative `schema.sql` and no autogenerated diff anymore
(that was Atlas) — the migration modules ARE the source of truth.

### Destructive changes — expand-contract

There is no automated destructive-change lint anymore (Atlas's
`diff { skip }` + `lint { destructive }` are gone). A schema change that
removes a column / table must still go through expand-contract across
deploys — **enforce it by review**, not a tool:

1. **Expand:** add the new column / table in a migration; deploy.
2. **Migrate:** application code stops reading/writing the old surface;
   deploy.
3. **Contract:** a later migration drops the old surface, once no live
   reader remains.

The testcontainers harness replays every migration against a real
Postgres on each run, so an authoring-time SQL error fails CI loudly.

Two safety nets Atlas's lint provided are gone too, and review must cover
them: (1) a `DROP TABLE`/`DROP COLUMN` in a migration runs against live
Cloud SQL on the next deploy with no automated gate — so destructive DDL
needs deliberate review; and (2) Kysely wraps the whole migration batch in
ONE transaction (Postgres `supportsTransactionalDdl`), which means a
migration CANNOT use `CREATE INDEX CONCURRENTLY` and a plain `CREATE INDEX`
on a large `cases` holds `ACCESS EXCLUSIVE` for the build's duration — and
the migrate Job runs while the OLD revision is still serving, so live reads
stall. Build per-property/large-table indexes through the runtime
`applySchemaChange` Phase-B path (`CREATE INDEX CONCURRENTLY`, no outer
transaction), NOT a migration. Migrations are for the fixed base schema.

### Migration modules are immutable once applied

Kysely's ledger records migration NAMES, not content hashes (the
`atlas.sum` content checksum is gone with Atlas). So **never edit the body
of a migration that has shipped** — every database that already ran it
carries its name in `kysely_migration` and silently skips the edit, so the
change lands on fresh databases (CI) but not on production. Fix forward: add
a new migration. (The two adoption baselines below are the one exception,
edited only because they had not yet shipped as Kysely migrations.)

### Adoption baselines are idempotent (the former Atlas schema)

The case store was previously migrated by Atlas, whose revision ledger
Kysely doesn't read — so production and existing local `nova-cases-data`
volumes carry the schema but no `kysely_migration` ledger. Rather than a
detection shim that seeds the ledger (which raced the migrator's advisory
lock and had to guess which baselines had landed), the two baseline
migration modules are **idempotent** (`CREATE TABLE IF NOT EXISTS`, a
`pg_constraint`-guarded CHECK): replaying them against the pre-existing Atlas
schema is a clean no-op, so the first `migrateToLatest` just records them as
applied. Fresh databases get the tables created; production at cutover and
every dev volume converge with no shim and no race. This covers even a
volume created in the brief window when only the first baseline had run (the
idempotent second baseline still adds `case_name`). Migrations added after
these two are normal forward-only migrations — only the adoption baselines
are idempotent.

### Production: the migrate Cloud Run Job

Migrations run once per deploy as the `commcare-nova-migrate` Cloud Run
Job, NOT on container boot. `cloudbuild.yaml` runs the Job
(`node migrate.cjs`) between pushing the image and deploying the new
revision; a non-zero exit fails the build before the deploy step, so
code never ships ahead of a failed schema change. The container `CMD` is
node-only.

`migrate.cjs` is `scripts/migrate.ts` bundled by esbuild during the
Docker build (the Next standalone runner has no full node_modules, so
kysely + pg + the Cloud SQL connector are inlined into one file). The
Job reuses the app image with a `--command=node --args=migrate.cjs`
override and mirrors the service's identity + network. It calls
`getCaseStoreDatabase()`, so it connects through the SAME
`@google-cloud/cloud-sql-connector` + IAM path the runtime uses — its
env therefore wires `NOVA_DB_USER` / `NOVA_DB_INSTANCE_CONNECTION_NAME`
/ `NOVA_DB_NAME` (the connector's inputs), not Atlas's raw
`NOVA_DB_HOST` URL.

The same entrypoint also owns the **auth** schema: after the case-store
migrations it runs Better Auth's own migrator (`getMigrations(...)
.runMigrations()`, which creates/updates the `auth_*` tables) via the
MCP-free `lib/auth-migrate-options.ts`, then the Nova-owned auth-app
migrations (`lib/auth/migrate.ts`, the `auth_oauth_grant_revocation`
watermark). On the prod connector path only (`NOVA_DB_LOCAL_URL` unset)
it then runs a one-shot, `auth_user`-empty-guarded copy of the durable
auth state Firestore → Postgres (`lib/auth/migrate-data.ts`) — local dev
/ smoke / tests set `NOVA_DB_LOCAL_URL`, so they create the tables but
never pull real Firestore auth data.

### Checking prod migration state

The migrate Job's apply log surfaces in its Cloud Run Job execution
logs:

```bash
gcloud logging read 'resource.labels.job_name=commcare-nova-migrate' \
  --limit=20 --freshness=1h --format='value(textPayload)' --project=commcare-nova
```

The source of truth for "what migrations are applied" is the
`kysely_migration` ledger. Open Cloud SQL Studio at
`https://console.cloud.google.com/sql/instances/nova-cases/studio?project=commcare-nova`
and run:

```sql
SELECT name, timestamp FROM kysely_migration ORDER BY name;
```

### Required Postgres extensions

The case-store's compiler stack depends on three extensions:

- `pg_trgm` — required by the `text` GIN index's `gin_trgm_ops`
  opclass. (The `match` modes no longer emit Postgres `%`
  similarity; the index is retained as the text-property slot.)
- `fuzzystrmatch` — `match(mode: fuzzy)` (`levenshtein` for the
  term-level AUTO-fuzziness clause) and `match(mode: phonetic)`
  (`soundex`, the encoder CommCare HQ's phonetic analyzer uses).
- `postgis` — `match(mode: within-distance)` (`ST_GeogFromText`
  + `ST_DWithin`).

All three are installed at provisioning time on the live Cloud
SQL instance; the testcontainers harness installs the same set via
its container's superuser before the migrations run. There is no
runtime verification gate — missing extensions surface as `function
does not exist` failures at the first compiler-emitted query against
them.

`CREATE EXTENSION` requires `cloudsqlsuperuser` on production, and
the migrate Job connects as the IAM-authenticated runtime SA which
does not have superuser. So extensions install once at provisioning
time under the `postgres` superuser, and schema migrations apply per
deploy under the runtime SA. The testcontainer harness mirrors the
same split.

## Testcontainers harness

A real Postgres engine boots once per `vitest run` and every test
in this package executes against it. The harness lives entirely
under `sql/__tests__/`; consumers import the fixture from
`setup.ts`.

### Container-per-run, transaction-per-test

The harness pins to two non-negotiable rules:

1. **One container per `vitest run`, NOT one per test file.**
   Vitest's `globalSetup` runs in the orchestrator process exactly
   once per run; the harness boots a `PostgreSqlContainer` there
   and publishes the connection URI via `project.provide()`. Per-
   file boots cost 5-15 s each on `pg_ctl init` + extension install
   and make the watch loop unusable.

2. **Per-test isolation comes from BEGIN/ROLLBACK, NOT separate
   schemas / databases.** The `db` fixture in `setup.ts` opens a
   transaction in `beforeEach`-equivalent setup and rolls it back
   in the `try/finally` cleanup wrapper. Don't bypass this with
   raw `pg.Client.connect()` — your writes will leak across tests
   and the harness's contract breaks silently.

   Tests that legitimately need a fresh-empty-database path (the
   per-test database helper at `sql/__tests__/perTestDatabase.ts`)
   are the documented exception: they create their own database
   via `CREATE DATABASE` against the testcontainer's superuser URI
   and drop it on cleanup. The motivating use case is
   `PostgresCaseStore`'s transaction-using methods (`insert` /
   `update` / `applySchemaChange`) — each method calls
   `db.transaction()` which Kysely lowers to a literal `BEGIN`.
   Postgres rejects nested BEGIN inside the harness's outer
   transaction. Per-test databases give every test its own engine
   state without any outer-transaction wrapping.

The `harness-isolation.test.ts` sibling file exists specifically
to catch a regression that splits one of these two rules: it
inserts sentinel UUIDs in `harness.test.ts`, rolls them back, then
asserts in the sibling file that those same UUIDs return zero
rows. A regression to per-file containers OR per-test commits
surfaces as a failing sibling test, not a silent leak.

### Image and extensions

`imresamu/postgis:18-3.6.1-alpine3.23` is the harness's pinned
image (referenced by SHA-256 digest, not by floating tag).
Postgres 18 matches Cloud SQL's default major (since 2025-09-25);
PostGIS 3.6.1 matches Cloud SQL's bundled PostGIS 3.6.0 within
one patch. The image is built FROM the official
`postgres:18-alpine3.23` and layers PostGIS on top, so the
Postgres binary set is upstream-official; only the PostGIS layer
is the maintainer's contribution. The full rationale (multi-arch
parity, why-not the official `postgis/postgis` amd64-only image,
why-not bare `postgres:18-alpine3.23` + apk install) lives in
`globalSetup.ts`'s `## Image choice` block.

### `case_type_schemas` seeding lives at the per-test layer

`globalSetup.ts` applies the schema migrations (via `applyMigrations`)
but does NOT seed any `case_type_schemas` rows. Test bodies that need a
typed JSON Schema row insert it themselves via the `db` fixture —
the row is wrapped in the test's transaction and rolls back along
with everything else. That keeps the harness's global state
minimal: tests that don't care about the schema row don't pay for
it; tests that do care construct exactly the schema they need.

### Fixtures

The `db` fixture is the transactional Kysely handle; `pgClient` is the escape hatch for queries Kysely can't compile (`EXPLAIN ANALYZE`, extension probes, `SET`). Both share one connection, so they see each other's writes within the test transaction.

### Hot-loop expectation

Steady-state watch-loop iteration on a single test file should
re-run in well under one second after the container is up. The
container itself takes 5-15 s to boot on a cold start. If you
ever observe per-file boots in `docker ps`, that's a regression
— file a fix against `globalSetup.ts`'s container-singleton
contract.

## DDL is dual-sourced — migrations + database.ts

Two surfaces describe the same DDL and must stay in lockstep:

1. `lib/case-store/migrations/*.ts` (the forward-only DDL Kysely's
   `Migrator` applies — the source of truth).
2. `sql/database.ts` (the Kysely type contract).

Any change to one requires updating the other in the same change.
The compile-only test in `sql/__tests__/database.test.ts` catches
type-level drift; the harness smoke tests catch DDL-level drift.
