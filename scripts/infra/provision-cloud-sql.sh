#!/usr/bin/env bash
# Record-of-truth provisioning script for the case-store's Cloud SQL Postgres
# instance. Provisions, in this order:
#
#   - Cloud SQL Admin + Service Networking APIs (Phase 0)
#   - VPC peering range and Service Networking peering (Phase 1)
#   - The Postgres 18 instance with private IP only, IAM auth, daily backup,
#     and PITR with 4-day WAL retention (Phase 2)
#   - The application database (Phase 3)
#   - Project IAM bindings + Cloud SQL database users for the runtime SA and
#     the developer principal (Phase 4)
#   - Cloud Run wiring (Direct VPC Egress + the env vars `connection.ts`
#     reads) (Phase 6)
#
# Re-runnability — the script is structured so a future re-run after a partial
# failure can pick up cleanly. Phases 1-6 each guard their primary mutation
# behind an existence check; existing resources are left in place rather than
# re-created.
#
# Phase 5 (extension installs + grants) is intentionally NOT in this script.
# `CREATE EXTENSION pg_trgm / fuzzystrmatch / postgis` requires the
# `cloudsqlsuperuser` role; only Cloud SQL's built-in `postgres` account
# carries that role at instance creation, and the runtime SA atlas runs as
# does not. The Phase 5 stub at the bottom of this script enumerates the
# four manual steps that run interactively in Cloud SQL Studio.
#
# Usage: ./scripts/infra/provision-cloud-sql.sh [--dry-run]

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants — single source for every project / instance / network identifier
# ---------------------------------------------------------------------------
readonly PROJECT_ID="commcare-nova"
readonly PROJECT_NUMBER="51003905459"
readonly REGION="us-central1"
readonly NETWORK="default"
readonly PEERING_RANGE_NAME="google-managed-services-default"
readonly PEERING_PREFIX_LENGTH=20
readonly INSTANCE_ID="nova-cases"
readonly DATABASE_NAME="nova_cases"
readonly DATABASE_VERSION="POSTGRES_18"
readonly TIER="db-f1-micro"
readonly EDITION="ENTERPRISE"
readonly STORAGE_SIZE_GB=10
readonly BACKUP_START_TIME="07:00"
readonly RETAINED_BACKUPS_COUNT=7
readonly RETAINED_TRANSACTION_LOG_DAYS=4
readonly MAX_CONNECTIONS=25

# IAM identity (full form, used for project IAM bindings).
readonly RUNTIME_SA_EMAIL="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
# Cloud SQL database username (truncated form — the .gserviceaccount.com suffix
# is appended internally by Cloud SQL during IAM token exchange and rejected by
# `gcloud sql users create`).
readonly RUNTIME_SA_DBUSER="${PROJECT_NUMBER}-compute@developer"
readonly DEVELOPER_USER="bperry@dimagi.com"

readonly CLOUD_RUN_SERVICE="commcare-nova"
readonly CLOUD_RUN_MAX_INSTANCES=5

# Set DRY_RUN=1 to print commands instead of executing them.
DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
	DRY_RUN=1
fi

# Wrapper that prints + executes (or just prints under --dry-run).
run() {
	echo "+ $*"
	if [[ "$DRY_RUN" -eq 0 ]]; then
		"$@"
	fi
}

# ---------------------------------------------------------------------------
# Pre-flight: confirm gcloud context matches the project this script targets.
# ---------------------------------------------------------------------------
echo "=== Pre-flight ==="
actual_project="$(gcloud config get-value project 2>/dev/null)"
if [[ "$actual_project" != "$PROJECT_ID" ]]; then
	echo "ERROR: gcloud project is '$actual_project', expected '$PROJECT_ID'." >&2
	echo "Run: gcloud config set project $PROJECT_ID" >&2
	exit 1
fi
echo "Project: $actual_project ✓"

# ---------------------------------------------------------------------------
# Phase 0 — Enable Cloud SQL Admin + Service Networking APIs.
# ---------------------------------------------------------------------------
echo "=== Phase 0: Enable APIs ==="
run gcloud services enable sqladmin.googleapis.com
run gcloud services enable servicenetworking.googleapis.com

# ---------------------------------------------------------------------------
# Phase 1 — Allocate VPC peering range and connect Service Networking peering.
# ---------------------------------------------------------------------------
echo "=== Phase 1: Service Networking peering ==="
if gcloud compute addresses describe "$PEERING_RANGE_NAME" --global \
	--format='value(name)' >/dev/null 2>&1; then
	echo "Peering range '$PEERING_RANGE_NAME' already allocated; skipping P1-1."
else
	run gcloud compute addresses create "$PEERING_RANGE_NAME" \
		--global \
		--purpose=VPC_PEERING \
		--prefix-length="$PEERING_PREFIX_LENGTH" \
		--network="$NETWORK"
fi

