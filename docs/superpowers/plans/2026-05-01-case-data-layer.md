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
| `compare`/`between` on `date`/`datetime`/`time` props → typed cast comparison | None today[^immutable]. The text-to-typed casts (`::date` / `::timestamptz` / `::time`) and the canonical `to_date(...)` / `to_timestamp(...)` builtins are STABLE in Postgres (DateStyle / TimeZone session dependency); expression indexes require IMMUTABLE expressions. Compare / between on these data types runs as a sequential scan over the case-type partition |
| `multi-select-contains(prop, ...)` quantifier=any/all → JSONB `?\|` / `?&` / `@>` | `CREATE INDEX <name> ON cases USING GIN ((properties->'<key>') jsonb_ops) WHERE case_type = '<type>'` (`->` not `->>` because the operators consume JSONB, not text; `jsonb_ops` not `jsonb_path_ops` because the latter only supports `@>` and would force a seq-scan for `?` / `?\|` / `?&` queries) |
| `within-distance(prop, ...)` → `ST_DWithin(ST_GeogFromText(concat('POINT(', ...)), ...)` | None today[^immutable]. The predicate compiler builds a WKT string via `concat(...)` over `split_part(...)` reads to bridge the wire shape `"lat lon alt acc"` to PostGIS's WKT input; `concat(...)` over text args is STABLE so the full expression cannot be indexed. The simpler `ST_GeogFromText(properties->>'<key>')` form would index successfully but the planner cannot bridge it to the compiler's WKT-build form for index match. `within-distance` queries run as a sequential scan |
| `is-null(prop)` / `is-blank(prop)` → JSONB `?` key existence | Covered by an explicit JSONB-keys GIN index per case-type if absence checks dominate; otherwise the seq-scan cost is acceptable |

[^immutable]: The discipline table widens to include temporal (`date` / `datetime` / `time`) + `geopoint` indexes once Nova adds an IMMUTABLE wrapper-function path. The wrapper rewrites the cast / WKT-build form into a Nova-owned IMMUTABLE function the term compiler also emits against; both surfaces target the same expression so the planner reaches the index. The foundation work belongs in a follow-on plan after Plan 2 ships. Until then, the four affected operators run as sequential scans over the case-type partition (correct semantically, slower on large case-types).

The foundation does NOT and CANNOT provision these — the property name is dynamic per blueprint, and the searched mode is dynamic per Plan 4 search-input config. Plan 2's `applySchemaChange` (Task 8) is the structural owner: it reads the per-case-type property declarations from the blueprint and emits the matching expression-index DDL alongside the JSON Schema regen.

Without the matching index, the operator still emits correct SQL — just as a sequential scan. At 100 cases per case-type: imperceptible. At 10,000: visible lag. At 1,000,000: broken UX. The discipline is structural: every searchable property + searched mode pair gets its expression index automatically, no author opt-in required, no "tune indexes later" deferral.

**Migration discipline (two-phase atomic-then-convergent shape):** when the blueprint mutates in a way that affects the index surface (property rename, retype, removal, search-input-mode change, search-input-target-property change, search-input `via`-walk change), `applySchemaChange` runs in two phases:

- **Phase A (one Postgres transaction):** schema sync (UPSERT `case_type_schemas`) + per-row migration (rename / retype / narrow-options). Commits atomically when both halves succeed; rolls back on failure. The schema row + data are always consistent — the database never holds a new schema with rows that fail validation against it.
- **Phase B (no transaction; runs after Phase A commits):** index DDL diff via `CREATE INDEX CONCURRENTLY` / `DROP INDEX CONCURRENTLY`. Convergent rather than atomic — a Phase B failure leaves Phase A's commit intact, and the next `applySchemaChange` call diffs against `pg_indexes` and re-emits whatever drops + creates remain outstanding. Missing indexes degrade query performance but never correctness.

`CONCURRENTLY` is required, not optional: non-CONCURRENT `CREATE INDEX` heap-scans with `SnapshotAny` semantics that include recently-deleted-but-not-yet-vacuumed tuples. A retype's quarantine DELETE produces dead tuples whose pre-migration values still get evaluated by the new index expression, failing the cast and rolling back. CONCURRENTLY uses MVCC snapshot semantics strict enough to ignore the dead tuples; its "cannot run inside transaction" constraint aligns naturally with Phase B's already-non-transactional shape. As a side benefit, CONCURRENTLY does not hold `ACCESS EXCLUSIVE` on `cases` for the build's duration — concurrent reads + writes against `cases` keep working while the index builds.

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

### Task 5: `HeuristicCaseGenerator` + sample-data interface — SHIPPED

SHIPPED 2026-05-05 in commits `a2abac6c` (feat) → `a9529fa1` (CR + spec-review fix-pass) on branch `feat/case-list-search`.

**Files shipped:**

