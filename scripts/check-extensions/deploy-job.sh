#!/usr/bin/env bash
# scripts/check-extensions/deploy-job.sh
#
# Deploy (or update) the Cloud Run extension-check job image.
#
# This script:
#   1. Builds the check container image from
#      `Dockerfile.check-extensions` via Cloud Build (so the build
#      runs in Google's infrastructure, not on the developer
#      laptop).
#   2. Deploys / updates the Cloud Run job
#      `check-postgres-extensions` in `us-central1` with the same
#      Direct VPC Egress + IAM auth shape as the migration job:
#      attached to the `default` network/subnet, runs as the
#      runtime service account, env-vars wired identical to the
#      migration job.
#
# The job's command + entry point come from
# `Dockerfile.check-extensions`'s `ENTRYPOINT` line. The job takes
# no arguments at execute time — verification has one operation.
#
# Run this script from a developer laptop or CI when the
# verification code or `Dockerfile.check-extensions` changes. It
# does NOT run the check itself —
# `npm run db:check-extensions` (or the equivalent execute-script
# wrapper) is the runtime invocation.
#
# Usage: ./scripts/check-extensions/deploy-job.sh

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants — single source for project / region / image identifiers
# ---------------------------------------------------------------------------
# Mirrors `scripts/migrate/deploy-job.sh` exactly except for the job
# name + image repo path. Two surfaces deployed via the same shape
# is a virtue, not a duplication concern — every constant here is
# the same operator-facing name as in the migration script's deploy.
readonly PROJECT_ID="commcare-nova"
readonly REGION="us-central1"
readonly NETWORK="default"
readonly JOB_NAME="check-postgres-extensions"
readonly IMAGE_REPO="us-central1-docker.pkg.dev/${PROJECT_ID}/cloud-run-source-deploy/${JOB_NAME}"
readonly RUNTIME_SA="51003905459-compute@developer.gserviceaccount.com"

# Database connection env vars — match Phase 6 of the runbook + the
# migration job's wiring exactly. The check job uses the same
# IAM-authenticated path as the main service.
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
# Build runs in Google's infrastructure (NOT on the developer
# laptop), so a slow uplink doesn't bottleneck the deploy. Cloud
# Build pushes the resulting image to Artifact Registry directly.
echo "=== Build image via Cloud Build ==="
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
IMAGE_TAG="${IMAGE_REPO}:${GIT_SHA}"
IMAGE_LATEST="${IMAGE_REPO}:latest"

# Cloud Build's `--config` flag does not accept a `-` stdin source
# in current gcloud (verified `gcloud builds submit --help`), so we
# write the build YAML to a temp file the gcloud CLI reads from.
# The temp file is cleaned up via trap so a failure mid-build still
# removes it.
CLOUDBUILD_YAML="$(mktemp -t cloudbuild-check-extensions.XXXXXX.yaml)"
trap 'rm -f "$CLOUDBUILD_YAML"' EXIT

cat >"$CLOUDBUILD_YAML" <<EOF
steps:
  - name: gcr.io/cloud-builders/docker
    args:
      - build
      - -f
      - Dockerfile.check-extensions
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

gcloud builds submit \
	--project="$PROJECT_ID" \
	--region="$REGION" \
	--config="$CLOUDBUILD_YAML" \
	.

# ---------------------------------------------------------------------------
# Deploy or update the Cloud Run job
# ---------------------------------------------------------------------------
#
# `--max-retries=0` so a failed check doesn't auto-retry — a
# missing extension is an operator-facing problem that demands
# investigation, not a transient network glitch.
#
# `--task-timeout=120s` (2 minutes) is plenty: the verification
# runs two `SELECT`s against system catalogs. If a check ever
# approaches this, something else is wrong (runaway DDL on the
# instance, etc.) and the timeout failing fast is the right
# signal.
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
	--task-timeout=120s \
	--quiet

echo "=== Job '${JOB_NAME}' deployed at image ${IMAGE_TAG} ==="
echo "Run a check via: ./scripts/check-extensions/execute-job.sh"
