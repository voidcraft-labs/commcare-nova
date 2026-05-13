#!/usr/bin/env bash
# Launch Claude Code with the Nova plugin pointed at a locally running
# Nova server instead of production.
#
# ## Why this script lives here, not in the plugin repo
#
# The shipped plugin's committed `.mcp.json` pins the MCP URL to
# `https://mcp.commcare.app/mcp` by design — no env-var substitution, no
# interpolation. That makes the published artifact immutable from the
# user's environment, so an attacker who gains the ability to set env
# vars on an end user's machine cannot redirect Nova to a man-in-the-
# middle server and exfiltrate prompts / PHI.
#
# Developers still need a way to run the same plugin code against
# `localhost`. That's a Nova-server concern (the Nova app + docs + MCP
# implementation all live in this repo), so the dev launcher belongs
# here too — the published plugin stays a flat data payload with no
# executable scripts.
#
# This script materializes a gitignored `.dev-plugin/` overlay inside
# the plugin repo that copies every plugin file from the source of
# truth and writes its own `.mcp.json` pointing at the dev URL, then
# execs `claude` with `--plugin-dir` set to the overlay.
#
# The overlay is a COPY rather than a symlink tree — Claude Code
# canonicalizes the path of `.claude-plugin/plugin.json` when it
# resolves the plugin root, so a symlinked `.claude-plugin/` would
# `realpath` back to the shipping plugin directory and the overlay's
# `.mcp.json` would never be read. Only the generated `.mcp.json`
# differs between the overlay and the shipping plugin; edits to
# skills/agents require a re-run of this script (or `/reload-plugins`
# inside Claude Code once the overlay has been rebuilt).
#
# ## Locating the plugin repo
#
# Defaults to `<commcare-nova>/../nova-plugin` (a sibling clone), which
# is the standard layout. Override with `--nova-plugin <path>` if the
# plugin lives elsewhere on your machine. Errors if neither resolves to
# a Claude plugin root.
#
# ## Usage
#
#   ./scripts/nova-plugin-dev.sh                           # sibling nova-plugin, localhost:3000 Nova, OAuth
#   ./scripts/nova-plugin-dev.sh --nova-plugin ~/code/nova-plugin
#   NOVA_MCP_URL=https://staging.example.com/api/mcp ./scripts/nova-plugin-dev.sh
#   ./scripts/nova-plugin-dev.sh --resume <id>             # extra args forward to `claude`
#
#   # Test the API-key override flow (prod docs document this trick):
#   NOVA_API_KEY=sk-nova-v1-XXX ./scripts/nova-plugin-dev.sh
#   ./scripts/nova-plugin-dev.sh --api-key sk-nova-v1-XXX
#
# ## API-key mode
#
# When `--api-key` (or `NOVA_API_KEY`) is set, the script also registers
# a user-scope MCP entry named `nova` pointing at the same dev URL as
# the overlay's `.mcp.json`, with `Authorization: Bearer <key>` baked
# in. Claude Code dedupes MCP entries by URL match — same URL on the
# overlay (plugin scope, OAuth) and the user-scope entry (API-key, with
# bearer) means the user-scope wins. That's the same override trick
# the production docs document at `docs.commcare.app/mcp/api-keys`,
# now testable end-to-end against localhost.
#
# A trap removes the user-scope entry on exit so subsequent OAuth-mode
# launches start clean. Ctrl-C, normal exit, and signal kills all
# trigger the cleanup.
#
# ## Prerequisites
#
# - Nova's Next.js dev server running: `npm run dev` in this repo
#   (default: http://localhost:3000).
# - The nova-plugin repo cloned (https://github.com/voidcraft-labs/nova-plugin).
# - `claude` CLI on PATH.
# - For API-key mode: a freshly-minted key from
#   `http://localhost:3000/settings` while signed in to the local dev
#   server (the key only authenticates against the dev DB, not prod).

set -euo pipefail

# Resolve commcare-nova root from this script's location so the launcher
# works regardless of the caller's working directory.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
nova_app_root="$(cd "$script_dir/.." && pwd)"

# Default plugin location: sibling of commcare-nova. Mirrors the dev
# layout where `nova-plugin` and `commcare-nova` are both checked out
# under the same parent directory.
default_plugin_dir="$(cd "$nova_app_root/.." && pwd)/nova-plugin"

# Pre-parse our own flags out of `$@` so the remaining argv can be
# forwarded to `claude` verbatim. The flag may appear at any position.
plugin_root=""
api_key=""
forward_args=()
while [[ $# -gt 0 ]]; do
	case "$1" in
		--nova-plugin)
			if [[ -z "${2:-}" ]]; then
				echo "error: --nova-plugin requires a path argument" >&2
				exit 1
			fi
			plugin_root="$2"
			shift 2
			;;
		--nova-plugin=*)
			plugin_root="${1#*=}"
			shift
			;;
		--api-key)
			if [[ -z "${2:-}" ]]; then
				echo "error: --api-key requires a key argument" >&2
				exit 1
			fi
			api_key="$2"
			shift 2
			;;
		--api-key=*)
			api_key="${1#*=}"
			shift
			;;
		*)
			forward_args+=("$1")
			shift
			;;
	esac
