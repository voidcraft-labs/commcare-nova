#!/usr/bin/env bash

# Provision Nova's least-privilege deployment, migration, audit, bucket-policy,
# and scheduled capture-maintenance identities. Plan-only by default.

set -euo pipefail

PROJECT="commcare-nova"
PROJECT_NUMBER="51003905459"
REGION="us-central1"
TRIGGER_ID="8d269c82-7de7-4b9f-a435-30b173f597b2"
INSTANCE="nova-cases"
REPOSITORY="cloud-run-source-deploy"
MEDIA_BUCKET="nova-multimedia-prod"
MEDIA_POLICY_ROLE_ID="novaMediaBucketPolicy"
CAPTURE_STORAGE_ROLE_ID="novaCaptureObjectMaintenance"
MEDIA_READER_ROLE_ID="novaMediaBucketReader"

BUILD_ACCOUNT="nova-build@${PROJECT}.iam.gserviceaccount.com"
MIGRATION_ACCOUNT="nova-migrate@${PROJECT}.iam.gserviceaccount.com"
RUNTIME_ACCOUNT="commcare-nova@${PROJECT}.iam.gserviceaccount.com"
MEDIA_POLICY_ACCOUNT="nova-media-policy@${PROJECT}.iam.gserviceaccount.com"
CAPTURE_CLEANUP_ACCOUNT="nova-capture-cleanup@${PROJECT}.iam.gserviceaccount.com"
AUDIT_ACCOUNT="nova-audit@${PROJECT}.iam.gserviceaccount.com"
CAPTURE_SCHEDULER_ACCOUNT="nova-capture-scheduler@${PROJECT}.iam.gserviceaccount.com"
BUILD_SERVICE_AGENT="service-${PROJECT_NUMBER}@gcp-sa-cloudbuild.iam.gserviceaccount.com"
SCHEDULER_SERVICE_AGENT="service-${PROJECT_NUMBER}@gcp-sa-cloudscheduler.iam.gserviceaccount.com"
MIGRATION_DB_USER="nova-migrate@${PROJECT}.iam"
RUNTIME_DB_USER="commcare-nova@${PROJECT}.iam"
CAPTURE_CLEANUP_DB_USER="nova-capture-cleanup@${PROJECT}.iam"
AUDIT_DB_USER="nova-audit@${PROJECT}.iam"

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

