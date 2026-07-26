#!/usr/bin/env bash
# Record-of-truth provisioning script for the case-store's Cloud SQL Postgres
# instance. Provisions, in this order:
#
#   - Cloud SQL Admin + Service Networking APIs (Phase 0)
#   - VPC peering range and Service Networking peering (Phase 1)
#   - The Postgres 18 instance with a private IP (Cloud Run's path), a public
#     IP (the laptop inspect-script path — no authorized networks, so the
#     connector's IAM-authenticated path is the only way in), IAM auth, daily
#     backup, and PITR with 4-day WAL retention (Phase 2)
#   - The application database (Phase 3)
#   - Project IAM bindings + Cloud SQL database users for the dedicated
#     migration/runtime/capture-cleanup SAs and the developer principal (Phase 4)
#   - Existing Cloud Run service/revision caps (Phase 5)
#   - Cloud Run wiring (Direct VPC Egress + the env vars `connection.ts`
#     reads) (Phase 7)
#
# Re-runnability — the script is structured so a future re-run after a partial
# failure can pick up cleanly. Phases 1-7 each guard their primary mutation
# behind an existence check; existing resources are left in place rather than
# re-created.
#
# The privileged extension/ownership bootstrap is intentionally NOT in this
# script. Creating pg_trgm/fuzzystrmatch/postgis/pgaudit requires the
# `cloudsqlsuperuser` role, which Nova's migration SA does not carry. Before
# that local CLI is run, this script converges and verifies both Cloud Run
# maxima at four. The checked-in bounded owner bootstrap then creates any
# missing extensions, preserves Cloud SQL-managed postgres ownership on
# pre-existing extensions, transfers only temporary/legacy ownership, and
# proves the final role shape.
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
# Cloud SQL replaces the complete database-flag set on every patch. Keep audit
# enablement/logging in the same exact contract as IAM auth and capacity so a
# convergence run can never silently disable production auditing.
readonly DATABASE_FLAGS="cloudsql.enable_pgaudit=on,cloudsql.iam_authentication=on,max_connections=${MAX_CONNECTIONS},pgaudit.log=all"

# Dedicated IAM identities (full form, used for project IAM bindings).
readonly MIGRATION_SA_EMAIL="nova-migrate@${PROJECT_ID}.iam.gserviceaccount.com"
readonly RUNTIME_SA_EMAIL="commcare-nova@${PROJECT_ID}.iam.gserviceaccount.com"
readonly CAPTURE_CLEANUP_SA_EMAIL="nova-capture-cleanup@${PROJECT_ID}.iam.gserviceaccount.com"
# Cloud SQL database usernames (truncated form — the .gserviceaccount.com
# suffix is appended internally by Cloud SQL during IAM token exchange and
# rejected by `gcloud sql users create`).
readonly MIGRATION_SA_DBUSER="nova-migrate@${PROJECT_ID}.iam"
readonly RUNTIME_SA_DBUSER="commcare-nova@${PROJECT_ID}.iam"
readonly CAPTURE_CLEANUP_SA_DBUSER="nova-capture-cleanup@${PROJECT_ID}.iam"
readonly DEVELOPER_USER="bperry@dimagi.com"

