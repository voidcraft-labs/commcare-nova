# Case Data Layer Implementation Plan (Plan 2 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Plan 2 of 5. Depends on Plan 1 (Foundation) — needs the Predicate AST, Expression AST, JSON Schema generator, and the Postgres compiler. Does NOT need Plans 3-5.

**Goal:** Stand up Cloud SQL Postgres as the live runtime for case data, with the `CaseStore` interface that case-list authoring (Plan 3), search authoring (Plan 4), and the running-app view (Plan 5) consume. Replace the existing `lib/preview/engine/dummyData.ts` with a typed `CaseStore`-backed flow that handles forms (registration / followup / close) writing through the same interface as auto-generated sample data.

**Architecture summary:** One interface (`CaseStore`) with one implementation (`PostgresCaseStore`). The AST→Kysely compiler from Plan 1 IS the evaluator — there is no parallel JS evaluator, no parity tests, no in-memory variant. Per-user / per-app isolation uses `(app_id, owner_id)` columns on the `cases` table — same pattern every other domain table follows. `HeuristicCaseGenerator` writes through `PostgresCaseStore.insert` so generated rows are real rows. The flipbook UI's running-app view operates on the same `cases` rows the editor inspects; sample-data generation is a user action ("Generate sample data" / "Reset sample data" buttons), not a mode switch.

**Tech Stack:** TypeScript (strict), Kysely (typed SQL builder), Cloud SQL for PostgreSQL, testcontainers (for CI / local tests), Vitest. Plan 1's Postgres compiler is exercised at runtime here.

---

## Per-property expression indexes — the perf discipline the foundation surfaces

Plan 1's compiler emits semantically correct SQL for every operator (verified by harness round-trips on the foundation), but Postgres performance for several operators depends on dedicated expression indexes per searchable property:

| Search operator (Plan 1 emission) | Required Postgres index DDL shape |
|---|---|
| `match(prop, "...", mode: "fuzzy")` → `(properties->>'<key>')::text % '...'` | `CREATE INDEX <name> ON cases USING GIN ((properties->>'<key>') gin_trgm_ops) WHERE case_type = '<type>'` |
| `match(prop, "...", mode: "starts-with")` → `(properties->>'<key>')::text LIKE '...%'` | Same GIN trgm index covers prefix search via planner-recognised LIKE patterns |
| `match(prop, "...", mode: "fuzzy-date")` → permutation IN-list | Same GIN trgm index covers the IN-list candidate lookup |
| `match(prop, "...", mode: "phonetic")` → `dmetaphone((properties->>'<key>')) = dmetaphone('...')` | No useful index — phonetic match is genuinely O(n). Document the perf characteristic; recommend authors avoid phonetic on large case-types |
| `compare`/`between` on `int`/`decimal` props → `((properties->>'<key>')::int) <op> <value>` | `CREATE INDEX <name> ON cases USING BTREE (((properties->>'<key>')::int)) WHERE case_type = '<type>'` (cast type matches `POSTGRES_CAST_FOR_DATA_TYPE`) |
| `compare`/`between` on `date`/`datetime`/`time` props → typed cast comparison | `CREATE INDEX <name> ON cases USING BTREE (((properties->>'<key>')::date)) WHERE case_type = '<type>'` (or `::timestamptz` / `::time`) |
| `multi-select-contains(prop, ...)` quantifier=any/all → JSONB `?\|` / `?&` / `@>` | `CREATE INDEX <name> ON cases USING GIN ((properties->'<key>') jsonb_path_ops) WHERE case_type = '<type>'` (`->` not `->>` because the operators consume JSONB, not text) |
| `within-distance(prop, ...)` → `ST_DWithin(ST_GeogFromText(properties->>'<key>'), ...)` | `CREATE INDEX <name> ON cases USING GIST (ST_GeogFromText(properties->>'<key>')) WHERE case_type = '<type>'` |
| `is-null(prop)` / `is-blank(prop)` → JSONB `?` key existence | Covered by an explicit JSONB-keys GIN index per case-type if absence checks dominate; otherwise the seq-scan cost is acceptable |

The foundation does NOT and CANNOT provision these — the property name is dynamic per blueprint, and the searched mode is dynamic per Plan 4 search-input config. Plan 2's `applySchemaChange` (Task 8) is the structural owner: it reads the union of (case-type properties × search inputs that target them × modes from Plan 4 + sort keys + filter operators) from the blueprint and emits the matching expression-index DDL alongside the JSON Schema regen, in the same transaction.

