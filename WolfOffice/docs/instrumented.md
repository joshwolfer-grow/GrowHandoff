# Instrumented jobs

Changes made outside this repo on 2026-09-14 (on the original Mac; the GrowSales repo templates in scripts/launchd/ do NOT include them) so existing jobs report to the office.
Backups sit next to each file with a `.bak-office-20260914` suffix.

## launchd (~/Library/LaunchAgents)

StandardOutPath set to the same file as StandardErrorPath (the wrapper merges the two streams).
ProgramArguments changed from `/bin/bash <script>` to
`~/bin/office-wrap <agent> --status-from-last-line -- /bin/bash <script>`.

| plist | agent | script |
|---|---|---|
| com.grow.sr-sync.plist | crawler | ~/Grow/GrowSales/scripts/run-grow-sync.sh |
| com.grow.amplify-sync.plist | amplify | ~/Grow/GrowSales/scripts/run-amplify-sync.sh |
| com.grow.rtr-sync.plist | rtr | ~/Grow/GrowSales/scripts/run-rtr-sync.sh |
| com.grow.isp-export.plist | exporter | ~/Grow/GrowSales/scripts/run-isp-export.sh |

## ~/Grow/GrowSales/scripts/run-isp-intake.sh (agent: courier)

- Empty inbox tick now runs `office-log beat courier` before exiting.
- The intake call is wrapped: `office-wrap courier -- python3 scripts/isp-intake.py ...`.

## Rollback

Restore the `.bak-office-20260914` copies and `launchctl unload/load` each plist.

## Local server

`~/Library/LaunchAgents/com.wolfoffice.site.plist` runs `bin/office-serve.mjs` at http://127.0.0.1:8787 (KeepAlive, PATH set to node + python). It serves the page and a read-only `/api/state` that queries Supabase with the service key from `.env`; the page has no sign-in because the server only listens on 127.0.0.1. Fixture view: http://127.0.0.1:8787/?fixture=1

## Wolf Office workers (2026-09-15)

`bin/install-workers.sh` writes one launchd job per entry in `workers/workers.json`
(`com.wolfoffice.<name>`), logs in `~/Library/Logs/wolfoffice/<name>.log`. Each job
runs through `office-wrap` so the desk logs start and finish. Re-run the installer
after editing `workers.json`.

| job | agent | what | when |
|---|---|---|---|
| analyst | analyst | rep outliers vs team (Grow) | 07:30 |
| installs | installs | install date diffs (Grow) | 07:35 |
| chaser | chaser | untouched callbacks (Grow) | 07:40 |

Grow workers read the Grow Sales Supabase project with the anon key embedded in
`~/Grow/GrowSales/index.html` (same as Grow's own scripts). The office tables live in
the Wolf Office Supabase project configured in `~/Grow/WolfOffice/.env`.

## Added 2026-09-15: Pay Auditor, Runners, Chiefs of staff

| job | agent | what | when |
|---|---|---|---|
| payaudit | payaudit | drives growsales.vercel.app headless (Playwright, corporate code from ~/Grow/RepText/.env) and calls the page's own computePayrun; diffs live owed vs frozen paid for closed weeks, lists adjustments both ways | Thu 06:00 |
| runner-grow | logs itself as runner-&lt;floor&gt; | claims the oldest queued row in `office_tasks` for its floor and executes it from `workers/runner/menu.mjs` (run, check, restart, log, fix). Desk jobs run through office-wrap as the target worker. `fix` tasks wait for Approve on the Runner's card | every 60 s, plus `launchctl kickstart` from the site when a task is queued |
| chief-grow | chief-&lt;floor&gt; | roll call (queues run/fix tasks for stale or failed workers), ranked to-do from every worker's latest snapshot, carry-over vs the previous brief | 08:00 |

The pay functions live in a nested scope inside the dashboard, so payaudit rewrites `window._grow={` to `window._grow={upfront:function(){...},` in the HTML **as loaded in its own headless browser only** (a Playwright route). Nothing on Vercel or on disk changes. If that anchor ever disappears the worker fails with a plain message.

Card **Run now** buttons now go through the floor's Runner (`POST /api/run` inserts an `office_tasks` row and kicks the Runner) so every run is on the record. `POST /api/task` queues any menu task, `/api/task/approve` and `/api/task/cancel` act on waiting ones, `GET /api/tasks?floor=` lists them.

## Added 2026-09-16: Card sender

| job | agent | what | when |
|---|---|---|---|
| mgrcards | mgrcards | runs `~/Grow/GrowSales/scripts/daily-report-text.mjs --scheduled --send`: drives growsales.vercel.app headless, calls `window._buildMgrCard` per manager whose team knocked yesterday, pastes the PNG into the hand-made Messages group "Daily Report: &lt;Manager&gt;" (members read from chat.db) and confirms the attachment landed in that group. Needs the Mac awake and unlocked, Messages signed in, Full Disk Access + Accessibility for node/osascript | daily 09:00 |
