# Case Data Layer Implementation Plan (Plan 2 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Plan 2 of 5. Depends on Plan 1 (Foundation) — needs the Predicate AST, Expression AST, JSON Schema generator, and the Postgres compiler. Does NOT need Plans 3-5.

**Goal:** Stand up Cloud SQL Postgres as the live runtime for case data, with the `CaseStore` interface that case-list authoring (Plan 3), search authoring (Plan 4), and the running-app view (Plan 5) consume. Replace the existing `lib/preview/engine/dummyData.ts` with a typed `CaseStore`-backed flow that handles forms (registration / followup / close) writing through the same interface as auto-generated sample data.

**Architecture summary:** One interface (`CaseStore`) with one implementation (`PostgresCaseStore`). The AST→Kysely compiler from Plan 1 IS the evaluator — there is no parallel JS evaluator, no parity tests, no in-memory variant. Per-user / per-app isolation uses `(app_id, owner_id)` columns on the `cases` table — same pattern every other domain table follows. `HeuristicCaseGenerator` writes through `PostgresCaseStore.insert` so generated rows are real rows. The flipbook UI's running-app view operates on the same `cases` rows the editor inspects; sample-data generation is a user action ("Generate sample data" / "Reset sample data" buttons), not a mode switch.

**Tech Stack:** TypeScript (strict), Kysely (typed SQL builder), Cloud SQL for PostgreSQL, testcontainers (for CI / local tests), Vitest. Plan 1's Postgres compiler is exercised at runtime here.

---

## File Structure

```
lib/case-store/
├── store.ts                          # CaseStore interface — the single seam
├── postgres/
│   ├── store.ts                      # PostgresCaseStore — wraps the Kysely DB
│   ├── connection.ts                 # Cloud SQL connection pool, Auth Proxy / private IP
│   ├── queryCompile.ts               # Plan 1 Kysely compiler integration glue
│   ├── caseIndices.ts                # case_indices materialization (Option B: direct edges + recursive CTE)
│   └── triggers/
│       ├── jsonSchemaValidator.sql   # `pg_jsonschema` trigger (when allowlisted)
│       └── plpgsqlValidator.sql      # PL/pgSQL fallback trigger
├── sample/
│   ├── generator.ts                  # SampleCaseGenerator interface
│   ├── heuristic.ts                  # HeuristicCaseGenerator
│   └── pools/                        # typed value pools per data_type
│       ├── names.ts
│       ├── addresses.ts
│       ├── geopoints.ts
│       └── dates.ts
├── form-bridge/
│   ├── writeThrough.ts               # form completion → CaseStore mutation
│   └── deriveFromForm.ts             # extract case operations from a completed form
├── migrations/
│   ├── 0001_init.sql                 # cases, case_type_schemas, case_indices, cases_quarantine
│   ├── 0002_indices.sql              # the index list from the spec's storage-layer schema
│   └── ...                           # ongoing schema evolution
└── __tests__/
    └── store.test.ts                 # interface compliance harness against testcontainers Postgres

lib/preview/engine/
├── dummyData.ts                      # DELETED — replaced by case-store/postgres
└── caseDataBinding.ts                # NEW — flipbook running-app view reads CaseStore via this binding
```

---

## Tasks

### Task 0: Cloud SQL provisioning + Auth Proxy / connection pool

**Files:** `lib/case-store/postgres/connection.ts`, infra scripts under `scripts/infra/`, secret entries.

Provision the Cloud SQL Postgres instance (smallest tier — `db-f1-micro` or equivalent — sized up later if needed). Configure private IP via the existing VPC. Create the `nova_cases` database. Generate a service account with `cloudsql.client` role and store credentials in Secret Manager. Wire the Cloud SQL Auth Proxy as a sidecar in the Cloud Run deployment, OR use direct private IP if the existing Cloud Run service has VPC connector access.