Without the matching index, the operator still emits correct SQL — just as a sequential scan. At 100 cases per case-type: imperceptible. At 10,000: visible lag. At 1,000,000: broken UX. The discipline is structural: every searchable property + searched mode pair gets its expression index automatically, no author opt-in required, no "tune indexes later" deferral.

**Migration discipline:** when the blueprint mutates in a way that affects the index surface (property rename, retype, removal, search-input-mode change, search-input-target-property change, search-input `via`-walk change), `applySchemaChange` runs the index DDL changes in the SAME transaction as the JSON Schema regen and per-row migration. Old expression indexes get dropped, new ones get created. The transaction commits when all halves succeed or rolls back atomically. The database never holds a state where a search input references an unindexed property.

**Relation-walk targeting:** a `SearchInputDef.via` walk (Plan 3 Task 1 schema) means the input filters cases reached by walking the relation path, NOT the module's case-type. The index lands on the destination case-type the walk reaches, not the originating case-type. Naming convention: `cases_<destination_case_type>_<property>_<mode>` so a patient-module input searching the household's name produces `cases_household_name_fuzzy` (one index covering all patient-module searches that walk to household). The `WHERE case_type = '<destination>'` partial-index predicate keeps the index scoped to the destination case-type's rows, sharing across all modules that walk to that destination.

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

**Extensions Plan 1's compiler depends on (NON-OPTIONAL on the production Cloud SQL instance):**
- `pg_trgm` — `match` mode "fuzzy" / "starts-with" / "fuzzy-date" all emit `%` similarity; without `pg_trgm`, these queries fail at execution time. The harness installs it (verified at `lib/case-store/sql/__tests__/globalSetup.ts`); production parity is non-negotiable.
- `fuzzystrmatch` — `match` mode "phonetic" emits `dmetaphone(...)` calls; without it, the function does not exist.
- `postgis` — `within-distance` emits `ST_GeogFromText` and `ST_DWithin`; without `postgis`, neither function exists.

If any of the three is unavailable on the provisioned Cloud SQL instance, the corresponding search modes / operators are unauthorable — Plan 4's search-input UI must reject those mode selections at construction time, OR the Cloud SQL instance must be re-provisioned with the extension enabled. Cloud SQL's documented allowlist (per `https://cloud.google.com/sql/docs/postgres/extensions`) includes all three at the time of writing.

`pg_jsonschema` is the one extension that's allowlist-gated and may genuinely be unavailable; the trigger has a documented PL/pgSQL fallback.

If `pg_jsonschema` is available: deploy `triggers/jsonSchemaValidator.sql` as the BEFORE INSERT/UPDATE trigger on `cases`.
If not: deploy `triggers/plpgsqlValidator.sql` (a PL/pgSQL implementation that walks the JSON Schema row from `case_type_schemas` against the candidate `properties` value). Architecture identical from the application's perspective; performance differs.

Either way, the trigger is defense-in-depth — the application's `PostgresCaseStore.insert` / `.update` path validates against the same JSON Schema in TypeScript before every write. The trigger catches anything that bypasses the application layer (direct SQL, future bulk imports, replication tooling).

Steps:
- [ ] Write the extension-availability gate script
- [ ] Run against the provisioned Cloud SQL instance; record results
- [ ] Pick the trigger SQL based on the gate result; deploy via migration `0003_validate_trigger.sql`
- [ ] Test: `INSERT INTO cases ... { invalid }` raises EXCEPTION

### Task 3: `CaseStore` interface + `withOwnerContext` factory

**Files:** `lib/case-store/store.ts`, `lib/case-store/withOwnerContext.ts`, tests via the interface-compliance harness.

