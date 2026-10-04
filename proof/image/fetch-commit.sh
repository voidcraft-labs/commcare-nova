#!/bin/sh
# fetch-commit <repository> <commit> <directory> [--submodules]
# Fetches exactly one commit (and, with --submodules, the submodule commits it
# records) without history, then proves the checkout is at that commit.
set -eu
repository="$1"
commit="$2"
directory="$3"
case "$commit" in
  *[!0-9a-f]* | "") echo "fetch-commit: $commit is not a full lowercase commit id" >&2; exit 1 ;;
esac
if [ "${#commit}" -ne 40 ]; then
  echo "fetch-commit: $commit is not a full 40-character commit id" >&2
  exit 1
fi
git init -q "$directory"
git -C "$directory" remote add origin "$repository"
git -C "$directory" fetch -q --depth 1 origin "$commit"
git -C "$directory" -c advice.detachedHead=false checkout -q FETCH_HEAD
if [ "${4:-}" = "--submodules" ]; then
  git -C "$directory" submodule update -q --init --depth 1
fi
actual="$(git -C "$directory" rev-parse HEAD)"
if [ "$actual" != "$commit" ]; then
  echo "fetch-commit: $repository checked out $actual, expected $commit" >&2
  exit 1
fi