readonly CLOUD_RUN_SERVICE="commcare-nova"
readonly CLOUD_RUN_MAX_INSTANCES=4

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
# Phase 2 — Create the Cloud SQL Postgres 18 instance.
#
# Notable flags:
#   --edition=ENTERPRISE      db-f1-micro is rejected on ENTERPRISE_PLUS; the
#                             API defaulted there in 2026 and ENTERPRISE must
#                             be explicit for shared-core tiers.
#   --assign-ip               a public IP alongside the private one. NO
#                             authorized networks are configured, so the raw
#                             Postgres port is unreachable; only the Cloud SQL
#                             connector/proxy (SQL Admin API + IAM-minted TLS)
#                             can connect. Cloud Run rides the private IP; the
#                             public IP serves the laptop inspect scripts
#                             (scripts/inspect-*.ts --prod).
#   --enable-point-in-time-recovery + --retained-transaction-log-days=4
#                             PITR with 4-day WAL retention.
#   --retained-backups-count  flag name on PG; --backup-retention is rejected.
#   --root-password omitted   gcloud accepts omission; Cloud SQL sets postgres
#                             to a random initial password we never see. IAM
#                             auth is the only authentication path used.
# ---------------------------------------------------------------------------
echo "=== Phase 2: Create Cloud SQL instance ==="
if gcloud sql instances describe "$INSTANCE_ID" --format='value(name)' >/dev/null 2>&1; then
	instance_existed=1
	echo "Instance '$INSTANCE_ID' already exists; skipping P2-1."
	# P2-2: converge the public-IP setting on the existing instance.
	ipv4_enabled="$(gcloud sql instances describe "$INSTANCE_ID" \
		--format='value(settings.ipConfiguration.ipv4Enabled)')"
	if [[ "$ipv4_enabled" == "True" ]]; then
		echo "Public IP already enabled; skipping P2-2."
	else
		run gcloud sql instances patch "$INSTANCE_ID" --assign-ip --quiet
	fi
else
	instance_existed=0
	run gcloud beta sql instances create "$INSTANCE_ID" \
		--project="$PROJECT_ID" \
		--edition="$EDITION" \
		--network="projects/${PROJECT_ID}/global/networks/${NETWORK}" \
		--assign-ip \
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
		--database-flags="$DATABASE_FLAGS" \
		--quiet
fi

# P2-3: converge capacity, IAM-auth, and pgaudit flags even on an existing
# instance.
# `--database-flags` is a replacement set, so every durable flag belongs in
# this exact contract. The database preflight independently audits the
# effective PostgreSQL settings before migration and maintenance Jobs.
expected_database_flags="$DATABASE_FLAGS"
read_database_flags() {
	gcloud sql instances describe "$INSTANCE_ID" \
		--format='json(settings.databaseFlags)' \
	| python3 -c '
import json
import sys

document = json.load(sys.stdin)
flags = document.get("settings", {}).get("databaseFlags", [])
print(",".join(sorted("{}={}".format(flag["name"], flag["value"]) for flag in flags)))
'
}
if [[ "$DRY_RUN" -eq 1 && "$instance_existed" -eq 0 ]]; then
	echo "New instance is plan-only; its create command carries the exact flags, so P2-3 verification will run after apply."
else
	actual_database_flags="$(read_database_flags)"
	if [[ "$actual_database_flags" == "$expected_database_flags" ]]; then
		echo "Cloud SQL database flags already match the capacity contract."
	else
		run gcloud sql instances patch "$INSTANCE_ID" \
			--database-flags="$expected_database_flags" \
			--quiet
		if [[ "$DRY_RUN" -eq 0 ]]; then
			actual_database_flags="$(read_database_flags)"
			if [[ "$actual_database_flags" != "$expected_database_flags" ]]; then
				echo "ERROR: Cloud SQL flags are '$actual_database_flags', expected '$expected_database_flags'." >&2
				exit 1
			fi
		fi
	fi
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

# Ensure all three durable database identities exist. The broader build/deploy
# grants remain owned by `provision-deployment-identities.sh`; creating the
# accounts here makes a first-ever Cloud SQL provision self-contained.
if ! gcloud iam service-accounts describe "$MIGRATION_SA_EMAIL" \
	--project="$PROJECT_ID" >/dev/null 2>&1; then
	run gcloud iam service-accounts create nova-migrate \
		--project="$PROJECT_ID" \
		--display-name="Nova database migrator"
fi
if ! gcloud iam service-accounts describe "$RUNTIME_SA_EMAIL" \
	--project="$PROJECT_ID" >/dev/null 2>&1; then
	run gcloud iam service-accounts create commcare-nova \
		--project="$PROJECT_ID" \
		--display-name="Nova runtime"
fi
if ! gcloud iam service-accounts describe "$CAPTURE_CLEANUP_SA_EMAIL" \
	--project="$PROJECT_ID" >/dev/null 2>&1; then
	run gcloud iam service-accounts create nova-capture-cleanup \
		--project="$PROJECT_ID" \
		--display-name="Nova capture cleanup worker"
