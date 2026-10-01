# Wolf Office (Grow)

Wolf Office is a status and orchestration layer that sits on top of the Grow data syncs.
It does not move Grow data itself. The real syncs (SalesRabbit, Amplify, Opendoor/RTR,
ISP export, lead intake) live in `~/Grow/GrowSales/scripts` and run from their own
`com.grow.*` launchd jobs.

What Wolf Office adds:

- **Workers**: small scheduled scripts (`workers/grow/*`) that read the Grow Sales database
  each morning and write one JSON "snapshot" per worker: rep outliers, install date changes,
  untouched callbacks, a revenue read per ISP, install slot availability, an upfront pay audit.
- **Event log**: `bin/office-wrap` brackets a job and posts start/finish events with
  `bin/office-log`, so every run is on record in the Wolf Office Supabase project.
- **Runner and Chief**: the Runner works a small task queue (run, check, restart, show log,
  fix) from a fixed menu; the Chief does a morning roll call and writes a ranked to-do list.
- **Office UI**: an isometric office at http://localhost:8787 (`node bin/office-serve.mjs`)
  that shows every worker's state, its findings, and Run/Fix buttons.

## It is optional

GrowSales runs fine without Wolf Office. The checked-in launchd templates in
`~/Grow/GrowSales/scripts/launchd/` do not use `office-wrap`, so the core syncs keep working
if you never install this. You only lose the morning findings, the event log and the UI.

One catch: on the original Mac the installed `com.grow.sr-sync`, `amplify-sync`, `rtr-sync`
and `isp-export` plists were hand-edited to call `~/bin/office-wrap` (see
`docs/instrumented.md`), and `run-isp-intake.sh` calls `~/bin/office-log`. If you copy those
installed plists instead of using the repo templates, install Wolf Office first, or the
syncs fail to start because `~/bin/office-wrap` is missing.

## Layout

This repo is expected at `~/Grow/WolfOffice`, next to `~/Grow/GrowSales`. Some paths
assume that layout (the Runner's commands in `site/help.js`, `lib/growdb.mjs` reading the
Grow anon key from `~/Grow/GrowSales/index.html`). `payaudit` and `mgrcards` also read
`GROW_ACCESS_CODE` from `~/Grow/RepText/.env`.

## Setup

