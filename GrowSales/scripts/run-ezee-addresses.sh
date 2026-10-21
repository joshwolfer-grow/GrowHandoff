#!/bin/bash
# Ezee addresses -> Supabase (launchd: com.grow.ezee-addresses, hourly tick).
#
#   bash scripts/run-ezee-addresses.sh               # what launchd runs
#   EZEE_FORCE=1 bash scripts/run-ezee-addresses.sh  # run now, ignore the once-a-day gate
#
# Once a day, first tick after EZEE_START_HOUR, pulls yesterday and today from the
# Opendoor Activity_Detail report for every Grow team and upserts the addresses
# (scripts/ezee-addresses-sync.mjs). Yesterday is re-pulled on purpose: reps' phones
# sync late, so the day is only complete the morning after. Same hourly-tick +
# date-stamp gate as run-isp-export.sh, because a laptop drops calendar firings it
# sleeps through but catches up a missed StartInterval on wake.
#
# The Google Sheet "Ezee Addresses" on the corporate Drive refreshes itself from
# the table (scripts/ezee-addresses-sheet.gs); nothing here touches Drive.

cd "$(dirname "$0")/.." || exit 1

EZEE_START_HOUR=${EZEE_START_HOUR:-7}
LOG=imports/done/ezee-addresses.log
STAMP=imports/done/ezee-addresses-last-run
mkdir -p imports/done

_hour=$(date +%-H)
_today=$(date +%Y-%m-%d)
if [ -z "$EZEE_FORCE" ]; then
  [ "$_hour" -lt "$EZEE_START_HOUR" ] && exit 0
  [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$_today" ] && exit 0
  bash scripts/paused.sh ezee_addresses && exit 0
fi

NODE=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)
[ -z "$NODE" ] && NODE=$(command -v node)

echo "=== $(date) ===" >> "$LOG"
"$NODE" scripts/ezee-addresses-sync.mjs >> "$LOG" 2>&1 &
np=$!
( sleep 1500; kill -9 $np 2>/dev/null ) &   # three SSRS renders; 25 min hard cap
wd=$!
wait $np; code=$?; kill $wd 2>/dev/null; wait $wd 2>/dev/null

if [ "$code" = 0 ]; then
  echo "$_today" > "$STAMP"
  detail=$(grep -E '^✓' "$LOG" | tail -1 | sed 's/^✓ //')
  bash scripts/sync-marker.sh ezee_addresses ok "$detail" "" daily
elif [ "$code" = 3 ]; then
  bash scripts/sync-marker.sh ezee_addresses fail "Opendoor session expired - run: node scripts/rtr-sync.mjs --login, then copy .rtr-profile to .rtr-profile-backfill" "node scripts/rtr-sync.mjs --login" daily
else
  echo "$(date) FAILED exit $code" >> "$LOG"
  bash scripts/sync-marker.sh ezee_addresses fail "exit $code - see imports/done/ezee-addresses.log" "EZEE_FORCE=1 bash scripts/run-ezee-addresses.sh" daily
fi
exit "$code"