fi

# Project-level IAM grants. add-iam-policy-binding is idempotent
# (re-applying an existing binding is a no-op + a verbose policy print).
for account in \
	"$MIGRATION_SA_EMAIL" \
	"$RUNTIME_SA_EMAIL" \
	"$CAPTURE_CLEANUP_SA_EMAIL"; do
	for role in roles/cloudsql.client roles/cloudsql.instanceUser; do
		run gcloud projects add-iam-policy-binding "$PROJECT_ID" \
			--member="serviceAccount:${account}" \
			--role="$role" \
			--condition=None
	done
done
for role in roles/cloudsql.client roles/cloudsql.instanceUser; do
	run gcloud projects add-iam-policy-binding "$PROJECT_ID" \
		--member="user:${DEVELOPER_USER}" \
		--role="$role" \
		--condition=None
done

# Dedicated runtime, migration, and cleanup database users. Runtime is created
# first because migration's sole custom database-role membership is runtime.
# Capture cleanup is intentionally isolated and receives only direct table
# grants from the migration-time privilege convergence.
for database_user in \
	"$RUNTIME_SA_DBUSER" \
	"$MIGRATION_SA_DBUSER" \
	"$CAPTURE_CLEANUP_SA_DBUSER"; do
	if gcloud sql users list --instance="$INSTANCE_ID" \
		--format='value(name)' 2>/dev/null \
		| grep -qx "$database_user"; then
		echo "Database user '$database_user' already exists; skipping create."
	else
		run gcloud sql users create "$database_user" \
			--instance="$INSTANCE_ID" \
			--type=CLOUD_IAM_SERVICE_ACCOUNT
	fi
done
# Replace runtime's custom database-role memberships with the empty set. This
# is a no-op on a fresh instance and removes any legacy owner role when the
# script converges an older instance.
run gcloud sql users assign-roles "$RUNTIME_SA_DBUSER" \
	--instance="$INSTANCE_ID" \
	--type=CLOUD_IAM_SERVICE_ACCOUNT \
	--revoke-existing-roles
run gcloud sql users assign-roles "$MIGRATION_SA_DBUSER" \
	--instance="$INSTANCE_ID" \
	--type=CLOUD_IAM_SERVICE_ACCOUNT \
	--database-roles="$RUNTIME_SA_DBUSER" \
	--revoke-existing-roles
run gcloud sql users assign-roles "$CAPTURE_CLEANUP_SA_DBUSER" \
	--instance="$INSTANCE_ID" \
	--type=CLOUD_IAM_SERVICE_ACCOUNT \
	--revoke-existing-roles

# Developer database user.
if gcloud sql users list --instance="$INSTANCE_ID" \
	--format='value(name)' 2>/dev/null \
	| grep -qx "$DEVELOPER_USER"; then
	echo "Database user '$DEVELOPER_USER' already exists; skipping create."
else
	run gcloud sql users create "$DEVELOPER_USER" \
		--instance="$INSTANCE_ID" \
		--type=CLOUD_IAM_USER
fi

# Developer read access. `pg_read_all_data` membership is what lets the
# read-only inspect scripts (scripts/inspect-*.ts --prod) SELECT tables owned
# by the runtime SA. Control-plane grant — no superuser session needed.
# Additive (no --revoke-existing-roles); re-running is a harmless re-grant.
run gcloud sql users assign-roles "$DEVELOPER_USER" \
	--instance="$INSTANCE_ID" \
	--type=CLOUD_IAM_USER \
	--database-roles=pg_read_all_data