if gcloud services vpc-peerings list --network="$NETWORK" \
	--format='value(reservedPeeringRanges)' 2>/dev/null \
	| grep -qw "$PEERING_RANGE_NAME"; then
	echo "VPC peering already present; skipping P1-2."
else
	run gcloud services vpc-peerings connect \
		--service=servicenetworking.googleapis.com \
		--ranges="$PEERING_RANGE_NAME" \
		--network="$NETWORK"
fi

# ---------------------------------------------------------------------------
# Phase 2 — Create the Cloud SQL Postgres 18 instance with private IP only.
#
# Notable flags:
#   --edition=ENTERPRISE      db-f1-micro is rejected on ENTERPRISE_PLUS; the
#                             API defaulted there in 2026 and ENTERPRISE must
#                             be explicit for shared-core tiers.
#   --no-assign-ip            no public IP is assigned; private-only.
#   --enable-point-in-time-recovery + --retained-transaction-log-days=4
#                             PITR with 4-day WAL retention.
#   --retained-backups-count  flag name on PG; --backup-retention is rejected.
#   --root-password omitted   gcloud accepts omission; Cloud SQL sets postgres
#                             to a random initial password we never see. IAM
#                             auth is the only authentication path used.
# ---------------------------------------------------------------------------
echo "=== Phase 2: Create Cloud SQL instance ==="
if gcloud sql instances describe "$INSTANCE_ID" --format='value(name)' >/dev/null 2>&1; then
	echo "Instance '$INSTANCE_ID' already exists; skipping P2-1."
else
	run gcloud beta sql instances create "$INSTANCE_ID" \
		--project="$PROJECT_ID" \
		--edition="$EDITION" \
		--network="projects/${PROJECT_ID}/global/networks/${NETWORK}" \
		--no-assign-ip \
		--database-version="$DATABASE_VERSION" \
		--tier="$TIER" \
		--region="$REGION" \
		--availability-type=ZONAL \
		--storage-type=SSD \
		--storage-size="$STORAGE_SIZE_GB" \
		--storage-auto-increase \
		--backup \
		--backup-start-time="$BACKUP_START_TIME" \
		--backup-location="$REGION" \
		--retained-backups-count="$RETAINED_BACKUPS_COUNT" \
		--enable-point-in-time-recovery \
		--retained-transaction-log-days="$RETAINED_TRANSACTION_LOG_DAYS" \
		--database-flags="cloudsql.iam_authentication=on,max_connections=${MAX_CONNECTIONS}" \
		--quiet
fi

# ---------------------------------------------------------------------------
# Phase 3 — Create the application database.
# ---------------------------------------------------------------------------
echo "=== Phase 3: Create database ==="
if gcloud sql databases describe "$DATABASE_NAME" --instance="$INSTANCE_ID" \
	--format='value(name)' >/dev/null 2>&1; then
	echo "Database '$DATABASE_NAME' already exists; skipping P3-1."
else
	run gcloud sql databases create "$DATABASE_NAME" --instance="$INSTANCE_ID"
fi

# ---------------------------------------------------------------------------
# Phase 4 — IAM bindings + database users.
#
# `--condition=None` is required when the policy already contains conditional
# bindings; gcloud refuses to add an unconditional binding without it once any
# conditional binding exists in the policy.
# ---------------------------------------------------------------------------
echo "=== Phase 4: IAM bindings + database users ==="

# P4-1..P4-4: project-level IAM grants. add-iam-policy-binding is idempotent
# (re-applying an existing binding is a no-op + a verbose policy print).
for role in roles/cloudsql.client roles/cloudsql.instanceUser; do
	run gcloud projects add-iam-policy-binding "$PROJECT_ID" \
		--member="serviceAccount:${RUNTIME_SA_EMAIL}" \
		--role="$role" \
		--condition=None
	run gcloud projects add-iam-policy-binding "$PROJECT_ID" \
		--member="user:${DEVELOPER_USER}" \
		--role="$role" \
		--condition=None
done

# P4-5: runtime SA database user.
if gcloud sql users list --instance="$INSTANCE_ID" \
	--format='value(name)' 2>/dev/null \
	| grep -qx "$RUNTIME_SA_DBUSER"; then
	echo "Database user '$RUNTIME_SA_DBUSER' already exists; skipping P4-5."
else
	run gcloud sql users create "$RUNTIME_SA_DBUSER" \
		--instance="$INSTANCE_ID" \
		--type=CLOUD_IAM_SERVICE_ACCOUNT
fi

# P4-6: developer database user.
if gcloud sql users list --instance="$INSTANCE_ID" \
	--format='value(name)' 2>/dev/null \
	| grep -qx "$DEVELOPER_USER"; then
	echo "Database user '$DEVELOPER_USER' already exists; skipping P4-6."
else
	run gcloud sql users create "$DEVELOPER_USER" \
		--instance="$INSTANCE_ID" \
		--type=CLOUD_IAM_USER
fi