- `lib/case-store/sample/generator.ts` — `SampleCaseGenerator` interface. One method: `generate(args: { blueprint: BlueprintDoc; appId: string; caseType: string; count: number; seed: string; parentRefs?: ReadonlyMap<string, ReadonlyArray<string>> }): ReadonlyArray<CaseInsert>`. The signature extends the spec's `generate(args: { caseType: CaseType; count: number; seed: string }): CaseRow[]` with three additions documented under "Spec deviations" below.
- `lib/case-store/sample/heuristic.ts` — `HeuristicCaseGenerator` class. Per-`data_type` dispatch with property-name heuristics (`age` → uniform 15-80; `count` / `quantity` / `total` → uniform 0-1000; `temperature` → clinical decimal range; `name` text → multi-word from the names pool; etc.). Schema-driven; reads `data_type`, `options`, and property names off the supplied blueprint snapshot.
- `lib/case-store/sample/prng.ts` — `SeededPrng` interface + `createSeededPrng(seed: string)` factory. Implementation uses FNV-1a 32-bit hash to derive an integer state from the string seed, then mulberry32 for the actual PRNG sequence. Extracted from `heuristic.ts` in the fix-pass to break the import cycle that would form once pool modules accept a `SeededPrng` directly. Citations in the file header link to the canonical FNV-1a Wikipedia entry and Tommy Ettinger's mulberry32 gist; the file states the explicit `Math.random` rejection ("not seedable; deterministic per `(blueprint, caseType, seed)` output is the contract").
- `lib/case-store/sample/pools/{names,addresses,geopoints,dates}.ts` — per-`data_type` value pools. Names pool covers ~1880 globally-varied combinations (Yoruba / Hindi / Arabic / Vietnamese / Mandarin / Spanish / Portuguese / Igbo / Swahili / etc.). Geopoints cover 10 city centers across multiple continents and population densities. Addresses use real public street names with fabricated building numbers (no PII). Dates carry three semantic ranges (DOB / registration / recent-event) keyed off the property-name heuristic. All pool functions take `(prng: SeededPrng, ...specificArgs)` for a uniform contract.
- `lib/case-store/sample/__tests__/heuristic.test.ts` — 21 generator unit tests across 5 describe blocks covering hash determinism, PRNG range invariants, generator schema-validity (a real `Ajv2020` + `addFormats` compile against `caseTypeToJsonSchema(caseType)` on every generated row across all 9 `data_type` arms), property-name heuristics, parent linkage threading, and error paths.
- `lib/case-store/__tests__/storeContract.ts` (+200 lines, 4 new contract tests): generate-respects-count, generate-is-deterministic-per-seed, reset-deletes-and-regenerates, parent-child-traverses-end-to-end through `case_indices`.

**Files modified:**

- `lib/case-store/store.ts` — adds `generateSampleData` + `resetSampleData` to the `CaseStore` interface. The summary bullet for `resetSampleData` mirrors the per-method JSDoc honestly: atomic deletion (cases + edges in one transaction), regeneration runs sequenced after the deletion commits because each per-row insert opens its own transaction.
- `lib/case-store/postgres/store.ts` — implementations + `sampleGenerator: SampleCaseGenerator` constructor arg (required, not optional) + `resolveParentRefs` helper that queries existing parents via the case-type's `parent_type` declaration and threads them through `parentRefs` so the generator picks parent_case_id from the existing real set.
- `lib/case-store/withOwnerContext.ts` — wires `new HeuristicCaseGenerator()` as the default `SampleCaseGenerator` in the factory.
- `lib/case-store/postgres/__tests__/store.test.ts` — passes `sampleGenerator` to the test factory; mirrors the production wiring (uses the same `HeuristicCaseGenerator` rather than a stub).

**`generateSampleData` routing:** the store iterates the generator's output and calls `this.insert(row)` per row, so `case_indices` derivation runs through the same path real inserts use. The generator never writes `case_indices` directly — it just produces case rows, and the store's existing relation-derivation in Tasks 3+4 fires for each insert.

**`resetSampleData` two-step shape:** the deletion is atomic (cases + edges in one Postgres transaction); regeneration runs sequenced after the deletion commits because each per-row `insert` opens its own transaction (Postgres rejects nested BEGIN). The interface JSDoc at `store.ts:354-357` and the per-method JSDoc at `:451-466` both describe this honestly. A mid-regeneration failure leaves a half-populated case-type — explicitly NOT atomic across the full deletion-plus-regeneration scope.

**Spec deviations (all approved):**

- **`SampleCaseGenerator.generate` signature.** Spec has `generate(args: { caseType: CaseType; count: number; seed: string }): CaseRow[]`. Shipped uses `generate(args: { blueprint: BlueprintDoc; appId: string; caseType: string; count, seed, parentRefs? })`. Three additions: (a) `blueprint` matches `applySchemaChange`'s caller-supplied-snapshot pattern; the generator calls `findCaseTypeOrThrow(blueprint, caseType)` to recover the `CaseType` object — substantively equivalent to the spec's pre-resolved object, with one extra throw path. (b) `appId` enters the PRNG seed composition `${appId}::${caseType}::${seed}` so two apps sharing the same case-type name + seed don't collide. (c) `parentRefs` threads the store layer's parent-id resolution into the generator without coupling them. Return type `ReadonlyArray<CaseInsert>` is more type-correct than the spec's `CaseRow[]` — the generator shouldn't assign `case_id` / `owner_id` / `app_id` (the store does), and `CaseInsert` is the type that omits those.
- **`count` is required (no `?`)** on both `generateSampleData` and `resetSampleData`. The spec's "Default count 30" framing is a UI affordance (the Generate-Sample-Data button defaults to 30), not a store-API default. Required on the API surface; defaulting in the calling layer.

**Age distribution fix:** the original draft used `Math.floor(Math.sqrt(prng.pickFloat()) * 100)` for age and yearsBack, which produces an elder-skewed distribution (mean ≈ 67) — opposite of the documented "adult-biased" intent. The fix-pass replaced it with uniform `Math.floor(15 + prng.pickFloat() * 65)` (range [15, 80)) for both `pickIntValue("age")` and `pickDateInRange("dob")`. Working-age coverage; child + elder ages out of scope for the demo distribution. Unit test at `heuristic.test.ts` asserts `[15, 80)` after the fix.

**REFERENCE_DATE:** pinned to `2026-05-01T12:00:00Z` as a module-level const. The determinism contract reads from this static anchor — no clock read at any point. The "plausibly recent" framing was dropped from the JSDoc to avoid implying the dates track the present-day clock; the contract is "deterministic per `(blueprint, caseType, seed)`", not "tracks current date." Periodically bumping `REFERENCE_DATE` is a future-supervisor option; not currently scheduled.

