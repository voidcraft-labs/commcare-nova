#!/usr/bin/env bash

# Provision Nova's least-privilege deployment, migration, bucket-policy, and
# scheduled capture-maintenance identities. Plan-only by default.

set -euo pipefail

PROJECT="commcare-nova"
PROJECT_NUMBER="51003905459"
REGION="us-central1"
TRIGGER_ID="8d269c82-7de7-4b9f-a435-30b173f597b2"
INSTANCE="nova-cases"
REPOSITORY="cloud-run-source-deploy"
MEDIA_BUCKET="nova-multimedia-prod"

BUILD_ACCOUNT="nova-build@${PROJECT}.iam.gserviceaccount.com"
MIGRATION_ACCOUNT="nova-migrate@${PROJECT}.iam.gserviceaccount.com"
RUNTIME_ACCOUNT="commcare-nova@${PROJECT}.iam.gserviceaccount.com"
MEDIA_POLICY_ACCOUNT="nova-media-policy@${PROJECT}.iam.gserviceaccount.com"
CAPTURE_CLEANUP_ACCOUNT="nova-capture-cleanup@${PROJECT}.iam.gserviceaccount.com"
CAPTURE_SCHEDULER_ACCOUNT="nova-capture-scheduler@${PROJECT}.iam.gserviceaccount.com"
BUILD_SERVICE_AGENT="service-${PROJECT_NUMBER}@gcp-sa-cloudbuild.iam.gserviceaccount.com"
SCHEDULER_SERVICE_AGENT="service-${PROJECT_NUMBER}@gcp-sa-cloudscheduler.iam.gserviceaccount.com"
MIGRATION_DB_USER="nova-migrate@${PROJECT}.iam"
RUNTIME_DB_USER="commcare-nova@${PROJECT}.iam"
CAPTURE_CLEANUP_DB_USER="nova-capture-cleanup@${PROJECT}.iam"

APPLY=false
case "${1:-}" in
	"") ;;
	--apply) APPLY=true ;;
	--help)
		printf '%s\n' \
			"Usage: $0 [--apply]" \
			"" \
			"Without --apply, print the exact GCP mutations."
		exit 0
		;;
	*)
		printf 'Unknown argument: %s\n' "$1" >&2
		exit 2
		;;
esac

run() {
	if $APPLY; then
		"$@"
		return
	fi
	printf 'PLAN'
	printf ' %q' "$@"
	printf '\n'
}

ensure_service_account() {
	local email="$1"
	local account_id="$2"
	local display_name="$3"
	if gcloud iam service-accounts describe "$email" \
		--project="$PROJECT" >/dev/null 2>&1; then
		return
	fi
	run gcloud iam service-accounts create "$account_id" \
		--project="$PROJECT" \
		--display-name="$display_name"
}

bind_project_role() {
	local account="$1"
	local role="$2"
	run gcloud projects add-iam-policy-binding "$PROJECT" \
		--member="serviceAccount:${account}" \
		--role="$role" \
		--condition=None \
		--quiet
}

bind_secret_access() {
	local account="$1"
	local secret="$2"
	run gcloud secrets add-iam-policy-binding "$secret" \
		--project="$PROJECT" \
		--member="serviceAccount:${account}" \
		--role=roles/secretmanager.secretAccessor \
		--condition=None \
		--quiet
}

bind_act_as() {
	local target="$1"
	run gcloud iam service-accounts add-iam-policy-binding "$target" \
		--project="$PROJECT" \
		--member="serviceAccount:${BUILD_ACCOUNT}" \
		--role=roles/iam.serviceAccountUser \
		--condition=None \
		--quiet
}

ensure_service_account "$BUILD_ACCOUNT" "nova-build" "Nova Cloud Build deployer"
ensure_service_account "$MIGRATION_ACCOUNT" "nova-migrate" "Nova database migrator"
ensure_service_account "$MEDIA_POLICY_ACCOUNT" "nova-media-policy" "Nova media bucket policy"
ensure_service_account "$CAPTURE_CLEANUP_ACCOUNT" "nova-capture-cleanup" "Nova capture cleanup worker"
ensure_service_account "$CAPTURE_SCHEDULER_ACCOUNT" "nova-capture-scheduler" "Nova capture cleanup scheduler"

for role in \
	roles/cloudscheduler.admin \
	roles/developerconnect.readTokenAccessor \
	roles/logging.logWriter \
	roles/run.admin \
	roles/serviceusage.serviceUsageConsumer; do
	bind_project_role "$BUILD_ACCOUNT" "$role"
done
run gcloud artifacts repositories add-iam-policy-binding "$REPOSITORY" \
	--project="$PROJECT" \
	--location="$REGION" \
	--member="serviceAccount:${BUILD_ACCOUNT}" \
	--role=roles/artifactregistry.writer \
	--condition=None \
	--quiet