done

# Env-var fallback so `NOVA_API_KEY=… ./script.sh` works the same as
# `--api-key …`. The flag wins if both are present.
api_key="${api_key:-${NOVA_API_KEY:-}}"

plugin_root="${plugin_root:-$default_plugin_dir}"

# Resolve and validate. We canonicalize via `cd` so the overlay path
# below is absolute even if the user passed a relative `--nova-plugin`.
# Stash the requested value first — a failed-cd subshell returns the
# empty string and we'd lose the user's input from the error message.
requested_plugin_root="$plugin_root"
if ! plugin_root="$(cd "$plugin_root" 2>/dev/null && pwd)"; then
	echo "error: nova-plugin path does not exist: ${requested_plugin_root}" >&2
	echo "       clone https://github.com/voidcraft-labs/nova-plugin or pass --nova-plugin <path>" >&2
	exit 1
fi

if [[ ! -f "$plugin_root/.claude-plugin/plugin.json" ]]; then
	echo "error: $plugin_root does not look like the nova-plugin repo" >&2
	echo "       (missing .claude-plugin/plugin.json)" >&2
	echo "       clone https://github.com/voidcraft-labs/nova-plugin or pass --nova-plugin <path>" >&2
	exit 1
fi

overlay_root="$plugin_root/.dev-plugin"

# Default to the Next.js dev route. Note the `/api/mcp` path — in
# production a host-level rewrite exposes the endpoint at `/mcp`, but
# locally we hit the Next route directly. Mirrors `MCP_RESOURCE_URL` in
# `lib/hostnames.ts`.
dev_url="${NOVA_MCP_URL:-http://localhost:3000/api/mcp}"

# Rebuild the overlay from scratch every launch so stale files from a
# prior plugin layout can't linger. Cheap — the plugin payload is small
# text files.
rm -rf "$overlay_root"
mkdir -p "$overlay_root"

# Copy each top-level plugin artifact into the overlay. Anything not in
# this list is deliberately omitted — notably `.mcp.json`, which we
# regenerate below with the dev URL. `cp -R` makes the overlay a real
# plugin root so Claude Code's `realpath` on `.claude-plugin/plugin.json`
# resolves inside the overlay, not back into the shipping plugin
# directory.
for item in .claude-plugin agents skills README.md LICENSE; do
	if [[ -e "$plugin_root/$item" ]]; then
		cp -R "$plugin_root/$item" "$overlay_root/$item"
	fi
done

# Write the dev-only `.mcp.json`. Keeping the schema aligned with the
# committed file (same `type`, same server key) so Claude Code treats
# the overlay as a drop-in replacement for the shipped plugin.
cat >"$overlay_root/.mcp.json" <<EOF
{
  "mcpServers": {
    "nova": {
      "type": "http",
      "url": "$dev_url"
    }
  }
}
EOF

echo "Nova plugin: $plugin_root"
echo "Overlay:     $overlay_root"
echo "MCP URL:     $dev_url"

# API-key override: register a user-scope MCP entry at the SAME dev URL
# as the overlay so Claude Code's URL-match dedup picks the user-scope
# (with bearer) over the overlay's plugin-scope entry (OAuth). Same
# mechanism the prod docs describe; this just runs it against localhost
# so we can validate the path without standing up an interactive OAuth
# flow against dev.
#
# Cleanup trap removes the entry whether the script exits normally or
# gets Ctrl-C'd. Without the trap, an OAuth-mode launch after an
# API-key launch would still see the user-scope override and silently
# keep using the stale (possibly revoked) key. `claude mcp remove`
# swallows "not found" via `|| true` so repeated cleanups are
# idempotent. Pre-remove first in case a prior run died before its
# trap fired (disk full, kernel kill -9, power loss).
if [[ -n "$api_key" ]]; then
	claude mcp remove nova --scope user >/dev/null 2>&1 || true
	claude mcp add nova --transport http "$dev_url" \
		--header "Authorization: Bearer ${api_key}" \
		--scope user >/dev/null
	trap 'claude mcp remove nova --scope user >/dev/null 2>&1 || true' EXIT
	echo "Auth:        API-key override (user-scope nova → ${dev_url})"
else
	echo "Auth:        OAuth (plugin-scope nova → ${dev_url})"
fi
echo

# `claude` runs as a child rather than via `exec` — `exec` replaces the
# shell process, which means the `EXIT` trap above (registered on the
# shell) never fires. Foreground call lets bash keep ownership of the
# process so the trap runs on every exit shape: normal claude quit,
# Ctrl-C, SIGTERM, panic. SIGINT from Ctrl-C goes to the foreground
# process group on macOS/Linux, so claude receives the signal and
# exits cleanly; bash then runs the trap on its own way out. The
# `+`-guarded expansion handles an empty array correctly under `set -u`
# on bash 3.2 (macOS default) — bare `"${arr[@]}"` would unbound-error.
claude --plugin-dir "$overlay_root" ${forward_args[@]+"${forward_args[@]}"}