**LlmCaseGenerator:** the polymorphism on `SampleCaseGenerator` exists today so tests can pass alternative implementations to `PostgresCaseStore`. An LLM-driven generator (`LlmCaseGenerator` against Haiku or another small model) is one possible alternative implementation, but no such consumer is in flight; the seam is incidentally available, not motivated by an unbuilt LLM consumer.

**Tests:**
- Case-store package: 316 passed (was 290 pre-Task-5; +26).
- Full repo: 2845 passed | 14 skipped.

Commit chain: `a2abac6c` (initial feat) → `a9529fa1` (CR + spec-review fix-pass).

### Task 6: Form running-app write-through — SHIPPED

SHIPPED 2026-05-05 in commits `a206a114` (feat) → `053a3a5a` (CR + spec-review fix-pass) on branch `feat/case-list-search`.

**Files shipped:**

- `lib/case-store/form-bridge/deriveFromForm.ts` — pure function. Walks the blueprint field tree; buckets each leaf's value into either the primary case's properties or a child-case bucket per `case_property_on`. Emits a typed `DerivedFormOps` discriminated union for the four form types (registration → `PrimaryRegistrationOp`; followup → `PrimaryUpdateOp` with optional update; close → `PrimaryUpdateOp` + close discriminator; survey → no-op against `cases`). Repeat containers fan out into one `ChildInsertOp` per runtime instance.
- `lib/case-store/form-bridge/writeThrough.ts` — I/O wrapper. Accepts a `CaseStore` instance, calls `deriveFromForm`, and applies the ops via `insert` / `update` / `close`. For registration, threads the generated primary `case_id` into child cases' `parent_case_id`; for followup / close, the bound `caseId` is the parent. Returns a typed `WriteFormCompletionResult` discriminated union — the survey arm carries only `{ kind: "survey" }`; the three case-touching arms carry `{ kind, caseId, childCaseIds }`.
- `lib/case-store/form-bridge/__tests__/deriveFromForm.test.ts` — 14 pure-function tests covering all four form types + edge cases (missing module case-type, missing bound caseId, repeat-instance fan-out, full `data_type` coercion).
- `lib/case-store/form-bridge/__tests__/writeThrough.test.ts` — 8 integration tests against per-test isolated Postgres via `setupPerTestDatabase`. Round-trip through real AJV validation + `case_indices` materialization. Includes the continuous-validation assertion (post-write `query` sees the new state immediately).
- `lib/case-store/form-bridge/__tests__/fixtures.ts` — shared `buildBlueprint` / `completed` / `DField` helpers extracted in the fix-pass; both test files import from here.

**`CaseStore` is a parameter, not constructed.** The form-bridge never calls `withOwnerContext` — Plan 2 Task 7's `caseDataBinding` constructs the store at the request boundary and passes it in. Tests construct `PostgresCaseStore` directly with the per-test handle, mirroring the contract harness wiring from Tasks 3+4.

**Forked the field walk rather than reusing `lib/commcare/deriveCaseConfig.ts`.** Two reasons:
1. `biome.json`'s `noRestrictedImports` rule blocks `lib/case-store/**` from importing `@/lib/commcare`. The boundary is structural, not a convention — see the project root CLAUDE.md's "CommCare boundary" section. A shared `lib/domain/` helper could in principle factor the walk skeleton, but the gain is marginal (~25 LOC of shared structure) and the downstream output shapes diverge enough that the visitor pattern would be doing little work.
2. `deriveCaseConfig` produces a build-time `DerivedCaseConfig` / `DerivedChildCase` (static descriptor with `repeat_context` as a string); the runtime path needs per-(case-type × repeat-instance) fan-out with typed values. Different inputs (blueprint vs blueprint + completed-form values), different invariants (build-time stable vs per-completion variable), different outputs (descriptor vs typed JSON document). The fork is structural, not a duplication waiting to be deduplicated.

**Empty-value omission semantic.** When `getValueSnapshot()` returns a values map missing a path (because `formEngine.ts:644` filters empty values out via `if (state.value) values.set(...)`), the form-bridge omits that property from the JSONB document the case-store writes. The decision was driven by AJV's strict-mode constraints: `null` fails `integer` / `number` types; `""` fails `format: date` / `format: time` / `format: date-time` / the geopoint pattern. The only shape that passes validation AND aligns with Postgres-strict `is-null` semantics ("absent" ≡ "not present in the JSONB document") is omission.

This means form completion produces only 2 of the 3 spec-defined JSONB states (absent / null / present-and-empty) — the "present-and-empty" state is unreachable via any form completion path. Other write paths (sample-data generator, direct API writes) can still produce it. Task 9's CLAUDE.md authoring pass documents this so future consumers of `is-blank` understand the form-completion path collapses to a 2-state model. The behavior survives both the absent-path fallback (`?? ""`) and the defensive-empty branch (`=== ""` short-circuit) converging on omission.

**Parent / child threading (registration).** Primary insert runs first via `caseStore.insert` (Postgres `RETURNING case_id` captures the generated id). Child inserts run sequentially after, with `parent_case_id = primary.case_id` (the derived ops carry no `parentCaseId` for registration; the I/O wrapper threads it via `fallbackParentCaseId`). Followup / close use the bound `caseId` as the primary directly; child ops carry `parentCaseId` set on the derivation side. The integration test at `writeThrough.test.ts` asserts the relationship materializes through `case_indices` end-to-end.

