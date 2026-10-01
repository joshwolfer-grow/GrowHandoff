#!/bin/bash
# Daily Amplify -> knocking sync runner (launchd: com.grow.amplify-knocking).
# Pulls yesterday's Lead Status from Amplify and writes knocking + knock_events.
# On failure (most likely LOGIN_EXPIRED), pops a notification so it never dies silently.

cd "$(dirname "$0")/.." || exit 1
NODE="$(command -v node || echo /usr/local/bin/node)"

if ! "$NODE" scripts/amplify-knocking-sync.mjs >> imports/done/amplify-sync.log 2>&1; then
  code=$?
  msg="Amplify knocking sync failed (exit $code)."
  [ "$code" = "2" ] && msg="Amplify login expired. Run: node scripts/amplify-knocking-sync.mjs --login"
  /usr/bin/osascript -e "display notification \"$msg\" with title \"Grow · Amplify Sync\" sound name \"Basso\"" || true
  exit "$code"
fi
