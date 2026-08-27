#!/usr/bin/env bash
#
# Hermetic local React profiling runner.
#
# Owns a dedicated Postgres database, an authenticated loopback-only DevTools
# daemon, a Next development server, and one headed Playwright browser. The
# default scenario records a small Builder interaction and exports both the raw
# React DevTools JSON and Nova's text analysis. Extra arguments pass through to
# Playwright so future profiling sessions can select another spec or grep.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077

profile_state_dir="$(mktemp -d "${TMPDIR:-/tmp}/nova-react-profile.XXXXXX")"
profile_server_log="$profile_state_dir/next-dev.log"
profile_server_pid=""

free_loopback_port() {
	node -e 'const net = require("node:net"); const server = net.createServer(); server.listen(0, "127.0.0.1", () => { console.log(server.address().port); server.close(); });'
}

profile_app_port="${NOVA_REACT_PROFILE_APP_PORT:-$(free_loopback_port)}"

if ! [[ "$profile_app_port" =~ ^[0-9]+$ ]] ||
	(( profile_app_port < 1024 || profile_app_port > 65535 )); then
	echo "NOVA_REACT_PROFILE_APP_PORT must be an integer from 1024 to 65535." >&2
	exit 1
fi

profile_bridge_port="${NOVA_REACT_PROFILE_PORT:-$(free_loopback_port)}"
if [[ "$profile_bridge_port" == "$profile_app_port" ]]; then
	profile_bridge_port="$(free_loopback_port)"
fi
if ! [[ "$profile_bridge_port" =~ ^[0-9]+$ ]] ||
	(( profile_bridge_port < 1024 || profile_bridge_port > 65535 )); then
	echo "NOVA_REACT_PROFILE_PORT must be an integer from 1024 to 65535." >&2
	exit 1
fi
profile_origin="http://127.0.0.1:${profile_app_port}"
profile_stamp="$(date +%Y%m%d-%H%M%S)"

export NOVA_REACT_PROFILE=1
export NOVA_REACT_PROFILE_PORT="$profile_bridge_port"
export NOVA_REACT_PROFILE_TOKEN="${NOVA_REACT_PROFILE_TOKEN:-$(
	node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'
)}"
export NOVA_REACT_PROFILE_ORIGIN="$profile_origin"
export NOVA_REACT_PROFILE_STATE_DIR="$profile_state_dir"
export NOVA_REACT_PROFILE_OUTPUT="${NOVA_REACT_PROFILE_OUTPUT:-react-profiles/${profile_stamp}-builder-smoke.json}"

profile_cli() {
	node_modules/.bin/agent-react-devtools "$@" "--state-dir=$profile_state_dir"
}

cleanup_profile() {
	local status=$?
	trap - EXIT INT TERM
	set +e
	if [[ -n "$profile_server_pid" ]] && kill -0 "$profile_server_pid" 2>/dev/null; then
		kill -TERM "$profile_server_pid" 2>/dev/null
		for _ in {1..30}; do
			kill -0 "$profile_server_pid" 2>/dev/null || break
			sleep 0.1
		done
		kill -KILL "$profile_server_pid" 2>/dev/null
		wait "$profile_server_pid" 2>/dev/null
	fi
	profile_cli stop >/dev/null 2>&1
	case "$profile_state_dir" in
		"${TMPDIR:-/tmp}"/nova-react-profile.*) rm -rf "$profile_state_dir" ;;
	esac
	exit "$status"
}
trap cleanup_profile EXIT INT TERM

export GOOGLE_CLOUD_PROJECT="${GOOGLE_CLOUD_PROJECT:-demo-test}"
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-react-profile-secret-do-not-use-in-prod}"
export BETTER_AUTH_URL="${BETTER_AUTH_URL:-$profile_origin}"
export SMOKE_BASE_URL="${SMOKE_BASE_URL:-$profile_origin}"
export GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-profile-dummy.apps.googleusercontent.com}"
export GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:-profile-dummy-secret}"
export NOVA_MEDIA_BUCKET="${NOVA_MEDIA_BUCKET:-demo-test-multimedia}"
export METADATA_SERVER_DETECTION="${METADATA_SERVER_DETECTION:-none}"
export NEXT_TELEMETRY_DISABLED="${NEXT_TELEMETRY_DISABLED:-1}"
export NOVA_DB_LOCAL_URL="${NOVA_DB_LOCAL_URL:-postgres://nova:nova@127.0.0.1:5432/nova_react_profile?sslmode=disable}"

if ! node -e '
  const url = new URL(process.env.NOVA_DB_LOCAL_URL);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (!loopback || url.pathname !== "/nova_react_profile") process.exit(1);
'; then
	echo "React profiling requires the loopback nova_react_profile database." >&2
	exit 1
fi

echo "[react-profile] checking the pinned hardening patch"
node scripts/harden-agent-react-devtools.mjs
node scripts/check-node.mjs

echo "[react-profile] booting local Postgres"
docker compose up -d --wait

echo "[react-profile] recreating nova_react_profile"
docker compose exec -T postgres psql -U nova -d postgres \
	-c "DROP DATABASE IF EXISTS nova_react_profile WITH (FORCE);" \
	-c "CREATE DATABASE nova_react_profile;" >/dev/null
docker compose exec -T postgres psql -U nova -d nova_react_profile \
	< lib/case-store/dev/init-extensions.sql >/dev/null

echo "[react-profile] applying migrations and seeding the Builder fixture"
npm run db:migrate
node_modules/.bin/tsx --conditions=react-server e2e/seed.ts

mkdir -p "$(dirname "$NOVA_REACT_PROFILE_OUTPUT")"

echo "[react-profile] starting the private DevTools daemon on a random loopback port"
profile_cli start "--port=$profile_bridge_port"

echo "[react-profile] starting Next development server at $profile_origin"
node_modules/.bin/next dev \
	--hostname 127.0.0.1 \
	--port "$profile_app_port" \
	>"$profile_server_log" 2>&1 &
profile_server_pid=$!

server_ready=0
for _ in {1..120}; do
	if curl -fsS "$profile_origin/" >/dev/null 2>&1; then
		server_ready=1
		break
	fi
	if ! kill -0 "$profile_server_pid" 2>/dev/null; then
		break
	fi
	sleep 1
done
if [[ "$server_ready" -ne 1 ]]; then
	echo "[react-profile] Next did not become ready. Recent log output:" >&2
	tail -n 80 "$profile_server_log" >&2
	exit 1
fi

echo "[react-profile] running the automated profile scenario"
if ! node_modules/.bin/playwright test \
	--config=e2e/react-profile/playwright.config.ts "$@"; then
	echo "[react-profile] Profile scenario failed. Recent Next log output:" >&2
	tail -n 80 "$profile_server_log" >&2
	exit 1
fi

echo "[react-profile] analyzing $NOVA_REACT_PROFILE_OUTPUT"
python3 scripts/analyze-react-profile.py "$NOVA_REACT_PROFILE_OUTPUT" \
	| tee "${NOVA_REACT_PROFILE_OUTPUT%.json}.txt"

echo "[react-profile] raw profile: $NOVA_REACT_PROFILE_OUTPUT"
echo "[react-profile] analysis: ${NOVA_REACT_PROFILE_OUTPUT%.json}.txt"
