#!/usr/bin/env bash
# scripts/migrate/execute-job.sh
#
# Execute the Cloud Run migration job. Wraps `gcloud run jobs
# execute` with the deploy-time defaults from
# `scripts/migrate/deploy-job.sh` so the runtime invocation stays
# short.
#
# This is the script `npm run db:migrate` / `db:rollback` /
# `db:status` invoke; it assumes the job has already been deployed
# via `deploy-job.sh`. Re-deploy when the migration code or
# schema files change; just execute when the migration set is
# unchanged but a new run is needed.
#
# Usage: ./scripts/migrate/execute-job.sh <latest|down|status>

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants — match deploy-job.sh
# ---------------------------------------------------------------------------
readonly PROJECT_ID="commcare-nova"
readonly REGION="us-central1"
readonly JOB_NAME="db-migrate"

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
ACTION="${1:-}"
case "$ACTION" in
	latest|down|status) ;;
	*)
		echo "usage: $0 <latest|down|status>" >&2
		exit 1
		;;
esac

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
# reflects the migration's outcome so CI / scripted callers see
# the right success / failure state.
#
# `--update-args` overrides the job's command-line args for this
# execution only. The job's deploy step doesn't pin a default
# action; the action is supplied per-execution to keep the
# `latest` / `down` / `status` paths visibly distinct in audit
# logs.
echo "=== Execute job '${JOB_NAME}' with action '${ACTION}' ==="
gcloud run jobs execute "$JOB_NAME" \
	--region="$REGION" \
	--project="$PROJECT_ID" \
	--update-args="$ACTION" \
	--wait

echo "=== Job execution complete ==="