**Survey forms** are a structural no-op against `cases`. The walk still runs (the survey form's tree is traversed for any future analytics consumers), but no `CaseStore` operation fires; the result is `{ kind: "survey" }`. Survey forms collect data without case ownership per the spec's running-app form-types model.

**Tests:** case-store package 339 passed (was 316 pre-Task-6; +23 — the fix-pass split H1's empty-value test into production-path + defensive-belt-and-suspenders shapes, adding one).

Commit chain: `a206a114` (feat) → `053a3a5a` (CR + spec-review fix-pass).

### Task 7: caseDataBinding + delete dummyData.ts — SHIPPED

SHIPPED 2026-05-05 in commits `c6d2ece1` (feat — single cutover commit per the plan) → `3b79a0b6` (CR + spec-review fix-pass) on branch `feat/case-list-search`.

**Files shipped:**

- `lib/preview/engine/caseDataBinding.ts` (new) — three Server Actions: `loadCasesAction`, `loadCaseDataAction`, `populateSampleCasesAction`. Each resolves session via `getSession()` server-side per the project's auth rule, then constructs `withOwnerContext(session.user.id)` to obtain a tenant-scoped `CaseStore`. No client-supplied identity ever crosses the server boundary. Tests don't go through these actions — they call the helper layer directly with an injected store.
- `lib/preview/engine/caseDataBindingHelpers.ts` (new) — pure helpers `readCases`, `readCaseData`, `seedSampleCases` plus presentation utilities (`caseRowToFormPreload`, `caseRowDisplayValue`, `pickBlueprintDoc`, the private `jsonValueToString` coercion). Each helper accepts a `CaseStore` parameter, mirroring `lib/case-store/form-bridge/writeThrough.ts`'s test-injection pattern. `pickBlueprintDoc` is a positive-allowlist projection over `BlueprintDoc`'s 11 fields; the return type is `BlueprintDoc`, so a future field added to the type surfaces as a TypeScript compile error in the projection — function-stripping is exhaustive by construction.
- `lib/preview/engine/caseDataBindingTypes.ts` (new) — discriminated-union result shapes. `LoadCasesResult` = `rows | empty | unauthenticated | error`; `LoadCaseDataResult` = `row | missing | unauthenticated | error`; `PopulateSampleCasesResult` = `ok | unauthenticated | error`. Plus `LoadingState<T>` adding `idle | loading` arms at the hook layer.
- `lib/preview/hooks/useCaseDataBinding.ts` (new) — three client hooks: `useCases`, `useCaseData`, `usePopulateSampleCases`. Wire-level rejections (HTTP 500, network unreachable, RSC serialization errors) map to the typed `error` arm via `.catch` chains; the loading-state machine always reaches a terminal state.
- `lib/preview/engine/__tests__/caseDataBinding.test.ts` (new) — 9 contract tests via per-test isolated Postgres + 2 branch-coverage tests added in fix-pass for `jsonValueToString`'s boolean / null / array / object arms (tested through `caseRowDisplayValue` + `caseRowToFormPreload` consumers).
- `lib/case-store/__tests__/fixtures/simpleBlueprint.ts` (new) — shared `buildBlueprint(caseTypes)` extracted from the 4-5 sites that had been duplicating the helper. Three consumers migrated: `lib/case-store/__tests__/storeContract.ts`, `lib/case-store/sample/__tests__/heuristic.test.ts`, `lib/preview/engine/__tests__/caseDataBinding.test.ts`. The form-bridge's separate `lib/case-store/form-bridge/__tests__/fixtures.ts` stays distinct (its API has diverged enough that a forced merge would produce a worse abstraction).
- `components/preview/screens/CaseListScreen.tsx` (refactored) — consumes `useCases` + `usePopulateSampleCases`. Renders all 6 `LoadingState<LoadCasesResult>` arms (idle / loading / unauthenticated / error / empty / rows). Empty arm renders a "Generate sample data" affordance; on populate success, `reload()` re-fires `loadCasesAction` and the result transitions empty → rows.
- `components/preview/screens/FormScreen.tsx` (refactored) — consumes `useCaseData`. Renders targeted `unauthenticated` and `error` cards before the `!caseId` "no cases available" guard. The `idle` / `loading` / `missing` arms intentionally fall through to the form body with no preload (these are valid mid-load states that a form can render against).
- `lib/preview/engine/dummyData.ts` (deleted).
- `lib/preview/engine/types.ts` (modified) — `DummyCaseRow` type removed.
- `lib/domain/predicate/types.ts` (modified) — comment that referenced the deleted `DummyCaseRow` updated to describe the live Postgres runtime.

**Server / client component split.** The Server Actions in `caseDataBinding.ts` carry `"use server"` and resolve session via the cached `getSession()` from `lib/auth-utils.ts`. The hooks in `useCaseDataBinding.ts` carry `"use client"`. The refactored screens are client components consuming the hooks. Tests construct `PostgresCaseStore` directly and call the pure helpers, never the Server Actions — same shape Tasks 5 + 6 use.

**Discriminated unions exhaustively typed.** `pickBlueprintDoc`'s positive-allowlist + the wide-then-narrow signature `<T extends BlueprintDoc>(state: T): BlueprintDoc` (CR fix-pass tightening) means new `BlueprintDoc` fields force a compile error at the projection site. The hook's `LoadingState<T>` adds `idle | loading` arms beyond the action's union; both screens handle the relevant arms cleanly.

**Continuous validation.** When `populateSampleCasesAction` succeeds, the consumer calls `reload()` (the `useCases` hook's stable callable), which re-fires the load action and re-renders with fresh rows. No router refresh, no `revalidatePath` — purely client-managed state because the data lives entirely in the Cloud SQL row and the read path is local to the action.

**Smoke render not driven through a browser.** The implementer correctly disclosed this in the commit message. The 9 contract tests + 2 branch-coverage tests + the test-suite verification chain (typecheck + lint + per-test Postgres round-trip) cover the helpers and the binding contract. Pixel-level screen render verification against a live dev server is a supervisor or QA action item; if needed, run `npm run dev` against the Cloud SQL instance and exercise the case-list + form screens manually.

**Tests:** preview-engine package 59 passed (was 48 pre-Task-7; +11). Full repo 2879 passed | 14 skipped.

Commit chain: `c6d2ece1` → `3b79a0b6`.

#### Plan 5 handoff obligations

The spec-compliance reviewer caught two structural obligations Plan 5's case-selection-to-form work must honor:

1. **`FormScreen.tsx` must guard `loadCaseDataAction`'s non-`row` arms.** This Task 7 commit guards `unauthenticated` and `error`; `idle` / `loading` / `missing` intentionally fall through to "no preload" because the URL slot for `caseId`-bound followup forms doesn't exist today (`lib/routing/types.ts` puts `caseId` only on `kind: "cases"`, not on `kind: "form"`). When Plan 5 adds the URL slot threading `caseId` into followup/close forms, it MUST also add explicit guards for `missing` and decide what the form should do when the bound case can't be loaded — render a back-to-list affordance, redirect, or surface a "case unavailable" card. The current "no preload + render the form anyway" behavior is fine for forms that don't carry `caseId`; it's wrong for forms that do.

2. **Case-selection-to-form URL wiring belongs to Plan 5.** `CaseListScreen.handleRowClick` currently navigates without `caseId`. The router doesn't have a slot to thread it into `openForm`. Plan 5 designs the URL schema for case-selected followup/close flows; the `caseDataBinding` consumer surface is ready to receive a `caseId` parameter from the route — it just isn't wired today.

### Task 8: Per-property expression-index DDL emission — SHIPPED (two-phase, four empirical deviations)

SHIPPED 2026-05-05 in commits `098c31d8` (feat) → `b562dbf3` (CR + spec-review fix-pass) on branch `feat/case-list-search`.

The implementation deviates from this plan's original "all in one transaction with non-CONCURRENT CREATE INDEX" framing on four counts. **All four were empirically forced** by Postgres internals; supervisor accepted each on review. The shipped shape:

#### Deviation 1 — Two-phase split (not single transaction)

**Plan said:** schema sync + per-row migration + DDL all inside one transaction.

**Postgres said no:** non-CONCURRENT `CREATE INDEX` uses `SnapshotAny` semantics — it evaluates the new index expression against every heap tuple including dead ones from same-transaction DELETEs. The per-row migration's quarantine path produces dead tuples whose values still get evaluated by the new index. A retype `text → int` against a row carrying `"abc"` fails the new index's `(properties->>'X')::int` cast against the dead tuple even though the row was deleted in the same transaction.

**Shipped:**
- **Phase A (one Kysely transaction):** schema sync (UPSERT case_type_schemas) → per-row migration → COMMIT.
- **Phase B (no transaction, against `this.db` directly):** index DDL diff via `CONCURRENTLY` (see Deviation 2). Naturally idempotent — every call diffs against `pg_indexes` and re-derives the missing creates / extra drops.

**Achievable invariant:** schema and data are always consistent; indexes converge on the next idempotent call. Phase B failure leaves schema + data intact; missing indexes degrade query performance but never correctness.

#### Deviation 2 — `CONCURRENTLY` required (not just acceptable)

**Plan said:** plain `CREATE INDEX` (non-CONCURRENT) is fine; the brief table-lock is acceptable per the atomic-blueprint-mutation principle.

**Postgres said no:** even after Phase A commits, non-CONCURRENT `CREATE INDEX` in Phase B can still see dead tuples from the same backend's just-committed DELETE if autovacuum hasn't advanced the visibility horizon. Surfaced as an intermittent flake in the testcontainer harness during the C1+C2 fix-pass (max:1 pool reuses the same backend; horizon doesn't advance synchronously).

**Shipped:** `CREATE INDEX CONCURRENTLY` and `DROP INDEX CONCURRENTLY` for both directions. CONCURRENTLY uses MVCC snapshot semantics that exclude dead tuples cleanly. CONCURRENTLY's "cannot run inside transaction" constraint aligns naturally with Phase B's already-non-transactional shape; as a side benefit, concurrent reads/writes against `cases` keep working while builds run.

#### Deviation 3 — `multi_select` opclass is `jsonb_ops`, not `jsonb_path_ops`

**Plan's discipline table said:** `CREATE INDEX ... USING GIN ((properties->'key') jsonb_path_ops)` for `multi-select-contains`.

**Postgres said no:** `jsonb_path_ops` only supports `@>` (containment); the predicate compiler emits `?|` / `?&` / `?` for `multi-select-contains` (Plan 1's `match` quantifier `any` / `all`). EXPLAIN against the compiler's emission with `jsonb_path_ops` showed seq-scan fallback; with `jsonb_ops` (the default GIN opclass for jsonb) the planner matches `?|` directly via Index Cond.

**Shipped:** `multi_select` properties use `USING GIN ((properties->'key') jsonb_ops)`. The plan's discipline table (top of this doc) was wrong on this row.

#### Deviation 4 — No per-property expression index for `geopoint` / `date` / `datetime` / `time`

**Plan's discipline table said:** btree expression indexes for temporal types; GIST `ST_GeogFromText(properties->>'X')` for geopoint.

**Postgres said no:**
- `(text)::date` / `::timestamptz` / `::time` are all `STABLE` (depend on `DateStyle` / `TimeZone` GUCs), not `IMMUTABLE`. Expression indexes require `IMMUTABLE`.
- Geopoint storage format is `"lat lon alt acc"` (not WKT); the predicate compiler's `within-distance` arm emits `ST_DWithin(ST_GeogFromText(concat('POINT(', split_part(...), ' ', split_part(...), ')')), ...)` to bridge the format. `concat(...)` over text args is `STABLE`; the indexable form `ST_GeogFromText(properties->>'X')` is `IMMUTABLE` but doesn't match the compiler's emission for the planner to bridge.

**Shipped:** temporal types and geopoint return `undefined` from `desiredIndexForProperty`. `compare` / `between` on temporal types and `within-distance` on geopoint run as sequential scans — semantically correct, slower on large case-types.

**Future fix path:** Nova-owned `IMMUTABLE` wrapper functions (`nova_parse_date(text) RETURNS date IMMUTABLE`, `nova_geopoint_to_geography(text) RETURNS geography IMMUTABLE`) plus matching term-compiler emission. Both surfaces move together when that lands; out of Plan 2 scope.

#### What SHIPPED produces

For each of the supported `data_type` arms, Phase B emits the matching expression index inside Phase B (post-Phase-A-commit, no transaction, CONCURRENTLY):

| `data_type` | Index DDL (via `CREATE INDEX CONCURRENTLY`) |
|---|---|
| `text` | `... USING GIN ((properties->>'<key>') gin_trgm_ops) WHERE case_type = '<type>'` |
| `int` | `... USING BTREE (((properties->>'<key>')::integer)) WHERE case_type = '<type>'` |
| `decimal` | `... USING BTREE (((properties->>'<key>')::numeric)) WHERE case_type = '<type>'` |
| `multi_select` | `... USING GIN ((properties->'<key>') jsonb_ops) WHERE case_type = '<type>'` |
| `single_select` | NO INDEX (closed value space; partial-predicate filter alone matches efficiently) |
| `date` / `datetime` / `time` | NO INDEX (deviation 4) |
| `geopoint` | NO INDEX (deviation 4) |

**Naming convention:** `cases_<case_type>_<property>_<mode>` with hyphens in property names transformed to underscores for Postgres identifier compatibility (the JSONB key in the indexed expression preserves the hyphen verbatim via `sql.lit`). Collision detection: if two properties in the same case-type produce the same composed name post-transform, applySchemaChange throws preflight before any DB write with a "rename one to disambiguate" error.

**Identifier safety:** `assertSafeIdentifierFragment` runs **preflight** — before Phase A's transaction opens. A property name that fails the index-name composability check throws BEFORE any schema row mutates. This is the C2 fix from the supervisor's CR fix-pass review.

**Tests shipped:** 24 tests in `lib/case-store/postgres/__tests__/store.test.ts` covering: each data_type's emitted DDL shape; each diff verb (additive / remove / rename / retype / retype-with-quarantine); Phase A rollback atomicity; Phase B engine-failure-and-convergence (sabotage via `DROP EXTENSION pg_trgm CASCADE`, verify Phase A intact, verify next call converges); EXPLAIN tests asserting the planner reaches each index for the predicate compiler's emitted SQL; identifier safety (hyphen-aware vocabulary, collision detection); cross-tenant index sharing.

**Tests:** case-store-postgres package 59 passed (was 51 pre-Task-8; +8 net from this fix-pass round). Full repo 2903 passed. Three consecutive clean runs verified the CONCURRENTLY shift resolved the prior intermittent flake.

#### Open design question — cross-app index sharing (deferred)

Indexes are scoped per-`(case_type, property, mode)` but NOT per-`app_id`. If app A and app B both declare a `patient` case-type with `name`, they share `cases_patient_name_fuzzy`. If app A retypes `name` from text to int, app B's text-trgm expectation breaks silently (no migration on app B's data; no app-id scoping in the partial-index WHERE clause).

`case_type_schemas` PK is `(app_id, case_type)`, so the SCHEMA differs across apps; the INDEX doesn't.

**Resolution deferred:** in practice, each Nova app has a unique app_id and apps with identical case-type vocabularies are rare. The data model permits the collision but doesn't surface it on the typical authoring path. Future fix: include app_id in the partial-index WHERE clause and a hash-prefix in the index name (UUIDs don't fit in a 63-byte composed identifier directly). Out of Plan 2 scope; surface when the first cross-app collision is observed in the wild.

#### Plan-doc reconciliation needed at the top of this doc

The "Per-property expression indexes — the perf discipline the foundation surfaces" section at the top of this plan still describes the original (pre-empirical) DDL shapes. The entries that need correction:
- `multi_select` row: `jsonb_path_ops` → `jsonb_ops` (deviation 3).
- `date` / `datetime` / `time` rows: add a footnote on the IMMUTABLE-cast constraint and the future-fix-path via Nova-owned wrapper functions (deviation 4).
- `geopoint` row: same footnote — joins the temporal types' "needs IMMUTABLE wrapper" group (deviation 4).
- The "atomic across all halves" framing in the section's tail: replace with the two-phase atomic-then-convergent shape (deviation 1) plus the CONCURRENTLY requirement (deviation 2).

The corrections live in the file-header docstring of `lib/case-store/postgres/store.ts` (which is the canonical reference for the implementation's actual behavior). The plan-doc reconciliation lands on Task 9's CLAUDE.md authoring pass; Task 9 owns the reconciliation between the plan's prose and the implementation's documented behavior.

Commit chain: `098c31d8` (initial feat) → `b562dbf3` (CR + spec-review fix-pass).

### Task 9: Barrel exports + CLAUDE.md + typed error contract — SHIPPED

SHIPPED 2026-05-05 in commits `0ec0fa2a` (feat) → `d9099886` (CR + spec-review fix-pass) on branch `feat/case-list-search`. Final task in Plan 2.

**Files shipped:**

- `lib/case-store/index.ts` (new) — public barrel. Curated `export type` / `export` (not wholesale `export *`). Exposes `CaseStore` interface + `withOwnerContext` factory + row/arg/result types (`CaseRow`, `CaseInsert`, `CaseUpdate`, `QueryArgs`, `MigrationReport`, `ApplySchemaChangeArgs`, `GenerateSampleDataArgs`, `ResetSampleDataArgs`, `SchemaChangeKind`, `SortKey`) + typed error classes (`CaseNotFoundError`, `CasePropertiesValidationError`, `CasePropertyFailure`) + form-bridge surfaces (`deriveFromForm`, `writeFormCompletionThrough` + types) + JSONB value types (`JsonObject`, `JsonValue`, `JsonPrimitive`). Package-private surfaces stay subpath-only: `PostgresCaseStore`, the connection layer, `SampleCaseGenerator` / `HeuristicCaseGenerator`, `setupPerTestDatabase`. Production callers go through `withOwnerContext`; tests reach for the package-private surfaces via subpath imports.

- `lib/case-store/errors.ts` (new) — typed user-domain errors:
  - `CaseNotFoundError(caseId)` — thrown by `update` only when the bound owner can't see a case. The 404-mapping body acknowledges three equivalent causes (the case may not exist, may have been closed and removed, or may sit outside the bound owner's tenant) without confirming which — keeps the tenant boundary structural rather than message-leaked. The fix-pass narrowed this to `update`-only after the spec reviewer caught that `close` semantics ("ensure this case is closed") want idempotent silent no-op for already-gone-or-missing rows, and `traverse` returning `[]` for a missing anchor is the right empty-list shape. Both are reversible if a future product need surfaces.
  - `CasePropertiesValidationError(appId, caseType, failures)` — thrown by `update` and `insert` when AJV validation fails. Carries the structured per-field failure list as `ReadonlyArray<{ path: string; message: string }>` so API routes catch + map to 400 with the structured array. The `case_type_schemas[appId, caseType].schema` wrapper jargon stays in `err.message` for server-side logs but does NOT surface in the response body.
  - Both classes use `readonly name = "<ClassName>"` field initializers for bundler stability across module boundaries.

- `lib/case-store/__tests__/errors.test.ts` (new) — 12 tests pinning the public-field shape, the `instanceof Error + instanceof <ErrorClass>` discrimination, the `name` stability, the message-body contract (does NOT confirm "case is in another tenant"), and the structured-failure-list passthrough.

- `lib/case-store/CLAUDE.md` (full rewrite) — covers every required topic from the brief: interface contract + 8 methods, single-implementation pattern, "no preview mode" architecture, `(app_id, owner_id)` isolation pattern, migration workflow (Atlas + db:diff/db:lint + Cloud Run startup CMD + gcloud-logging + atlas_schema_revisions ledger), required Postgres extensions (provisioning-time, no runtime gate), TypeScript-side validation at the API trust boundary, the typed error contract (with code example showing the API-route catch-translate pattern + the equivalence-class rationale + the body-vs-message split), form-bridge surface (Task 6) + caseDataBinding surface (Task 7) + HeuristicCaseGenerator (Task 5), `applySchemaChange` two-phase shape (Task 8 with all four deviations: SnapshotAny + dead tuples + CONCURRENTLY + autovacuum visibility horizon + STABLE casts + jsonb_ops vs jsonb_path_ops), CommCare boundary, hyphen-to-underscore identifier transform.

- **Throw sweep across `lib/case-store/**`:** every production throw uses one of four shapes:
  - **2 typed user-domain throws** — `CaseNotFoundError`, `CasePropertiesValidationError`.
  - **~26 invariant throws** via `compilerBugMessage` from `lib/domain/predicate/errors.ts` (contract violations, impossible-by-upstream-gate states).
  - **~12 exhaustive-switch throws** via `unhandledKindMessage` (for `_exhaustive: never` fallthroughs).
  - **2 deploy-time configuration throws** inline-Elm-style in `connection.ts` (capacity-budget violation, missing env vars). The predicate package's `errors.ts` documents the inline-vs-helper split for one-off shapes that don't fit the helpers' "internal bug" framing — operator misconfiguration is a deploy-time mistake, not an internal contract violation.
  - Plus pre-existing `typeCheckerBypassMessage` throws across `sql/compileTerm.ts`, `sql/compilePredicate.ts`, `sql/compileExpression.ts` (shipped in Plan 1; reused, not refactored).
  - The total `throw new Error(...)` count went 48 → 46. The regex still matches helper-wrapped throws (`throw new Error(compilerBugMessage(...))`); only the two typed-class sites moved out of that shape entirely.

- **Plan-doc discipline-table reconciliation** — at the top of this plan, the "Per-property expression indexes" table corrected on 4 entries: `multi_select` opclass `jsonb_path_ops` → `jsonb_ops`; `date` / `datetime` / `time` rows + `geopoint` row added the IMMUTABLE-cast footnote (with the future Nova-owned wrapper-function path documented in plan-doc footnote, not in code); the "atomic across all halves" tail replaced with two-phase atomic-then-convergent + CONCURRENTLY framing.

**Migration-of-consumers:** `lib/preview/engine/caseDataBinding.ts` + `caseDataBindingHelpers.ts` + `caseDataBindingTypes.ts` migrated to import barrel-exposed types from `@/lib/case-store`. The fix-pass also moved `caseDataBinding.test.ts`'s `CaseRow` / `CaseStore` / `JsonObject` imports to the barrel (the initial commit had missed those).

**Tests:** case-store package 375 passed (was 363 pre-Task-9; +12 from `errors.test.ts`). Full repo 2915 passed | 14 skipped.

**Plan 5 handoff obligations** (recorded in Task 7's SHIPPED block; restated here for completeness):
1. `FormScreen.tsx` must guard `loadCaseDataAction`'s non-`row` arms when Plan 5 adds the URL slot threading caseId into followup/close forms.
2. Case-selection-to-form URL wiring (`CaseListScreen.handleRowClick` → form with caseId) belongs to Plan 5.

**Deferred design questions** (carry forward to whichever plan addresses them):
- **Cross-app index sharing** (Task 8): indexes are scoped per `(case_type, property, mode)` but NOT per `app_id`. Two apps sharing a case-type name share their indexes. Resolution deferred until a real cross-app collision surfaces.
- **`nova_parse_date` / `nova_geopoint_to_geography` IMMUTABLE wrapper functions** (Task 8): unlock per-property expression indexes for temporal types and geopoint. Future migration; out of Plan 2 scope.

Commit chain: `0ec0fa2a` (initial feat) → `d9099886` (CR + spec-review fix-pass).

---

#### Plan 2 follow-up — holistic-review cleanups SHIPPED

After Plan 2's nine tasks shipped, a holistic review of the case-store package surfaced nine actionable items spanning correctness, schema cleanliness, voice, and operational recovery. Two implementer rounds + supporting CR rounds addressed all nine in three commits:

- `4892e5fd feat(case-store): denormalize case_name + holistic-review cleanups` — case_name became a top-level column on `cases` (matching the data-model rule that platform-fixed-shape fields are columns and per-blueprint-variable-shape fields stay in JSONB); `CaseUpdate` rewritten as an explicit allowlist; `Plan [0-9]'s` cross-plan references swept from code; `readCaseData` rewritten as a predicate-based read; form-bridge's `buildBlueprint` renamed `buildFormBlueprint` and composes `buildSimpleBlueprint`; sample-data generation routes through a new `insertMany` private method (one validator fetch + one bulk insert + one bulk `case_indices` insert per batch instead of N round-trips per row).
- `df2c9436 refactor(case-store): code-review fix-pass on case_name denormalization` — `traverse` projection now includes `case_name` (a CRITICAL bug the CR caught: the `as unknown as CaseRow[]` cast hid the missing column at compile time, returning `undefined` at runtime); `caseTypeToJsonSchema` filter for `case_name` test-pinned; "four reserved" → "the reserved scalar columns" stale-comment sweep across 7+ sites; `RESERVED_SCALAR_COLUMNS` extracted to a single source in `dataTypeTokens.ts`; empty-`caseName` invariant pushed into `deriveFromForm` (the structurally-correct boundary); `insertMany` rollback test added.
- `33d225bc refactor(case-store): INVALID-index recovery + discriminator rename + lazy budget check` — `readLiveIndexSet` JOINs `pg_index` + `pg_class` + `pg_namespace` to capture `indisvalid`; `diffIndexSets` recreates INVALID indexes (drop + create) so failed `CREATE INDEX CONCURRENTLY` builds converge on the next call; `WriteFormCompletionResult.operation` renamed to `kind` for consistency with every other discriminated-union surface in Plan 2; `enforceConnectionBudget()` moved from module top-level into the `getCaseStoreDatabase()` lazy init so importing the barrel from a test file no longer triggers the deploy-time check.

**Deferred to Plan 3 prerequisite.** A `CaseStore.get(args)` interface arm was suggested as a cleaner shape for single-row reads (replacing the `query()` + JS filter pattern). The plan-2-internal `readCaseData` rewrite uses a predicate-based read and doesn't need the interface arm; whether to widen the public surface is a Plan 3 design call when its consumer story is concrete.

Final case-store package: 379 tests across 18 files. Full repo: 2927 passed, 14 skipped.

#### Plan 2 follow-up — pass-2 holistic-review cleanups SHIPPED

A second holistic review of the case-store package (after the first-pass cleanups landed) surfaced seven more actionable items. One implementer round + supporting CR round addressed all seven plus two CR-flagged LOWs across two commits:

- `65fc4774 refactor(case-store): pass-2 holistic-review fix-pass — atomicity + typed errors + bulk migrations` — `resetSampleData` is now atomic (delete + regenerate in one transaction; threading `trx` through private `*InTransaction` helpers); four cross-tenant contract tests added for `insert` / `applySchemaChange` / `generateSampleData` / `resetSampleData` (the `applySchemaChange` test pins the explicit per-`(appId, caseType)` schema-row contract distinct from the per-row tenant model); two new typed error classes (`CaseTypeNotInBlueprintError`, `SchemaNotSyncedError`) replace `compilerBugMessage` throws on stale-blueprint user-driven paths and are mapped at the `populateSampleCasesAction` Server Action boundary; `runRetypeMigration` and `runNarrowOptionsMigration` collapsed to bulk SQL (5 and 3 round-trips respectively, regardless of row count); `close()` adds `closed_on IS NULL` to its WHERE clause so already-closed cases silently no-op (first-time-close idempotent); `pickBlueprintDoc` uses `blueprintDocSchema.parse(state)` instead of a manual whitelist (Zod's default strip mode handles function stripping; `fieldParent` re-attached because it's an in-memory-only `BlueprintDoc` extension the schema doesn't declare); new `CaseStore.insertWithChildren` method batches a primary case + N children of mixed types into one transaction, with chunking-by-case-type and `originalIndex` reassembly so the returned `childCaseIds` matches input order — the form-bridge registration path uses it.
- `8c0ed4eb refactor(case-store): pass-2 fix-pass — extend validation error mapping` — `mapPopulateSampleCasesError` now discriminates `CasePropertiesValidationError` and returns a typed `{ kind: "validation-failure", caseType, failures }` arm so AJV's per-field failure list reaches the user instead of leaking through the generic `error` arm; the `CaseListScreen` populate-status switch handles the new arm with a per-field `field: reason` rendering; one eternal-present voice cleanup ("previous wrapper" → "internal-invariant body").

Final case-store package: 399 tests across 18 files. Full repo: 2957 passed, 14 skipped.

#### Plan 2 status — ALL TASKS SHIPPED

Plan 2 (case data layer) ships in 9 tasks plus the Tasks 1+2 Atlas rework plus two post-review cleanup passes (above). Branch `feat/case-list-search` carries the full commit chain from Task 0 → Task 9 → first-pass holistic-review fix-pass → second-pass holistic-review fix-pass. The eventual Plan 2 PR (opened at the end of the entire spec, not at the end of Plan 2) merges into `main`; the existing Cloud Build trigger fires on the merge commit, builds the new Dockerfile (atlas-bundled), and the new Cloud Run revision applies migrations at startup against the live `nova_cases` Cloud SQL instance.

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
