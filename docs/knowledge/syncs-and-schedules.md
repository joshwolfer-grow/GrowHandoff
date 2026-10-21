# Syncs, schedulers and health

There are **two schedulers**, which is what made "what's running?" hard to answer:

1. **launchd on a Mac** (needs the machine awake, and for some jobs unlocked and logged in): the knocking scrapers, ISP workbooks/maps, ISP intake, WolfOffice workers.
2. **Vercel crons** (always on): Bria, Sequifi, Sequifi teams. (Watchdog and weekly summary were retired Oct 14 2026.)

Since Oct 14 2026 the one place to see both is **More > Admin > Sources** in GrowSales (`sources.js`): a pathway graph of every job reading `office_agents` / `office_events` / `office_snapshots` / `office_tasks` (tables now in the Grow Sales Supabase project), the `report_config` markers, the `*_sync_meta` rows and `data_versions`. Selecting a step traces upstream (solid) and downstream (dashed). Run now / Fix / Show log / Restart insert an `office_tasks` row that `com.wolfoffice.runner-grow` on the Mac executes within a minute and writes the result back on. Pause writes the shared `__paused__` flag. See wolfoffice.md.

## launchd agents (GrowSales)

Install/list/remove only with `bash scripts/install-agents.sh` (`--list`, `--remove`); `bash scripts/install-timetrack-agents.sh` for the Time Track pair (both unloaded Oct 14). **On a new Mac run `scripts/install-all-agents.sh`** (Oct 2026), which installs the GrowSales agents and the WolfOffice workers together. **Never hand-copy plists**: they hardcode absolute repo and node paths and fail silently elsewhere (the Aug 2026 repo move left every agent exiting "No such file or directory", launchctl status 78, for two days). Plist sources live in `scripts/launchd/*.plist`. `SETUP.md` in GrowSales is the new-Mac runbook. `scripts/sync-status.sh` summarises.

| Agent | Runs | Writes |
|---|---|---|
| `com.grow.sr-sync` | `scripts/run-grow-sync.sh` → `node scripts/grow-sync.mjs --scheduled` (implies `--lean`) | `knocking` (method sr_activity), `knocking_isp`; markers `__knock_sync__` (on success only = "data current as of") and `__sr_health__` `{ok,detail,fix}` (every run) |
| `com.grow.amplify-sync` | TDS Amplify crawl `scripts/amplify-company-sync.mjs --source tds` | `knocking`/`knock_events` source tds; `__amplify_sync__` |
| `com.grow.rtr-sync` | `scripts/run-rtr-sync.sh` → `scripts/rtr-sync.mjs` (Ezee, Bluepeak, Omni via Opendoor portal) | `knocking` per source; `__rtr_sync__` |
| `com.grow.isp-export` | hourly tick, runs once a day on the first tick after 7am: `scripts/run-isp-export.sh` | ISP workbooks to Drive, sector maps, TDS map crawl; `__isp_export__` + `sector_maps` markers |
| `com.grow.isp-intake` | every 5 min, `isp-intake.py --archive-only` on `imports/isp/` | archives raw ISP files to Drive, parks them |
| `com.grow.mail-leads` | every 10 min, `scripts/mail-leads-pull.py` | read-only IMAP on the owner's own Workspace mailbox (`GMAIL_USER` / `GMAIL_APP_PASSWORD` in `.env.prod`): mails FROM daxton@ / nick@growmarketing.biz with xlsx/csv attached are saved to `imports/isp/` with a quoted `.ask.txt` sidecar of what they asked for; never imports, never acts on the ask. State `imports/done/mail-leads-seen.txt`. Needs re-pointing at the new owner's mailbox |
| `com.grow.ezee-addresses` | hourly tick, runs once a day on the first tick after 7am (Oct 21 2026): `scripts/run-ezee-addresses.sh` | `ezee_knocks` / `ezee_addresses` from Ezee Activity_Detail (yesterday + today, per Grow team); marker `__ezee_addresses__`, health row "Ezee addresses" (daily cadence) |
| `com.grow.timetrack-import` (UNLOADED Oct 14 2026, plist in `~/Library/LaunchAgents/disabled-grow/`) | was a folder watcher on `imports/`, `node scripts/import-timetrack.mjs --scan` | `knocking` method timetrack. Never ran since Sep 14 (launchd bash could not write `imports/done/import.log`); Time Track is imported by hand if ever |
| `com.grow.timetrack-reminder` (UNLOADED) | weekday 9am notification to pull the Time Track report | obsolete since rtr-sync pulls Ezee |

Also unloaded into `disabled-grow/` on Oct 14 2026: `com.wolfoffice.mgrcards`, `com.wolfoffice.payaudit`, `com.wolfoffice.site`. Live launchd set on Oct 21 2026: sr-sync, amplify-sync (paused on the board since the TDS login expired Oct 5), rtr-sync, isp-export, isp-intake, mail-leads, ezee-addresses, plus the WolfOffice workers listed below.

