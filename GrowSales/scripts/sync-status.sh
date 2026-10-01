#!/bin/bash
# One-glance health check for the scheduled syncs on this Mac, plus a kill
# switch for a run that's wedged.
#
#   bash scripts/sync-status.sh              # status of all four syncs
#   bash scripts/sync-status.sh kill sr      # terminate a running sync
#                                            # (sr | rtr | amplify | timetrack | isp)
#
# Status shows, per sync: is the launchd agent loaded, is a run going RIGHT NOW
# (pid file), and the last thing the log said. Killing is safe: the runner sees
# the child die, logs the failure, marks the health card, and the next tick
# retries from the watermark — nothing is lost.

cd "$(dirname "$0")/.." || exit 1

# name | launchd label | pid file (runner) | log | child script to kill
SYNCS="
sr|com.grow.sr-sync|imports/done/sr-sync.pid|imports/done/sr-sync.log|grow-sync.mjs
rtr|com.grow.rtr-sync|imports/done/rtr-sync.pid|imports/done/rtr-sync.log|rtr-sync.mjs
amplify|com.grow.amplify-sync|imports/done/amplify-sync.pid|imports/done/amplify-sync.log|amplify-company-sync.mjs
timetrack|com.grow.timetrack-import|-|imports/done/import.log|import-timetrack.mjs
isp|com.grow.isp-export|-|imports/done/isp-export.log|knock-export.py
"

row() { echo "$SYNCS" | grep "^$1|"; }

if [ "$1" = "kill" ]; then
  r=$(row "${2:-}")
  [ -z "$r" ] && { echo "usage: bash scripts/sync-status.sh kill <sr|rtr|amplify|timetrack|isp>"; exit 1; }
  IFS='|' read -r name label pidf log child <<< "$r"
  # Kill the node child, not the runner: the runner then wakes from wait,
  # logs FAILED, stamps the health marker, and cleans up its own pid file.
  if pkill -f "scripts/$child"; then
    echo "sent TERM to $child — the runner will log the failure and exit."
    sleep 3
    if pgrep -f "scripts/$child" >/dev/null; then
      pkill -9 -f "scripts/$child" && echo "still alive after 3s; sent KILL."
    fi
    [ "$pidf" != "-" ] && [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null && sleep 2
    echo "next scheduled tick will retry from the watermark."
  else
    echo "no $child process running — nothing to kill."
  fi
  exit 0
fi

printf '%-10s %-11s %-9s %s\n' "SYNC" "AGENT" "RUNNING" "LAST LOG LINE"
echo "$SYNCS" | while IFS='|' read -r name label pidf log child; do
  [ -z "$name" ] && continue

  l=$(launchctl list 2>/dev/null | awk -v L="$label" '$3==L {print $2}')
  if [ -z "$l" ]; then agent="NOT LOADED"
  elif [ "$l" = "0" ] || [ "$l" = "-" ]; then agent="loaded"
  else agent="exit $l"      # last run's exit code, per launchd
  fi

  running="no"
  if [ "$pidf" != "-" ] && [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null; then
    running="pid $(cat "$pidf")"
  elif pgrep -f "scripts/$child" >/dev/null 2>&1; then
    running="pid $(pgrep -f "scripts/$child" | head -1)"
  fi

  last=$(tail -1 "$log" 2>/dev/null | cut -c1-90)
  [ -z "$last" ] && last="(no log yet)"

  printf '%-10s %-11s %-9s %s\n' "$name" "$agent" "$running" "$last"

  # A FAILED line after the last "===" header means the most recent run broke —
  # surface it even when a later marker line is what tail -1 caught.
  fail=$(tail -40 "$log" 2>/dev/null | awk '/^=== /{f=""} /FAILED|Terminated|killed/{f=$0} END{print f}')
  [ -n "$fail" ] && printf '%-10s %-11s %-9s !! %s\n' "" "" "" "$(echo "$fail" | cut -c1-85)"
done

echo
echo "kill a stuck run:  bash scripts/sync-status.sh kill <sr|rtr|amplify|timetrack|isp>"
