# Plan 2 Task 0 — Cloud SQL provisioning runbook

**Date created:** 2026-05-02 · **Last revised:** 2026-05-03 (post-execution capture)
**Owner:** supervisor (Braxton, executed gcloud after sign-off)
**Plan reference:** `docs/superpowers/plans/2026-05-01-case-data-layer.md` Task 0
**Status:** EXECUTED 2026-05-03 against project `commcare-nova`. Record-of-truth shell script at `scripts/infra/provision-cloud-sql.sh` captures the actual commands run.

This runbook locks every Task 0 decision against live Google docs and the existing project state, then sequences the billable provisioning. The implementer's downstream code-side scope (`lib/case-store/postgres/connection.ts`, `scripts/infra/provision-cloud-sql.sh` as the record-of-truth shell script, test wiring) follows after the infra is up.

**Architecture summary:** private-IP-only Cloud SQL Postgres 18 in us-central1, reached from Cloud Run via Direct VPC Egress over Service Networking VPC peering. Smallest viable shared-core tier (`db-f1-micro`) sized to current load (3 internal users) with explicit headroom for the next tier-bump when traffic demands it. IAM database authentication; no passwords stored anywhere.

---

## 1. Read-only verification commands

Run each of these BEFORE any billable command. Each is no-cost and project-state-only — they mutate nothing. Output is the input to the Decisions section below; if any output diverges from what's recorded, halt and reconcile before proceeding.

### 1.1 Active gcloud context

```bash
gcloud config list --format='value(core.project,core.account)'
gcloud projects describe commcare-nova --format='value(projectNumber)'
```

Expected: `commcare-nova  bperry@dimagi.com` and project number `51003905459`.

### 1.2 Currently-enabled APIs

```bash
gcloud services list --enabled --format='value(config.name)' \
  | grep -E '^(sqladmin|servicenetworking|secretmanager|run|compute|iam|cloudresourcemanager|cloudbuild|artifactregistry)\.googleapis\.com$' \
  | sort
```

Expected as of 2026-05-03 (already verified):

```
artifactregistry.googleapis.com
cloudbuild.googleapis.com
cloudresourcemanager.googleapis.com
compute.googleapis.com
secretmanager.googleapis.com
```

`sqladmin.googleapis.com` and `servicenetworking.googleapis.com` are both NOT enabled — Phase 0 enables them.

### 1.3 Cloud Run service state

```bash
gcloud run services describe commcare-nova --region=us-central1 \
  --format='yaml(spec.template.spec.serviceAccountName,spec.template.metadata.annotations,spec.template.spec.containers[0].image)' \
  | grep -E '(serviceAccountName|maxScale|cloudsql-instances|vpc-access|network-interfaces|image:)'
```

Expected (already verified): runtime SA `51003905459-compute@developer.gserviceaccount.com`, `run.googleapis.com/maxScale: '20'` (Phase 6 reduces to 5), no `cloudsql-instances` annotation, no VPC connector or network interfaces.

### 1.4 Cloud Run service agent IAM

Direct VPC Egress requires the Cloud Run service agent (separate from the runtime SA) to have `compute.subnetworks.use`. The role `roles/run.serviceAgent` covers this and is auto-granted when the Run API is enabled.

```bash
gcloud projects get-iam-policy commcare-nova \
  --flatten='bindings[].members' \
  --filter='bindings.members~serverless-robot-prod\.iam\.gserviceaccount\.com' \
  --format='value(bindings.role)' | sort -u
```

Expected to include `roles/run.serviceAgent`. Cloud Run is already running so this should be present; if absent, halt and grant before Phase 6.

### 1.5 VPC topology

```bash
gcloud compute networks list --format='table(name,subnet_mode,bgp_routing_mode)'
gcloud compute networks subnets list --filter='region:us-central1 AND network:default' --format='table(name,region,ipCidrRange)'
```

Expected: only the auto-mode `default` network, with `default` subnet in us-central1 at `10.128.0.0/20`. The /20 subnet is well above Direct VPC Egress's `/26` minimum requirement.

### 1.6 Tier list (after Phase 0)

```bash
gcloud sql tiers list --filter='region:us-central1' --format='table(tier,RAM,DiskQuota)' \
  | grep -E '(db-f1-micro|db-g1-small|db-custom-1-3840|db-perf-optimized)'
```

This requires the Cloud SQL Admin API — Phase 0 enables it, then this verification runs. The chosen tier (`db-f1-micro`) must be present in the output.

### 1.7 Existing peering ranges (pre-Phase 1)

```bash
gcloud compute addresses list --filter='purpose:VPC_PEERING' --global \
  --format='table(name,addressType,prefixLength,network,status)'
```

Expected (already verified): empty. If any range named `google-managed-services-default` already exists, halt — Phase 1 collides with it and the prior allocation needs investigation.

---

## 2. Decisions — locking each fork

Every decision below is grounded in either a live Google docs read (cited URL) or the existing project state from §1. None are inferred from training data.

### 2.1 Postgres major version → `POSTGRES_18`

- Cloud SQL's current default is Postgres 18, in regular support since 2025-09-25.
- Source: `https://docs.cloud.google.com/sql/docs/postgres/db-versions` (verified 2026-05-03).
- Alignment with Plan 1's testcontainers harness: `imresamu/postgis:18-3.6.1-alpine3.23` (PG 18 + PostGIS 3.6.1) matches Cloud SQL's default major and bundled PostGIS one patch ahead of production.
- gcloud flag: `--database-version=POSTGRES_18`.