**Pause / Resume (Oct 5 2026):** one switch, `report_config` row `__paused__` = `{key: {at}}`, keys `sr`, `tds`, `isp`, `rtr_<src>` (and since Oct 14 `slots_tds`, `slots_surf`, `wo_<agent>` for every other WolfOffice worker). Toggle it from the Live badge popover in the top bar (`window._growTogglePause`, paused rows grey and not counted as bad) or the Sources page. Runners call `bash scripts/paused.sh <key>` (fails OPEN) and skip silently with no marker, so a paused job shows neither red nor an email; rtr checks per source; `isp-export` ignores the flag under `ISP_FORCE=1`; `~/bin/office-wrap` checks `wo_<agent>` before a WolfOffice worker runs.

**Cadence since Sep 29 2026:** sr-sync, amplify-sync and rtr-sync run on a `StartCalendarInterval` list (73 runs/day) written by `scripts/knock-schedule.py`: every 10 min 11am to 10pm, every 2h overnight. Opendoor (`run-rtr-sync.sh`) still skips before 8am (window gate `RTR_START_HOUR`/`RTR_END_HOUR`), so its seal and the daily Omni pull land at 8am. History: Aug 7 2026 sr/amplify every 5 min, rtr every 30 min, then hourly 8am to 10pm. rtr was never pushed faster because it renders an SSRS report in Chrome on Opendoor's server and its data is cumulative for the day.

**Changing a cadence means editing all of:** the schedule (knock-schedule.py / plist), the runner's watchdog `sleep`, and the health-board row config in `index.html` (`_growSyncStatus` / `_growSyncState`: `every:`, `sched:`, `slots:true`, `slotFrom:8`; `RTR_CADENCE` per RTR source; `cadence` in `data/rtr-sources.json`). The board measures "runs missed" against these and lies if they drift.

**Watchdogs:** fast runners are killed at 240s so a wedged run dies before the next tick. Exit 137 = killed by watchdog (usually store bloat, see below).

**Exit codes:** sr-sync exit 3 = expired SalesRabbit API token; fix `node scripts/grow-sync.mjs --seed` (interactive sign-in, a human must do it; recurs every day or two). Without a sign-in it exits "Never saw an API token". rtr-sync exit 3 = expired Opendoor SSO, human renews. Amplify TDS login lives in `.amplify-profile-tds/`, re-auth `--source tds --login`; session expiry is the main fragility.

**Tell a stale token from a dead agent:** stale token = a fresh FAILED line in `imports/done/sr-sync.log`; dead agent = no new lines at all. Check `launchctl list | grep grow` (nonzero last exit) and `imports/done/*-agent.err` before re-seeding.

**Profile locks:** rtr-sync holds a Chrome profile lock covering every entry point (a manual run used to kill the scheduled one). Backfills use a copied profile `--profile .rtr-profile-backfill` so they never hold the live lock (scheduled ticks skip while it is held). Backfill and manual runs need `--scheduled` or Chrome opens visibly. grow-sync holds `imports/done/sr-sync.pid`; anything touching the crawl store (isp-export recompile, crawl purges) must take that lock.

**Markers:** stamps go through `scripts/sync-marker.sh` (upsert; anon has no DELETE on `report_config`). It takes a 5th arg `cadence` stored on the marker. Before Aug 7 2026 grow-sync did DELETE-then-POST, both failed inside a catch, and `__knock_sync__` froze while the crawl ran fine.

**Failure emails (one per outage, since Oct 19 2026):** `sync-marker.sh` calls `scripts/alert-email.py` (Gmail SMTP, creds in `.env.prod`); Mac banners were removed. Rule the owner set ("just once and that's it"): ONE email when a source fails, no "recovered" mail, no 12h reminders (those were about half of 78 emails). Sources whose cadence label contains "min" or "knock" (Ezee/Bluepeak rtr, amplify, sr_health) must fail TWICE in a row before mailing because an Ezee render routinely times out once and clears on the next tick; daily sources mail on the first fail. State file `imports/done/alerts/<name>` = `<ok|fail> <strikes> <mailed>`. A new runner must pass its cadence as arg 5 ("knock schedule" or "daily") or it is treated as daily. The health board, not email, shows when something clears.

**Health colours:** `_growSyncState` derives amber from `every*3` minutes but red from `bad` HOURS, so anything slower than hourly must set `warn` explicitly or it jumps straight to red. Daily = `{every:1440, warn:1560, bad:50}` (green to 25h, amber 26 to 50h, red past 50h). An Omni row that is green means "ran fine", not "data flowing" (empty reports exit 0).

**Where health shows:** a status dot on the "Updated" badge in the top bar (green all current, amber behind/asleep, red pulsing failed; tap for per-source breakdown). There used to be a Start-of-day card and Admin › Ops › Automations board (`opsAutomations()`); the Ops/Flags pages were removed Sep 16 2026, so confirm what remains of the board in the current file. Cloud crons show as blue reference rows (no local marker).

## Store bloat and compaction

