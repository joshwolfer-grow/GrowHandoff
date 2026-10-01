#!/bin/bash
# ISP knocking workbooks -> shared Drive (launchd: com.grow.isp-export, hourly tick).
#
#   bash scripts/run-isp-export.sh              # what launchd runs
#   ISP_FORCE=1 bash scripts/run-isp-export.sh  # run now, ignore the once-a-day gate
#
# This is the job that used to be "the Monday job" run by hand:
#   python3 scripts/knock-export.py --isp all --week
# One workbook per ISP (Grow & <ISP> Knocking Data.xlsx), rebuilt from scratch
# with a tab per week, written straight into the ISP's folder on the shared
# Drive. Since the workbook is rebuilt whole every time, running it DAILY is
# safe: the current week's tab simply fills in as the week goes, and a late
# disposition corrects history instead of leaving a stale row.
#
# launchd ticks this every hour around the clock; the gate below runs the
# export ONCE a day, on the first tick after ISP_START_HOUR. Hourly ticks plus a
# date stamp, not a calendar firing at 7am, because this is a laptop: a
# StartCalendarInterval missed while the lid is shut is dropped, whereas a
# StartInterval catches up on wake.
#
# The 5-minute SalesRabbit crawl runs --lean and does NOT rebuild the two CSVs
# the export reads (sr-doors-by-area.csv, sr-activity.csv), so step one is a
# full recompile from the store (no crawl, no push). That recompile reads the
# same store the crawl appends to, so this runner takes the crawl's pid lock for
# the duration: the crawl's next tick sees a live pid and skips, and its
# watermark means it loses nothing but a few minutes.

cd "$(dirname "$0")/.." || exit 1

ISP_START_HOUR=${ISP_START_HOUR:-7}
LOG=imports/done/isp-export.log
STAMP=imports/done/isp-export-last-run
mkdir -p imports/done

_hour=$(date +%-H)
_today=$(date +%Y-%m-%d)
if [ -z "$ISP_FORCE" ]; then
  [ "$_hour" -lt "$ISP_START_HOUR" ] && exit 0
  [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$_today" ] && exit 0
fi

NODE=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)
[ -z "$NODE" ] && NODE=$(command -v node)
PY=/Library/Frameworks/Python.framework/Versions/3.10/bin/python3
[ -x "$PY" ] || PY=$(command -v python3)

. scripts/_drive.sh
DRIVE="$GROW_DRIVE/Reporting/SalesRabbit Reports For ISPs"
if [ ! -d "$DRIVE" ]; then
  echo "$(date) Drive folder not mounted, nothing written" >> "$LOG"
  bash scripts/sync-marker.sh isp_export fail "Google Drive is not mounted, workbooks not written" "open -a 'Google Drive'" daily
  exit 1
fi

# Take the crawl's lock (see header). Wait up to 4 min for a tick in flight.
PID=imports/done/sr-sync.pid
for _ in $(seq 1 48); do
  if [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; then sleep 5; else break; fi
done
if [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; then
  echo "$(date) crawl still running after 4 min, trying next tick" >> "$LOG"
  exit 0
fi
echo $$ > "$PID"
trap 'rm -f "$PID"' EXIT

echo "=== $(date) ===" >> "$LOG"
# Batch registry first: a new SalesRabbit import since yesterday gets its ISP
# from the file name here. Exit 2 = a batch no rule could label. The export
# still runs (those doors are simply on no report), but the day is flagged
# until someone labels it, because silently folding them into a state report
# is the failure this whole system exists to prevent.
"$NODE" scripts/isp-registry.mjs >> "$LOG" 2>&1
reg_code=$?
(
  "$NODE" scripts/grow-sync.mjs --skip-crawl --full-csv --no-push && \
  "$PY" scripts/knock-export.py --isp all --week
) >> "$LOG" 2>&1 &
np=$!
( sleep 1500; kill -9 $np 2>/dev/null; pkill -9 -f "scripts/knock-export.py" 2>/dev/null ) &
wd=$!
wait $np
code=$?
{ kill $wd && wait $wd; } 2>/dev/null

# knock-export runs one subprocess per ISP and does not propagate their exit
# codes, so judge the run by what it wrote: one "saved" line per ISP, no Tracebacks.
run_log=$(awk '/^=== /{buf=""} {buf=buf"\n"$0} END{print buf}' "$LOG")
saved=$(printf '%s' "$run_log" | grep -c '^  saved ')
expected=$("$PY" -c "import json;d=json.load(open('data/isps.json'));print(sum(1 for k,v in d.items() if not k.startswith('_') and not (isinstance(v,dict) and v.get('_skip'))))")
tracebacks=$(printf '%s' "$run_log" | grep -c 'Traceback')

if [ "$code" = "137" ]; then
  msg="export ran past 25 min and was killed"
elif [ "$code" != 0 ]; then
  msg="recompile failed (exit $code). See $LOG"
elif [ "$tracebacks" != 0 ] || [ "$saved" -lt "$expected" ]; then
  msg="$saved of $expected workbooks written. See $LOG"
elif [ "$reg_code" = "2" ]; then
  n=$(printf '%s' "$run_log" | grep -c '^  [0-9a-f]\{8\}  ')
  msg="$n new import batch(es) have no ISP label, their doors are on no report. Label: node scripts/isp-registry.mjs"
elif [ "$reg_code" != 0 ]; then
  msg="import registry sync failed (exit $reg_code), labels may be stale. See $LOG"
else
  msg=""
fi

if [ -n "$msg" ]; then
  echo "$(date) FAILED: $msg" >> "$LOG"
  bash scripts/sync-marker.sh isp_export fail "$msg" "ISP_FORCE=1 bash scripts/run-isp-export.sh" daily
  /usr/bin/osascript -e "display notification \"$msg\" with title \"Grow · ISP workbooks\" sound name \"Basso\"" || true
  exit 1
fi

# Sector maps for the site (More > ISP Maps), off the same fresh CSVs the export
# just recompiled. Its own marker: a stale map is worth knowing about but must
# never fail the workbooks, which is what this job is actually for.
# TDS is its own SalesRabbit company: refresh its doors before the maps so the
# TDS map draws today's knocks. Skipped quietly until a token has been seeded
# (data/sr-auth-tds.json from a signed-in TDS window); a dead token exits 3 and the
# map simply keeps yesterday's doors.
if [ -f data/sr-auth-tds.json ]; then
  ( "$NODE" scripts/tds-sr-sync.mjs && "$PY" scripts/sector-build.py TDS --extract ) >> "$LOG" 2>&1 &
  tp=$!; ( sleep 900; kill -9 $tp 2>/dev/null ) & tw=$!; wait $tp || echo "tds crawl failed ($?)" >> "$LOG"; kill $tw 2>/dev/null
fi
if "$PY" scripts/sector-maps.py --all >> "$LOG" 2>&1; then
  bash scripts/sync-marker.sh sector_maps ok "ISP maps refreshed" "" daily
else
  echo "$(date) sector maps failed, workbooks were fine" >> "$LOG"
  bash scripts/sync-marker.sh sector_maps fail "ISP maps on the site are stale. See $LOG" \
    "python3 scripts/sector-maps.py --all" daily
fi

echo "$_today" > "$STAMP"
echo "$(date) ok: $saved workbooks on Drive" >> "$LOG"
bash scripts/sync-marker.sh isp_export ok "$saved workbooks on Drive, through $(date -v-1d +%Y-%m-%d)" "" daily