Needs: macOS, Node 20+ on PATH, `python3` on PATH (for the lead desk), Google Chrome
(the Playwright workers borrow GrowSales' `node_modules/playwright` with `channel: 'chrome'`),
and GrowSales already set up with `npm ci`.

1. **Database.** Create a new Supabase project and run the SQL in `supabase/` in order.
   Read `supabase/README.md` first: `0001_office.sql` has a `<SUCCESSOR_AUTH_UID>` policy
   placeholder you must fill in or delete.
2. **Env.** `cp .env.example .env` and fill `OFFICE_SUPABASE_URL` and `OFFICE_SERVICE_KEY`
   (Project Settings > API, the service_role key). Every worker refuses to start without them.
3. **Install.** `npm ci` (only dev dependency is vitest), then `npx vitest run` as a sanity check.
4. **Preview the jobs.** `bin/install-workers.sh --dry-run` prints every launchd plist it
   would write, with this machine's node, python and paths filled in. Nothing is written.
5. **Install the jobs.** `bin/install-workers.sh`. It links `~/bin/office-wrap` and
   `~/bin/office-log` to this repo, writes `~/Library/LaunchAgents/com.wolfoffice.<name>.plist`
   for each entry in `workers/workers.json`, and loads them. Logs go to
   `~/Library/Logs/wolfoffice/<name>.log`. It refuses to run if `workers.json` contains any
   name outside its Grow allowlist. Re-run it after editing `workers.json`.
6. **UI.** `node bin/office-serve.mjs`, then open http://localhost:8787
   (`?fixture=1` shows demo data with no database). To keep it running, make a launchd
   plist with `RunAtLoad` + `KeepAlive` that runs node on `bin/office-serve.mjs`; the installer
   does not create that one.

`workers/workers.json` uses two placeholders the installer fills in: `__WOLFOFFICE__` (this
folder) and `__HOME__` ($HOME). Python is `$GROW_PYTHON`, else `python3` on PATH.

## Jobs (17)

| job | runs | schedule | what it does |
|---|---|---|---|
| isp-i3 | workers/grow/isp.mjs i3 | daily 07:15 | i3 revenue read: Bria sales vs pace, installs, cancels, booking lag, lead file and export freshness |
| isp-slic | isp.mjs slic | daily 07:17 | same, SLIC |
| isp-lyte | isp.mjs lyte | daily 07:19 | same, Lyte |
| isp-surf | isp.mjs surf | daily 07:21 | same, Surf |
| isp-tds | isp.mjs tds | daily 07:23 | same, TDS |
| isp-ezee | isp.mjs ezee | daily 07:25 | same, Ezee |
| isp-omni | isp.mjs omni | daily 07:27 | same, Omni |
| analyst | workers/grow/analyst.mjs | daily 07:30 | reps outside the team's middle 80% (lead time, sold/day, install rate, doors/day) |
| installs | workers/grow/installs.mjs | daily 07:35 | install dates pushed, cancelled, or booked far out vs yesterday |
| chaser | workers/grow/chaser.mjs | daily 07:40 | cancel callbacks untouched for 3+ days, by rep |
| sales-lead | isp.mjs all | daily 07:50 | rolls the ISP desks into one company view (needs the ISP runs above) |
| chief-grow | workers/chief/chief.mjs grow | daily 08:00 | roll call, queues reruns/fixes, ranked to-do |
| mgrcards | ~/Grow/GrowSales/scripts/daily-report-text.mjs --scheduled --send | daily 09:00 | manager cards texted to "Daily Report: <Manager>" groups (see known issues) |
| payaudit | workers/grow/payaudit.mjs | Thu 06:00 | reruns the dashboard's upfront pay math, lists adjustments both ways |
| slots-tds | workers/grow/slots.mjs tds | 06:30, 11:30, 15:30 | earliest TDS install date per market (never books) |
| slots-surf | workers/grow/slots.mjs surf | 06:45, 11:45, 15:45 | earliest Surf install date per market (never books) |
| runner-grow | workers/runner/runner.mjs grow | every 60 s | works the task queue from the UI and the Chief |

All but `runner-grow` run through `office-wrap`, so the UI shows start/finish for each run.
The UI also shows the GrowSales syncs (crawler, amplify, rtr, exporter, courier) when their
plists are wrapped as described above.

## Known issues

- **mgrcards has never delivered reliably.** It sends iMessages from whatever Apple ID is
  signed in to this Mac's Messages app, into hand-made group chats named exactly
  "Daily Report: <Manager>". It needs Full Disk Access (to read `chat.db`), Automation and
  Accessibility, and the Mac awake, unlocked and signed in at 09:00. On a new Mac none of
  the groups exist and they cannot be created by script. Decide whether to keep it before
  installing; to drop it, remove its entry from `workers/workers.json` and from `ALLOW` in
  `bin/install-workers.sh`.
- **payaudit needs a corporate access code.** `GROW_ACCESS_CODE` in `~/Grow/RepText/.env`
  (or the process env) must be a corporate code; a rep or manager code signs in but no deal
  data loads ("is the access code corporate?"). It keeps a Chrome profile at
  `~/.grow-payaudit-profile`.
- **slots-surf needs a Surf login profile.** `GrowSales/.env.install-slots` (`SURF_USER_ID`,
  `SURF_PIN`) and the GrowSales `.slots-profile-surf` Chrome profile, created by signing in
  once through `scripts/install-slots.mjs`. slots-tds needs no login.
- The lead desk (`site/leads.html`) asks the Claude Code CLI (`claude`, Haiku) to name
  columns, so it uses whichever Claude account is signed in on this Mac.
- `bin/office-beat-file` and `bin/subagent-hook.mjs` are optional helpers no scheduled
  Grow job uses.
- A few UI skins and props in `site/` were drawn for other floors that no longer exist.
  They are unused and harmless.