# ---------------------------------------------------------------------------
# Phase 5 — Cap and verify the serving fleet BEFORE database login caps.
#
# The existing service can currently demand four database sessions per
# instance. Its global and revision maxima must both be four BEFORE the
# bootstrap lowers runtime's hard login cap to 16; otherwise a five-instance
# old fleet can demand 20 sessions inside a 16-session role cap. A missing
# service is the safe first-deploy case (zero serving sessions).
# ---------------------------------------------------------------------------
echo "=== Phase 5: Cap Cloud Run before database bootstrap ==="
if ! existing_cloud_run_services="$(gcloud run services list \
	--region="$REGION" \
	--filter="metadata.name=${CLOUD_RUN_SERVICE}" \
	--format='value(metadata.name)')"; then
	echo "ERROR: Could not inventory Cloud Run services; refusing to infer that the service is absent." >&2
	exit 1
fi
if [[ "$existing_cloud_run_services" == "$CLOUD_RUN_SERVICE" ]]; then
	run gcloud run services update "$CLOUD_RUN_SERVICE" \
		--region="$REGION" \
		--max="$CLOUD_RUN_MAX_INSTANCES" \
		--max-instances="$CLOUD_RUN_MAX_INSTANCES" \
		--quiet
	if [[ "$DRY_RUN" -eq 0 ]]; then
		if ! reported_maxima="$(gcloud run services describe "$CLOUD_RUN_SERVICE" \
			--region="$REGION" \
			--format=json \
			| python3 -c '
import json
import sys

service = json.load(sys.stdin)
if not isinstance(service, dict):
    raise TypeError("Cloud Run service response must be an object")
annotations = service.get("metadata", {}).get("annotations", {})
template_annotations = (
    service.get("spec", {})
    .get("template", {})
    .get("metadata", {})
    .get("annotations", {})
)
print("{},{}".format(
    annotations.get("run.googleapis.com/maxScale", ""),
    template_annotations.get("autoscaling.knative.dev/maxScale", ""),
))
')"; then
			echo "ERROR: Could not read and parse Cloud Run service maxima after convergence." >&2
			exit 1
		fi
		if [[ "$reported_maxima" != "${CLOUD_RUN_MAX_INSTANCES},${CLOUD_RUN_MAX_INSTANCES}" ]]; then
			echo "ERROR: Cloud Run maxima are '$reported_maxima', expected '${CLOUD_RUN_MAX_INSTANCES},${CLOUD_RUN_MAX_INSTANCES}'." >&2
			exit 1
		fi
	else
		echo "Dry run: both reported maxima will be verified after apply."
	fi
elif [[ -z "$existing_cloud_run_services" ]]; then
	echo "Cloud Run service is absent; zero serving sessions make the first bootstrap safe."
else
	echo "ERROR: Cloud Run inventory returned unexpected service names: '$existing_cloud_run_services'." >&2
	exit 1
fi

# ---------------------------------------------------------------------------
# Phase 6 — INTENTIONALLY NOT IN THIS SCRIPT.
#
# The extension/ownership bootstrap requires `cloudsqlsuperuser`, which only a
# temporary built-in administrator has. Cloud SQL Studio can optionally inspect
# the read-only catalog, but it cannot run this repository's Node/TypeScript
# command. Run the checked-in CLI locally through the Cloud SQL connector:
#
#   1. Create a strong-password temporary BUILT_IN administrator with NO inline
#      `--database-roles`; assigning roles at creation suppresses its automatic
#      cloudsqlsuperuser membership.
#   2. After creation, assign runtime, migration, cleanup, and the retired role
#      when present WITHOUT `--revoke-existing-roles`, preserving
#      cloudsqlsuperuser. Migration keeps runtime as its sole custom role;
#      runtime and capture cleanup keep none.
#   3. Export NOVA_DB_BOOTSTRAP_USER and NOVA_DB_BOOTSTRAP_PASSWORD only in the
#      local operator shell.
#   4. Run `npx tsx scripts/infra/bootstrap-database-owner.ts` locally without
#      `--apply`, inspect its owner/version/config/dependency inventory, then
#      run the same command with `--apply`.
#      It transactionally creates pg_trgm/fuzzystrmatch/postgis/pgaudit, sets
#      runtime/migration/cleanup CONNECTION LIMIT 16/1/3, makes `nova-migrate`
#      the database owner, retains trusted Cloud-SQL-managed `postgres`
#      extension ownership, transfers temporary and legacy ownership, and
#      audits every result.
#   5. Grant any separately authorized operator access only after bootstrap;
#      bootstrap's `DROP OWNED` deliberately removes grants owned by the
#      temporary administrator.
#   6. Delete the temporary built-in administrator through Cloud SQL and verify
#      it is absent.
#   7. Verify each extension is reachable under IAM auth as the developer
#      user (a smoke query against `pg_extension`).
#   8. Run the capacity preflight; the already-capped fleet must drain to <=16
#      runtime sessions before migration or capture-cleanup Jobs run.
#
# The split exists because PostGIS specifically requires `cloudsqlsuperuser`
# per Cloud SQL's documented extension allowlist. Every subsequent schema
# migration runs as the dedicated migration database owner; runtime receives
# application DML and the isolated case-index DDL authority only.
# ---------------------------------------------------------------------------
echo "=== Phase 6: SKIPPED (manual — run the checked-in local CLI) ==="

