#!/bin/bash
# Intraday SalesRabbit sync runner (launchd: com.grow.sr-sync, on the shared
# knocking calendar in scripts/knock-schedule.py: every 10 min 11am-10pm, 2h otherwise).
#
# Runs the same grow-sync.mjs you run by hand, with --scheduled (never open a
# window; nobody is watching) and --push-days 7 (a narrow rewrite, so nothing
# reads the knocking table mid-replace).
#
#   bash scripts/run-grow-sync.sh          # what launchd runs
#
# Exit 3 means the token expired and only you can mint a new one. That is the one
# failure you have to act on, so it gets a notification naming the command.
# Everything else is appended to imports/done/sr-sync.log and retried next tick,
# since the watermark makes a failed run cost nothing but time.

cd "$(dirname "$0")/.." || exit 1

# Paused from the dashboard (Live badge > Pause). Skip without a marker, so no red and no email.
bash scripts/paused.sh sr && { echo "$(date) paused from dashboard, skipping" >> imports/done/sr-sync.log; exit 0; }

NODE=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)
[ -z "$NODE" ] && NODE=$(command -v node)
[ -z "$NODE" ] && { echo "$(date) node not found" >> imports/done/sr-sync.log; exit 1; }

mkdir -p imports/done

# A run that overruns its tick must not collide with the next one: two Chromes on
# one profile is exactly the "profile is already in use" failure, and the second
# process would clear the first's lock out from under it. Skip this tick instead;
# the watermark means nothing is lost, the next run just has more to pull.
# macOS has no flock(1), so the lock is a pid file we verify is still alive —
# which also self-heals after a crash, where a plain lockfile would wedge the
# schedule until someone noticed and deleted it.
PID=imports/done/sr-sync.pid
if [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; then
  echo "$(date) previous run (pid $(cat "$PID")) still going, skipping this tick" >> imports/done/sr-sync.log
  exit 0
fi
echo $$ > "$PID"
trap 'rm -f "$PID"' EXIT

echo "=== $(date) ===" >> imports/done/sr-sync.log
# Hard cap the run, and cap it UNDER the 5-minute StartInterval. It was 540s,
# sized when ticks were 10 minutes apart; left there, one wedged run would block
# two later ticks instead of one. A healthy run is 12s, so 240 is ample.
#
# A sync does not hang on its own, but the files it reads can:
# with the repo in an iCloud-synced folder, reading a file that hasn't been
# downloaded blocks indefinitely if the iCloud daemon wedges (observed
# 2026-08-05 — reads of data/sr-store.jsonl never returned, bird idle at 0% CPU,
# network fine). Without a cap that run holds the pid lock forever and every
# later tick skips silently, which looks exactly like "nothing to do".
# macOS has no timeout(1), hence the watchdog.
"$NODE" scripts/grow-sync.mjs --scheduled --push-days 7 >> imports/done/sr-sync.log 2>&1 &
np=$!
( sleep 240; kill -9 $np 2>/dev/null ) &
wd=$!
wait $np
code=$?
# Reap the watchdog inside the redirect, or bash prints a scary
# "Terminated: 15" job notice for it on every healthy run.
{ kill $wd && wait $wd; } 2>/dev/null
# Rep GPS trail (Ops > Rep Map). Same token, under a second, and its own cap so a
# hang here can never hold the pid lock. Never fails the tick: a missed run just
# re-reads the overlap next time.
"$NODE" scripts/rep-locations-sync.mjs >> imports/done/sr-sync.log 2>&1 &
lp=$!
( sleep 60; kill -9 $lp 2>/dev/null ) &
lw=$!
wait $lp
{ kill $lw && wait $lw; } 2>/dev/null
if [ "$code" = "137" ]; then
  echo "$(date) run exceeded 4 min and was killed" >> imports/done/sr-sync.log
fi
if [ "$code" != 0 ]; then
  msg="SalesRabbit sync failed (exit $code). See imports/done/sr-sync.log"
  fix="bash scripts/run-grow-sync.sh"
  [ "$code" = "3" ] && msg="token expired — sign in again" && fix="node scripts/grow-sync.mjs --seed"
  # 137 is the watchdog above, and re-running is the ONE thing that won't fix it:
  # whatever made the run overrun 4 minutes is still true on the next tick, so the
  # board would sit red offering a command that fails the same way every 5 minutes.
  # What actually causes it is store bloat. sr-store.jsonl and sr-leads.jsonl are
  # append-only with latest-line-wins, so re-pulling a lead leaves the old copy
  # behind; by 2026-08-18 they were 68% dead lines and the compile read 1.3 GB to
  # use half of it, which took a tick from 11s to over the cap. Compacting took it
  # straight back to 11s. So name THAT command, not the retry.
  # A big BACKLOG used to be the other cause (2026-10-16: a token expired overnight,
  # ~15,000 changed leads, every tick killed at the cap, seven hours of 137). It is
  # not anymore: under --scheduled the crawl stops after 30 es_search pages, saves
  # how far it got in data/sr-sync-state.json ("partial") and the next tick resumes
  # there, so a backlog drains over a few ticks on its own. A 137 that persists
  # across ticks is therefore the store, not the backlog.
  [ "$code" = "137" ] && msg="sync ran past its 4 minute cap and was killed. Usually the crawl store has filled with superseded lines. Compacting it is safe and keeps a backup" && fix="node scripts/compact-store.mjs"
  echo "$(date) FAILED exit $code" >> imports/done/sr-sync.log
  # Tell the dashboard, not just this Mac. The osascript notification below is
  # gone the moment it is dismissed, and grow-sync.mjs stamps __knock_sync__
  # only on SUCCESS — so before this line a failed run left NO trace anywhere
  # the app could see, and the start-of-day card kept reporting the last good
  # crawl as if nothing were wrong. That is how the token sat expired for eight
  # hours on 2026-08-07 with the card showing "catching up after sleep".
  bash scripts/sync-marker.sh sr_health fail "$msg" "$fix" "knock schedule"
  exit "$code"
fi

# Clear the failure. Without this the card would stay red after a good run.
bash scripts/sync-marker.sh sr_health ok "crawl ok" "" "knock schedule"
