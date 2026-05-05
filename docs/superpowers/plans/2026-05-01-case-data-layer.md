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
├── withOwnerContext.ts               # the only constructor; binds owner_id at the request boundary
├── postgres/
│   ├── store.ts                      # PostgresCaseStore — wraps the Kysely DB; owns query / insert / update / close / traverse / applySchemaChange
│   ├── connection.ts                 # Cloud SQL connection pool via @google-cloud/cloud-sql-connector
│   └── __tests__/
│       └── store.test.ts             # concrete runner that wires the contract harness against per-test isolated DBs
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
├── migrations/                       # schema migrations — see lib/case-store/CLAUDE.md "Migrations" for the migration workflow
└── __tests__/
    └── storeContract.ts              # implementation-agnostic CaseStore contract harness (14 tests)

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

### Task 1: Migration tooling + initial schema — SHIPPED (Atlas rework)

SHIPPED 2026-05-05 with Atlas owning schema-as-code and migration application. The original (2026-05-03) Kysely-migration-runner-via-Cloud-Run-job design was reworked end-to-end: the runner, the Cloud Run job, the deployment scripts, and the custom Dockerfile all deleted; Atlas runs at Cloud Run startup against the same private-IP Cloud SQL instance the application talks to. Rationale: the Kysely path required two custom Dockerfiles, a deploy-then-execute script pair, a 245-line runner wrapping Kysely's stock `Migrator`, and hand-written TS migrations that didn't autogenerate from a schema source. Atlas autogenerates, ships in the existing Next.js image via a multi-stage `arigaio/atlas` digest pin, and runs at every Cloud Run revision startup. The destructive-change story is gated by Atlas's `diff { skip }` policy (auto-skips DROP statements at diff generation) plus `lint { destructive { error = true } }` (CI/lefthook fails on any manually-authored destructive migration); expand-contract is the only path to drop columns/tables.

**Files shipped:**

- `atlas.hcl` (repo root) — three envs:
  - `local` for `atlas migrate diff` against an Atlas-booted Postgres dev container.
  - `testcontainer` for the test harness's `atlas migrate apply --url <uri>` shell-out.
  - `prod` for the Cloud Run startup CMD; reads `NOVA_DB_USER` / `NOVA_DB_HOST` / `NOVA_DB_NAME` via `getenv()`, IAM-auth via the `gcp_cloudsql_token` data source. `NOVA_DB_USER` and the IAM token are both `urlescape`'d for RFC 3986 compliance.
  - `locals.dev_url` shared between `local` and `testcontainer` envs: inline `docker+postgres://imresamu/postgis:18-3.6.1-alpine3.23/dev?search_path=public` (matches the testcontainer harness image; community-edition Atlas — the Pro `docker { ... }` block was tested empirically and rejected with `Unsupported attribute`).
  - Diff policy auto-skips destructive (`drop_schema`, `drop_table`, `drop_column`); lint policy errors on destructive in CI.