### 2.2 Connection pattern → private IP via Direct VPC Egress (no public IP)

- Cloud SQL instance is created with `--no-assign-ip --network=projects/commcare-nova/global/networks/default`. The instance has no public IP at all; it's reachable only from networks peered with the Service Networking managed-services VPC.
- Cloud Run service is updated with `--network=default --subnet=default --vpc-egress=private-ranges-only`. RFC1918 outbound traffic (i.e., the Cloud SQL connection) routes through the VPC; non-RFC1918 outbound (LLM API calls, NPM registry, etc.) keeps the default Cloud Run egress for performance.
- Direct VPC Egress is GA (no `--beta` required); supersedes the legacy Serverless VPC Access Connector. Sources: `https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc` and `https://docs.cloud.google.com/sql/docs/postgres/configure-private-ip` (both verified 2026-05-03).
- **Why private IP for our case** (overrides the previous draft of this runbook): Nova stores case data, which is the user's real CommCare data and may include PHI. "Database is reachable on a public IP, even if frontend-gated" is a weaker compliance and defense-in-depth posture than "database has no public IP at all." The marginal operational cost of the private-IP setup (3 extra commands during Phase 1, one /20 IP range consumed permanently) is bounded; the compliance and defense-in-depth posture matters now and will matter more as the workload moves toward production.
- Plan 2's "Auth Proxy sidecar OR direct private IP via VPC connector" framing is stale; the canonical 2026 path is Direct VPC Egress + VPC peering, both of which this runbook uses.
- Note: `gcloud sql instances create` for private-IP instances requires `gcloud beta sql instances create` per the docs as of 2026-05-03. Every other gcloud command in this runbook is GA.

### 2.3 Region → `us-central1`

- Required by user's brief: Cloud SQL must live in the same region as Cloud Run.
- Cloud Run service `commcare-nova` is in `us-central1` (verified §1.3).

### 2.4 Machine tier → `db-f1-micro` (shared-core, 0.6 GB RAM, ~$10/mo)

- Smallest available Cloud SQL tier. Cloud SQL Postgres lists `db-f1-micro` for "low-cost test and development instances" — not covered by the SLA, which matches this dev environment's needs (the SLA-bearing tiers start at `db-custom-N-MEMORY` and the tier-up command is one gcloud invocation when traffic demands it).
- Source: `https://docs.cloud.google.com/sql/docs/postgres/instance-settings` (verified 2026-05-03).
- Workload sizing: ~3 internal users, ~30 cases per case-type per app, ~100 apps total → ~3K rows lifetime. The shared-core tier is correct for this load by an order of magnitude.
- Default `max_connections` for `db-f1-micro` is 25; this runbook pins it explicitly (§2.8) so future changes are visible.
- Tier-up path (when load grows): `db-g1-small` (50 conns, ~$25/mo) → `db-custom-1-3840` (100 conns, ~$50/mo) → larger custom tiers. Each step is a single `gcloud sql instances patch --tier=...` command with brief downtime; no schema migration, no app code change.

### 2.5 Authentication → IAM database authentication (no passwords)

