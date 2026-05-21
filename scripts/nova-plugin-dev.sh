#!/usr/bin/env bash
# Launch Claude Code with the Nova plugin pointed at a locally running
# Nova server instead of production.
#
# ## Why this script lives here, not in the plugin repo
#
# The shipped plugin's committed `.mcp.json` pins the MCP *URL* to
# `https://mcp.commcare.app/mcp` with no substitution — that's what
# keeps the published artifact immune to env-based redirection: an
# attacker who can set env vars on an end user's machine still can't
# point Nova at a man-in-the-middle server. Auth is supplied by a
# `headersHelper` command that reads `NOVA_API_KEY`: set, it emits an
# `Authorization: Bearer <key>` header; unset, it emits *nothing*, so
# Claude Code's OAuth flow runs cleanly. (It must omit the header, not
# emit an empty `Bearer `: Claude Code applies the entry's headers on
# top of the OAuth token — observed — so an empty `Bearer ` clobbers
# the freshly-issued token on reconnect and OAuth never authenticates.)
# The URL stays pinned regardless — a hijacked env var can only swap
# which account is used, not redirect traffic.
#
# Developers still need to run the same plugin code against
# `localhost` — and that IS a URL change, which the shipped `.mcp.json`
# deliberately can't express. So the dev launcher belongs here (the
# Nova app + docs + MCP implementation all live in this repo): it
# regenerates `.mcp.json` with the dev URL. The published plugin ships
# no executable script files — the one thing Claude Code runs is that
# inline `headersHelper`, which reads the env key but can't touch the
# pinned URL.
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
#   # Test the API-key auth path (same env var the shipped plugin reads):
#   NOVA_API_KEY=sk-nova-v1-XXX ./scripts/nova-plugin-dev.sh
#   ./scripts/nova-plugin-dev.sh --api-key sk-nova-v1-XXX
#
# ## API-key mode
#
# When `--api-key` (or `NOVA_API_KEY`) is set, the script exports
# `NOVA_API_KEY` into the launched `claude` process. The overlay's
# `.mcp.json` carries the same `headersHelper` as the shipped plugin,
# so Claude Code runs it and authenticates the plugin's own MCP entry
# with the key. No second entry, no `claude mcp add`, no cleanup trap.
# With the var unset the helper emits no header and Claude Code runs
# the OAuth flow instead, exactly as in production.
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

# Write the dev-only `.mcp.json`. Schema matches the shipped plugin's
# committed file (same `type`, server key, and `headersHelper`) so
# Claude Code treats the overlay as a drop-in replacement — only the
# URL differs. Two heredocs: the first is unquoted so `$dev_url`
# expands; the second is quoted (`<<'EOF'`) so the headersHelper
# one-liner lands byte-for-byte. That line carries `$NOVA_API_KEY` and
# escaped quotes Claude Code must receive verbatim — a single unquoted
# heredoc would force a brittle second layer of `\$` / `\\` escaping
# over them. The helper drops the key straight into the JSON without
# escaping — safe only because Nova keys are alphanumeric after the
# `sk-nova-v1-` prefix; a key with JSON quotes or backslashes would
# break it.
{
	cat <<EOF
{
  "mcpServers": {
    "nova": {
      "type": "http",
      "url": "$dev_url",
EOF
	cat <<'EOF'
      "headersHelper": "if [ -n \"$NOVA_API_KEY\" ]; then printf '{\"Authorization\":\"Bearer %s\"}' \"$NOVA_API_KEY\"; else printf '{}'; fi"
    }
  }
}
EOF
} >"$overlay_root/.mcp.json"

echo "Nova plugin: $plugin_root"
echo "Overlay:     $overlay_root"
echo "MCP URL:     $dev_url"

# API-key mode: export NOVA_API_KEY into the launched `claude` so the
# overlay's `headersHelper` sees it and emits the bearer for the
# plugin's own MCP entry. Same path as the shipped plugin — no
# user-scope override entry, no URL-dedup trick, nothing to clean up on
# exit. With `api_key` empty, NOVA_API_KEY stays unset, the helper
# emits no header, and Claude Code runs the OAuth flow.
if [[ -n "$api_key" ]]; then
	export NOVA_API_KEY="$api_key"
	echo "Auth:        API-key (NOVA_API_KEY → overlay nova header)"
else
	echo "Auth:        OAuth (plugin-scope nova → ${dev_url})"
fi
echo

# `exec` replaces this shell with `claude`, so no wrapper process
# lingers for the session's lifetime. Safe because the overlay carries
# its auth inline — there's no user-scope MCP entry to clean up on
# exit, hence no EXIT trap that would need the shell to stay alive. The
# `+`-guarded expansion handles an empty array correctly under `set -u`
# on bash 3.2 (macOS default) — bare `"${arr[@]}"` would unbound-error.
exec claude --plugin-dir "$overlay_root" ${forward_args[@]+"${forward_args[@]}"}
