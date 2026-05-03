#!/usr/bin/env bash
# scripts/migrate/deploy-job.sh
#
# Deploy (or update) the Cloud Run migration job image.
#
# This script:
#   1. Builds the migration container image from `Dockerfile.migrate`
#      via Cloud Build (so the build runs in Google's infrastructure,
#      not on the developer laptop — important because the laptop
#      can't push large images quickly to Artifact Registry).
#   2. Deploys / updates the Cloud Run job `db-migrate` in
#      `us-central1` with the same Direct VPC Egress + IAM auth
#      shape as the main service: attached to the `default`
#      network/subnet via Direct VPC Egress, runs as the runtime
#      service account, env-vars wired identical to the main
#      service.
#
# The job's command + entry point come from `Dockerfile.migrate`'s
# `ENTRYPOINT ["node", "scripts/migrate/run.js"]`. The `--args`
# flag at execute time supplies the action (`latest` / `down` /
# `status`).
#
# Run this script from a developer laptop or CI when the migration
# code or schema files change. It does NOT run the migration —
# `npm run db:migrate` (or the equivalent execute-script wrapper)
# is the runtime invocation.
#
# Usage: ./scripts/migrate/deploy-job.sh

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants — single source for project / region / image identifiers
# ---------------------------------------------------------------------------
readonly PROJECT_ID="commcare-nova"
readonly REGION="us-central1"
readonly NETWORK="default"
readonly JOB_NAME="db-migrate"
readonly IMAGE_REPO="us-central1-docker.pkg.dev/${PROJECT_ID}/cloud-run-source-deploy/${JOB_NAME}"
readonly RUNTIME_SA="51003905459-compute@developer.gserviceaccount.com"

# Database connection env vars — match Phase 6 of the runbook + the
# Cloud Run service's wiring exactly. The migration job uses the
# same IAM-authenticated path as the main service.
readonly DB_NAME="nova_cases"
readonly DB_USER="51003905459-compute@developer"
readonly INSTANCE_CONNECTION_NAME="${PROJECT_ID}:${REGION}:nova-cases"

# ---------------------------------------------------------------------------
# Pre-flight: confirm gcloud context targets this project
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
# Build the image via Cloud Build
# ---------------------------------------------------------------------------
#
# The build runs in Google's infrastructure (NOT on the developer
# laptop), so a slow uplink doesn't bottleneck the deploy. Cloud
# Build pushes the resulting image to Artifact Registry directly.
#
# `--tag` pushes the `latest` tag plus a SHA-prefixed tag so a
# rollback can target the exact prior image; the SHA prefix comes
# from the current git commit (`git rev-parse --short HEAD`) so the
# tag is reproducible from the source tree.
echo "=== Build image via Cloud Build ==="
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
IMAGE_TAG="${IMAGE_REPO}:${GIT_SHA}"
IMAGE_LATEST="${IMAGE_REPO}:latest"

gcloud builds submit \
	--project="$PROJECT_ID" \
	--region="$REGION" \
	--config=- \
	. <<EOF
steps:
  - name: gcr.io/cloud-builders/docker
    args:
      - build
      - -f
      - Dockerfile.migrate
      - -t
      - ${IMAGE_TAG}
      - -t
      - ${IMAGE_LATEST}
      - .
images:
  - ${IMAGE_TAG}
  - ${IMAGE_LATEST}
options:
  logging: CLOUD_LOGGING_ONLY
EOF

# ---------------------------------------------------------------------------
# Deploy or update the Cloud Run job
# ---------------------------------------------------------------------------
#
# `gcloud run jobs deploy` is idempotent — it creates the job on
# the first run and updates it on subsequent runs.
#
# Network attachment matches the main service: `default`/`default`
# with Direct VPC Egress in `private-ranges-only` mode, so RFC1918
# traffic (the Cloud SQL connection) routes through the VPC and
# everything else uses default egress.
#
# `--service-account` pins the runtime SA — the same identity the
# main service runs as. Both share the IAM bindings the runbook's
# Phase 4 created (`roles/cloudsql.client` + `roles/cloudsql.instanceUser`).
#
# `--max-retries=0` so a failed migration doesn't auto-retry —
# migrations are not idempotent at the failure boundary, and the
# operator should investigate before re-running.
#
# `--task-timeout=600s` (10 minutes) is plenty for this stage's
# small migration set. Tier up later if any single migration
# starts approaching it.
echo "=== Deploy/update Cloud Run job '${JOB_NAME}' ==="
gcloud run jobs deploy "$JOB_NAME" \
	--image="$IMAGE_TAG" \
	--region="$REGION" \
	--project="$PROJECT_ID" \
	--service-account="$RUNTIME_SA" \
	--network="$NETWORK" \
	--subnet="$NETWORK" \
	--vpc-egress=private-ranges-only \
	--set-env-vars="NOVA_DB_NAME=${DB_NAME},NOVA_DB_USER=${DB_USER},NOVA_DB_INSTANCE_CONNECTION_NAME=${INSTANCE_CONNECTION_NAME}" \
	--max-retries=0 \
	--task-timeout=600s \
	--quiet

echo "=== Job '${JOB_NAME}' deployed at image ${IMAGE_TAG} ==="
echo "Run a migration via: ./scripts/migrate/execute-job.sh <latest|down|status>"
