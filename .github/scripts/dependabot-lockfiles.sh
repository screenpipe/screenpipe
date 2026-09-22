#!/usr/bin/env bash
# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

base_sha="${1:?expected the pull request base SHA}"
[[ "$base_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid base SHA" >&2; exit 1; }

# Shared path dependencies can invalidate lockfiles outside the changed manifest
# directory. Resolve every tracked lockfile for each affected ecosystem, using
# install/metadata to preserve existing resolutions rather than blanket updates.
changed_manifests="$(git diff --name-only "$base_sha...HEAD" -- '**/package.json' package.json '**/Cargo.toml' Cargo.toml)"
if grep -qE '(^|/)package\.json$' <<< "$changed_manifests"; then
  while IFS= read -r -d '' lockfile; do
    (cd "$(dirname "$lockfile")" && bun install --lockfile-only --ignore-scripts)
  done < <(git ls-files -z -- '**/bun.lock' bun.lock)
fi

if grep -qE '(^|/)Cargo\.toml$' <<< "$changed_manifests"; then
  bash scripts/regenerate-locks.sh
fi

# The autofix integration may commit only lockfile repairs, never manifest or
# source edits. Package lifecycle scripts are disabled above.
while IFS= read -r -d '' changed_file; do
  case "$changed_file" in
    bun.lock|*/bun.lock|Cargo.lock|*/Cargo.lock) ;;
    *) echo "unexpected non-lockfile change: $changed_file" >&2; exit 1 ;;
  esac
done < <(git diff --name-only -z HEAD; git ls-files -z --others --exclude-standard)
