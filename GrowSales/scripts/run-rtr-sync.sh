#!/bin/bash
# Opendoor "Time Track Highlight" -> knocking runner (launchd: com.grow.rtr-sync).
#
#   bash scripts/run-rtr-sync.sh          # what launchd runs
#   RTR_FORCE=1 bash scripts/run-rtr-sync.sh   # ignore the time window
#
# launchd runs this on the shared knocking calendar (scripts/knock-schedule.py):
# every 10 min 11am-10pm, every 2h otherwise. The window below drops the
# overnight ticks, so Opendoor's day is 8am, 10am, then every 10 min to 10pm.
# 8am matters: the seal and the daily sources run on the FIRST tick of the day,
# and at midnight reps' phones have not synced yesterday's last doors yet.
#
# The first successful run of each day passes --seal, which re-pulls YESTERDAY
# and overwrites it: reps' phones sync to SalesRabbit late, so the last evening
# pull can miss activity landing after it. Every other run pulls today. The
# report is cumulative for the day, so any single run already holds the whole day
# so far — the cadence is for how fresh the board looks, not correctness.
#
# Worth knowing: this renders a report on Opendoor's SSRS box rather than hitting
# a JSON endpoint, so runs are not free the way the SalesRabbit and Amplify polls
# are. From 8am on the shared calendar is 69 runs a day, ~69 renders per every-tick ISP.
#
# Exit 3 means the SSO session expired and only you can renew it — that is the one
# failure you have to act on, so it gets a notification naming the command.

cd "$(dirname "$0")/.." || exit 1

# --- selling-day window ------------------------------------------------------
# Inclusive start, exclusive end: 8 and 23 keeps the calendar's 10pm tick.
RTR_START_HOUR=${RTR_START_HOUR:-8}
RTR_END_HOUR=${RTR_END_HOUR:-23}
_hour=$(date +%-H)
if [ -z "$RTR_FORCE" ] && { [ "$_hour" -lt "$RTR_START_HOUR" ] || [ "$_hour" -ge "$RTR_END_HOUR" ]; }; then
  exit 0    # outside the window · silent by design, or the log is 100 lines of "skipped"
fi

NODE=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)
[ -z "$NODE" ] && NODE=$(command -v node)
[ -z "$NODE" ] && { echo "$(date) node not found" >> imports/done/rtr-sync.log; exit 1; }

mkdir -p imports/done

# One Chrome per profile. A run that overruns must not collide with the next:
# two Chromes on one user-data-dir is the "profile is already in use" failure, and
# the second would clear the first's lock out from under it. Skip the tick instead
# — the next one re-pulls the same cumulative totals, so nothing is lost.
PID=imports/done/rtr-sync.pid
if [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; then
  echo "$(date) previous run (pid $(cat "$PID")) still going, skipping this tick" >> imports/done/rtr-sync.log
  exit 0
fi
echo $$ > "$PID"
trap 'rm -f "$PID"' EXIT

# Seal yesterday on the FIRST run of each day, whenever that happens to land —
# not at a fixed hour. This is a laptop: the lid is shut overnight and through the
# commute, and StartCalendarInterval firings missed while asleep are skipped, not
# queued. A seal pinned to 4am would simply never run on a machine that sleeps at
# midnight. Keyed off a marker file, so it happens exactly once a day no matter
# which run gets there first.
SEALED=imports/done/rtr-last-sealed
YESTERDAY=$(date -v-1d +%Y-%m-%d 2>/dev/null || date -d yesterday +%Y-%m-%d)
TODAY=$(date +%Y-%m-%d)
if [ "$(cat "$SEALED" 2>/dev/null)" != "$YESTERDAY" ]; then
  NEEDS_SEAL=1
fi

ARGS="--scheduled"

# Every ISP configured in data/rtr-sources.json, in one tick. They share a login
# and a portal, so there is nothing to gain from separate launchd agents the way
# Amplify and SalesRabbit need them — but they DO run sequentially and are scored
# independently below, so one ISP's broken report can't stop the others syncing.
CFG=data/rtr-sources.json
[ -f "$CFG" ] || CFG="${GROW_SALES_DIR:-$HOME/Grow/GrowSales}/data/rtr-sources.json"
# path.resolve, not a bare require: node treats require('data/x.json') as a PACKAGE
# name rather than a relative path, so it fails with a module-not-found that 2>/dev/null
# swallows — leaving SOURCES empty and the run looking like "nothing configured".
SOURCES=$("$NODE" -e "const p=require('path');const c=require(p.resolve('$CFG'));console.log(Object.keys(c).filter(k=>!k.startsWith('_')).join(' '))" 2>/dev/null)
# Per-source cadence. Sources under this one agent no longer share a schedule:
# omni sells at a fraction of ezee's volume and its report is a full SSRS render
# against someone else's box, so it pulls ONCE A DAY while the others pull every
# tick. Anything without a cadence keeps the old behaviour.
CADENCES=$("$NODE" -e "const p=require('path');const c=require(p.resolve('$CFG'));console.log(Object.entries(c).filter(([k])=>!k.startsWith('_')).map(([k,v])=>k+'='+(v.cadence||'tick')).join(' '))" 2>/dev/null)
cadence_of() { for kv in $CADENCES; do case "$kv" in "$1="*) echo "${kv#*=}"; return;; esac; done; echo tick; }
if [ -z "$SOURCES" ]; then
  echo "$(date) no sources configured in $CFG" >> imports/done/rtr-sync.log
  exit 1
fi

