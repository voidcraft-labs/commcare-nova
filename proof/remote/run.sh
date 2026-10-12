#!/bin/bash
# Runs the proof lane on another machine from this working tree: a proof
# machine reached over ssh (proof/README.md, "Running the lane on another
# machine"), where every reader runs, as the person's own may not.
#
#   proof/remote/run.sh <ssh host> [--slot S] [--env NAME=VALUE]... -- <npm run proof arguments>
#   proof/remote/run.sh <ssh host> --provision [--android-licenses <directory>]
#   proof/remote/run.sh <ssh host> [--slot S] --fetch
#
# The working tree is copied to ~/proof-remote/<slot> on the host (rsync,
# without .git, node_modules or .proof, so uncommitted edits are included),
# its node_modules hard-linked from the one install of its lock provision.sh
# made (or installed into the slot where the lock differs), the slot's
# earlier runs cleared (the lane's container writes them as root), and
# `npm run proof -- <arguments>` run there with the Android reader's runtime
# and its JDK (PROOF_ANDROID_RUNTIME, PROOF_ANDROID_JDK) and each --env.
# The run's output comes back to .proof/remote/<slot>-<stamp>/ (without the
# store's blobs or the emitted corpus), and the exit status is the run's.
# The slot (this tree's directory name by default) keeps two trees' runs on
# one host apart. --provision copies the tree and runs provision.sh on the
# host; --fetch brings the slot's latest run back.
#
# <ssh host> is anything ssh takes, an entry of ~/.ssh/config included;
# PROOF_REMOTE_SSH names another ssh command (`ssh -F <config>`, say), which
# rsync uses too.
set -euo pipefail
read -r -a ssh_command <<< "${PROOF_REMOTE_SSH:-ssh}"

usage() {
  sed -n '6,8p' "$0" >&2
  exit 2
}

host="${1:-}"
[ -n "$host" ] && [ "${host#-}" = "$host" ] || usage
shift
here="$(cd "$(dirname "$0")/../.." && pwd)"
slot="$(basename "$here")"
mode=run
envs=()
licenses=()
while [ $# -gt 0 ]; do
  case "$1" in
    --slot) slot="$2"; shift 2 ;;
    --env) envs+=("$2"); shift 2 ;;
    --provision) mode=provision; shift ;;
    --android-licenses) licenses=(--android-licenses "$2"); shift 2 ;;
    --fetch) mode=fetch; shift ;;
    --) shift; break ;;
    *) usage ;;
  esac
done
remote="proof-remote/$slot"

# Runs a command on the host through its login shell, each argument quoted for it.
on_host() {
  local line=""
  for argument in "$@"; do line+=" $(printf '%q' "$argument")"; done
  "${ssh_command[@]}" "$host" "bash -lc $(printf '%q' "$line")"
}

sync_tree() {
  on_host mkdir -p "$remote"
  on_host sudo rm -rf "$remote/.proof/runs" "$remote/.proof/out"
  rsync -a --delete -e "${PROOF_REMOTE_SSH:-ssh}" \
    --exclude .git --exclude node_modules --exclude .proof --exclude .next --exclude __pycache__ \
    --exclude .source --exclude '*.tsbuildinfo' --exclude .claude/worktrees \
    "$here/" "$host:$remote/"
}

link_dependencies() {
  on_host bash -c '
    set -e
    cd "$1"
    if cmp -s package-lock.json node_modules/.lock-copy 2>/dev/null; then exit 0; fi
    rm -rf node_modules
    if cmp -s package-lock.json "$HOME/proof-remote/_deps/package-lock.json"; then
      cp -al "$HOME/proof-remote/_deps/node_modules" node_modules
    else
      echo "proof/remote/run.sh: this lock differs from the one provision.sh installed; installing it into the slot."
      npm ci --no-audit --no-fund --ignore-scripts >/dev/null
    fi
    cp package-lock.json node_modules/.lock-copy
  ' _ "$remote"
}

fetch_output() {
  local destination
  destination="$here/.proof/remote/$slot-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$destination"
  rsync -a -e "${PROOF_REMOTE_SSH:-ssh}" --exclude store/blobs --exclude 'corpus/' \
    "$host:$remote/.proof/out/" "$destination/" || true
  echo "proof/remote/run.sh: the run's output is at $destination"
}

case "$mode" in
  provision)
    sync_tree
    on_host bash -c 'cd "$1" && shift && bash proof/remote/provision.sh "$@"' _ "$remote" "${licenses[@]+"${licenses[@]}"}"
    ;;
  fetch)
    fetch_output
    ;;
  run)
    sync_tree
    link_dependencies
    set +e
    on_host bash -c '
      cd "$1"
      shift
      runtime=()
      if [ -d "$HOME/proof-android-reader" ]; then
        runtime=(PROOF_ANDROID_RUNTIME="$HOME/proof-android-reader" PROOF_ANDROID_JDK=/opt/proof-jdk)
      fi
      count="$1"
      shift
      exec env "${runtime[@]}" "${@:1:$count}" npm run proof -- "${@:$((count + 1))}"
    ' _ "$remote" "${#envs[@]}" "${envs[@]+"${envs[@]}"}" "$@"
    code=$?
    set -e
    fetch_output
    exit "$code"
    ;;
esac
