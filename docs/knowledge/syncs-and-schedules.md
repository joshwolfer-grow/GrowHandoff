# Syncs, schedulers and health

There are **two schedulers**, which is what made "what's running?" hard to answer:

1. **launchd on a Mac** (needs the machine awake, and for some jobs unlocked and logged in): the knocking scrapers, ISP workbooks/maps, ISP intake, WolfOffice workers.
2. **Vercel crons** (always on): Bria, Sequifi, Sequifi teams, watchdog, weekly summary.

## launchd agents (GrowSales)

Install/list/remove only with `bash scripts/install-agents.sh` (`--list`, `--remove`); `bash scripts/install-timetrack-agents.sh` for the Time Track pair. **Never hand-copy plists**: they hardcode absolute repo and node paths and fail silently elsewhere (the Aug 2026 repo move left every agent exiting "No such file or directory", launchctl status 78, for two days). Plist sources live in `scripts/launchd/*.plist`. `SETUP.md` in GrowSales is the new-Mac runbook. `scripts/sync-status.sh` summarises.

| Agent | Runs | Writes |
|---|---|---|
| `com.grow.sr-sync` | `scripts/run-grow-sync.sh` → `node scripts/grow-sync.mjs --scheduled` (implies `--lean`) | `knocking` (method sr_activity), `knocking_isp`; markers `__knock_sync__` (on success only = "data current as of") and `__sr_health__` `{ok,detail,fix}` (every run) |
| `com.grow.amplify-sync` | TDS Amplify crawl `scripts/amplify-company-sync.mjs --source tds` | `knocking`/`knock_events` source tds; `__amplify_sync__` |
| `com.grow.rtr-sync` | `scripts/run-rtr-sync.sh` → `scripts/rtr-sync.mjs` (Ezee, Bluepeak, Omni via Opendoor portal) | `knocking` per source; `__rtr_sync__` |
| `com.grow.isp-export` | hourly tick, runs once a day on the first tick after 7am: `scripts/run-isp-export.sh` | ISP workbooks to Drive, sector maps, TDS map crawl; `__isp_export__` + `sector_maps` markers |
| `com.grow.isp-intake` | every 5 min, `isp-intake.py --archive-only` on `imports/isp/` | archives raw ISP files to Drive, parks them |
| `com.grow.timetrack-import` | folder watcher on `imports/`, `node scripts/import-timetrack.mjs --scan` | `knocking` method timetrack, moves files to `imports/done/` |
| `com.grow.timetrack-reminder` | weekday 9am notification to pull the Time Track report | (reminder only; likely obsolete since rtr-sync pulls Ezee) |

**Cadence since Sep 29 2026:** sr-sync, amplify-sync and rtr-sync run on a `StartCalendarInterval` list (73 runs/day) written by `scripts/knock-schedule.py`: every 10 min 11am to 10pm, every 2h overnight. Opendoor (`run-rtr-sync.sh`) still skips before 8am (window gate `RTR_START_HOUR`/`RTR_END_HOUR`), so its seal and the daily Omni pull land at 8am. History: Aug 7 2026 sr/amplify every 5 min, rtr every 30 min, then hourly 8am to 10pm. rtr was never pushed faster because it renders an SSRS report in Chrome on Opendoor's server and its data is cumulative for the day.

**Changing a cadence means editing all of:** the schedule (knock-schedule.py / plist), the runner's watchdog `sleep`, and the health-board row config in `index.html` (`_growSyncStatus` / `_growSyncState`: `every:`, `sched:`, `slots:true`, `slotFrom:8`; `RTR_CADENCE` per RTR source; `cadence` in `data/rtr-sources.json`). The board measures "runs missed" against these and lies if they drift.

**Watchdogs:** fast runners are killed at 240s so a wedged run dies before the next tick. Exit 137 = killed by watchdog (usually store bloat, see below).

**Exit codes:** sr-sync exit 3 = expired SalesRabbit API token; fix `node scripts/grow-sync.mjs --seed` (interactive sign-in, a human must do it; recurs every day or two). Without a sign-in it exits "Never saw an API token". rtr-sync exit 3 = expired Opendoor SSO, human renews. Amplify TDS login lives in `.amplify-profile-tds/`, re-auth `--source tds --login`; session expiry is the main fragility.

**Tell a stale token from a dead agent:** stale token = a fresh FAILED line in `imports/done/sr-sync.log`; dead agent = no new lines at all. Check `launchctl list | grep grow` (nonzero last exit) and `imports/done/*-agent.err` before re-seeding.