`data/sr-store.jsonl` and `data/sr-leads.jsonl` are append-only, latest-line-per-lead wins. By Aug 18 2026 they were ~68% superseded (627k lines for 202k leads, 909 MB) and ticks hit the 240s watchdog. Fix: `node scripts/compact-store.mjs` (keeps `.pre-compact` copies; verify with a recompile then delete them); took a run from 166s to 11s. grow-sync nags when the store is >50% stale and `run-grow-sync.sh` publishes `compact-store.mjs` as the `fix` on exit 137.

`--scheduled` implies `--lean` (skips sr-activity / sr-lead-history / sr-doors-by-area CSVs). Run plain `node scripts/grow-sync.mjs` (or `--skip-crawl --full-csv`) before `knock-report.py` or those CSVs are stale. `sr-doors-by-area.csv` is never byte-stable (`days_since_last_knock` uses now).

## Chrome download crash (Sep 1 2026)

Chrome 152.0.7977.65 crashes the whole browser on any Playwright download, killing all three Opendoor syncs. Fix in `rtr-sync.mjs`: stub `window.open` around `$find('ctl00_MainContent_ReportViewer1').exportReport('CSV')`, capture the URL (carries the live ReportSession and ControlID), fetch it with `ctx.request.get()` (shares cookies). Any future Playwright script needing a file must do the same. Verified by matching 8/31 numbers (ezee 858 doors / 41 sold, bluepeak 25 / 2).

## Vercel crons

**As of Oct 21 2026 there are exactly three** (UTC): `sequifi-sync` 08:30 (writes `rep_onboarding`, the Sequifi user mirror, NOT deals), `sequifi-teams-sync` 08:45 (`__sequifi_teams__`), `bria-sync` 09:00 (Bria deals/daily/teams, filtered to Grow's company since Oct 16). Deals come hourly from the Rep Sales sheet Apps Script, not from any Vercel cron. The weekly rep email has NO cron (manual by choice).

Retired Oct 14 2026: `sync-watchdog` (10:00) and `weekly-summary` (Monday 14:00). Their files, `vapid-public-key.js` and `_notify.js` were moved to `GrowSales/backups/api-retired-20261014/` and the cron entries removed. The watchdog pushed to a single dead web-push subscription; the summary was Monday-anchored (so reported 0 sold against Sunday weeks) and counted Sequifi deals. **Trap:** `api/sequifi-sync.js` line 21 and `api/sequifi-teams-sync.js` line 32 still `require('./_notify.js')`; stub it (as `bria-sync.js` does since Oct 16 with a `console.warn`) before the next deploy or those two functions fail at load. The bria/sequifi syncs otherwise alert only via their own `*_sync_meta` rows now; there is no push or email path from Vercel.

Pre-Oct 14 behaviour, for reading old code: the watchdog read `sequifi_sync_meta`/`bria_sync_meta`/`pronto_sync_meta` and pushed (web-push via `api/_notify.js`, VAPID env) when a sync was >20h stale or errored. Bria sync parallelises writes (batches of 6, count=exact on page 1 only) to fit the 60s ceiling; a shrink guard refuses an unexpected drop (`?force=1` overrides, used Oct 16 after the demo-company filter).

## Google Apps Scripts (run as the owner's Google account)

- Rep Sales sheet: hourly Supabase sync (`scripts/rep-sales-sync.gs`), `doPost` web app for Sync now; a second Apps Script email importer feeds a "Knocking Data" tab (legacy).
- Master Manager Pay sheet: `scripts/master-pay-sync.gs` (Monday `mphPush` trigger) → `__roster_weeks__` (stalled at 2026-08-09 by late Aug).
- Blitz Sign Up sheet: `scripts/roster-sync.gs` ("Grow Roster" menu, Sunday trigger) → `__roster_current__`. Never confirmed run.
- Onboarding sheet: `processNewHires` every 15 min (see data-sources.md).
Workspace org blocks service-account creation, so Apps Script running as a user is the cron route for sheets.

## WolfOffice launchd jobs that serve Grow

Still loaded on Oct 21 2026: `com.wolfoffice.runner-grow` (every 60s, executes `office_tasks` rows queued by the Sources page), `chief-grow` 08:00, `analyst` 07:30, `installs` 07:35, `chaser` 07:40, `isp-i3` / `isp-slic` / `isp-lyte` / `isp-surf` / `isp-tds` / `isp-ezee` / `isp-omni` 07:15 to 07:27, `sales-lead` 07:50, `slots-tds` 6:30 / 11:30 / 15:30, `slots-surf` 6:45 / 11:45 / 15:45. Unloaded Oct 14: `mgrcards` (09:00 manager cards), `payaudit`, `site`. See wolfoffice.md.

## Morning check

One glance: status dot green, then today's knocking board populating. If red: read the per-source fix command; for SR token expiry run the seed; for watchdog kills compact the store. Grey rows are paused on purpose (check `__paused__` before assuming a job died). Since Oct 19 you get one email per outage and nothing when it clears, so the board is the only "it's back" signal. Today (Oct 21) isp-export is red for 2 unlabeled import batches (see open-items.md).
