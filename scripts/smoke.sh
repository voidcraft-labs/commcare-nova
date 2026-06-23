#!/usr/bin/env bash
#
# Local + CI smoke runner.
#
# Stands up the hermetic stack the Playwright smoke suite needs and runs it:
#   1. local Postgres (the case store) via docker compose + Atlas migrations,
#   2. the Firestore emulator (project `demo-test`, fully offline),
#   3. seeds a user/session/apps into the emulator,
#   4. runs Playwright, which starts `next dev` pointed at both.
#
# No real GCP project, no prod credentials, no LLM spend. Extra args are passed
# through to Playwright, e.g.:
#   scripts/smoke.sh --project=public          # public checks only
#   scripts/smoke.sh e2e/tests/authed.spec.ts  # one file
#
# Requires: docker, the Atlas CLI on PATH, and a JDK (the Firestore emulator).
set -euo pipefail
cd "$(dirname "$0")/.."

# ── Smoke env ────────────────────────────────────────────────────────
# A throwaway secret — the seed signs the session cookie with it and `next dev`
# verifies with the same value. NEVER reuse the production secret here.
export GOOGLE_CLOUD_PROJECT="${GOOGLE_CLOUD_PROJECT:-demo-test}"
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-smoke-test-secret-do-not-use-in-prod}"
export BETTER_AUTH_URL="${BETTER_AUTH_URL:-http://localhost:3000}"
export SMOKE_BASE_URL="${SMOKE_BASE_URL:-http://localhost:3000}"
# Dummy OAuth creds: the suite never calls Google. sign-in/social only needs a
# non-empty client id to build the consent URL.
export GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-smoke-dummy.apps.googleusercontent.com}"
export GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:-smoke-dummy-secret}"
export NOVA_MEDIA_BUCKET="${NOVA_MEDIA_BUCKET:-demo-test-multimedia}"
# Pin 127.0.0.1, not `localhost`: on Linux CI runners `localhost` resolves to
# ::1 first, where the compose-published port (IPv4 only) isn't reachable —
# atlas/the app get "connection reset by peer" on [::1]:5432.
export NOVA_DB_LOCAL_URL="${NOVA_DB_LOCAL_URL:-postgres://nova:nova@127.0.0.1:5432/nova_cases?sslmode=disable}"

# ── 1+2. Case-store Postgres (compose) + migrations ──────────────────
# Not `npm run db:dev` — that script hardcodes a `localhost` URL for the Atlas
# step, which hits the ::1 trap above. Boot the container and migrate over the
# pinned IPv4 URL instead.
echo "[smoke] booting case-store Postgres + applying migrations…"
docker compose up -d --wait
atlas migrate apply --env testcontainer --url "$NOVA_DB_LOCAL_URL" --allow-dirty

# ── 3+4. Emulator → seed → Playwright ────────────────────────────────
# emulators:exec sets FIRESTORE_EMULATOR_HOST for everything it spawns, so the
# seed and the dev server share one offline Firestore. The emulator is torn down
# when the wrapped command exits (data is ephemeral — no cleanup needed).
echo "[smoke] starting Firestore emulator, seeding, running Playwright…"
node_modules/.bin/firebase emulators:exec \
  --only firestore \
  --project demo-test \
  "node_modules/.bin/tsx e2e/seed.ts && node_modules/.bin/playwright test $*"