- Cloud SQL flag: `cloudsql.iam_authentication=on` enables IAM-authenticated database users alongside the built-in `postgres` superuser.
- Cloud Run runtime SA (`51003905459-compute@developer.gserviceaccount.com`) becomes a database user; the app authenticates via `@google-cloud/cloud-sql-connector` (Google's canonical Node.js connector), which presents the runtime SA's identity through mTLS and lets Postgres skip password negotiation entirely. The connector handles certificate rotation and IAM token refresh internally.
- bperry@dimagi.com also becomes a database user for local dev / admin queries.
- Rejected: password auth + Secret Manager. The IAM path eliminates an entire class of secret-rotation drift; tokens auto-rotate with the SA's IAM credentials.

### 2.6 Service account → reuse existing Cloud Run runtime SA

- Cloud Run service `commcare-nova` runs as `51003905459-compute@developer.gserviceaccount.com` (the project default Compute Engine SA, verified §1.3).
- Grant `roles/cloudsql.client` (allows connection initiation) and `roles/cloudsql.instanceUser` (required for IAM database auth).
- Cloud Run service agent (`service-51003905459@serverless-robot-prod.iam.gserviceaccount.com`) keeps its existing `roles/run.serviceAgent` (verified §1.4) — this is what authorizes Direct VPC Egress; no additional grant needed.
- Rejected: dedicated `nova-cases-runtime` SA. Adds an account to rotate without buying isolation we don't need.

### 2.7 Connection pool → `pg.Pool` `max: 4` per Cloud Run instance

- Math: `cloud_run_max_instances × pool_max ≤ tier_max_connections - 5` (5 reserved for `postgres` / admin / replication).
- `db-f1-micro` defaults to `max_connections=25`.
- Cloud Run `maxScale=5` (set in Phase 6, down from current 20 — see §2.9).
- `5 × 4 = 20 ≤ 25 - 5 = 20`. Fits exactly.
- Plan 2's original `pg.Pool` `max: 10` was off by ~5×; the runbook's `max: 4` correctly sizes the pool against the tier. The plan-doc correction lands as part of the SHIPPED-sync commit after execution.
- The connection.ts implementer's brief encodes this math as a runtime invariant (`pool max × CLOUD_RUN_MAX_INSTANCES ≤ CLOUD_SQL_MAX_CONNECTIONS - 5`) so future Cloud Run scaling changes don't silently break it.

### 2.8 `max_connections` flag → 25

- Pinned explicitly on the instance create even though it matches `db-f1-micro`'s default. Reason: future tier-up commands need to know whether the value is implicit-default or explicit-set; pinning makes the resize math auditable.
- gcloud flag: `--database-flags=cloudsql.iam_authentication=on,max_connections=25`.

### 2.9 Cloud Run `maxScale` → 5

- Cloud Run is currently at `maxScale=20` (verified §1.3). For 3 internal users, that's overprovisioned. Default Cloud Run per-instance concurrency is 80 simultaneous requests — one instance handles ~80 concurrent requests, well above peak load for 3 users.
- 5 instances × 80 concurrency = 400 concurrent request capacity, plenty of headroom.
- Phase 6's `gcloud run services update` includes `--max-instances=5`.
- Cost impact: $0 (Cloud Run is request-billed, not instance-billed; lower max only caps spikes).
- Tier-up path: when traffic grows, raise `maxScale` first (free), tier-up Cloud SQL second (paid). Each step is one gcloud command.

### 2.10 High availability → single-zone (zonal)

- Dev environment; `--availability-type=ZONAL`.
- Regional failover doubles cost and is also not supported on shared-core tiers — would require tier-up to a custom tier first. Move to regional when there's a customer SLA that demands it.

### 2.11 Backups → automatic, daily, 7-day retention

- `--backup-start-time=07:00` (UTC; runs at 02:00 US-Central, off business hours).
- `--backup-retention=7` (days). PITR-enabled by default for Postgres on Cloud SQL Enterprise edition; `--transaction-log-retention=4` keeps 4 days of WAL.
- Restoration test is out of Task 0 scope but should land in Task 1's migration runner verification.

### 2.12 Local dev access → Cloud SQL Studio (ad-hoc) + testcontainers (tests)

There is no direct laptop-to-DB path. `cloud-sql-proxy --private-ip` from a developer laptop does not work for `--no-assign-ip` instances — verified against `https://docs.cloud.google.com/sql/docs/postgres/sql-proxy` and the `cloud-sql-proxy` README (the proxy uses the Admin API for *auth* but makes a direct TCP connection to the IP, which from outside the VPC is unreachable for private-IP-only instances). The previous draft of this runbook had this design wrong; A1 is the corrected path.

Three layers cover the access patterns:

- **Ad-hoc queries / DB inspection** → Cloud SQL Studio in the Google Cloud Console. Studio runs queries through Google's Admin API plane (not direct TCP), so it reaches private-IP-only instances. Verified post-Phase-7 by opening Studio against `nova-cases` and running `SELECT 1`. If Studio doesn't work for our instance configuration, the contingency is a follow-up runbook for an IAP bastion VM (~$5/mo); see §6 rollback for that path. (Plan 1 C7.5's testcontainers-vs-prod separation insulates code-side development from this question — the testcontainers harness keeps day-to-day tests off Cloud SQL entirely.)
- **Migrations** → Plan 2 Task 1's migration runner runs as a Cloud Run job, not as a local script. The job inherits the Cloud Run network attachment and reaches the private IP via Direct VPC Egress. This is a small Plan 2 Task 1 design change from the original "local Cloud SQL Auth Proxy" framing — the runbook flags it in §5 so the implementer picks the right pattern.
- **Test runs** → Vitest testcontainers harness (Plan 1 C7.5) unchanged. It spins up its own Postgres per Vitest run and never touches the Cloud SQL instance.

`connection.ts` reads `NOVA_DB_NAME` / `NOVA_DB_USER` / `NOVA_DB_INSTANCE_CONNECTION_NAME` from env in Cloud Run. The connector resolves the private IP from `NOVA_DB_INSTANCE_CONNECTION_NAME` via the SQL Admin API at connection time, so a separate `NOVA_DB_HOST` is not needed. There is no local dev mode — testcontainers covers tests, and Cloud Run is the only execution environment that talks to the live Cloud SQL.

### 2.13 Database name → `nova_cases`; database role naming → IAM identity strings

- Database: `nova_cases` (per Plan 2).
- Database users:
  - `51003905459-compute@developer.gserviceaccount.com` (Cloud Run runtime SA)
  - `bperry@dimagi.com` (developer)
- IAM auth uses the literal IAM identity as the DB role name.

### 2.14 Required extensions installed at Phase 5

`pg_trgm`, `fuzzystrmatch`, `postgis`. All three on Cloud SQL's documented allowlist; none requires a database flag (`CREATE EXTENSION ...` succeeds with the default flag set). Source: `https://docs.cloud.google.com/sql/docs/postgres/extensions` (verified 2026-05-03).

`pg_jsonschema` is intentionally NOT installed. Validation lives in TypeScript (`lib/domain/predicate/jsonSchema.ts` + `ajv`) at the API-route trust boundary — Cloud SQL doesn't allowlist `pg_jsonschema` and a hand-rolled PL/pgSQL validator would just create a second source of truth to keep in sync. This is locked by Plan 1 C7.5's post-shipped amendment.

### 2.15 Service Networking peering range → `/20` (4,096 addresses)

- Allocated as `google-managed-services-default` (canonical naming for the default VPC's managed-services range).
- /20 sized for ~1,000 Cloud SQL instances under Google's allocation density — far more than this project will ever need; one Cloud SQL instance consumes maybe 1–2 IPs from the range.
- /20 leaves 15/16 of the project's RFC1918 address space unallocated, preserving room for future VPN bridges, multi-cloud connections, or additional VPCs without IP collisions.
- Allocation is permanent while the peering exists; growing the range later is supported but disruptive. /20 is sized to never need growth at this project's scale.

### 2.16 Out of scope for this runbook

- Cloud SQL instance create flags for read replicas / regional HA / per-app schema isolation. (`(app_id, owner_id)` columns + `withOwnerContext` factory is the locked isolation model per spec § "Risks and mitigations".)
- Migration tooling (Atlas at Cloud Run startup; local `db:diff` / `db:lint` against an Atlas-booted dev container). Plan 2 Task 1.
- `applySchemaChange` orchestration. Plan 2 Task 8.
- Private Service Connect (PSC) as an alternative to VPC peering. Mentioned in `https://docs.cloud.google.com/sql/docs/postgres/configure-private-services-access` (verified 2026-05-03) but the page does not gate-keep VPC peering as legacy or recommend PSC for new instances. Sticking with the more thoroughly-documented VPC peering path.

---

## 3. Sequenced billable commands

Run after sign-off. Each step annotated with concrete cost and reversibility. Steps must run in order.

### Phase 0 — API enables ($0, reversible)

| # | Command | Cost | Reversibility |
|---|---|---|---|
| P0-1 | `gcloud services enable sqladmin.googleapis.com` | $0 | `gcloud services disable sqladmin.googleapis.com` (reversible until first instance) |
| P0-2 | `gcloud services enable servicenetworking.googleapis.com` | $0 | `gcloud services disable servicenetworking.googleapis.com` (reversible until first peering) |

After P0-2, run §1.6 to confirm `db-f1-micro` is in the tier list and §1.7 to confirm no preexisting peering range, then proceed.

### Phase 1 — Service Networking peering ($0)

| # | Command | Cost |
|---|---|---|
| P1-1 | `gcloud compute addresses create google-managed-services-default --global --purpose=VPC_PEERING --prefix-length=20 --network=default` | $0 (IP reservation is free) |
| P1-2 | `gcloud services vpc-peerings connect --service=servicenetworking.googleapis.com --ranges=google-managed-services-default --network=default` | $0 |

After P1-2, verify with:

```bash
gcloud services vpc-peerings list --network=default --format='value(network,reservedPeeringRanges)'
```

Expected: `default  google-managed-services-default`.

### Phase 2 — Create the Cloud SQL instance (~$10/mo recurring)

| # | Command | Cost |
|---|---|---|
| P2-1 | `gcloud beta sql instances create nova-cases --project=commcare-nova --edition=ENTERPRISE --network=projects/commcare-nova/global/networks/default --no-assign-ip --database-version=POSTGRES_18 --tier=db-f1-micro --region=us-central1 --availability-type=ZONAL --storage-type=SSD --storage-size=10 --storage-auto-increase --backup --backup-start-time=07:00 --backup-location=us-central1 --retained-backups-count=7 --enable-point-in-time-recovery --retained-transaction-log-days=4 --database-flags=cloudsql.iam_authentication=on,max_connections=25 --quiet` | ~$10/mo (db-f1-micro compute ~$8/mo + 10GB SSD ~$1.70/mo + daily backups in us-central1, list price 2026) |

The `--no-assign-ip` flag forces private-IP-only — no public IP is ever assigned. The `--network` flag attaches the instance to the default VPC's Service Networking peering.

`--edition=ENTERPRISE` is required explicit. The `gcloud sql instances create` API defaulted to `ENTERPRISE_PLUS` in 2026, which only supports the `db-perf-optimized-N-*` tier family — `db-f1-micro` is rejected on ENTERPRISE_PLUS with "Invalid Tier (db-f1-micro) for (ENTERPRISE_PLUS) Edition." The flag pins the older edition that supports shared-core tiers.

`--enable-point-in-time-recovery` enables PITR for Postgres; without it, `--retained-transaction-log-days` is rejected because transaction logs aren't being kept. The flag is a per-instance gate; PITR is what makes accidental data-loss recovery possible at second-level granularity (within the WAL retention window).

`--root-password` is intentionally omitted. gcloud's help marks it optional (`[--root-password=ROOT_PASSWORD]`); when omitted, Cloud SQL creates the instance with the `postgres` superuser having a random initial password we never see. Since this runbook authenticates everything through IAM (P4-5/P4-6 onward), the `postgres` user stays unused. If we ever need superuser access for an operation IAM users can't perform (`ALTER SYSTEM`, certain extensions outside IAM grants — rare), rotate via `gcloud sql users set-password postgres --instance=nova-cases --prompt-for-password` to set a fresh password on demand.

After P2-1 (~5 min wait for instance to come up). The connector resolves the private IP from `instanceConnectionName` at connection time, so no separate IP capture is required for Phase 6.

### Phase 3 — Create the application database ($0)

| # | Command | Cost |
|---|---|---|
| P3-1 | `gcloud sql databases create nova_cases --instance=nova-cases` | $0 |

### Phase 4 — IAM bindings + database users ($0)

| # | Command | Cost |
|---|---|---|
| P4-1 | `gcloud projects add-iam-policy-binding commcare-nova --member='serviceAccount:51003905459-compute@developer.gserviceaccount.com' --role='roles/cloudsql.client' --condition=None` | $0 |
| P4-2 | `gcloud projects add-iam-policy-binding commcare-nova --member='serviceAccount:51003905459-compute@developer.gserviceaccount.com' --role='roles/cloudsql.instanceUser' --condition=None` | $0 |
| P4-3 | `gcloud projects add-iam-policy-binding commcare-nova --member='user:bperry@dimagi.com' --role='roles/cloudsql.client' --condition=None` | $0 |
| P4-4 | `gcloud projects add-iam-policy-binding commcare-nova --member='user:bperry@dimagi.com' --role='roles/cloudsql.instanceUser' --condition=None` | $0 |
| P4-5 | `gcloud sql users create 51003905459-compute@developer --instance=nova-cases --type=CLOUD_IAM_SERVICE_ACCOUNT` | $0 |

Note: Cloud SQL Postgres requires the IAM-service-account database username to be created **without** the `.gserviceaccount.com` suffix; gcloud appends it internally for IAM token exchange. The truncated form (`51003905459-compute@developer`) is the database user identity for SQL GRANT statements (Phase 5) and the `NOVA_DB_USER` env var (Phase 6). The full IAM identity (`...@developer.gserviceaccount.com`) is still used for `gcloud projects add-iam-policy-binding` (P4-1/P4-2 above).
| P4-6 | `gcloud sql users create bperry@dimagi.com --instance=nova-cases --type=CLOUD_IAM_USER` | $0 |

### Phase 5 — Install extensions and grant database privileges ($0; runs in Cloud SQL Studio with brief postgres-superuser bootstrap)

The instance is private-IP-only — there's no laptop-to-private-IP path. Phase 5 runs through Cloud SQL Studio in the Google Cloud Console.

PostGIS specifically requires the `cloudsqlsuperuser` role to install (per Cloud SQL's documented extension allowlist behavior), and only the built-in `postgres` user has that role at instance creation. Phase 5 therefore briefly opens the `postgres` account, runs the install + grants, then closes it again. The `postgres` account begins Phase 5 with an unknown random password (set by Cloud SQL at instance create when we omitted `--root-password`); ends Phase 5 with a fresh unknown random password we rotate in. No human knows the `postgres` password before, during (briefly), or after.

**P5-0: Verify Cloud SQL Studio reaches the private-IP instance.**

1. Navigate to `https://console.cloud.google.com/sql/instances/nova-cases/studio?project=commcare-nova`.
2. Sign in with `bperry@dimagi.com` (the IAM user created in P4-6).
3. Select database `nova_cases`.
4. Run `SELECT 1;`. If it returns `1`, Studio works — proceed to P5-A.
5. If Studio errors (network unreachable, "instance not accessible"), halt. Two follow-up paths:
   - **Bastion path:** provision an `e2-micro` IAP bastion in the default VPC (~$5/mo recurring). Separate follow-up runbook.
   - **Cloud Run job path:** package a one-shot SQL-runner image, deploy as a Cloud Run job with Direct VPC Egress, run once. Reusable as the Plan 2 Task 1 migration-runner foundation.

**P5-A: Briefly open the postgres account.**

In a separate terminal, generate a random temporary password and copy it to clipboard:

```bash
openssl rand -base64 32 | pbcopy   # macOS; on Linux use xclip or wl-copy
```

Then in the runbook execution terminal:

```bash
gcloud sql users set-password postgres --instance=nova-cases --prompt-for-password
# Paste the value from clipboard when prompted (input is not echoed).
```

The temporary password lives only in the clipboard and gcloud's outbound API call. Don't write it down.

**P5-B: Run the install + grants in Studio as postgres.**

1. In Cloud SQL Studio, switch authentication to "Built-in database authentication."
2. Sign in as user `postgres` with the temporary password.
3. Run the SQL block below.
4. Verify the final SELECT lists all three extensions installed.

```sql
-- Probe: halt the session if any of the three is absent from
-- pg_available_extensions and do not proceed to CREATE EXTENSION.
SELECT name, default_version FROM pg_available_extensions
  WHERE name IN ('pg_trgm', 'fuzzystrmatch', 'postgis')
  ORDER BY name;

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;
CREATE EXTENSION IF NOT EXISTS postgis;

-- Grant the IAM users CONNECT + USAGE on the schema. The Cloud Run
-- runtime SA also gets CREATE so Plan 2 Task 1's migration runner can
-- create the application tables (cases / case_type_schemas / case_indices
-- / cases_quarantine); the SA will own those tables by virtue of being
-- the creator and gets full DML on them automatically.
GRANT CONNECT ON DATABASE nova_cases TO "51003905459-compute@developer";
GRANT USAGE, CREATE ON SCHEMA public TO "51003905459-compute@developer";
GRANT CONNECT ON DATABASE nova_cases TO "bperry@dimagi.com";
GRANT USAGE ON SCHEMA public TO "bperry@dimagi.com";

-- Verify the three extensions installed.
SELECT extname, extversion FROM pg_extension
  WHERE extname IN ('pg_trgm', 'fuzzystrmatch', 'postgis')
  ORDER BY extname;
```

5. Sign out of Studio. The temporary postgres password is no longer needed.

**P5-C: Close the postgres account.**

Generate a fresh random password to a discarded clipboard and rotate `postgres` to it:

```bash
openssl rand -base64 32 | pbcopy
gcloud sql users set-password postgres --instance=nova-cases --prompt-for-password
# Paste at the prompt; the value is now known to nobody.
echo "" | pbcopy   # clear the clipboard
```

End state: `postgres` account is present (Cloud SQL won't let it be deleted) with a password no human knows. The only path back in is `gcloud sql users set-password ... --prompt-for-password` again, which requires `roles/cloudsql.admin` IAM — equivalent to the threat surface that role already has. For the threat model "outsider with no project IAM gets data": same as if `postgres` had never been opened.

**P5-D: Verify IAM auth + extensions usable as bperry.**

1. In Cloud SQL Studio, switch authentication back to "IAM authentication."
2. Sign in as `bperry@dimagi.com`.
3. Run the smoke queries:

```sql
SELECT 'foo' <-> 'fop' AS pg_trgm_distance;       -- pg_trgm: should return ~0.5
SELECT dmetaphone('Foosball') AS phonetic_code;    -- fuzzystrmatch: should return 'FSBL'
SELECT ST_AsText(ST_GeogFromText('POINT(0 0)'));   -- postgis: should return 'POINT(0 0)'
```

If all three return values, Phase 5 is complete and the live runtime path is exercised end-to-end.

### Phase 6 — Wire Cloud Run to Cloud SQL via Direct VPC Egress ($0; deploys a new revision)

This is the single command that flips the Cloud Run service onto the VPC and tells it where the database lives. The Cloud SQL connector resolves the private IP from `NOVA_DB_INSTANCE_CONNECTION_NAME` itself.

| # | Command | Cost |
|---|---|---|
| P6-1 | `gcloud run services update commcare-nova --region=us-central1 --network=default --subnet=default --vpc-egress=private-ranges-only --max-instances=5 --update-env-vars=NOVA_DB_NAME=nova_cases,NOVA_DB_USER=51003905459-compute@developer,NOVA_DB_INSTANCE_CONNECTION_NAME=commcare-nova:us-central1:nova-cases` | $0 (deploys a new revision; Cloud Run pricing unchanged) |

Flag breakdown:
- `--network=default --subnet=default` — Cloud Run instances bind into the default VPC's us-central1 subnet (10.128.0.0/20, verified §1.5).
- `--vpc-egress=private-ranges-only` — only RFC1918 outbound traffic flows over the VPC; everything else (LLM API, NPM registry, etc.) keeps the default Cloud Run egress for performance and cost.
- `--max-instances=5` — drops the current 20 down to 5, fitting the pool-sizing math in §2.7.
- Env vars wire `connection.ts` to the instance. `NOVA_DB_INSTANCE_CONNECTION_NAME` drives the `@google-cloud/cloud-sql-connector` resolution + IAM auth path; `NOVA_DB_NAME` and `NOVA_DB_USER` populate the `pg.Pool` config.

### Phase 7 — Final verification ($0)

| # | Command | Cost |
|---|---|---|
| P7-1 | `gcloud sql instances describe nova-cases --format='value(settings.databaseFlags,settings.tier,databaseVersion,connectionName,settings.ipConfiguration.privateNetwork,settings.ipConfiguration.ipv4Enabled,ipAddresses[0].type,ipAddresses[0].ipAddress)'` | $0 |
| P7-2 | `gcloud run services describe commcare-nova --region=us-central1 --format='value(spec.template.metadata.annotations.run\.googleapis\.com/network-interfaces,spec.template.metadata.annotations.run\.googleapis\.com/vpc-access-egress,spec.template.metadata.annotations.run\.googleapis\.com/maxScale)'` | $0 |
| P7-3 | (Cold-start the deployed Cloud Run service and verify it can resolve `pg_extension` over the private link — quick smoke. Out-of-band of this runbook; the Plan 2 Task 1 migration runner is the first real exercise of the path.) | $0 |

P7-1 expected output:
- `databaseFlags`: `cloudsql.iam_authentication=on`, `max_connections=25`
- `tier`: `db-f1-micro`
- `databaseVersion`: `POSTGRES_18`
- `connectionName`: `commcare-nova:us-central1:nova-cases`
- `privateNetwork`: `projects/commcare-nova/global/networks/default`
- `ipv4Enabled`: `False`
- `ipAddresses[0].type`: `PRIVATE`
- `ipAddresses[0].ipAddress`: an RFC1918 address from the `google-managed-services-default` range

P7-2 expected: a network-interfaces annotation pointing at `default`/`default`, `vpc-access-egress: private-ranges-only`, `maxScale: '5'`.

---

## 4. Total cost summary

- One-time: $0 (every command in Phases 0–7 is free in itself).
- Recurring: ~$10/mo (db-f1-micro compute ~$8/mo + 10GB SSD ~$1.70/mo + daily backups, single-zone, us-central1 list price 2026).
- First-month proration: ~$10 if executed early in the billing cycle; less if mid-cycle.

If billing exceeds $20/mo at any point on this instance, halt and re-evaluate — that signals tier auto-resize, runaway storage growth, or a misconfiguration.

---

## 5. Post-execution handoff to the implementer

After Phase 7 verifies clean, the implementer's CODE-side scope per Plan 2 Task 0:

1. `lib/case-store/postgres/connection.ts` — Kysely instance + `pg.Pool` (`max: 4`); reads `NOVA_DB_NAME` / `NOVA_DB_USER` / `NOVA_DB_INSTANCE_CONNECTION_NAME` from env (set by Phase 6's `gcloud run services update`). Wires `@google-cloud/cloud-sql-connector` (Google's canonical Node.js connector for IAM-authenticated private-IP Cloud SQL Postgres) into the pool's `stream` option; the connector resolves the private IP, owns certificate rotation, and presents the runtime SA's identity via mTLS so Postgres skips password negotiation. There is no local-dev mode for `connection.ts` — testcontainers (Plan 1 C7.5) covers tests, and Cloud Run is the only environment that talks to the live Cloud SQL.

2. `scripts/infra/provision-cloud-sql.sh` — record-of-truth shell script transcribing every Phase 0–7 gcloud command. Lives alongside the runbook so a future supervisor can re-execute from script rather than re-reading the runbook.

3. Test wiring — none for Task 0 specifically; the testcontainers harness from Plan 1 C7.5 keeps tests off the live Cloud SQL instance.

### Plan 2 Tasks 1+2 SHIPPED — Atlas at Cloud Run startup (supersedes the Cloud Run job pattern)

Tasks 1+2 SHIPPED 2026-05-05 with Atlas owning schema-as-code and migration application. The original (2026-05-03) Kysely-runner-via-Cloud-Run-job design was reworked; the Cloud Run job pattern this section originally flagged is gone. The replacement: Atlas runs at Cloud Run startup against the same private-IP Cloud SQL instance the application already talks to, in the same container that serves Next.js. See Plan 2 Tasks 1+2 SHIPPED blocks for the full picture.

Key shape for future readers:

- The main `commcare-nova` Cloud Run service has Direct VPC Egress (`private-ranges-only` on `default`/`default`); the runtime container reaches `10.9.160.3` natively. Atlas piggybacks on that — it doesn't need its own Cloud Run job, its own Dockerfile, or its own deploy step.
- The atlas binary lives in the runtime image via a multi-stage `arigaio/atlas` digest pin; the migration files + `atlas.hcl` are COPY'd into the image at the same time as the Next.js standalone build. The Dockerfile CMD chains: `atlas migrate apply --env prod --allow-dirty && exec node server.js`. Postgres advisory lock (`atlas_migrate_execute`) serializes concurrent instance startups.
- `NOVA_DB_HOST=10.9.160.3` is re-added to the Cloud Run env (revision `commcare-nova-00102-njr`). Atlas is a Go binary and can't use `@google-cloud/cloud-sql-connector` — it requires a real `host:port` URL. The Node app continues to ignore `NOVA_DB_HOST` and resolve via `NOVA_DB_INSTANCE_CONNECTION_NAME`. Both consumers coexist.
- No npm scripts target prod from the laptop (the private IP isn't reachable). Local flow: `npm run db:diff` and `npm run db:lint` run against an Atlas-booted dev container. Production migration state is observable via `gcloud logging read 'resource.labels.service_name=commcare-nova AND textPayload:"atlas migrate apply"'` for the most recent apply, and via Cloud SQL Studio against the `atlas_schema_revisions` ledger for the full applied set.

This subsection is preserved (rather than deleted) so the supervisor's original "design flag" framing — that the laptop-to-private-IP gap forced a deploy-side migration pattern — stays discoverable. The deploy-side pattern that actually shipped is atlas-at-Cloud-Run-startup, not a separate Cloud Run job.

---

## 6. Rollback plan

Should provisioning fail mid-flight or the design need to back out:

| To undo | Command | Notes |
|---|---|---|
| Phase 6 (Cloud Run wire-up) | `gcloud run services update commcare-nova --region=us-central1 --clear-network --remove-env-vars=NOVA_DB_NAME,NOVA_DB_USER,NOVA_DB_INSTANCE_CONNECTION_NAME --max-instances=20` | $0; deploys a clean revision restoring prior maxScale |
| Phase 5 (extensions) | `DROP EXTENSION ...` for each | $0; idempotent |
| Phase 4 (IAM) | `gcloud projects remove-iam-policy-binding ...` for each P4-1..P4-4; `gcloud sql users delete ...` for P4-5..P4-6 | $0 |
| Phase 3 (database) | `gcloud sql databases delete nova_cases --instance=nova-cases` | $0; data lost |
| Phase 2 (instance) | `gcloud sql instances delete nova-cases` | $0; **data lost; ~7 days to undelete via `gcloud sql instances restore-backup` if backups still retained** |
| Phase 1 (peering + range) | `gcloud services vpc-peerings delete --service=servicenetworking.googleapis.com --network=default`, then `gcloud compute addresses delete google-managed-services-default --global` | $0; deleting the peering will fail if any Cloud SQL instances still depend on it |
| Phase 0 (API enables) | `gcloud services disable servicenetworking.googleapis.com`, `gcloud services disable sqladmin.googleapis.com` | $0 if no dependent resources exist |

---

## 7. Sign-off checklist

Before executing Phase 0 onward, all confirmed in chat 2026-05-03:

- [x] Run §1.1–1.5 + §1.7 read-only commands and verify outputs match expected. (§1.6 runs after Phase 0.)
- [x] `db-f1-micro` tier and the ~$10/mo cost.
- [x] Private-IP-only Cloud SQL via Direct VPC Egress with /20 Service Networking peering range.
- [x] IAM database authentication (no passwords stored anywhere; `--root-password` flag intentionally omitted).
- [x] Reuse existing Cloud Run runtime SA `51003905459-compute@developer.gserviceaccount.com`.
- [x] `max_connections=25` flag + `pool max: 4` + `Cloud Run maxScale=5` (matches the conn-budget math).
- [x] Cloud Run `maxScale` reduction from 20 to 5.
- [x] Cloud SQL Studio as the ad-hoc DB-access path (path A1: optimistic, no bastion provisioned upfront; bastion as contingency if Studio fails P5-0).

All boxes checked per chat 2026-05-03.

---

## 8. Post-execution outcomes (2026-05-03)

Captured here for the SHIPPED record; the shell script at `scripts/infra/provision-cloud-sql.sh` is the re-runnable transcript.

### Resources created

| Resource | Identifier | Notes |
|---|---|---|
| Service Networking range | `google-managed-services-default` (10.9.160.0/20) | RESERVED, /20 = 4096 addresses, room for ~1000 Cloud SQL instances |
| VPC peering | `default` ↔ `servicenetworking.googleapis.com` | Status active |
| Cloud SQL instance | `commcare-nova:us-central1:nova-cases` | PG 18, ENTERPRISE, db-f1-micro, ZONAL, private IP `10.9.160.3` |
| Database | `nova_cases` | Empty; Plan 2 Task 1 migrations populate the schema |
| IAM bindings (4) | runtime SA + bperry × (cloudsql.client + cloudsql.instanceUser) | All `--condition=None` |
| Database users (2) | `51003905459-compute@developer` (CLOUD_IAM_SERVICE_ACCOUNT), `bperry@dimagi.com` (CLOUD_IAM_USER) | postgres exists with fresh-random-unknown password |
| Extensions installed | pg_trgm 1.6, fuzzystrmatch 1.2, postgis (default version) | Verified via IAM-auth Studio queries |
| Cloud Run revision | `commcare-nova-00101-jq4` | maxScale=5, vpc-access-egress=private-ranges-only, env vars wired (`NOVA_DB_NAME` / `NOVA_DB_USER` / `NOVA_DB_INSTANCE_CONNECTION_NAME`) |

### Phase 5 P5-D smoke verification (Cloud SQL Studio, IAM auth as bperry)

| Query | Returned |
|---|---|
| `SELECT 'foo' <-> 'fop'` | `0.6666666` (pg_trgm distance) |
| `SELECT dmetaphone('Foosball')` | `FSPL` (fuzzystrmatch metaphone) |
| `SELECT ST_AsText(ST_GeogFromText('POINT(0 0)'))` | `POINT(0 0)` (postgis) |

All three extensions live and reachable end-to-end via IAM auth. The runtime path Cloud Run will use is exercised structurally.

### Mid-execution corrections folded back into this runbook

- `--root-password` removed from P2-1 (gcloud accepts omission).
- `--edition=ENTERPRISE` added to P2-1 (API defaulted to ENTERPRISE_PLUS, which rejects shared-core tiers).
- `--enable-point-in-time-recovery` added to P2-1 (required for `--retained-transaction-log-days`).
- `--retained-backups-count=7` and `--retained-transaction-log-days=4` are the correct flag names; the original `--backup-retention` and `--transaction-log-retention` are MySQL-only forms.
- `--backup-location=us-central1` added to P2-1 (defensive — without it Cloud SQL picks a multi-region default).
- `--condition=None` added to all four `gcloud projects add-iam-policy-binding` commands; gcloud rejects unconditional bindings on policies that already contain conditional ones.
- P4-5: Cloud SQL strips `.gserviceaccount.com` from IAM service-account database usernames at create time (`Database username for Cloud IAM service account should be created without ".gserviceaccount.com" suffix`). The truncated form `51003905459-compute@developer` is the database user identity used by SQL GRANT statements (Phase 5) and by the `NOVA_DB_USER` env var (Phase 6); the full `.gserviceaccount.com` form is what the project IAM policy bindings reference.
- §2.12 + Phase 5: `cloud-sql-proxy --private-ip` from a developer laptop does not work for `--no-assign-ip` instances. Phase 5 runs through Cloud SQL Studio in the Console; ad-hoc DB inspection going forward also runs through Studio. Plan 2 Task 1's migration runner is consequently a Cloud Run job (the runbook flagged this; Plan 2 picks it up).
- Plan 2 Task 0's "pg.Pool max: 10" was off by ~5×. The correct math (Cloud Run `--max-instances=5` × pool `max=4` ≤ Cloud SQL `max_connections=25 − 5` reserved = 20) lives in §2.7 and is folded into Plan 2 SHIPPED.
- Connector pattern reconciliation: the original draft of this runbook described a `google-auth-library` + manual-token-exchange flow, and Phase 6 wired a separate `NOVA_DB_HOST` env var to expose the captured private IP. The implementer correctly read the canonical Cloud SQL docs and adopted `@google-cloud/cloud-sql-connector` instead — the connector resolves the private IP from `NOVA_DB_INSTANCE_CONNECTION_NAME` itself, so `NOVA_DB_HOST` was dead. Removed via `gcloud run services update --remove-env-vars=NOVA_DB_HOST` (revision `00101-jq4`); Phase 6 + §5 + §6 above now reflect the three-variable env contract.

### Plan 2 sync

`docs/superpowers/plans/2026-05-01-case-data-layer.md` Task 0 is rewritten as a SHIPPED block citing this runbook and the shell script. Task 1's migration runner reframes from "local Cloud SQL Auth Proxy" to "Cloud Run job" with the rationale captured. The pool=4 math + the tier-up path are documented in Plan 2.