# ---------------------------------------------------------------------------
# Phase 7 — Wire Cloud Run to Cloud SQL via Direct VPC Egress.
#
# `private-ranges-only` keeps non-RFC1918 traffic on Cloud Run's default
# egress; only the database connection routes through the VPC. NOVA_DB_USER is
# the truncated form (no .gserviceaccount.com) — Cloud SQL strips the suffix
# at create time and the connector appends it internally for IAM token
# exchange. The full form is what the project IAM policy grants reference.
#
# `connection.ts` uses @google-cloud/cloud-sql-connector, which resolves the
# private IP from NOVA_DB_INSTANCE_CONNECTION_NAME via the SQL Admin API at
# connection time. No NOVA_DB_HOST env var is needed. Both the service-level
# `--max` (which spans revisions) and revision-level `--max-instances` stay at
# four as soft outer controls. PostgreSQL's runtime login cap of 16 is the hard
# boundary for the current `4 * (pool 3 + listener 1)` demand; migration=1 and
# cleanup=3 are separate non-inherited login-role caps. NOVA_DB_WORKLOAD=service
# selects pool 3 and fails closed if a non-local deployment omits its workload.
# ---------------------------------------------------------------------------
echo "=== Phase 7: Wire Cloud Run to Cloud SQL ==="
run gcloud run services update "$CLOUD_RUN_SERVICE" \
	--region="$REGION" \
	--network="$NETWORK" \
	--subnet="$NETWORK" \
	--vpc-egress=private-ranges-only \
	--max="$CLOUD_RUN_MAX_INSTANCES" \
	--max-instances="$CLOUD_RUN_MAX_INSTANCES" \
	--update-env-vars="NOVA_DB_WORKLOAD=service,NOVA_DB_NAME=${DATABASE_NAME},NOVA_DB_USER=${RUNTIME_SA_DBUSER},NOVA_DB_INSTANCE_CONNECTION_NAME=${PROJECT_ID}:${REGION}:${INSTANCE_ID}"

# ---------------------------------------------------------------------------
# Phase 8 — Final verification.
# ---------------------------------------------------------------------------
echo "=== Phase 8: Final verification ==="
echo "--- Cloud SQL instance ---"
run gcloud sql instances describe "$INSTANCE_ID" \
	--format='yaml(name,databaseVersion,settings.tier,settings.edition,settings.availabilityType,settings.databaseFlags,settings.backupConfiguration.enabled,settings.backupConfiguration.startTime,settings.backupConfiguration.backupRetentionSettings,settings.backupConfiguration.pointInTimeRecoveryEnabled,settings.backupConfiguration.transactionLogRetentionDays,settings.ipConfiguration.ipv4Enabled,settings.ipConfiguration.privateNetwork,connectionName,ipAddresses)'

echo "--- Cloud Run service ---"
run gcloud run services describe "$CLOUD_RUN_SERVICE" --region="$REGION" \
	--format='yaml(metadata.annotations,spec.template.metadata.annotations,spec.template.spec.containers[0].env)'

echo "=== Provisioning complete ==="