- `lib/case-store/schema.sql` — single raw-DDL source of truth for the four case-store tables (`cases`, `case_type_schemas`, `case_indices`, `cases_quarantine`) plus the two static `case_indices` indexes. Spec citations per column (lines 254-284 + 309-340). `case_id` defaults to `uuidv7()` per PG 18's built-in v7 generator. The deleted Kysely TS migrations' per-column rationale carries forward as SQL comments.
- `lib/case-store/migrations/20260505152732_baseline.sql` — autogenerated by `atlas migrate diff baseline --env local`. 6 SQL statements (4 CREATE TABLE + 2 CREATE INDEX). Schema-equivalence verified at Checkpoint 1 against `pg_dump` output of the deleted `0001_init.ts` + `0002_indices.ts` migrations applied to a parallel testcontainer.
- `lib/case-store/migrations/atlas.sum` — autogenerated directory-integrity hash file.
- `Dockerfile` (root, modified) — adds a multi-stage `FROM arigaio/atlas@sha256:6d34257110be...` (digest-pinned per the supply-chain rationale below). The runner stage `COPY --from=atlas-binary /atlas /usr/local/bin/atlas` plus the migration directory and `atlas.hcl`. CMD swapped to `sh -c "atlas migrate apply --env prod --allow-dirty && exec node server.js"`. The `--allow-dirty` flag suppresses Atlas's empty-DB precondition (production has the postgis-managed `tiger`/`topology` schemas pre-installed); it doesn't affect the `atlas_schema_revisions` ledger as the version source. `exec node` ensures SIGTERM propagates to Node for graceful shutdown.
- `lib/case-store/sql/__tests__/globalSetup.ts` (modified) — replaces `runMigration(db, "latest")` with a `child_process.spawnSync("atlas", ["migrate", "apply", "--env", "testcontainer", "--url", uri, "--allow-dirty"])` shell-out. The harness still installs the three required Postgres extensions as the container's superuser before atlas runs.
- `lib/case-store/sql/__tests__/applyMigrations.ts` — extracted helper used by both `globalSetup.ts` and `postgres/__tests__/store.test.ts`'s per-test database setup. Single source for the atlas-shellout error handling (ENOENT surfaces as a CI prereq message; non-zero exit includes captured stdout/stderr).
- `lib/case-store/CLAUDE.md` (rewritten "Migrations" section) — documents the atlas authoring workflow, the destructive-change expand-contract pattern, the Cloud Run startup CMD, the testcontainers shell-out, the install instructions including the macOS 26 CLT brew-fallback path. Adds a "Checking prod migration state" subsection with two canonical paths: `gcloud logging read` for the most recent apply log + an `atlas_schema_revisions` ledger query via Cloud SQL Studio.
- `package.json` (modified) — net `-6 / +2`: removes `db:migrate`, `db:migrate:deploy`, `db:rollback`, `db:status`, `db:check-extensions`, `db:check-extensions:deploy` (laptop can't reach private-IP prod, so prod-targeting npm scripts always fail); adds `db:diff` (`atlas migrate diff --env local`) and `db:lint` (`atlas migrate lint --env local --latest 1`).
- `lefthook.yml` (modified) — adds `atlas-migrate-lint` to pre-commit, scoped to the `lib/case-store/migrations/*.sql` glob. Destructive changes that bypass Atlas's diff-skip (e.g., manually-authored migrations) fail at commit time.
- `.dockerignore` (modified) — drops the `!scripts/migrate` and `!scripts/check-extensions` allowlist exceptions (no longer needed); adds nothing (atlas.hcl, schema.sql, and the migrations directory aren't blocked by other rules).
- `~/.claude/skills/atlas/SKILL.md` + `~/.claude/skills/atlas/references/schema-sources.md` — Atlas Claude Code skill (Option 2 from atlasgo.io's published guide). Auto-loads when Claude Code touches atlas-related paths.

**Files deleted (also covered in Task 2 below; listed once here for completeness):**

`lib/case-store/migrations/0001_init.ts`, `0002_indices.ts`, `runner.ts`, `__tests__/runner.test.ts`, `package.json`; `Dockerfile.migrate`; `scripts/migrate/run.ts`, `deploy-job.sh`, `execute-job.sh`, `package.json`.

**`uuidv7()` adoption:** unchanged from the original SHIPPED block — PG 18's native `uuidv7()` generates timestamp-prefixed UUIDs that cluster on B-tree pages. `case_id`'s default is `uuidv7()`; verified runtime via per-test inserts that omit `case_id` and assert the returned value matches the RFC 9562 v7 regex.

**Cloud Run runtime adjustments approved for the rework:**

1. **`NOVA_DB_HOST=10.9.160.3` re-added** to the Cloud Run env (revision `commcare-nova-00102-njr`). Atlas (Go binary) doesn't have access to `@google-cloud/cloud-sql-connector` (Node lib) and requires a real `host:port` URL. The Node app continues to ignore `NOVA_DB_HOST` and resolve via `NOVA_DB_INSTANCE_CONNECTION_NAME`; both consumers coexist in the same container.
2. **`arigaio/atlas` digest-pinned** (`@sha256:6d34257110be...`) for supply-chain integrity. Atlas runs at startup with the runtime SA's IAM credentials; an attacker compromising arigaio's dockerhub account could push a malicious `:latest` tag and our next deploy would pull it. Digest pinning blocks that. Rotation policy: bump the digest when atlas releases a new minor version OR quarterly, whichever comes first. Mirrors the supply-chain framing the testcontainers harness already uses for its postgis image.
3. **Community-edition Atlas binary** (not Pro). Pro requires `atlas login` + paid account on every invocation; community covers everything we need (`migrate diff`, `migrate apply`, `migrate lint`, `migrate validate`). The Pro-only `docker "postgres" "dev"` block was tested empirically and rejected — the community path uses an inline `docker+postgres://...` URL via `locals.dev_url`.
4. **No baseline extension installs** in the dev container. `schema.sql` references no extension types/functions today (PostGIS is used only at query time for `ST_DWithin`). If a future schema.sql adds a `geometry`/`tsvector` column, the atlasgo.io `composite_schema` data source is the canonical community-edition path; documented as a present-tense future-need note in atlas.hcl.

**Cutover verification:** Checkpoint 2 confirmed `nova_cases` was empty before deploy via two confirming signals: (a) `gcloud run jobs list --region=us-central1` showed only `check-postgres-extensions` (the obsolete `db-migrate` job from the original design was never deployed), (b) zero application call sites for `getCaseStoreDatabase()` across `app/` and `lib/`. Production deploys via the existing Cloud Build trigger `rmgpgab-commcare-nova-us-central1-voidcraft-labs-commcare-nozhs` (fires on push to `^main$`); the new revision's startup CMD applies the baseline migration before serving traffic.

**Commit chain (rework):**
- `112ed975` — `feat(case-store): atlas owns schema + migrations; runs at Cloud Run startup`
- `199a9f7d` — `refactor(case-store): delete obsolete migration runner + check-extensions infrastructure`
- `135f4702` — `refactor(case-store): code-review fix-pass on Plan 2 Tasks 1+2 rework`

Original (superseded) commit chain captured for archeology: `1e554960` → `664faae8` → `6fafe247` → `33b211bc`.

### Task 2: Cleanup of obsolete extension-verification surface — SHIPPED (Atlas rework)

SHIPPED 2026-05-05 alongside Task 1's rework. The original (2026-05-03) Cloud Run job design — a `verifyExtensions` function plus a `db-check-extensions` Cloud Run job that ran as an explicit pre-flight gate — gets replaced by Atlas's startup-application semantic: the first compiler-emitted query against a missing extension fails fast at runtime with `function does not exist` or `operator does not exist`. Same halt-if-missing structural enforcement, no separate verification surface. Extensions are installed once at provisioning time per the Task 0 runbook §Phase 5; the testcontainer harness installs the same set via its container superuser before atlas runs. The production parity invariant the original Task 2 protected lives in those two places, not in a separate Cloud Run job.

**Files deleted (this task + Task 1's deletions land in commit `199a9f7d`):**

- `lib/case-store/postgres/checkExtensions.ts`
- `lib/case-store/postgres/__tests__/checkExtensions.test.ts`
- `lib/case-store/postgres/package.json` (the nodenext ESM scoping shim — no longer needed; `connection.ts` doesn't require it post-cleanup, verified via `npm run typecheck` clean)
- `scripts/check-extensions/run.ts`, `deploy-job.sh`, `execute-job.sh`, `package.json`
- `Dockerfile.check-extensions`

**Files retained (explicit retention — original Task 2 listed these for deletion):**

- `lib/case-store/sql/__tests__/perTestDatabase.ts` STAYS. Original consumers (`runner.test.ts` and `checkExtensions.test.ts`) go away with this rework, but Tasks 3+4 (shipped at SHA `b9a264dc`) introduced a third consumer: `lib/case-store/postgres/__tests__/store.test.ts` imports `setupPerTestDatabase` for `db.transaction()`-using methods that nest `BEGIN` (Postgres rejects nested BEGIN inside the harness's outer BEGIN/ROLLBACK). The helper's responsibility — per-test isolated database via `CREATE DATABASE` + `DROP DATABASE` — is independently useful for the case-store contract suite. The `extensionsToInstall` parameterization that existed for the deleted gate test is removed; default extension install is now non-configurable.

**GCP-side artifacts deleted:**

- Cloud Run job `check-postgres-extensions` (was the only deployed job from the original design — `db-migrate` was never deployed): `gcloud run jobs delete check-postgres-extensions --region=us-central1 --quiet`.
- Artifact Registry image: `gcloud artifacts docker images delete us-central1-docker.pkg.dev/commcare-nova/cloud-run-source-deploy/check-postgres-extensions --delete-tags --quiet`.

Verified: `gcloud run jobs list --region=us-central1` returns 0 items; `gcloud artifacts docker images list us-central1-docker.pkg.dev/commcare-nova/cloud-run-source-deploy --include-tags` shows only the main `commcare-nova/commcare-nova` repository.

**Extensions Plan 1's compiler depends on (NON-OPTIONAL on the production Cloud SQL instance):** unchanged from the original SHIPPED block — `pg_trgm` (fuzzy match `%` similarity), `fuzzystrmatch` (phonetic `dmetaphone`), `postgis` (`ST_GeogFromText` + `ST_DWithin`). All three on Cloud SQL's documented allowlist for PG 18; installed at provisioning time per runbook §Phase 5; verified live (Phase 5 P5-D smoke queries returned the expected values from each extension).

**Validation lives in TypeScript, not in Postgres** — unchanged from the original SHIPPED block. AJV at the API trust boundary; no in-database trigger; no `pg_jsonschema` dependency.

**Commit chain:** `199a9f7d` (deletion sweep, shared with Task 1) and `135f4702` (fix-pass that resolved the dead `extensionsToInstall` API on `setupPerTestDatabase`).

Original (superseded) commit chain captured for archeology: `f03b6e72` (initial Task 2) → `8f4f952c` (CR fix-pass extracting shared helper).

### Task 3: `CaseStore` interface + `withOwnerContext` factory — SHIPPED

SHIPPED 2026-05-03 with Task 4 in commits `b9a264dc` (feat) → `f740cf9d` (spec-review fix-pass) → `e6751e51` (code-review fix-pass) on branch `feat/case-list-search`. The combined commit pair was structurally necessary because `withOwnerContext` directly references `PostgresCaseStore`; Task 3's factory and Task 4's class share a file-level cycle that cannot be split into two implementer rounds.

**Files:** `lib/case-store/store.ts`, `lib/case-store/withOwnerContext.ts`, `lib/case-store/__tests__/storeContract.ts` (interface-compliance harness — 14 contract tests).

Define the single seam used by every consumer. Methods:
- `query(args: { appId, caseType, predicate?, sort?, limit?, offset?, blueprint? }): Promise<CaseRow[]>` — `blueprint?: BlueprintDoc` carries the snapshot needed for property-typed predicate compilation; predicate-free queries omit it.
- `insert(args: { appId, row }): Promise<{ caseId: string }>` — returns the generated `case_id` so callers don't need a follow-up SELECT.
- `update(args: { appId, caseId, patch }): Promise<void>` — `CaseUpdate` omits `app_id`, `owner_id`, and `case_id` from the patch shape (the row identity columns can't be patched).
- `close(args: { appId, caseId, status? }): Promise<void>` — optional `status` writes the closure reason alongside `closed_on`.
- `traverse(args: { appId, caseId, via }): Promise<CaseRow[]>`
- `applySchemaChange(args: { appId, caseType, blueprint, property?, change? }): Promise<MigrationReport>` — atomic schema sync + per-row migration in a single Postgres transaction. **The `blueprint: BlueprintDoc` parameter is required** so the function derives the prospective JSON Schema from a caller-supplied snapshot rather than re-fetching from Firestore. The blueprint mutator (Plan 3 Task 1) passes the prospective state into `applySchemaChange`, commits Firestore on success, and runs a compensating call on Firestore-commit failure. With no `property` / `change`: regenerates the JSON Schema, upserts `case_type_schemas`. With `property` + `change`: runs schema sync + the rename / retype / narrow-options migration in the same transaction; rows that fail the new schema move to `cases_quarantine` with the original value + failure reason. Per-property expression-index DDL emission lands inside the same transaction in Task 8.

`MigrationReport` includes counts of migrated / quarantined / skipped rows plus per-row failure reasons. `runRenameMigration` pre-counts the case-type's full row population inside the transaction to surface the real `skipped` count (rows lacking the `from` key).

**`withOwnerContext` factory** — `lib/case-store/withOwnerContext.ts` exposes `withOwnerContext(userId: string): Promise<CaseStore>`. The factory is async because `getCaseStoreDatabase()` is a lazy singleton (Task 0's connection layer). There is **no** other constructor. Every `CaseStore` instance carries an owner id resolved at the request boundary; every method internally adds `WHERE owner_id = <bound userId>` to the underlying query. Tenant scoping is structural, not by discipline — it is impossible to construct a `CaseStore` instance that bypasses the owner-id filter, and any new method on the interface inherits the filter automatically.

Request-boundary integration: in API routes, the factory is awaited once per request from `session.user.id` (resolved via Better Auth) and the resulting `CaseStore` is passed down to handlers. Handlers receive a tenant-scoped store, never construct one themselves. Centralizing connection routing in one file means changes to the routing strategy don't ripple across application code.

The interface is one shape; `PostgresCaseStore` is the only implementation. No "InMemory" variant; no parity tests across implementations.

**Sample-data methods are not on the interface in this task.** `generateSampleData` and `resetSampleData` ship in Task 5 alongside `HeuristicCaseGenerator` — adding throwing stubs in Task 3 was forward-projection that the code-review caught and removed.

### Task 4: `PostgresCaseStore` implementation — SHIPPED

SHIPPED 2026-05-03 with Task 3 in commits `b9a264dc` (feat) → `f740cf9d` (spec-review fix-pass) → `e6751e51` (code-review fix-pass).

**Files:** `lib/case-store/postgres/store.ts`, `lib/case-store/postgres/__tests__/store.test.ts` (concrete runner that wires the contract harness against per-test isolated DBs).

Implements `CaseStore` against the Kysely instance from Task 0:
- `query` invokes Plan 1's Kysely predicate/expression compiler to build the SELECT, applies sort / limit / offset, executes against the `cases` table filtered by `(app_id, owner_id)`. **Compiler invocation contract:** the outer query owns the `(app_id, owner_id)` filter on `cases as c` (`compileRelationPath` enforces the filter on JOIN-ed `cases` rows inside relation walks, NOT on the outer scan — `withOwnerContext` is the structural anchor for the outer filter). The query method uses `expressionContextFor(ctx)` from `lib/case-store/sql` to derive the `ExpressionCompileContext` for calculated columns / sort expressions; the helper was promoted from package-internal to barrel-exported in this task (CR finding C8). The outermost call site uses `relationPathDepth: 0` by default; the foundation's compiler increments it automatically when recursing into nested relation walks.
- `insert` validates `properties` against `case_type_schemas[appId, caseType].schema` via AJV (Plan 1's JSON Schema generator + `ajv` + `ajv-formats`), serializes the parsed object back to a JSONB string before write, INSERTs the row (case_id defaulted via Postgres's `uuidv7()` when not supplied), and captures the generated case_id through `RETURNING case_id` to surface in the return value. `case_indices` derivation is deferred to Plan 3 / Plan 4 (the column shape is in place; downstream tasks own the materialization).
- `update` does a JSONB merge on `properties` (full-row replacement per the spec's JSONB-write-bloat mitigation), updates `modified_on`, validates the merged shape via the same AJV path. `validateProperties` accepts an `executor` parameter so transaction-internal calls share the trx connection — without this threading, `pg.Pool` with `max: 1` deadlocks during the `update` test.
- `close` updates `closed_on` and the optional `status`, no row deletion.
- `traverse` compiles the `RelationPath` via Plan 1's relation-path compiler into a recursive CTE; runs against `case_indices`.
- `applySchemaChange` opens a Postgres transaction, regenerates the JSON Schema via Plan 1's generator + UPSERTs `case_type_schemas`, then (when `property` + `change` are present) runs the rename / retype / narrow-options migration in the same transaction. Rows that fail the new schema move to `cases_quarantine` with the original value + failure reason. The transaction commits when both halves succeed or rolls back atomically. **Per-property expression-index DDL emission is added by Task 8** inside this same transaction; Task 8 owns both the call site and the body together (no empty hook in this task — the original draft included one, the code-review removed it as forward-projection).

`case_indices` materialization: Option B (direct edges only, recursive CTE on read) per the spec's verification gate. Switch to Option A if profiling shows the CTE dominates query cost.

Tests run the interface-compliance harness from Task 3 against a testcontainers Postgres instance per-test isolated database. Coverage includes: insert + query roundtrip (string and `JsonObject` inputs both round-trip); relation traversal; schema sync (positive atomicity verified); rename / retype / narrow-options migration paths (each with positive + quarantine cases); cross-tenant negative tests for `update`, `close`, `traverse` (the security invariant that drove the `withOwnerContext` factory pattern).

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

This task adds `generateSampleData` and `resetSampleData` to the `CaseStore` interface and to `PostgresCaseStore`:
- `generateSampleData(args: { appId, caseType, count, seed }): Promise<{ inserted: number }>` — calls `HeuristicCaseGenerator` and routes the rows through `insert`.
- `resetSampleData(args: { appId, caseType }): Promise<{ deleted: number; inserted: number }>` — deletes existing rows for the case-type, then re-generates with a fresh seed.

These methods were intentionally not on the interface in Task 3 — adding throwing stubs would have been forward-projection. They land here together with the implementation. The user invokes generation via the new methods; backstop CLI / developer script: `scripts/seed-sample-data.ts`.

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

### Task 8: Per-property expression-index DDL emission inside `applySchemaChange`

**Files:** `lib/case-store/postgres/store.ts` (the existing `applySchemaChange` method gets a third half added), tests.

Tasks 3+4 shipped two halves of `applySchemaChange`'s transaction: schema sync and per-row migration. Task 8 adds the third — per-property expression-index DDL emission — inside the same Postgres transaction. The DDL emission lives in `postgres/store.ts` directly (not a separate file as an earlier draft of this plan suggested); the method wrapping the transaction is already there, this task adds the emission step alongside the existing sync + migration steps.

The complete three-halves shape after Task 8:

1. **Schema sync** (always runs, shipped in Task 4): regenerate the JSON Schema via Plan 1's generator from the current blueprint state for `(appId, caseType)`; UPSERT into `case_type_schemas`.
2. **Per-property expression-index DDL emission** (always runs, this task): read the union of (case-type properties × search inputs that target them × modes × sort keys × filter operators) from the current blueprint state. Compute the desired index set per the discipline table at the top of this plan. Compare against `pg_indexes` for the case-type's existing per-property indexes; emit `DROP INDEX` / `CREATE INDEX` statements for the diff. The index naming convention pins each index to its `(case_type, property, mode)` tuple so the diff is mechanical (e.g. `cases_<case_type>_<property>_<mode>`). Property rename: drops the index on the old extraction path, creates the index on the new one. Property removal: drops the index. Search-input mode change: drops the old-mode index, creates the new-mode index. The DDL runs INSIDE the transaction so the index state matches the schema state atomically.
3. **Per-row migration** (runs when `property` + `change` are present, shipped in Task 4): for each row in the case-type, apply the change shape:
   - `rename(from, to)` — `UPDATE cases SET properties = jsonb_set(properties #- '{from}', '{to}', properties->'from')` for every row.
   - `retype(fromType, toType)` — for each row, attempt to cast the value per the spec's "Schema migration policy" table. On success: `UPDATE cases SET properties = jsonb_set(...)`. On failure: move to `cases_quarantine` with `quarantine_reason` set to the cast-failure detail.
   - `narrow-options(removedOptions)` — for each row whose property value is in `removedOptions`, move to `cases_quarantine`.

The transaction commits when all three halves succeed, rolls back atomically on failure. The database never holds a new schema with rows that fail validation against it, AND it never holds a search input that references an unindexed property. This is the structural backstop for the "apps are always in a valid state" principle at the storage layer.

Tests: each change shape against fixtures; index DDL diff produces the right `CREATE` / `DROP` set for representative blueprint mutations (property add / remove / rename / retype / search-input mode change); rollback verified by simulating a mid-migration failure inside the index-DDL emission step (which Task 8 makes a real-world reachable failure path — the cast loop in Task 4's migration step doesn't throw, so a sabotage-the-transaction test wasn't possible until DDL emission lands); quarantine surfacing; no-property-no-change call runs schema sync + index DDL sync (without per-row migration).

### Task 9: Barrel exports + CLAUDE.md + full error-message sweep

**Files:** `lib/case-store/index.ts`, `lib/case-store/CLAUDE.md`, `lib/case-store/errors.ts` (new), every existing `throw new Error(...)` site across `lib/case-store/**`.

**Barrel + CLAUDE.md:**

Document:
- The interface contract.
- The single-implementation pattern (no in-memory variant; no parity tests; testcontainers covers test isolation).
- The "no preview mode" architecture: the running-app view operates on the same rows the editor sees; sample-data generation is a user action.
- The `(app_id, owner_id)` isolation pattern.
- The migration workflow: Atlas owns schema-as-code (`schema.sql` source) + autogenerates migrations into `migrations/` via `npm run db:diff`. Production applies via the Cloud Run startup CMD (`atlas migrate apply --env prod --allow-dirty && exec node server.js`); tests apply via the same atlas binary shelled out from `globalSetup.ts`. Local-only npm scripts: `db:diff` (generate from `schema.sql` edit) + `db:lint` (matches the lefthook pre-commit destructive-change check). Production migration state: `gcloud logging read` for the most recent apply log + `atlas_schema_revisions` ledger via Cloud SQL Studio for the full applied set.
- The required Postgres extensions (`pg_trgm`, `fuzzystrmatch`, `postgis`) — installed at provisioning time per the Task 0 runbook §Phase 5 + by the testcontainer harness via container superuser. No runtime verification gate; missing extensions surface as `function does not exist` failures at the first compiler-emitted query against them.
- Why validation lives in TypeScript, not in Postgres triggers: `lib/domain/predicate/jsonSchema.ts` + `ajv` at the API-route trust boundary; no `pg_jsonschema` (Cloud SQL doesn't allowlist it) and no PL/pgSQL fallback (would duplicate the TS validator's logic).
- The typed error contract (see "Full error-message sweep" below).

**Full error-message sweep:**

Every `throw new Error(...)` site across `lib/case-store/**` gets rewritten to match the Elm-style voice already established at `lib/domain/predicate/errors.ts` (header line + indented diagnostic body + narrative + `Hint:` line; third-person impersonal except enumeration lists which use first-person). The predicate package's CLAUDE.md "Design principles (drawing on Elm / Rust / Roc compiler-error work)" section is the canonical voice rationale. The same standard already applies to `lib/commcare/validator/` (app validation) and `lib/domain/predicate/typeChecker.ts` (search AST + compiler errors); the case-store catches up.

Two error families:

1. **Typed user-domain errors** in a new `lib/case-store/errors.ts`:
   - `CaseNotFoundError(caseId: string)` — replaces the current `update` throw at `postgres/store.ts:337–342` whose message lists "another tenant" as a possible cause. The new message acknowledges tenant boundaries exist as an equivalence statement ("may not exist, may have been closed and removed, or may sit outside the bound owner's tenant — the three are equivalent so the tenant boundary stays structural rather than message-leaked") rather than confirming the case is in another tenant. API routes catch this and map to 404 with no body detail.
   - `CasePropertiesValidationError(appId, caseType, failures)` — replaces the current `validateProperties` throw at `postgres/store.ts:1036–1039`. Carries the per-field AJV failure list as structured data so API routes catch + map to 400 with the structured array (the user-actionable per-field detail surfaces; the `case_type_schemas[appId, caseType].schema` wrapper jargon does not).
   - The error classes use `readonly name = "<ClassName>"` so `instanceof` works across the bundler boundary.

2. **Internal-invariant throws** that reuse helpers from `lib/domain/predicate/errors.ts`:
   - `applySchemaChange` property-required (`postgres/store.ts:553`) — `compilerBugMessage`.
   - Schema-row-missing (`postgres/store.ts:1074`) — `compilerBugMessage` with a `Hint:` pointing at the blueprint mutator's `applySchemaChange()` ordering contract.
   - JSONB shape errors (`postgres/store.ts:1184`, `1186`, `1194`) — `compilerBugMessage`.
   - `tryCastValue` exhaustive switch fallthrough (`postgres/store.ts:1288`) — `unhandledKindMessage`.
   - The migration-runner shellout helper at `lib/case-store/sql/__tests__/applyMigrationsViaAtlas.ts:53, 70` — `compilerBugMessage` (CI prereq surface).
   - The per-test-database helper at `lib/case-store/sql/__tests__/perTestDatabase.ts:164` — `compilerBugMessage`.

Tests verify each typed error class throws with the expected `name` + structured fields; the message text is contract-tested only at the front (`expect(err.message).toContain("Case '...' not found")`) so future voice tweaks don't break tests over indentation.

Plan 2 Tasks 6+7 (the first API-route consumers of `CaseStore`) catch the typed errors at their handler boundaries and emit the matching HTTP responses; the typed contract makes the error → status mapping mechanical at every consumer.

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
