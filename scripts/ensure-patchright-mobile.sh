#!/usr/bin/env bash
set -euo pipefail

profile='/Users/lysak/.codex/patchright-chrome-profile'

# Close only stale Chrome processes that use Cartwise's dedicated Patchright
# profile. Do not use pkill: user Chrome and unrelated browser sessions are
# deliberately out of scope.
for pid in $(pgrep -f -- "--user-data-dir=${profile}" || true); do
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$command" in
    *"--user-data-dir=${profile}"*) kill "$pid" 2>/dev/null || true ;;
  esac
done

# Chrome releases its profile lock asynchronously after SIGTERM. Starting
# Patchright before the matching processes disappear reproduces the exact
# "Opening in existing browser session" failure this launcher prevents.
for _ in {1..50}; do
  if ! pgrep -f -- "--user-data-dir=${profile}" >/dev/null; then
    break
  fi
  sleep 0.1
done

if pgrep -f -- "--user-data-dir=${profile}" >/dev/null; then
  echo "Patchright profile did not close in time" >&2
  exit 1
fi

exec npx patchright-mcp@0.0.68 \
  --browser chrome \
  --device 'iPhone 15 Pro' \
  --user-data-dir "$profile"