ensure_custom_role() {
	local role_id="$1"
	local title="$2"
	local description="$3"
	local permissions="$4"
	if gcloud iam roles describe "$role_id" \
		--project="$PROJECT" >/dev/null 2>&1; then
		run gcloud iam roles update "$role_id" \
			--project="$PROJECT" \
			--title="$title" \
			--description="$description" \
			--permissions="$permissions" \
			--stage=GA \
			--quiet
		return
	fi
	run gcloud iam roles create "$role_id" \
		--project="$PROJECT" \
		--title="$title" \
		--description="$description" \
		--permissions="$permissions" \
		--stage=GA \
		--quiet
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

# Enabling the API creates Google's Cloud Scheduler service agent. Do this
# before any IAM binding names that agent and before the build identity can run
# its first scheduler-bearing deployment. `services enable` is idempotent.
run gcloud services enable cloudscheduler.googleapis.com \
	--project="$PROJECT"

ensure_service_account "$BUILD_ACCOUNT" "nova-build" "Nova Cloud Build deployer"
ensure_service_account "$MIGRATION_ACCOUNT" "nova-migrate" "Nova database migrator"
ensure_service_account "$MEDIA_POLICY_ACCOUNT" "nova-media-policy" "Nova media bucket policy"
ensure_service_account "$CAPTURE_CLEANUP_ACCOUNT" "nova-capture-cleanup" "Nova capture cleanup worker"
ensure_service_account "$AUDIT_ACCOUNT" "nova-audit" "Nova canonical identity auditor"
ensure_service_account "$CAPTURE_SCHEDULER_ACCOUNT" "nova-capture-scheduler" "Nova capture cleanup scheduler"

for role in \
	roles/cloudscheduler.viewer \
	roles/developerconnect.readTokenAccessor \
	roles/logging.logWriter \
	roles/run.admin \
	roles/serviceusage.serviceUsageConsumer; do
	bind_project_role "$BUILD_ACCOUNT" "$role"
done
ensure_custom_role \
	"$MEDIA_READER_ROLE_ID" \
	"Nova media bucket reader" \
	"Read media bucket metadata for deployment prerequisite checks." \
	"storage.buckets.get"
run gcloud storage buckets add-iam-policy-binding "gs://${MEDIA_BUCKET}" \
	--member="serviceAccount:${BUILD_ACCOUNT}" \
	--role="projects/${PROJECT}/roles/${MEDIA_READER_ROLE_ID}" \
	--condition=None --quiet
# Remove obsolete scheduler-admin, ingress-maintenance, and media/scheduler
# actAs grants only after the simplified pipeline is serving. See deployment.md.
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
bind_act_as "$CAPTURE_CLEANUP_ACCOUNT"
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
bind_project_role "$AUDIT_ACCOUNT" roles/cloudsql.client
bind_project_role "$AUDIT_ACCOUNT" roles/cloudsql.instanceUser
ensure_custom_role \
	"$MEDIA_POLICY_ROLE_ID" \
	"Nova media bucket policy" \
	"Exact bucket metadata authority for lifecycle and CORS convergence." \
	"storage.buckets.get,storage.buckets.update"
ensure_custom_role \
	"$CAPTURE_STORAGE_ROLE_ID" \
	"Nova capture object maintenance" \
	"Exact capture object create, read, and delete authority." \
	"storage.objects.get,storage.objects.create,storage.objects.delete"
# Replace the whole bucket policy with its etag intact. This removes every
# stale role/condition variant for both bucket principals in the SAME atomic
# write that installs each sole intended custom-role binding. A read, parse,
# set, or verification failure is fatal; "grant absent" is represented by
# valid JSON with no matching member, never by swallowing a failed gcloud
# command.
capture_policy_dir="$(mktemp -d)"
capture_policy_before="${capture_policy_dir}/before.json"
capture_policy_after="${capture_policy_dir}/after.json"
capture_policy_verified="${capture_policy_dir}/verified.json"
cleanup_capture_policy_dir() {
	rm -f \
		"$capture_policy_before" \
		"$capture_policy_after" \
		"$capture_policy_verified"
	rmdir "$capture_policy_dir"
}
trap cleanup_capture_policy_dir EXIT
if ! gcloud storage buckets get-iam-policy "gs://${MEDIA_BUCKET}" \
	--format=json >"$capture_policy_before"; then
	printf 'Failed to read the media bucket IAM policy.\n' >&2
	exit 1
fi
capture_policy_role="projects/${PROJECT}/roles/${CAPTURE_STORAGE_ROLE_ID}"
media_policy_role="projects/${PROJECT}/roles/${MEDIA_POLICY_ROLE_ID}"
node "$(dirname "$0")/capture-bucket-policy.mjs" \
	render \
	"$MEDIA_BUCKET" \
	"$CAPTURE_CLEANUP_ACCOUNT" \
	"$MEDIA_POLICY_ACCOUNT" \
	"$capture_policy_role" \
	"$media_policy_role" \
	"$capture_policy_before" \
	"$capture_policy_after"
run gcloud storage buckets set-iam-policy \
	"gs://${MEDIA_BUCKET}" \
	"$capture_policy_after" \
	--quiet
if $APPLY; then
	if ! gcloud storage buckets get-iam-policy "gs://${MEDIA_BUCKET}" \
		--format=json >"$capture_policy_verified"; then
		printf 'Failed to verify the media bucket IAM policy.\n' >&2
		exit 1
	fi
else
	cp "$capture_policy_after" "$capture_policy_verified"
fi
node "$(dirname "$0")/capture-bucket-policy.mjs" \
	verify \
	"$MEDIA_BUCKET" \
	"$CAPTURE_CLEANUP_ACCOUNT" \
	"$MEDIA_POLICY_ACCOUNT" \
	"$capture_policy_role" \
	"$media_policy_role" \
	"$capture_policy_verified"
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
existing_audit_user="$(gcloud sql users list \
	--project="$PROJECT" \
	--instance="$INSTANCE" \
	--filter="name=${AUDIT_DB_USER}" \
	--format='value(name)')"
if [[ "$existing_audit_user" != "$AUDIT_DB_USER" ]]; then
	run gcloud sql users create "$AUDIT_DB_USER" \
		--project="$PROJECT" \
		--instance="$INSTANCE" \
		--type=CLOUD_IAM_SERVICE_ACCOUNT
fi
# Runtime, capture cleanup, and audit inherit no custom database role.
# `--database-roles` is intentionally omitted: Cloud SQL interprets this as an
# empty replacement set.
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
	--revoke-existing-roles \
	--quiet
run gcloud sql users assign-roles "$AUDIT_DB_USER" \
	--project="$PROJECT" \
	--instance="$INSTANCE" \
	--type=CLOUD_IAM_SERVICE_ACCOUNT \
	--revoke-existing-roles \
	--quiet

run gcloud beta builds triggers update developer-connect "$TRIGGER_ID" \
	--project="$PROJECT" \
	--region="$REGION" \
	--service-account="projects/${PROJECT}/serviceAccounts/${BUILD_ACCOUNT}"

printf '%s\n' \
	"Database bootstrap remains intentionally separate:" \
	"  ${RUNTIME_DB_USER}, ${CAPTURE_CLEANUP_DB_USER}, and ${AUDIT_DB_USER} have no custom parent role; only migration inherits ${RUNTIME_DB_USER}." \
	"  Run the checked-in privileged bootstrap dry-run, inspect its catalog inventory, then apply it before ordinary migrations."
