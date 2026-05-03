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
│   └── caseIndices.ts                # case_indices materialization (Option B: direct edges + recursive CTE)
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

### Task 0: Cloud SQL provisioning + connection pool — SHIPPED

SHIPPED 2026-05-03 against project `commcare-nova`. Two halves: infrastructure (provisioning + Cloud Run wire-up) per the runbook at `docs/superpowers/runbooks/2026-05-02-plan-2-task-0-cloud-sql-provisioning.md` and the record-of-truth script at `scripts/infra/provision-cloud-sql.sh`; code (connection layer) at `lib/case-store/postgres/connection.ts`.

**Infrastructure deliverable:**

- Cloud SQL instance `nova-cases` running Postgres 18 on tier `db-f1-micro` (ENTERPRISE edition — required explicit because the API defaulted to ENTERPRISE_PLUS, which rejects shared-core tiers), private IP `10.9.160.3` from the `/20` `google-managed-services-default` peering range at `10.9.160.0/20`, no public IP, IAM database authentication on, `max_connections=25`, daily backups + point-in-time recovery (4-day WAL retention, 7 retained backups), single-zone HA, US-Central1.
- Application database `nova_cases`.
- IAM bindings: `roles/cloudsql.client` + `roles/cloudsql.instanceUser` on the runtime SA `51003905459-compute@developer.gserviceaccount.com` and on `bperry@dimagi.com`.
- Database users: `51003905459-compute@developer` (CLOUD_IAM_SERVICE_ACCOUNT — Cloud SQL strips the `.gserviceaccount.com` suffix at create time and gcloud appends it internally for IAM token exchange) and `bperry@dimagi.com` (CLOUD_IAM_USER).
- Extensions installed and verified working via IAM-auth Cloud SQL Studio queries: `pg_trgm` 1.6, `fuzzystrmatch` 1.2, `postgis` (the postgres superuser was opened briefly via `gcloud sql users set-password ... --prompt-for-password` for the install + grants, then closed back with a fresh-random-unknown password the same way; no human knows the postgres password before, during, or after).
- Cloud Run service `commcare-nova` updated with Direct VPC Egress (`--network=default --subnet=default --vpc-egress=private-ranges-only`), `--max-instances=5`, and connection env vars `NOVA_DB_NAME=nova_cases`, `NOVA_DB_USER=51003905459-compute@developer`, `NOVA_DB_INSTANCE_CONNECTION_NAME=commcare-nova:us-central1:nova-cases`. Revision `commcare-nova-00101-jq4` serves 100% traffic.

Recurring cost: ~$10/mo (db-f1-micro compute ~$8/mo + 10GB SSD ~$1.70/mo + daily backups in us-central1, list price 2026).