`connection.ts` exports a Kysely instance configured against the Cloud SQL connection pool (`pg.Pool` with `max: 10` per Cloud Run instance — Cloud SQL's per-instance connection limit divided by the Cloud Run max instances). The Database type comes from Plan 1 Task C2.

For local dev: `connection.ts` reads `NOVA_DATABASE_URL` from env; in CI / tests the testcontainers fixture sets it.

For ephemeral dev / preview-deploy environments: per-deployment database isolation via a database-per-deployment or schema-per-deployment naming convention (TBD when the first preview deploy lands).

Steps:
- [ ] Provision Cloud SQL instance via gcloud (record commands in `scripts/infra/provision-cloud-sql.sh` for reproducibility)
- [ ] Configure VPC peering / private IP / Auth Proxy
- [ ] Create the `nova_cases` database; create role with appropriate grants
- [ ] Generate service account, store credentials in Secret Manager, wire to Cloud Run env
- [ ] Implement `lib/case-store/postgres/connection.ts` with the Kysely instance
- [ ] Verify connection from local dev (`npm run dev` connects via Auth Proxy locally)
- [ ] Verify connection from a deployed Cloud Run revision

### Task 1: Migration tooling + initial schema

**Files:** `lib/case-store/migrations/0001_init.sql`, `0002_indices.sql`, migration runner script.

Adopt `kysely-migration-cli` (or equivalent) for schema migrations — runs migration SQL files in order, tracks applied migrations in a `kysely_migrations` table.

Initial migration (`0001_init.sql`) creates the four tables from the spec's "Storage layer for cases" section:
- `cases` with `(case_id, app_id, owner_id, case_type, status, opened_on, modified_on, closed_on, parent_case_id, properties JSONB)` plus per-spec indices.
- `case_type_schemas` with `(app_id, case_type, schema JSONB)` PK `(app_id, case_type)`.
- `case_indices` with `(case_id, ancestor_id, identifier, relationship, depth)` plus `(ancestor_id, identifier)` and `(case_id, identifier)` indices.
- `cases_quarantine` with the same shape as `cases` plus `quarantine_reason TEXT`, `quarantined_at TIMESTAMPTZ`.

`owner_id` is the spec's per-user isolation key — every read filters by `owner_id = <session.user.id>` via a middleware layer in the `PostgresCaseStore` query path. Defense-in-depth via Postgres Row-Level Security policies in a later migration once the application-layer pattern is exercised.

Steps:
- [ ] Add migration runner to `package.json` scripts (`db:migrate`, `db:rollback`, `db:status`)
- [ ] Write `0001_init.sql` per the spec schema
- [ ] Write `0002_indices.sql` for the per-spec indices
- [ ] Run migrations against local Cloud SQL Auth Proxy + against testcontainers Postgres in CI
- [ ] Document the migration workflow in `lib/case-store/CLAUDE.md`

### Task 2: Cloud SQL extension allowlist gate (formerly Plan 1 Task C2-pre)

**Files:** `scripts/check-postgres-extensions.ts`, `lib/case-store/postgres/triggers/`.

Run `gcloud sql instances describe ... --format='value(databaseFlags)'` and `SELECT * FROM pg_available_extensions WHERE name IN ('pg_jsonschema', 'pg_trgm', 'fuzzystrmatch', 'postgis')` against the provisioned instance. Record availability in a generated TypeScript constant.

If `pg_jsonschema` is available: deploy `triggers/jsonSchemaValidator.sql` as the BEFORE INSERT/UPDATE trigger on `cases`.
If not: deploy `triggers/plpgsqlValidator.sql` (a PL/pgSQL implementation that walks the JSON Schema row from `case_type_schemas` against the candidate `properties` value). Architecture identical from the application's perspective; performance differs.

Either way, the trigger is defense-in-depth — the application's `PostgresCaseStore.insert` / `.update` path validates against the same JSON Schema in TypeScript before every write. The trigger catches anything that bypasses the application layer (direct SQL, future bulk imports, replication tooling).

Steps:
- [ ] Write the extension-availability gate script
- [ ] Run against the provisioned Cloud SQL instance; record results
- [ ] Pick the trigger SQL based on the gate result; deploy via migration `0003_validate_trigger.sql`
- [ ] Test: `INSERT INTO cases ... { invalid }` raises EXCEPTION

### Task 3: `CaseStore` interface

**Files:** `lib/case-store/store.ts`, tests via the interface-compliance harness.

Define the single seam used by every consumer. Methods (matching the spec):
- `query(args: { appId, caseType, predicate?, sort?, limit?, offset? }): Promise<CaseRow[]>`
- `insert(args: { appId, row }): Promise<void>`
- `update(args: { appId, caseId, patch }): Promise<void>`
- `close(args: { appId, caseId }): Promise<void>`
- `traverse(args: { appId, caseId, via }): Promise<CaseRow[]>`
- `syncSchemaForCaseType(appId, caseType): Promise<void>` — re-derives the JSON Schema from the current blueprint and upserts the `case_type_schemas` row. Synchronous on the blueprint-write path so the database always reflects the blueprint's current schema before any case-store write evaluates against it.
- `migrateProperty(args: { appId, caseType, property, change }): Promise<MigrationReport>` — schema-migration policy per the spec. `change` is a discriminated union: `rename` (atomic key-copy in same transaction), `retype` (migrate-or-quarantine), `narrow-options` (existing rows with removed values move to `cases_quarantine`).
- `generateSampleData(args: { appId, caseType, count, seed }): Promise<{ inserted: number }>` — calls `HeuristicCaseGenerator` and routes the rows through `insert`.
- `resetSampleData(args: { appId, caseType }): Promise<{ deleted: number; inserted: number }>` — deletes existing rows for the case-type, then re-generates with a fresh seed.

`MigrationReport` includes counts of migrated / quarantined / skipped rows plus per-row failure reasons.

The interface is one shape; `PostgresCaseStore` is the only implementation. No "InMemory" variant; no parity tests across implementations.

### Task 4: `PostgresCaseStore` implementation

**Files:** `lib/case-store/postgres/store.ts`, `queryCompile.ts`, `caseIndices.ts`, tests.

Implements `CaseStore` against the Kysely instance from Task 0:
- `query` invokes Plan 1's Kysely predicate/expression compiler to build the SELECT, applies sort / limit / offset, executes against the `cases` table filtered by `(app_id, owner_id)`.
- `insert` validates against `case_type_schemas[appId, caseType].schema` (TS-side via Plan 1's JSON Schema generator), then INSERTs the row, then derives `case_indices` direct edges from `parent_case_id` + property-level relations.
- `update` does a JSONB merge on `properties` (full-row replacement per the spec's JSONB-write-bloat mitigation), updates `modified_on`, re-derives `case_indices` if the relation surface changed.
- `close` updates `closed_on`, `status`, no row deletion.
- `traverse` compiles the RelationPath via Plan 1's relation-path compiler (Task C5) into a recursive CTE; runs against `case_indices`.
- `syncSchemaForCaseType` invokes Plan 1's JSON Schema generator + UPSERTs `case_type_schemas`.
- `migrateProperty` runs the rename / retype / narrow-options paths in a single transaction; rows that fail the new schema move to `cases_quarantine` with the original value + failure reason.

`case_indices` materialization: Option B (direct edges only, recursive CTE on read) per the spec's verification gate. Switch to Option A if profiling shows the CTE dominates query cost.

Tests run the interface-compliance harness from Task 3 against a testcontainers Postgres instance: insert + query roundtrip; relation traversal; schema sync; migration paths.

### Task 5: `HeuristicCaseGenerator` (sample data writes through `CaseStore`)

**Files:** `lib/case-store/sample/generator.ts`, `heuristic.ts`, `pools/*.ts`, tests.

Implements `SampleCaseGenerator` from the spec. Schema-driven, deterministic per `(app, case-type, seed)`. Generates realistic-but-fake values per `data_type`:
- `text` → name pool (regional names if app context hints at locale, otherwise global)
- `int` → bounded integer pool (age-shaped if property name contains "age", count-shaped otherwise)
- `date` / `datetime` → plausible ranges (DOB pool, registration-date pool, recent-event pool — selected by property-name heuristic)
- `single_select` / `multi_select` → uniform sample over the property's option set
- `geopoint` → cluster around city centers (NYC, Lagos, Mumbai, etc. — varied so search-by-location demos work)
- `time` → reasonable working-hours range

Default count 30 per case type. Generates parent linkages from the case-type relationship graph: child case types get a `parent_case_id` pointing at a randomly-selected parent case. The `case_indices` rows derive from those linkages via `PostgresCaseStore.insert` (Task 4) — the generator doesn't write `case_indices` directly; it just writes case rows and the store derives the index structure.

The user invokes generation via `CaseStore.generateSampleData` / `resetSampleData` (Task 3). Backstop CLI / developer script: `scripts/seed-sample-data.ts`.

Tests: deterministic output (same seed → same data); valid against the case-type's JSON schema; parent linkages create the right `case_indices` rows; cross-case-type relational queries work end-to-end.

### Task 6: Form running-app write-through

**Files:** `lib/case-store/form-bridge/writeThrough.ts`, `deriveFromForm.ts`, tests.

Routes form completion in the running-app view through `CaseStore`. `deriveFromForm` extracts the case operations a completed form implies (registration → insert; followup → update; close → close), using the existing `lib/commcare/deriveCaseConfig.ts` logic but at runtime per form-completion rather than build-time per blueprint.

Tests: completing a registration form inserts the right shape; followup updates the bound case; close marks closed; the running-app view re-queries and sees the changes immediately (continuous validation principle — no "save then refresh").

### Task 7: Replace `lib/preview/engine/dummyData.ts` with `caseDataBinding.ts`

**Files:** `lib/preview/engine/caseDataBinding.ts` (new), `lib/preview/engine/dummyData.ts` (delete).

`caseDataBinding.ts` exposes the same surface as `dummyData.ts` did (`getCases(caseTypeName)`, `getCaseData(caseTypeName, caseId)`) but routes through `PostgresCaseStore`. Existing call-sites in the preview engine continue to work; the implementation underneath is now the typed CaseStore over Cloud SQL.

For empty case-types (no rows yet), the binding surfaces a "Generate sample data" affordance to the running-app view — clicking it invokes `CaseStore.generateSampleData`. The flipbook is "always in valid state": no error state when the case-type is empty, just a button to populate it.

Tests: existing dummyData tests pass against the new binding (rename + minor adjust). Existing CaseListScreen rendering continues to work. Empty-case-type renders the "Generate sample data" affordance.

### Task 8: Schema-migration policy implementation

**Files:** `lib/case-store/postgres/migrate.ts`, tests.

Implements `CaseStore.migrateProperty`. Three change shapes:
- `rename(from, to)` — atomic in a single transaction: `UPDATE cases SET properties = jsonb_set(properties #- '{from}', '{to}', properties->'from')` for every row in the case-type.
- `retype(fromType, toType)` — for each row, attempt to cast the value via the `fromType → toType` rules from the spec's "Schema migration policy" table. On success: `UPDATE cases SET properties = jsonb_set(...)`. On failure: move to `cases_quarantine` with `quarantine_reason` set to the cast-failure detail.
- `narrow-options(removedOptions)` — for each row whose property value is in `removedOptions`, move to `cases_quarantine`.

All run in a single transaction; the migration is atomic.

Tests: each change shape against fixtures; rollback on transaction failure; quarantine surfacing.

### Task 9: Barrel exports + CLAUDE.md

**Files:** `lib/case-store/index.ts`, `lib/case-store/CLAUDE.md`.

Document:
- The interface contract.
- The single-implementation pattern (no in-memory variant; no parity tests; testcontainers covers test isolation).
- The "no preview mode" architecture: the running-app view operates on the same rows the editor sees; sample-data generation is a user action.
- The `(app_id, owner_id)` isolation pattern.
- The migration workflow (`db:migrate`, `db:rollback`, `db:status`).
- The Cloud SQL extension gate and trigger-deployment policy.

---

## Dependencies between tasks

- 0 → 1 → 2 → 3, 4 (parallel after 2)
- 4 → 5 (generator writes through `PostgresCaseStore`)
- 4 → 6 (write-through uses `PostgresCaseStore`)
- 4 → 7 (binding routes through `PostgresCaseStore`)
- 4 → 8 (migration uses `PostgresCaseStore` connection)
- All → 9

## Final verification

- [ ] `npm run test` green (uses testcontainers for the DB)
- [ ] `npm run lint` clean
- [ ] Local dev connects to Cloud SQL Auth Proxy and runs queries
- [ ] Deployed Cloud Run revision connects to private-IP Cloud SQL and runs queries
- [ ] Existing CaseListScreen renders against the new binding
- [ ] No `TODO` / `FIXME` in `lib/case-store/`

## Plan shape

Plan 2 is heavier than the v1 in-memory plan because Cloud SQL provisioning and migration tooling are real concerns, but lighter on application code because there's only one implementation of every operator. The Postgres compiler from Plan 1 is the only evaluator — no parallel JS evaluator, no parity tests, no in-memory variant. Per-user / per-app isolation is `(app_id, owner_id)` columns, the same pattern every other domain table follows. The flipbook's running-app view operates on the same `cases` rows the editor inspects; "preview" is a UI word, not a technical layer.