# ---------------------------------------------------------------------------
# Phase 5 — INTENTIONALLY NOT IN THIS SCRIPT.
#
# Extension installs (pg_trgm / fuzzystrmatch / postgis) require the
# cloudsqlsuperuser role, which only the built-in `postgres` account has at
# instance creation. The instance is private-IP-only, so there is no
# laptop-to-private-IP path; this work runs through Cloud SQL Studio in the
# Google Cloud Console:
#
#   1. Set a temporary postgres password
#      (gcloud sql users set-password postgres --prompt-for-password).
#   2. Sign into Studio as postgres; run, against database `nova_cases`:
#
#        CREATE EXTENSION IF NOT EXISTS pg_trgm;
#        CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;
#        CREATE EXTENSION IF NOT EXISTS postgis;
#
#        GRANT USAGE ON SCHEMA public TO "51003905459-compute@developer";
#        GRANT USAGE ON SCHEMA public TO "bperry@dimagi.com";
#
#        -- Atlas's `migrate apply` at Cloud Run startup creates the
#        -- `atlas_schema_revisions` schema for its migration ledger and
#        -- creates the case-store tables in `public`. Both require the
#        -- runtime SA to hold DDL rights at the database + public scopes —
#        -- without these, startup fails with
#        -- `permission denied for database nova_cases` and the Cloud Run
#        -- revision never binds :8080.
#        GRANT CREATE ON DATABASE nova_cases TO "51003905459-compute@developer";
#        GRANT CREATE ON SCHEMA public TO "51003905459-compute@developer";
#        GRANT CREATE ON SCHEMA public TO "bperry@dimagi.com";
#
#   3. Sign out, rotate the postgres account back to a fresh-random-unknown
#      password (no human knows it before, during briefly, or after).
#   4. Verify each extension is reachable under IAM auth as the developer
#      user (a smoke query against `pg_extension`).
#
# The split exists because PostGIS specifically requires `cloudsqlsuperuser`
# per Cloud SQL's documented extension allowlist, and atlas-applied schema
# migrations can only assume the runtime SA's privilege set. The CREATE
# grants above are the bridge: atlas runs as the runtime SA, but needs DDL
# rights one layer up (database for its tracking schema, public for the
# migration target). Once granted, every subsequent schema migration runs
# through atlas under the runtime SA at Cloud Run startup.
# ---------------------------------------------------------------------------
echo "=== Phase 5: SKIPPED (manual — runs interactively in Cloud SQL Studio) ==="

# ---------------------------------------------------------------------------
# Phase 6 — Wire Cloud Run to Cloud SQL via Direct VPC Egress.
#
# `private-ranges-only` keeps non-RFC1918 traffic on Cloud Run's default
# egress; only the database connection routes through the VPC. NOVA_DB_USER is
# the truncated form (no .gserviceaccount.com) — Cloud SQL strips the suffix
# at create time and the connector appends it internally for IAM token
# exchange. The full form is what the project IAM policy grants reference.
#
# `connection.ts` uses @google-cloud/cloud-sql-connector, which resolves the
# private IP from NOVA_DB_INSTANCE_CONNECTION_NAME via the SQL Admin API at
# connection time. No NOVA_DB_HOST env var is needed.
# ---------------------------------------------------------------------------
echo "=== Phase 6: Wire Cloud Run to Cloud SQL ==="
run gcloud run services update "$CLOUD_RUN_SERVICE" \
	--region="$REGION" \
	--network="$NETWORK" \
	--subnet="$NETWORK" \
	--vpc-egress=private-ranges-only \
	--max-instances="$CLOUD_RUN_MAX_INSTANCES" \
	--update-env-vars="NOVA_DB_NAME=${DATABASE_NAME},NOVA_DB_USER=${RUNTIME_SA_DBUSER},NOVA_DB_INSTANCE_CONNECTION_NAME=${PROJECT_ID}:${REGION}:${INSTANCE_ID}"

# ---------------------------------------------------------------------------
# Phase 7 — Final verification.
# ---------------------------------------------------------------------------
echo "=== Phase 7: Final verification ==="
echo "--- Cloud SQL instance ---"
run gcloud sql instances describe "$INSTANCE_ID" \
	--format='yaml(name,databaseVersion,settings.tier,settings.edition,settings.availabilityType,settings.databaseFlags,settings.backupConfiguration.enabled,settings.backupConfiguration.startTime,settings.backupConfiguration.backupRetentionSettings,settings.backupConfiguration.pointInTimeRecoveryEnabled,settings.backupConfiguration.transactionLogRetentionDays,settings.ipConfiguration.ipv4Enabled,settings.ipConfiguration.privateNetwork,connectionName,ipAddresses)'

echo "--- Cloud Run service ---"
run gcloud run services describe "$CLOUD_RUN_SERVICE" --region="$REGION" \
	--format='yaml(spec.template.metadata.annotations,spec.template.spec.containers[0].env)'

echo "=== Provisioning complete ==="