Define the single seam used by every consumer. Methods (matching the spec's canonical interface block):
- `query(args: { appId, caseType, predicate?, sort?, limit?, offset? }): Promise<CaseRow[]>`
- `insert(args: { appId, row }): Promise<void>`
- `update(args: { appId, caseId, patch }): Promise<void>`
- `close(args: { appId, caseId }): Promise<void>`
- `traverse(args: { appId, caseId, via }): Promise<CaseRow[]>`
- `applySchemaChange(args: { appId, caseType, blueprint, property?, change? }): Promise<MigrationReport>` — atomic schema sync + per-property index DDL diff + per-row migration in a single Postgres transaction. **The `blueprint: BlueprintDoc` parameter is required** so the function derives the prospective JSON Schema + index set from a caller-supplied snapshot rather than re-fetching from Firestore. This shape is the foundation for the cross-store saga pattern (Plan 3 Task 1): the blueprint mutator passes the prospective state into `applySchemaChange`, commits Firestore on success, and runs a compensating `applySchemaChange(previousBlueprintState)` on Firestore-commit failure. With no `property` / `change`: regenerates the JSON Schema, upserts `case_type_schemas`, and diffs/applies the per-property expression-index DDL set (the additive-blueprint-mutation path). With `property` + `change`: runs schema sync + index DDL diff + the rename / retype / narrow-options migration in the same transaction; rows that fail the new schema move to `cases_quarantine` with the original value + failure reason. The transaction commits when all three halves succeed or rolls back atomically — the database never holds a new schema with rows that fail validation against it AND never holds a search input that references an unindexed property.
- `generateSampleData(args: { appId, caseType, count, seed }): Promise<{ inserted: number }>` — calls `HeuristicCaseGenerator` and routes the rows through `insert`.
- `resetSampleData(args: { appId, caseType }): Promise<{ deleted: number; inserted: number }>` — deletes existing rows for the case-type, then re-generates with a fresh seed.

`MigrationReport` includes counts of migrated / quarantined / skipped rows plus per-row failure reasons.

**`withOwnerContext` factory** — `lib/case-store/withOwnerContext.ts` exposes `withOwnerContext(userId: string): CaseStore`. There is **no** other constructor. Every `CaseStore` instance carries an owner id resolved at the request boundary; every method internally adds `WHERE owner_id = <bound userId>` to the underlying query. Tenant scoping is structural, not by discipline — it is impossible to construct a `CaseStore` instance that bypasses the owner-id filter, and any new method on the interface inherits the filter automatically.

Request-boundary integration: in API routes, the factory is called once per request from `session.user.id` (resolved via Better Auth) and the resulting `CaseStore` is passed down to handlers. Handlers receive a tenant-scoped store, never construct one themselves. The factory pattern is the migration anchor for future stricter-isolation models — switching to schema-per-tenant or database-per-tenant means changing the factory's connection routing logic, with no application-code rewrite.

The interface is one shape; `PostgresCaseStore` is the only implementation. No "InMemory" variant; no parity tests across implementations.

### Task 4: `PostgresCaseStore` implementation

**Files:** `lib/case-store/postgres/store.ts`, `queryCompile.ts`, `caseIndices.ts`, tests.

Implements `CaseStore` against the Kysely instance from Task 0:
- `query` invokes Plan 1's Kysely predicate/expression compiler to build the SELECT, applies sort / limit / offset, executes against the `cases` table filtered by `(app_id, owner_id)`. **Compiler invocation contract:** the outer query owns the `(app_id, owner_id)` filter on `cases as c` (the foundation's `compileRelationPath` only enforces the filter on JOIN-ed `cases` rows inside relation walks, NOT on the outer scan — `withOwnerContext` is the structural anchor for the outer filter). When invoking `compileExpression` for calculated columns / sort expressions, supply `compilePredicate: (pred, ctx) => compilePredicate(pred, ctx)` on the `ExpressionCompileContext` so the cycle-break callback wires the `if` / `switch` / `count(via, where)` arms back through the predicate compiler. The outermost call site uses `relationPathDepth: 0` (or omits the field; the default is 0); the foundation's compiler increments it automatically when recursing into nested relation walks.
- `insert` validates against `case_type_schemas[appId, caseType].schema` (TS-side via Plan 1's JSON Schema generator), then INSERTs the row, then derives `case_indices` direct edges from `parent_case_id` + property-level relations.
- `update` does a JSONB merge on `properties` (full-row replacement per the spec's JSONB-write-bloat mitigation), updates `modified_on`, re-derives `case_indices` if the relation surface changed.
- `close` updates `closed_on`, `status`, no row deletion.
- `traverse` compiles the RelationPath via Plan 1's relation-path compiler (Task C5) into a recursive CTE; runs against `case_indices`.
- `applySchemaChange` opens a Postgres transaction, regenerates the JSON Schema via Plan 1's generator + UPSERTs `case_type_schemas`, drops/creates per-property expression indexes per the index-DDL discipline section above, then (when `property` + `change` are present) runs the rename / retype / narrow-options migration in the same transaction. Rows that fail the new schema move to `cases_quarantine`. The transaction commits when ALL halves succeed or rolls back atomically.

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

### Task 7: Route running-app screens through `caseDataBinding`; delete `dummyData.ts` + existing preview screens

**Files:**
- New: `lib/preview/engine/caseDataBinding.ts`
- Delete: `lib/preview/engine/dummyData.ts`
- Delete or refactor: `components/preview/screens/CaseListScreen.tsx`, `components/preview/screens/FormScreen.tsx` (existing screens that consume `getDummyCases` / `getCaseData`)
- New: `components/builder/preview/{android,web}/CaseListScreen.tsx` come from Plan 5 — Task 7's job is the binding layer + ensuring no consumer is left referencing `getDummyCases` after `dummyData.ts` is gone.

`caseDataBinding.ts` exposes `getCases(caseTypeName)` / `getCaseData(caseTypeName, caseId)` routed through `PostgresCaseStore` via `withOwnerContext(session.user.id)`. The shape matches what `dummyData.ts` exposed today so the migration is mechanical at every call site.

Sweep + cutover (single commit):
1. Implement `caseDataBinding.ts`.
2. Update every import of `getDummyCases` / `getCaseData` to import from `caseDataBinding` instead. Grep `rg "from .*dummyData|getDummyCases|getCaseData"` to find every site; expected sites are `components/preview/screens/*` and any other consumer.
3. Decide per existing screen: if Plan 5's new `components/builder/preview/{android,web}/CaseListScreen.tsx` supersedes it, delete the old screen in this commit; if not, refactor the old screen to import from the new binding. The end state is **no surviving import of `dummyData.ts`** anywhere in the tree.
4. Delete `lib/preview/engine/dummyData.ts`.
5. Run the full test suite + a smoke render of the case-list screen against testcontainers Postgres.

For empty case-types (no rows yet), the binding surfaces a "Generate sample data" affordance to the running-app view — clicking it invokes `CaseStore.generateSampleData`. The flipbook is "always in valid state": no error state when the case-type is empty, just a button to populate it.

Tests: every former-`dummyData.ts` consumer renders correctly through the new binding; empty-case-type renders the "Generate sample data" affordance; no surviving import of `dummyData.ts`.

### Task 8: `applySchemaChange` implementation

**Files:** `lib/case-store/postgres/applySchemaChange.ts`, tests.

Implements `CaseStore.applySchemaChange`. Single Postgres transaction wraps THREE halves:

1. **Schema sync** (always runs): regenerate the JSON Schema via Plan 1's generator from the current blueprint state for `(appId, caseType)`; UPSERT into `case_type_schemas`.
2. **Per-property expression-index DDL emission** (always runs): read the union of (case-type properties × search inputs that target them × modes × sort keys × filter operators) from the current blueprint state. Compute the desired index set per the discipline table at the top of this plan. Compare against `pg_indexes` for the case-type's existing per-property indexes; emit `DROP INDEX` / `CREATE INDEX` statements for the diff. The index naming convention pins each index to its `(case_type, property, mode)` tuple so the diff is mechanical (e.g. `cases_<case_type>_<property>_<mode>`). Property rename: drops the index on the old extraction path, creates the index on the new one. Property removal: drops the index. Search-input mode change: drops the old-mode index, creates the new-mode index. The DDL runs INSIDE the transaction so the index state matches the schema state atomically.
3. **Per-row migration** (runs when `property` + `change` are present): for each row in the case-type, apply the change shape:
   - `rename(from, to)` — `UPDATE cases SET properties = jsonb_set(properties #- '{from}', '{to}', properties->'from')` for every row.
   - `retype(fromType, toType)` — for each row, attempt to cast the value per the spec's "Schema migration policy" table. On success: `UPDATE cases SET properties = jsonb_set(...)`. On failure: move to `cases_quarantine` with `quarantine_reason` set to the cast-failure detail.
   - `narrow-options(removedOptions)` — for each row whose property value is in `removedOptions`, move to `cases_quarantine`.

The transaction commits when ALL THREE halves succeed, rolls back atomically on failure. The database never holds a new schema with rows that fail validation against it, AND it never holds a search input that references an unindexed property. This is the structural backstop for the "apps are always in a valid state" principle at the storage layer.

Tests: each change shape against fixtures; index DDL diff produces the right `CREATE` / `DROP` set for representative blueprint mutations (property add / remove / rename / retype / search-input mode change); rollback verified by simulating a mid-migration failure (the schema row + the new indexes should not be present after rollback); quarantine surfacing; no-property-no-change call runs schema sync + index DDL sync (without per-row migration).

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
