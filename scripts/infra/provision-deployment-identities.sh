#!/usr/bin/env bash

# Provision the two durable deployment identities Nova adds to its existing
# runtime identity. Plan-only by default; pass --apply to mutate GCP.

set -euo pipefail

PROJECT="commcare-nova"
PROJECT_NUMBER="51003905459"
REGION="us-central1"
TRIGGER_ID="8d269c82-7de7-4b9f-a435-30b173f597b2"
INSTANCE="nova-cases"
REPOSITORY="cloud-run-source-deploy"

BUILD_ACCOUNT="nova-build@${PROJECT}.iam.gserviceaccount.com"
MIGRATION_ACCOUNT="nova-migrate@${PROJECT}.iam.gserviceaccount.com"
RUNTIME_ACCOUNT="commcare-nova@${PROJECT}.iam.gserviceaccount.com"
BUILD_SERVICE_AGENT="service-${PROJECT_NUMBER}@gcp-sa-cloudbuild.iam.gserviceaccount.com"
MIGRATION_DB_USER="nova-migrate@${PROJECT}.iam"

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

for role in \
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
run gcloud iam service-accounts add-iam-policy-binding "$BUILD_ACCOUNT" \
	--project="$PROJECT" \
	--member="serviceAccount:${BUILD_SERVICE_AGENT}" \
	--role=roles/iam.serviceAccountTokenCreator \
	--condition=None \
	--quiet

bind_project_role "$MIGRATION_ACCOUNT" roles/cloudsql.client
bind_project_role "$MIGRATION_ACCOUNT" roles/cloudsql.instanceUser

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

run gcloud beta builds triggers update developer-connect "$TRIGGER_ID" \
	--project="$PROJECT" \
	--region="$REGION" \
	--service-account="projects/${PROJECT}/serviceAccounts/${BUILD_ACCOUNT}"

printf '%s\n' \
	"Database bootstrap remains intentionally separate:" \
	"  ${MIGRATION_DB_USER} must own database nova_cases and inherit both current object-owner roles before the first split-identity migration." \
	"  Verify that prerequisite with the checked-in S02c runbook before merging."
