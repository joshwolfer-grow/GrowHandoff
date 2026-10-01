#!/bin/bash
# Intraday Amplify sync runner (launchd: com.grow.amplify-sync, on the shared
# knocking calendar in scripts/knock-schedule.py: every 10 min 11am-10pm, 2h otherwise).
#
# Runs every company configured in data/amplify-sources.json, each with its own
# Chrome profile and its own row `source` in the knocking table. Unlike the
# SalesRabbit side, Amplify is happy headless, so there is no token to seed —
# the saved profile is enough and a run needs nothing from you.
#
#   bash scripts/run-amplify-sync.sh       # what launchd runs
#
# Exit 3 from any source means that company's Amplify login expired. Each source
# is independent: one expired login must not stop the others, so the loop keeps
# going and reports at the end. Log: imports/done/amplify-sync.log

cd "$(dirname "$0")/.." || exit 1

NODE=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)
[ -z "$NODE" ] && NODE=$(command -v node)
[ -z "$NODE" ] && { echo "$(date) node not found" >> imports/done/amplify-sync.log; exit 1; }

mkdir -p imports/done

# Same pid lock as the SalesRabbit runner: a run that overruns its 5 minutes
# must not collide with the next one, since two Chromes on one profile is the
# "profile in use" failure. Skipping costs nothing — the next run catches up
# from the watermark in the knocking table.
PID=imports/done/amplify-sync.pid
if [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; then
  echo "$(date) previous run (pid $(cat "$PID")) still going, skipping this tick" >> imports/done/amplify-sync.log
  exit 0
fi
echo $$ > "$PID"
trap 'rm -f "$PID"' EXIT

# Sources come from the config, so adding a company to amplify-sources.json puts
# it on the schedule automatically — no edit here, nothing to forget.
SOURCES=$("$NODE" -e 'const c=require("./data/amplify-sources.json");console.log(Object.keys(c).filter(k=>!k.startsWith("_")).join(" "))' 2>/dev/null)
[ -z "$SOURCES" ] && { echo "$(date) no sources in data/amplify-sources.json" >> imports/done/amplify-sync.log; exit 1; }

echo "=== $(date) ===" >> imports/done/amplify-sync.log
failed=""
for src in $SOURCES; do
  # Same watchdog as the SalesRabbit runner: a stuck file read (iCloud) or a
  # hung headless Chrome must not hold the pid lock forever and silently skip
  # every later tick. macOS has no timeout(1). Deliberately UNDER the 5-minute
  # StartInterval (it was 300, exactly one tick, back when ticks were 10 min):
  # a hung run is dead before the next tick fires, so it costs one skipped run
  # instead of racing the lock. A healthy run is 11s, so this is 20x headroom.
  "$NODE" scripts/amplify-company-sync.mjs --source "$src" --scheduled >> imports/done/amplify-sync.log 2>&1 &
  np=$!
  ( sleep 240; kill -9 $np 2>/dev/null ) &
  wd=$!
  wait $np
  code=$?
  kill $wd 2>/dev/null
  [ "$code" = "137" ] && echo "$(date) [$src] exceeded 5 min, killed" >> imports/done/amplify-sync.log
  if [ "$code" != 0 ]; then
    echo "$(date) [$src] FAILED exit $code" >> imports/done/amplify-sync.log
    if [ "$code" = "3" ]; then
      failed="$failed $src(login)"
    else
      failed="$failed $src(exit $code)"
    fi
  fi
done

if [ -n "$failed" ]; then
  msg="Amplify sync failed:$failed. See imports/done/amplify-sync.log"
  # The health board card renders `fix` with a Copy button, so it has to be the
  # command that actually clears THIS failure. A login expiry needs --login and
  # nothing else; re-running the runner (the card's default) just fails again,
  # which is how a dead session sat unnoticed from 09-04 to 09-07.
  fix="bash scripts/run-amplify-sync.sh"
  case "$failed" in
    *login*)
      first=$(echo "$failed" | tr ' ' '\n' | grep '(login)' | head -1 | sed 's/(login)//')
      msg="Amplify login expired:$failed. Run: node scripts/amplify-company-sync.mjs --source $first --login"
      fix="node scripts/amplify-company-sync.mjs --source $first --login" ;;
  esac
  /usr/bin/osascript -e "display notification \"$msg\" with title \"Grow · Amplify Sync\" sound name \"Basso\"" || true
  bash scripts/sync-marker.sh amplify_sync fail "$msg" "$fix" "knock schedule"
  exit 3
fi

# All sources clean — stamp the Ops health board.
bash scripts/sync-marker.sh amplify_sync ok "sources: $SOURCES" "" "knock schedule"