worst=0
for src in $SOURCES; do
  CAD=$(cadence_of "$src")
  # A daily source runs on the first tick of the day and is skipped for the rest
  # of it. The stamp is written only on SUCCESS, so a failed morning run retries
  # on the next tick instead of being written off until tomorrow. Skipping also
  # leaves the existing marker alone, which is what keeps the board showing this
  # morning's real result rather than resetting it every 30 minutes.
  DAILY_STAMP="imports/done/rtr-last-daily-$src"
  if [ "$CAD" = "daily" ] && [ "$(cat "$DAILY_STAMP" 2>/dev/null)" = "$TODAY" ]; then
    continue
  fi
  # First run of the day: correct yesterday before touching today. Reps' phones
  # sync to SalesRabbit after they stop knocking, so the evening's last pull can
  # be short by a few doors.
  if [ -n "$NEEDS_SEAL" ]; then
    echo "=== $(date) [$src] sealing $YESTERDAY ===" >> imports/done/rtr-sync.log
    "$NODE" scripts/rtr-sync.mjs --source "$src" --scheduled --seal >> imports/done/rtr-sync.log 2>&1
    sc=$?
    [ "$sc" != 0 ] && echo "$(date) [$src] seal FAILED exit $sc" >> imports/done/rtr-sync.log
  fi

  echo "=== $(date) [$src] ($ARGS) ===" >> imports/done/rtr-sync.log
  # Hard cap per ISP: an SSRS render behind a cold-started App Service can hang,
  # and a run holding the pid lock forever makes every later tick skip silently —
  # which looks exactly like "nothing to do". macOS has no timeout(1), hence the
  # watchdog.
  "$NODE" scripts/rtr-sync.mjs --source "$src" $ARGS >> imports/done/rtr-sync.log 2>&1 &
  np=$!
  ( sleep 420; kill -9 $np 2>/dev/null ) &
  wd=$!
  wait $np
  code=$?
  kill $wd 2>/dev/null
  [ "$code" = "137" ] && echo "$(date) [$src] exceeded 7 min and was killed (stuck render?)" >> imports/done/rtr-sync.log

  # PER-SOURCE marker. The aggregate __rtr_sync__ below reports the WORST result
  # across every ISP, which means a green board only tells you that at least the
  # last one worked: bluepeak could fail every tick while ezee kept the row green
  # and nothing would say so. Each ISP now reports for itself, and the board
  # renders one row per marker it finds, so adding an ISP to rtr-sources.json
  # still needs no dashboard edit.
  CAD_LABEL=$([ "$CAD" = "daily" ] && echo "daily" || echo "knock schedule")
  if [ "$code" = 0 ]; then
    [ "$CAD" = "daily" ] && echo "$TODAY" > "$DAILY_STAMP"
    bash scripts/sync-marker.sh "rtr_sync_$src" ok "$src" "" "$CAD_LABEL"
  elif [ "$code" = "3" ]; then
    bash scripts/sync-marker.sh "rtr_sync_$src" fail "session expired - run: node scripts/rtr-sync.mjs --login" "node scripts/rtr-sync.mjs --login" "$CAD_LABEL"
  elif [ "$code" = "137" ]; then
    bash scripts/sync-marker.sh "rtr_sync_$src" fail "render exceeded 7 min and was killed" "node scripts/rtr-sync.mjs --source $src" "$CAD_LABEL"
  else
    bash scripts/sync-marker.sh "rtr_sync_$src" fail "exit $code - see imports/done/rtr-sync.log" "node scripts/rtr-sync.mjs --source $src" "$CAD_LABEL"
  fi
  if [ "$code" != 0 ]; then
    echo "$(date) [$src] FAILED exit $code" >> imports/done/rtr-sync.log
    # An expired session is the one failure only you can clear, so it wins the
    # notification even if another ISP failed for a duller reason.
    if [ "$code" = "3" ]; then
      msg="Opendoor session expired. Run: node scripts/rtr-sync.mjs --login"
      worst=3
    else
      msg="Opendoor sync failed for $src (exit $code). See imports/done/rtr-sync.log"
      [ "$worst" != 3 ] && worst="$code"
    fi
    /usr/bin/osascript -e "display notification \"$msg\" with title \"Grow · Opendoor Sync\" sound name \"Basso\"" || true
    # A dead session kills every ISP the same way; no point rendering the rest.
    [ "$code" = "3" ] && break
  fi
done

# Only mark the day sealed once every ISP got through, so a failure retries on the
# next tick rather than being silently skipped until tomorrow.
[ -n "$NEEDS_SEAL" ] && [ "$worst" = 0 ] && echo "$YESTERDAY" > "$SEALED"

# Publish the sealed-through date. The file above is local to this Mac, but the
# thing that needs to know is the manager report, which gets read and sent from a
# phone. Until yesterday is sealed, its knocking is whatever the evening's last
# pull caught, and reps whose phones synced after that are short — 2026-08-06
# gained 13 doors and 3 sales between the 9:14pm pull and the morning seal.
# Stamped on every run, not just sealing ones, so it can never drift from the file.
SEALED_THRU=$(cat "$SEALED" 2>/dev/null)
[ -n "$SEALED_THRU" ] && bash scripts/sync-marker.sh rtr_seal ok "$SEALED_THRU"

# Status marker for the dashboard's Ops health board. Failures included: exit 3
# (expired session, needs you) reads differently there than a render hiccup.
if [ "$worst" = 0 ]; then
  bash scripts/sync-marker.sh rtr_sync ok "sources: $SOURCES"
elif [ "$worst" = 3 ]; then
  bash scripts/sync-marker.sh rtr_sync fail "session expired - run: node scripts/rtr-sync.mjs --login"
else
  bash scripts/sync-marker.sh rtr_sync fail "exit $worst - see imports/done/rtr-sync.log"
fi

exit "$worst"