for secret in \
	nova-sentry \
	nova-google_maps_api_key \
	nova-server-actions-key; do
	bind_secret_access "$BUILD_ACCOUNT" "$secret"
done

bind_act_as "$MIGRATION_ACCOUNT"
bind_act_as "$RUNTIME_ACCOUNT"
bind_act_as "$MEDIA_POLICY_ACCOUNT"
bind_act_as "$CAPTURE_CLEANUP_ACCOUNT"
bind_act_as "$CAPTURE_SCHEDULER_ACCOUNT"
run gcloud iam service-accounts add-iam-policy-binding "$BUILD_ACCOUNT" \
	--project="$PROJECT" \
	--member="serviceAccount:${BUILD_SERVICE_AGENT}" \
	--role=roles/iam.serviceAccountTokenCreator \
	--condition=None \
	--quiet

bind_project_role "$MIGRATION_ACCOUNT" roles/cloudsql.client
bind_project_role "$MIGRATION_ACCOUNT" roles/cloudsql.instanceUser
bind_project_role "$CAPTURE_CLEANUP_ACCOUNT" roles/cloudsql.client
bind_project_role "$CAPTURE_CLEANUP_ACCOUNT" roles/cloudsql.instanceUser
run gcloud storage buckets add-iam-policy-binding "gs://${MEDIA_BUCKET}" \
	--member="serviceAccount:${MEDIA_POLICY_ACCOUNT}" \
	--role=roles/storage.admin \
	--condition=None
run gcloud storage buckets add-iam-policy-binding "gs://${MEDIA_BUCKET}" \
	--member="serviceAccount:${CAPTURE_CLEANUP_ACCOUNT}" \
	--role=roles/storage.objectUser \
	--condition=None
run gcloud iam service-accounts add-iam-policy-binding "$CAPTURE_SCHEDULER_ACCOUNT" \
	--project="$PROJECT" \
	--member="serviceAccount:${SCHEDULER_SERVICE_AGENT}" \
	--role=roles/iam.serviceAccountTokenCreator \
	--condition=None \
	--quiet

existing_migration_user="$(gcloud sql users list \
	--project="$PROJECT" \
	--instance="$INSTANCE" \
	--filter="name=${MIGRATION_DB_USER}" \
	--format='value(name)')"
if [[ "$existing_migration_user" != "$MIGRATION_DB_USER" ]]; then
	run gcloud sql users create "$MIGRATION_DB_USER" \
		--project="$PROJECT" \
		--instance="$INSTANCE" \
		--type=CLOUD_IAM_SERVICE_ACCOUNT
fi
existing_capture_cleanup_user="$(gcloud sql users list \
	--project="$PROJECT" \
	--instance="$INSTANCE" \
	--filter="name=${CAPTURE_CLEANUP_DB_USER}" \
	--format='value(name)')"
if [[ "$existing_capture_cleanup_user" != "$CAPTURE_CLEANUP_DB_USER" ]]; then
	run gcloud sql users create "$CAPTURE_CLEANUP_DB_USER" \
		--project="$PROJECT" \
		--instance="$INSTANCE" \
		--type=CLOUD_IAM_SERVICE_ACCOUNT
fi
# Runtime must not inherit any custom database role. In particular, remove the
# legacy Compute-default owner membership before the ownership bootstrap audits
# and retires that role. `--database-roles` is intentionally omitted: Cloud SQL
# interprets this as an empty replacement set.
run gcloud sql users assign-roles "$RUNTIME_DB_USER" \
	--project="$PROJECT" \
	--instance="$INSTANCE" \
	--type=CLOUD_IAM_SERVICE_ACCOUNT \
	--revoke-existing-roles \
	--quiet
run gcloud sql users assign-roles "$MIGRATION_DB_USER" \
	--project="$PROJECT" \
	--instance="$INSTANCE" \
	--type=CLOUD_IAM_SERVICE_ACCOUNT \
	--database-roles="$RUNTIME_DB_USER" \
	--revoke-existing-roles \
	--quiet
run gcloud sql users assign-roles "$CAPTURE_CLEANUP_DB_USER" \
	--project="$PROJECT" \
	--instance="$INSTANCE" \
	--type=CLOUD_IAM_SERVICE_ACCOUNT \
	--database-roles="$RUNTIME_DB_USER" \
	--revoke-existing-roles \
	--quiet

run gcloud beta builds triggers update developer-connect "$TRIGGER_ID" \
	--project="$PROJECT" \
	--region="$REGION" \
	--service-account="projects/${PROJECT}/serviceAccounts/${BUILD_ACCOUNT}"

printf '%s\n' \
	"Database bootstrap remains intentionally separate:" \
	"  ${RUNTIME_DB_USER} has no custom parent role; migration and capture cleanup inherit only ${RUNTIME_DB_USER}." \
	"  The checked-in bootstrap must transfer and retire the legacy database role before the first split-identity migration." \
	"  Verify that prerequisite with the checked-in S02c runbook before merging."