**Profile locks:** rtr-sync holds a Chrome profile lock covering every entry point (a manual run used to kill the scheduled one). Backfills use a copied profile `--profile .rtr-profile-backfill` so they never hold the live lock (scheduled ticks skip while it is held). Backfill and manual runs need `--scheduled` or Chrome opens visibly. grow-sync holds `imports/done/sr-sync.pid`; anything touching the crawl store (isp-export recompile, crawl purges) must take that lock.

**Markers:** stamps go through `scripts/sync-marker.sh` (upsert; anon has no DELETE on `report_config`). It takes a 5th arg `cadence` stored on the marker. Before Aug 7 2026 grow-sync did DELETE-then-POST, both failed inside a catch, and `__knock_sync__` froze while the crawl ran fine.

**Health colours:** `_growSyncState` derives amber from `every*3` minutes but red from `bad` HOURS, so anything slower than hourly must set `warn` explicitly or it jumps straight to red. Daily = `{every:1440, warn:1560, bad:50}` (green to 25h, amber 26 to 50h, red past 50h). An Omni row that is green means "ran fine", not "data flowing" (empty reports exit 0).

**Where health shows:** a status dot on the "Updated" badge in the top bar (green all current, amber behind/asleep, red pulsing failed; tap for per-source breakdown). There used to be a Start-of-day card and Admin › Ops › Automations board (`opsAutomations()`); the Ops/Flags pages were removed Sep 16 2026, so confirm what remains of the board in the current file. Cloud crons show as blue reference rows (no local marker).

## Store bloat and compaction

`data/sr-store.jsonl` and `data/sr-leads.jsonl` are append-only, latest-line-per-lead wins. By Aug 18 2026 they were ~68% superseded (627k lines for 202k leads, 909 MB) and ticks hit the 240s watchdog. Fix: `node scripts/compact-store.mjs` (keeps `.pre-compact` copies; verify with a recompile then delete them); took a run from 166s to 11s. grow-sync nags when the store is >50% stale and `run-grow-sync.sh` publishes `compact-store.mjs` as the `fix` on exit 137.

`--scheduled` implies `--lean` (skips sr-activity / sr-lead-history / sr-doors-by-area CSVs). Run plain `node scripts/grow-sync.mjs` (or `--skip-crawl --full-csv`) before `knock-report.py` or those CSVs are stale. `sr-doors-by-area.csv` is never byte-stable (`days_since_last_knock` uses now).

## Chrome download crash (Sep 1 2026)

Chrome 152.0.7977.65 crashes the whole browser on any Playwright download, killing all three Opendoor syncs. Fix in `rtr-sync.mjs`: stub `window.open` around `$find('ctl00_MainContent_ReportViewer1').exportReport('CSV')`, capture the URL (carries the live ReportSession and ControlID), fetch it with `ctx.request.get()` (shares cookies). Any future Playwright script needing a file must do the same. Verified by matching 8/31 numbers (ezee 858 doors / 41 sold, bluepeak 25 / 2).

## Vercel crons

UTC: `sequifi-sync` 08:30, `sequifi-teams-sync` 08:45, `bria-sync` 09:00, `sync-watchdog` 10:00, `weekly-summary` Monday 14:00. The weekly rep email has NO cron (manual by choice, see reports-emails-texts.md). The watchdog reads `sequifi_sync_meta`/`bria_sync_meta`/`pronto_sync_meta` and pushes (web-push via `api/_notify.js`, VAPID env) only when a sync is >20h stale or errored; sequifi/bria syncs also alert inline in their catch blocks. Test: `curl "https://growsales.vercel.app/api/sync-watchdog?key=<SYNC_TRIGGER_KEY>"`. Bria sync parallelises writes (batches of 6, count=exact on page 1 only) to fit the 60s ceiling.

## Google Apps Scripts (run as the owner's Google account)

- Rep Sales sheet: hourly Supabase sync (`scripts/rep-sales-sync.gs`), `doPost` web app for Sync now; a second Apps Script email importer feeds a "Knocking Data" tab (legacy).
- Master Manager Pay sheet: `scripts/master-pay-sync.gs` (Monday `mphPush` trigger) → `__roster_weeks__` (stalled at 2026-08-09 by late Aug).
- Blitz Sign Up sheet: `scripts/roster-sync.gs` ("Grow Roster" menu, Sunday trigger) → `__roster_current__`. Never confirmed run.
- Onboarding sheet: `processNewHires` every 15 min (see data-sources.md).
Workspace org blocks service-account creation, so Apps Script running as a user is the cron route for sheets.

## WolfOffice launchd jobs that serve Grow

`mgrcards` 09:00 daily manager cards; `com.wolfoffice.slots-tds` (6:30 / 11:30 / 15:30) and `slots-surf` (:45) install-slot checks. See wolfoffice.md.

## Morning check

One glance: status dot green, then today's knocking board populating. If red: read the per-source fix command; for SR token expiry run the seed; for watchdog kills compact the store.
