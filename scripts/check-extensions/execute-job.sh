#!/usr/bin/env bash
# scripts/check-extensions/execute-job.sh
#
# Execute the Cloud Run extension-check job. Wraps `gcloud run jobs
# execute` with the deploy-time defaults from
# `scripts/check-extensions/deploy-job.sh` so the runtime invocation
# stays short.
#
# This is the script `npm run db:check-extensions` invokes; it
# assumes the job has already been deployed via `deploy-job.sh`.
# Re-deploy when the verification code or `Dockerfile.check-extensions`
# changes; just execute when the deployed image is current but a
# new run is needed (e.g. after a Cloud SQL re-provisioning that
# might have affected the extension allowlist).
#
# Usage: ./scripts/check-extensions/execute-job.sh

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants — match deploy-job.sh
# ---------------------------------------------------------------------------
readonly PROJECT_ID="commcare-nova"
readonly REGION="us-central1"
readonly JOB_NAME="check-postgres-extensions"

# ---------------------------------------------------------------------------
# Pre-flight: confirm gcloud context
# ---------------------------------------------------------------------------
actual_project="$(gcloud config get-value project 2>/dev/null)"
if [[ "$actual_project" != "$PROJECT_ID" ]]; then
	echo "ERROR: gcloud project is '$actual_project', expected '$PROJECT_ID'." >&2
	echo "Run: gcloud config set project $PROJECT_ID" >&2
	exit 1
fi

# ---------------------------------------------------------------------------
# Execute the job
# ---------------------------------------------------------------------------
#
# `--wait` blocks until the job finishes — the script's exit code
# reflects the check's outcome so CI / scripted callers see the
# right success / failure state. The check writes its formatted
# report to the job's stdout (success) / stderr (failure); both
# stream into Cloud Logging and surface in `gcloud run jobs
# executions describe`.
#
# No `--update-args` because the verification has one operation;
# unlike the migration job which takes `latest` / `down` / `status`,
# the check is single-action.
echo "=== Execute job '${JOB_NAME}' ==="
gcloud run jobs execute "$JOB_NAME" \
	--region="$REGION" \
	--project="$PROJECT_ID" \
	--wait

echo "=== Job execution complete ==="