**Code deliverable:** `lib/case-store/postgres/connection.ts` is a Kysely instance backed by `pg.Pool` with `max: 4` and `@google-cloud/cloud-sql-connector` (Google's canonical Node.js connector) wired via the pool's `stream` option. The connector's `getOptions({ instanceConnectionName, ipType: 'PRIVATE', authType: 'IAM' })` resolves the private IP via the SQL Admin API, owns certificate rotation and TLS handshake, and presents the runtime SA's identity via mTLS so Postgres skips password negotiation. Three required env vars (`NOVA_DB_NAME`, `NOVA_DB_USER`, `NOVA_DB_INSTANCE_CONNECTION_NAME`) — strict validation throws at module-init time naming any missing variable. Lazy singleton via `getCaseStoreDatabase()` (Next.js builds import without runtime env, so eager init would crash); SIGTERM-safe teardown via `closeCaseStoreDatabase()`. No local-dev fallback — Cloud Run is the only execution environment that talks to the live Cloud SQL.

**Pool sizing.** `pg.Pool` `max` × `Cloud Run --max-instances` ≤ Cloud SQL `max_connections − 5` (5 reserved for `postgres` / admin / replication). For our shape (`db-f1-micro` `max_connections=25`, Cloud Run `--max-instances=5`): `5 × 4 = 20 ≤ 25 − 5 = 20` exactly. The four numbers (`CLOUD_SQL_MAX_CONNECTIONS`, `CLOUD_SQL_RESERVED_CONNECTIONS`, `CLOUD_RUN_MAX_INSTANCES`, `POOL_MAX_PER_INSTANCE`) live as named exports; `enforceConnectionBudget()` runs eagerly at module load and throws if the math ever drifts inconsistent.

**Tier-up path.** `db-f1-micro` (~$10/mo, 25 conns) → `db-g1-small` (~$25/mo, 50 conns) → `db-custom-1-3840` (~$50/mo, 100 conns) → larger custom tiers. Each hop is one `gcloud sql instances patch --tier=...` command with brief downtime; no schema migration, no app code change. The pool/maxScale numbers re-tune at the same time.

**Why no local-dev DB connection.** `cloud-sql-proxy --private-ip` from a developer laptop does not work for `--no-assign-ip` instances (the proxy uses the Admin API for *auth* but makes a direct TCP connection to the IP, which from outside the VPC is unreachable). Ad-hoc DB inspection runs through Cloud SQL Studio in the Google Cloud Console, which routes queries via the Admin API plane and reaches private-IP-only instances without any local network setup. The runbook §P5-0 verified Studio works for our configuration.

**Connector pattern reconciliation (post-implementation cleanup).** The original draft of this SHIPPED block described a `google-auth-library` + manual-token-exchange pattern; the implementer correctly read the canonical Cloud SQL connector docs and adopted `@google-cloud/cloud-sql-connector` instead. The connector handles certificate rotation and IAM token refresh internally, eliminating the need for direct `google-auth-library` use in this file. As a second-order consequence, `NOVA_DB_HOST` (originally wired in Phase 6 to expose the captured private IP) was unused by the connector path and removed from Cloud Run's env in revision `00101-jq4`. The runbook + provision script reflect the reduced env-var set.

Commit chain: `afe6fa9e` (initial) → `65014221` (spec-review forward-projection strip) → `84c3b5dc` (CR fix-pass: untautological budget test + JSDoc accuracy) → `5431cf15` (NOVA_DB_HOST paragraph removal after env-var cleanup).

### Task 1: Migration tooling + initial schema

**Files:** `lib/case-store/migrations/0001_init.sql`, `0002_indices.sql`, migration runner script.

Adopt `kysely-migration-cli` (or equivalent) for schema migrations — runs migration SQL files in order, tracks applied migrations in a `kysely_migrations` table.

Initial migration (`0001_init.sql`) creates the four tables from the spec's "Storage layer for cases" section:
- `cases` with `(case_id UUID PRIMARY KEY DEFAULT uuidv7(), app_id, owner_id, case_type, status, opened_on, modified_on, closed_on, parent_case_id, properties JSONB)` plus per-spec indices. PG 18's native `uuidv7()` (added 2025-09-25 with PG 18.0) generates timestamp-prefixed UUIDs; case_ids issued in temporal order cluster on B-tree pages, so INSERTs touch fewer cold pages than `gen_random_uuid()` (uuidv4) would. Pagination by `(opened_on, case_id)` is naturally close-to-sorted because uuidv7's first 48 bits are the millisecond Unix timestamp. Cite: `https://www.postgresql.org/docs/18/functions-uuid.html`.
- `case_type_schemas` with `(app_id, case_type, schema JSONB)` PK `(app_id, case_type)`.
- `case_indices` with `(case_id, ancestor_id, identifier, relationship, depth)` plus `(ancestor_id, identifier)` and `(case_id, identifier)` indices.
- `cases_quarantine` with the same shape as `cases` plus `quarantine_reason TEXT`, `quarantined_at TIMESTAMPTZ`.

`owner_id` is the spec's per-user isolation key — every read filters by `owner_id = <session.user.id>` via a middleware layer in the `PostgresCaseStore` query path. Defense-in-depth via Postgres Row-Level Security policies in a later migration once the application-layer pattern is exercised.

**Migration runner runs as a Cloud Run job, not locally.** The original framing was "run migrations against local Cloud SQL Auth Proxy + against testcontainers Postgres in CI." The local-Auth-Proxy half does not work for our `--no-assign-ip` instance (see Task 0 § "Why no local-dev DB connection"). The migration runner is instead packaged as a Cloud Run job: a containerized command (Kysely migration runner + `0001_init.sql` + `0002_indices.sql`) deployed via `gcloud run jobs deploy db-migrate`, attached to the same `default` network/subnet as the main service with `--vpc-egress=private-ranges-only`. `npm run db:migrate` becomes "execute the deployed Cloud Run job." Authentication uses the same IAM token flow as `connection.ts`. CI runs the same migration code against the testcontainers Postgres harness directly (no Cloud Run job in CI — testcontainers runs in-process).

Steps:
- [ ] Add migration runner to `package.json` scripts (`db:migrate` invokes the deployed Cloud Run job; `db:rollback` and `db:status` invoke equivalent jobs)
- [ ] Write `0001_init.sql` per the spec schema
- [ ] Write `0002_indices.sql` for the per-spec indices
- [ ] Build a Cloud Run job image that runs the migration runner, deploy with Direct VPC Egress to `default`/`default`, IAM-auth as `51003905459-compute@developer` (the runtime SA database user)
- [ ] Run migrations against the deployed instance via the Cloud Run job; against testcontainers Postgres in CI directly
- [ ] Document the migration workflow in `lib/case-store/CLAUDE.md` (the Cloud Run job pattern + the testcontainers parallel)

### Task 2: Cloud SQL extension allowlist gate

**Files:** `scripts/check-postgres-extensions.ts`.

Run `gcloud sql instances describe ... --format='value(databaseFlags)'` and `SELECT * FROM pg_available_extensions WHERE name IN ('pg_trgm', 'fuzzystrmatch', 'postgis')` against the provisioned instance. Record availability in a generated TypeScript constant.

**Extensions Plan 1's compiler depends on (NON-OPTIONAL on the production Cloud SQL instance):**
- `pg_trgm` — `match` mode "fuzzy" / "starts-with" / "fuzzy-date" all emit `%` similarity; without `pg_trgm`, these queries fail at execution time. The harness installs it (verified at `lib/case-store/sql/__tests__/globalSetup.ts`); production parity is non-negotiable.
- `fuzzystrmatch` — `match` mode "phonetic" emits `dmetaphone(...)` calls; without it, the function does not exist.
- `postgis` — `within-distance` emits `ST_GeogFromText` and `ST_DWithin`; without `postgis`, neither function exists.

All three are on Cloud SQL's documented allowlist for PG 18 (per `https://cloud.google.com/sql/docs/postgres/extensions` and the Cloud SQL release notes confirming PostGIS 3.6.0 is bundled). The gate is a structural check that the provisioned instance hasn't been configured to disable any of them. If any is missing, the corresponding search modes / operators are unauthorable — Plan 4's search-input UI must reject those mode selections at construction time, OR the Cloud SQL instance must be re-provisioned with the extension enabled.

**Validation lives in TypeScript, not in Postgres.** Every `cases` write flows through `PostgresCaseStore.insert` / `.update` (Task 4), which validates the candidate `properties` payload against `case_type_schemas[appId, caseType].schema` via `lib/domain/predicate/jsonSchema.ts` + `ajv` before the row hits the database. The API route is the trust boundary; the database is internal. There is no in-database trigger and no `pg_jsonschema` extension dependency — Cloud SQL doesn't allowlist `pg_jsonschema`, and a hand-rolled PL/pgSQL JSON Schema implementation duplicating the TypeScript validator's behavior would just create a second validator to keep in sync. The single TypeScript validator is the single source of truth.

Steps:
- [ ] Write the extension-availability gate script
- [ ] Run against the provisioned Cloud SQL instance; record results
- [ ] If any of the three required extensions is missing, halt provisioning and re-provision with the extension enabled (do not proceed to Task 4 with a partial extension surface)

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
- `insert` validates against `case_type_schemas[appId, caseType].schema` (TS-side via Plan 1's JSON Schema generator), then INSERTs the row (case_id defaulted via Postgres's `uuidv7()` when not supplied — see Task 1's schema for the rationale), captures the generated case_id through `RETURNING case_id`, then derives `case_indices` direct edges from `parent_case_id` + property-level relations against the captured id.
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
- The Cloud SQL extension allowlist gate (Task 2) — required extensions, what halts provisioning if any is missing.
- Why validation lives in TypeScript, not in Postgres triggers: `lib/domain/predicate/jsonSchema.ts` + `ajv` at the API-route trust boundary; no `pg_jsonschema` (Cloud SQL doesn't allowlist it) and no PL/pgSQL fallback (would duplicate the TS validator's logic).

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
