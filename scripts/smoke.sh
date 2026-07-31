#!/usr/bin/env bash
#
# Local + CI smoke runner.
#
# Stands up the hermetic stack the Playwright smoke suite needs and runs it:
#   1. local Postgres (the case store) via docker compose + Kysely migrations,
#   2. seeds a user/session/apps into that Postgres,
#   3. runs Playwright, which builds + starts the production server pointed at it.
#
# No real GCP project, no prod credentials, no LLM spend. Extra args are passed
# through to Playwright, e.g.:
#   scripts/smoke.sh --project=public          # public checks only
#   scripts/smoke.sh e2e/tests/authed.spec.ts  # one file
#
# Requires: docker.
set -euo pipefail
cd "$(dirname "$0")/.."

# ── Smoke env ────────────────────────────────────────────────────────
# A throwaway secret — the seed signs the session cookie with it and the server
# verifies with the same value. NEVER reuse the production secret here.
export GOOGLE_CLOUD_PROJECT="${GOOGLE_CLOUD_PROJECT:-demo-test}"
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-smoke-test-secret-do-not-use-in-prod}"
export BETTER_AUTH_URL="${BETTER_AUTH_URL:-http://localhost:3000}"
export SMOKE_BASE_URL="${SMOKE_BASE_URL:-http://localhost:3000}"
# Tell playwright.config to manage its own server (vs `test:smoke:url`, which
# probes an already-running server and sets no flag).
export SMOKE_MANAGE_SERVER=1
# Dummy OAuth creds: the suite never calls Google. sign-in/social only needs a
# non-empty client id to build the consent URL.
export GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-smoke-dummy.apps.googleusercontent.com}"
export GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:-smoke-dummy-secret}"
export NOVA_MEDIA_BUCKET="${NOVA_MEDIA_BUCKET:-demo-test-multimedia}"
# Don't probe the GCE metadata server: the credential-free smoke env isn't on
# GCP, so google-auth (pulled in by the KMS / GCS clients) would emit a noisy
# MetadataLookupWarning. `none` skips the probe entirely (keeps the logs clean).
export METADATA_SERVER_DETECTION="${METADATA_SERVER_DETECTION:-none}"
# Keep the smoke logs clean: opt out of Next.js's anonymous CLI telemetry so the
# webServer's `next build` doesn't print its telemetry notice. Playwright merges
# this process env into the server it spawns (playwright.config.ts `webServer`).
export NEXT_TELEMETRY_DISABLED="${NEXT_TELEMETRY_DISABLED:-1}"
# Pin 127.0.0.1, not `localhost`: on Linux CI runners `localhost` resolves to
# ::1 first, where the compose-published port (IPv4 only) isn't reachable —
# the migrate runner / the app get "connection reset by peer" on [::1]:5432.
# The suite owns `nova_smoke`, NOT the `nova_cases` database `npm run dev` uses.
# Two reasons, both load-bearing: a smoke run would otherwise delete a
# developer's local apps, and it can no longer clean up after itself anyway —
# `app_change_fold_baselines` rows are immutable by design and RESTRICT their
# Project's delete, so once any seeded app has folded, a reused database can
# never be returned to a seedable state. Recreating it each run is what CI's
# fresh volume already gives us.
export NOVA_DB_LOCAL_URL="${NOVA_DB_LOCAL_URL:-postgres://nova:nova@127.0.0.1:5432/nova_smoke?sslmode=disable}"

# ── 1+2. Case-store Postgres (compose) + migrations ──────────────────
# Not `npm run db:dev` — that script hardcodes a `localhost` URL for the migrate
# step, which hits the ::1 trap above. Boot the container and migrate over the
# pinned IPv4 URL (already exported as NOVA_DB_LOCAL_URL, which the migrate
# runner reads) instead.
echo "[smoke] booting case-store Postgres…"
docker compose up -d --wait

# Recreate the suite's own database from scratch. The extensions come from the
# same init SQL compose runs for `nova_cases`; they are created by the
# superuser, since the migrate runner (a non-superuser) cannot CREATE EXTENSION.
case "$NOVA_DB_LOCAL_URL" in
  */nova_smoke*)
    echo "[smoke] recreating nova_smoke…"
    docker compose exec -T postgres psql -U nova -d postgres \
      -c "DROP DATABASE IF EXISTS nova_smoke WITH (FORCE);" \
      -c "CREATE DATABASE nova_smoke;" >/dev/null
    docker compose exec -T postgres psql -U nova -d nova_smoke \
      < lib/case-store/dev/init-extensions.sql >/dev/null
    ;;
  *)
    # An explicit NOVA_DB_LOCAL_URL means the caller chose the database; never
    # drop one this script did not create.
    echo "[smoke] using the caller's database; not recreating it."
    ;;
esac

# compose.yaml's healthcheck now probes over TCP, so the `--wait` above already
# guarantees Postgres accepts TCP queries. Keep a short retry as cheap insurance
# against any docker-proxy port-forward warmup; the migrate is idempotent.
echo "[smoke] applying case-store migrations…"
for attempt in $(seq 1 8); do
  if npm run db:migrate; then
    break
  fi
  if [ "$attempt" -eq 8 ]; then
    echo "[smoke] Postgres never became ready for TCP queries — giving up." >&2
    exit 1
  fi
  echo "[smoke] Postgres not ready yet (attempt $attempt/8); retrying in 2s…"
  sleep 2
done

# ── 3+4. Seed → Playwright ───────────────────────────────────────────
# Seed the local Postgres, then run Playwright (which builds + starts the
# production server). Extra args pass straight through to Playwright via "$@".
echo "[smoke] seeding local Postgres, running Playwright…"
# The seed is a server-side fixture writer and intentionally reaches
# `server-only` persistence services (for example, lookup-table creation).
# Resolve that marker to its no-op server condition instead of Node's
# client-import guard.
node_modules/.bin/tsx --conditions=react-server e2e/seed.ts
node_modules/.bin/playwright test "$@"
