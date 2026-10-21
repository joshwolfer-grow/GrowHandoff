# Grow Ops Handoff

As of Oct 21 2026. Written by Josh Wolfer on his last day. The live, shareable copy of this page is the Claude doc "Grow Ops Handoff"; this file is the repo copy.

Everything that keeps growsales.vercel.app and the Grow field-ops routines running, written so a successor can run it without having built it. The code and the detailed knowledge base live in this repo (GrowHandoff); this page is the process layer on top. Start here, then `HANDOFF.md` for machine setup, then `docs/knowledge/` for detail.

## 1. The system in one map

Four layers. The first two run with no laptop; the last two run on one Mac that must stay awake.

| Layer | What it is | Where it lives | Needs a laptop |
| --- | --- | --- | --- |
| Dashboard | One static page (`GrowSales/index.html`, ~1.2 MB) that reads Supabase directly from the browser. Corporate, manager and cancel-caller logins only; reps use Bria. | https://growsales.vercel.app, deployed with `vercel --prod` from `~/Grow/GrowSales` | No |
| Database | Supabase Postgres project `cmkfohwbejcztctrpdnt` (Grow Sales). Every table the site shows, plus `report_config` key/value markers. | Supabase org owned by Josh (transfer, see section 10) | No |
| Server syncs | Vercel serverless functions on daily crons: Bria sales, Sequifi users and Sequifi teams. The deals feed itself arrives hourly from the Rep Sales Google Sheet's Apps Script. | `GrowSales/api/*.js`, schedules in `vercel.json` | No |
| Local jobs | launchd agents on the Mac: SalesRabbit knock crawl, Opendoor/Ezee portal pulls, TDS Amplify crawl, ISP mail intake, ISP workbooks and sector maps, Ezee address sheet, plus WolfOffice workers (install slots, morning briefs). | `GrowSales/scripts/`, plists in `scripts/launchd/`, installed with `scripts/install-all-agents.sh` | Yes |

**The one repo to clone** is this one, to `~/Grow` on the new Mac (paths assume that). It holds `GrowSales/`, `WolfOffice/` (Grow parts only), `RepText/`, `TrainingVideos/`, the Grow Claude skills, `bootstrap.sh` for a new machine, and `docs/knowledge/` with 17 topic files that explain every rule and trap in detail. The successor opens Claude Code in that folder and says "Set me up. Follow HANDOFF.md."

**Upstream systems** and what each feeds:

| System | Feeds | Login type |
| --- | --- | --- |
| Bria (rep sales app, new since Sep 11 2026) | `bria_sales_daily`, `bria_deals`, `bria_teams`: source of truth for sold, reps, teams | read-only Supabase role issued by Bria |
| Sequifi (comp platform) | `deals` (install report feed), weekly teams for login roles | admin seat, API token expires every ~60 days |
| SalesRabbit (door app, Grow tenant) | `knocking` method `sr_activity`, `knock_events`, `knocking_isp`, lead imports, areas | user login seeded into a Chrome profile |
| SalesRabbit old tenant (TDS) | TDS map only | separate login |
| Amplify (TDS company) | `knocking` source `tds` | cookie session in `.amplify-profile-tds/` |
| Opendoor / Realtime Results portal | Ezee, Bluepeak, Omni knocking and hours | SSO session in `.rtr-profile*/` |
| Google Drive shared drive "Grow - Corporate" | raw ISP files, SalesRabbit import CSVs, ISP-facing workbooks | Drive for Desktop |
| Gmail shared mailbox | ISP lead attachments in, weekly rep emails and crawler alerts out | app password |
| Google Sheets (Rep Sales, Master Manager Pay, upfront opt-in, Ezee Addresses) | deals feed, opt-in list, pay history log, Ezee address list | Apps Script run as the owner |
| Geocodio, Terros | address geocoding, Terros territory pushes | API keys |
| Canva | training decks, weekly manager meeting deck, ISP guides | Canva team seat |

## 2. Your calendar

Most of the system runs itself. This is what a person still does, and the skill or page to use. Say any of these to Claude Code in plain words.

| When | Task | How |
| --- | --- | --- |
| Every morning | Glance at the status dot on the dashboard's Updated badge (top bar). Green = all sources current. Red = tap it, the row names the fix command, usually a re-login. | Dashboard, section 4 |
| Every morning | Check `imports/isp/parked/` (or the macOS notification) for ISP lead files that arrived overnight. Each one needs a human review before it becomes a SalesRabbit import. | isp-leads skill, section 3 |
| When a file arrives | Build the SalesRabbit CSV, upload it in SalesRabbit (manual browser step), then "add these to the map". | section 3 |
| When a cancel list arrives from an ISP | Load it into Cancel Center. | cancel-list-import skill, section 8 |
| When a TDS cancel report arrives | Same, with `--isp TDS`; it is the only source of TDS phones and emails. | section 8 |
| Monday morning | Pull the numbers for the manager meeting deck and the More > Meeting board; goals get set on the call. | section 9 |
| Monday (or when the list comes) | Paste the weekly subs list so subs stay out of KPIs, PRA and pay. | section 6 |
| Weekly | Paste the schedule and ask "who's missing from Sequifi". | sequifi-roster-check skill |
| Thursday | Upfront pay run: Payroll > Upfront > Pay & Reconcile, tick paid, close the run, export the 6-column Sequifi file. Sales Thu to Wed, processed Thu, paid Fri. | section 7 |
| Weekly, by hand | Weekly rep email (control panel on `/api/weekly-rep-email`, no cron by design). Confirm whether it is still wanted now that reps live in Bria. | section 9 |
| Every ~60 days | Sequifi API token expires: the Vercel sync starts failing with 401. Mint a new one, update `SEQUIFI_TOKEN` in Vercel and `GrowSales/data/.sequifi-token`. | section 10 |
| Every day or two | SalesRabbit crawl token expires (exit 3, red row). Run `node scripts/grow-sync.mjs --seed`, sign in once. | section 4 |
| When it goes red | Opendoor SSO expired: `node scripts/rtr-sync.mjs --login`. Amplify expired: `node scripts/amplify-company-sync.mjs --source tds --login`. | section 4 |
| Monthly | Bonus review on the KPI page Bonus lens (review date is the only control). | section 5 |
| As needed | Deploy a dashboard change: commit, then `cd ~/Grow/GrowSales && vercel --prod`. Vercel ships whatever is on disk. | section 10 |

## 3. Runbook: an ISP lead file, from inbox to SalesRabbit

Grow knocks doors for several fiber ISPs. Each sends spreadsheets of addresses; those become SalesRabbit leads assigned to a rep. The rule: **a person reviews every file.** The watcher only archives and parks.

1. **Arrival.** `com.grow.mail-leads` (every 10 min) saves attachments from the shared mailbox into `GrowSales/imports/isp/`. Files can also be dropped there by hand.
2. **Intake.** `com.grow.isp-intake` (every 5 min) detects the ISP from the file name, folder or the towns inside, archives the raw file to Drive `SalesRabbit Leads/<ISP>/Raw/<date> <name>`, parks it in `imports/isp/parked/`, and notifies.
3. **Review.** Tell Claude "process the parked file from i3" (isp-leads skill). It shows the headers and first rows first, because ISPs change layouts between sends. You confirm the rep to assign.
4. **Build.** `python3 scripts/isp-intake.py <file> --assign "<rep>"` runs `lead-import.py`, dedupes against the live crawl, and writes **one CSV per workbook** named `SR <CODE>-<TOWN> (<m d>).csv` to `imports/isp/ready/` and the ISP's Drive `Imports/` folder, plus a `<name> - dupes.xlsx` review sheet in `Raw/`. Counts must close: source = in-file dupes + already in SR + new + DROPPED.
5. **Upload.** Open SalesRabbit, import the CSV by hand (Flatfile, no API). Hand over only the import CSV; the dupes report stays on Drive.
6. **Map.** "Add these to the map": `sector-build.py --extend` cuts new areas, `sector-maps.py` publishes to the More > ISP Maps page. New areas get the What's new chip.

**Rules that have cost real doors**

- One workbook in = ONE import, even with several sheets or towns. Split only when told.
- Existing customers go in the same import as `Current Customer` (SLIC `Customer` column, Surf `MBS Status`, NLF `Activated`). Never a second file.
- Blank zips are dropped silently by the dedupe key. The script now prints a loud DROPPED block; use `--fill-zip-from-city` or look the zip up.
- CSV only. SalesRabbit rejects xlsx.
- A second drop for the same town and day overwrites the first. Rename it `... (9 24) 2.csv`.
- Dedupe is against the crawl (`data/sr-doors-by-area.csv`). If the crawl files are 0-byte iCloud stubs, every file reads as "all new". Check file sizes before trusting a report.
- The crawl keeps deleted leads. After deleting leads in SalesRabbit, purge their ids or the next dedupe drops real doors.

**Per-ISP quirks** (full detail in `docs/knowledge/isp-pipeline.md`)

| ISP | Code | Quirk |
| --- | --- | --- |
| Northern Lights | NLF | Alberta, Canada; usually Nick Boyd; network-export columns; Status + Drop map to SR stage; drop MDUParent and TEST rows |
| Lyte | LY | One sheet per sector; drop Activated and "UNKNOWN ADDRESS" rows; map and workbook use SalesRabbit areas exactly |
| SLIC | SLIC | Build files carry WO number and SLIC ID in Notes; rename "Street Address" to "Address"; `total_doors: true` |
| Surf | SURF | One file per serving area, area only in the file name; `MBS Status` Active/Pending = Current Customer |
| i3 | I3 | Sends its own sectors (`data/sectors/i3.csv`) |
| GFiber | GFI | Austin and Round Rock are GFiber inside Lyte's Texas (`also` key in `data/isps.json`) |
| TDS | | Separate SalesRabbit tenant; cannot dedupe against Grow's crawl; no import batches |
| Ezee, Bluepeak, Omni | | Not SalesRabbit imports; their knocking comes from the Opendoor portal |

**Which ISP owns a door:** by SalesRabbit import batch (`scripts/isp-registry.mjs` labels batches into `data/isp-imports.json`; `isp_territory.py` resolves batch, then zip majority, then the `isps.json` map). Never by geography alone.

**Terros files** stay manual (terros-import skill): `geocode-file.mjs --terros --rep "Name"` then `push-to-terros.mjs`.

## 4. Runbook: knocking data, the Mac syncs and the health board

Every door, contact and hour comes from scrapers on one Mac. Nothing here runs if the laptop is asleep, so it stays plugged in, open, with sleep prevented on power.

**The seven `com.grow.*` launchd jobs** (install, list or remove only with `bash scripts/install-all-agents.sh`; never hand-copy a plist, they hardcode absolute paths)

| Job | Schedule | Does | Health row and fix |
| --- | --- | --- | --- |
| `com.grow.sr-sync` | every 10 min 11am to 10pm, every 2 h overnight (73 runs/day, written by `scripts/knock-schedule.py`) | `run-grow-sync.sh`: SalesRabbit crawl into `data/sr-store.jsonl`, pushes `knocking` (method `sr_activity`), `knock_events`, `knocking_isp`, then rep GPS | exit 3 = token expired: `node scripts/grow-sync.mjs --seed` (sign in once, recurs every day or two). exit 137 = killed by the 240 s watchdog: `node scripts/compact-store.mjs` |
| `com.grow.rtr-sync` | same calendar, 8am to 11pm | `run-rtr-sync.sh`: Opendoor portal Time Track for Ezee (team column gives `knocking.market`), Bluepeak, Omni (daily); first run of the day re-pulls yesterday | exit 3 = SSO expired: `node scripts/rtr-sync.mjs --login`, then copy `.rtr-profile` to `.rtr-profile-backfill` |
| `com.grow.amplify-sync` | same calendar | `run-amplify-sync.sh`: TDS knocks from Amplify, `source=tds` | exit 3 = login expired: `node scripts/amplify-company-sync.mjs --source tds --login`, then Resume on the board. Paused since Oct 5 |
| `com.grow.isp-export` | hourly tick, works once a day after 7am | ISP workbooks to Drive, sector maps, TDS map (section 9) | exit 2 = an import batch has no ISP label: `node scripts/isp-registry.mjs --label <id> <ISP>`, then `ISP_FORCE=1 bash scripts/run-isp-export.sh`. Needs Drive mounted |
| `com.grow.isp-intake` | every 5 min | archives and parks new ISP files (section 3) | |
| `com.grow.mail-leads` | every 10 min | saves ISP lead attachments from the mailbox into `imports/isp/` | creds `GMAIL_USER` / `GMAIL_APP_PASSWORD` in `.env.prod` |
| `com.grow.ezee-addresses` | once a day after 7am | Ezee per-knock addresses into `ezee_knocks` / `ezee_addresses` (section 9) | exit 3 = same Opendoor re-login |

**WolfOffice workers** (`com.wolfoffice.*`, code in `~/WolfOffice/workers/grow`, logs in `~/Library/Logs/wolfoffice/`): morning briefs per ISP at 7:15 to 7:27, analyst 7:30, installs 7:35, chaser 7:40, sales-lead 7:50, chief 8:00; install-slot checks for TDS and Surf three times a day; `runner-grow` every minute executes Run / Fix / Restart tasks queued from More > Admin > Sources. The syncs run fine without any of these.

**Health board.** Every runner stamps `report_config.__<name>__` through `scripts/sync-marker.sh` (ok or fail, detail, fix command, cadence). The dashboard shows a status dot on the Updated badge; tap it for one row per source with Pause / Resume switches (shared `__paused__` flag, a paused runner writes no marker and sends no email). More > Admin > Sources draws the whole pipeline and can Run, Fix or Restart a job. Logs: `imports/done/<job>.log` and `<job>-agent.err`; `scripts/sync-status.sh` summarises all five. A failure sends one email per outage (fast sources must fail twice in a row).

**Reading `knocking`** (full detail in `docs/knowledge/knocking.md`): one row per rep per day per `source` (grow, ezee, tds, bluepeak, omni = the feed) and `method` (sr_activity, timetrack, amplify). Methods overlap on the same rep-days, so any reader takes the MAX per rep-day, never a sum; hours are a span. `knocking.sold` is SalesRabbit sold pins, not deals. Door ownership per ISP lives in `knocking_isp`. The Time Track folder watcher is unloaded; Time Track exports are imported by hand with `node scripts/import-timetrack.mjs <csv>` when needed.

**Store hygiene.** `data/sr-store.jsonl` and `sr-leads.jsonl` are append-only and bloat until ticks hit the watchdog; compact when grow-sync nags. The scheduled run is lean and skips the big CSVs, so run plain `node scripts/grow-sync.mjs` before `knock-report.py` or `knock-export.py` by hand. Keep all `knock_events` rows (a year of history is wanted).

## 5. Runbook: sales data and the definitions every number must match

**Two feeds, one rule each.** Sold, reps and PRA come from **Bria** (`bria_sales_daily`). Installs, cancels and install rates come from the **install report** (Sequifi `deals`). Never blend them for the same period. Pronto chat sync, Ask Grow search and push notifications were retired in Sep 2026.

| Sync | Runs | Writes | If it fails |
| --- | --- | --- | --- |
| Rep Sales Google Sheet Apps Script (`scripts/rep-sales-sync.gs`, lives in the sheet) | hourly, plus the Sync now button (`api/sheet-sync.js`) | `deals` (full replace every run, so ids change daily), `leaderboard`, `upfront_optin` | Runs as the owner's Google account; the successor must re-create the trigger and redeploy the web app, then update `SHEET_SYNC_URL` |
| `api/bria-sync.js` | Vercel cron 09:00 UTC daily | `bria_sales_daily`, `bria_deals`, `bria_reps`, `bria_teams`, `__bria_teams__` roster; filtered to the Grow company id since Oct 16 (a demo company leaked 31 fake reps) | last run in `bria_sync_meta`; `?force=1` bypasses the shrink guard |
| `api/sequifi-sync.js` | 08:30 UTC daily | `rep_onboarding` (Sequifi users, emails, employee ids) | 401 = token expired, ~60 days; `sequifi_sync_meta` |
| `api/sequifi-teams-sync.js` | 08:45 UTC daily | `__sequifi_teams__` (now only for email-login manager roles) | `?dry=1` to test |

Those three are the only Vercel crons left; the watchdog and Monday weekly-summary were retired Oct 14. Both Sequifi functions still `require('./_notify.js')`, which was moved to `backups/`; remove the require before the next deploy.

Manual run of any sync: `GET https://growsales.vercel.app/api/<name>?key=<SYNC_TRIGGER_KEY>`.

**Definitions** (full detail in `docs/knowledge/metrics-definitions.md`; `scripts/verify-metrics.mjs` checks them headless before and after a change)

| Term | Definition |
| --- | --- |
| Week | Sunday-anchored everywhere. `deals.week` holds the Sunday. A Monday week silently drops Saturdays. |
| Worked day | More than 10 doors (`PRA_MIN_KNOCKS`). A sale alone does not make a worked day on the KPI layer. |
| PRA (daily) | Sales ÷ days worked. Never ÷ sale-days (that inflated every PRA ~14%). |
| Weekly PRA | Deals sold that week ÷ reps who worked that week. Team bar is 20; actuals sit near 10. |
| Close rate | Sold ÷ contacts, only on rep-days with contacts. Not sold ÷ doors. |
| Contact | Not Interested, Call Back, No English, Do Not Knock, Sold. |
| Knock | A SalesRabbit stage update made within 1 km of the door. |
| Install Rate | Installs ÷ sold. |
| Completed IR | Installs ÷ (installs + cancels). The 80% goal is against this one. |
| Report lag clip | PRA and close rate stop at the last day the install report covers at least 70% of Bria, so a late sheet never reads as a sales collapse. Bria fills past that date. |
| Subs | Excluded from KPIs, PRA and pay. From week 2026-09-27 on, only the weekly subs list makes a sub (section 6). |
| Intake accounts | Daxton Day and Nick Boyd are excluded from knocking everywhere; their deals still count. |
| Bonus lens | Review date is the only control: install rate = the 4 Sunday weeks ending 2 weeks before the review date; PRA and close = the prior calendar month. Do not reinterpret. |
| Markets page | Market = ISP + state, deals feed only, so Deals per Rep, never PRA. |

**Name splits.** The same rep can appear under two spellings (Bria nicknames, Sequifi legal names). `api/_name-aliases.js` is applied at ingest; point an alias at the spelling the deal feed already uses, never the prettier one, or you create phantom doors. Rep identity by email (`rep_identity`) stamps `rep_email` on knocking rows.

## 6. Runbook: teams, the weekly subs list, rep identity

**Teams come from Bria**, everywhere, via `report_config.__bria_teams__` built by the Bria sync: the manager's blitz group for the week first, the nearest group 3 weeks back or 2 ahead second, the Bria market team by sales third. A rep with no Bria team shows as **Unassigned**, never hidden. Rep to manager is always resolved per week; `deals.manager` is dead.

**Weekly subs list** (until Bria separates subs itself)

1. The subs list is pasted into chat each week, lines like "Thomas Shelton (c) (L)" or "James Acharte - GHOST".
2. Claude matches each name to the exact spelling in `knocking`, `deals` and `bria_sales_daily` (keys are case-sensitive: "jaime Butts"). Anything that does not match confidently is asked about, never guessed.
3. Upsert `rep_flags` with `is_sub = true`, `roster_status = 'sub'`, `roster_status_by = 'weekly subs list'`, the annotation in `note`.
4. Diff against last week's list. For anyone dropped, ask whether they left or went internal. Never clear silently.
5. Anyone not on the list is not a sub. The flag is not per week; it reclassifies the rep's whole history.

**Schedule check:** paste the weekly schedule grid and ask "who's missing from Sequifi" (sequifi-roster-check skill). It reports reps not in Sequifi and spelling mismatches.

**Rep identity:** `rep_identity` (Sequifi login email, employee id, display name, alt emails) and `rep_identity_alias` map every spelling to one email; a trigger stamps `knocking.rep_email`. After editing aliases run `select * from restamp_rep_email();`. Names not in Sequifi are subs; leave their email null. Since Oct 13 the upfront opt-in name wins by email. Never load the Sequifi export's Personal Info sheet.

## 7. Runbook: upfront pay and the ramp bonus

**The program.** Opt-in reps get $50 per deal at sale, the remainder on install, with a final 10% held 90 days (the holdback exists only on paper, not in code). Presales are never paid upfront. Pay cycle: sales **Thursday to Wednesday, processed Thursday, paid Friday**. This differs from the Sunday reporting week and from Sequifi's Sun to Sat pay periods.

**Thursday run** (Payroll > Upfront > Pay & Reconcile, three-step strip):

1. Sync the opt-in list (Sync now button; it reads the "upfront pay reps" tab of the Google Sheet into `upfront_optin`; check a rep's End date before calling anything underpayment).
2. Review the table: pay this week, last-week Bria, last-week report. Click a rep to see deals paid and the weekly reconciliation buckets.
3. Tick paid, Close pay run. Paid rows persist to `upfront_paid` and `upfront_pay_runs`; a closed week is locked and late deals roll into the next run.
4. Export to Sequifi: exactly six columns, `Payouts, Start Date, End Date, Deals, Upfront Pay, Note`, numeric amounts. A rep coming off tier gets one negative row.
5. Give payroll per-rep totals, never deal lists.

**Source rule (one source per rep per day):** if the install report has a Standard deal for that rep in that blitz week, use it; otherwise use Bria rows that carry an install date. Never count both for the same period; that is how reps were double paid in Aug 2026 (net $5,050 overpaid across nine weeks, audit sheet "Upfront Pay Audit, Adjustments").

**Tier:** cumulative Completed IR on all deals since 2026-07-01. 75%+ green; 65 to 74 yellow, still paid, two weeks grace; red on the third week or under 65 at once; under 10 settled deals nobody comes off. All checks go through `_ufStatus`; never re-add a bare 75 check.

**Two clawbacks, never summed:** weekly reconciliation (a Bria-paid deal the report never confirms) and tier chargeback (reversal of the yellow run, only on red). Cancels alone never claw. `UF_AUDIT_THRU = 2026-09-02`: never reconcile a week the audit already covered.

**Ramp bonus (live on the rep snapshot since Oct 20 2026):** a 4 worked-week ramp per new rep, read from the `rep_ramp_weeks` view and shown as a Ramp strip on `?snapshot=<rep>`. The pay amounts in it ($100 / $200 / $300) are placeholders until leadership sets them (`docs/ramp-bonus-baseline.md`).

**Pay History tab** in the Rep Sales sheet is the payout log (counts, not names). Neither `deals` nor `bria_deals` keeps arrival history, so "when did this deal arrive" cannot be proven after the fact.

## 8. Runbook: Cancel Center, callbacks and Deal Check

**Cancel Center** (More > Cancel Center, live Oct 16 2026) is the call queue for cancelled customers. Callers sign in with a caller access code and see only the queue; corporate sees Today, Reports and Setup.

- **Sources.** Deals-feed rows marked Cancelled become callable 7 days after the cancel, for 45 days. ISP cancel lists in `callback_leads` are callable at once and are the cancel truth (the first Lyte list had 73 Grow sales our feed still called Pending).
- **Loading an ISP cancel list:** cancel-list-import skill, `node scripts/callback-import.mjs <csv> --isp <ISP>`, dry run first, then the Assign tab splits it between callers. A newer export of the same list updates in place by order number.
- **TDS:** TDS emails a "Grow Cancel Report.xlsx". Convert to CSV, then `--isp TDS`. It is the only source of TDS phones, emails and cancel reasons. Rows with a blank rep are TDS's own orders, not ours.
- **Card:** reason chips (price, install wait, didn't know, moved, kept ISP, no service, other) and promo chips from the promos set up on the Setup tab. Outcomes drive the queue; "Add note" never changes state.
- **Reports:** by caller, reason, rep, ISP and promo for week / 30 / 90 days. Save rate on Callers is saves over reached; elsewhere saves over cancels.
- **Pipeline tab:** kanban Working / Interested / Won / Dead for customers being worked by text.
- **Settings** (wait days, window, retries, max tries, save goal) live in `cancel_settings` and are edited on Setup, not in SQL.
- Texts stay a mockup until a Twilio number with an approved 10DLC campaign exists.

**Deal Check** (live Oct 7 2026) is a second queue for lists an ISP hands over to verify by phone (Ezee first). Same caller logins, switched with "Cancel calls | Deal check". Outcomes: Clean Deal, Didn't order, No Answer, Bad Phone Number. Load a list with the dealcheck-import skill: `node scripts/dealcheck-import.mjs <csv> --isp "Ezee Fiber" --list "<name>" --dry` first. Export CSV returns the list in the ISP's row order. The seeded Ezee call script is a draft nobody reviewed; edit it in-app (admin only).

Tables: `cancel_callbacks`, `callback_leads`, `callback_assign`, `callback_pipeline`, `cancel_promos`, `cancel_settings`, `dealcheck_leads`, `dealcheck_calls`, `dealcheck_assign`, `dealcheck_scripts`.

## 9. Runbook: reports and comms

| Output | Cadence | How it is made | Human step |
| --- | --- | --- | --- |
| ISP knocking workbooks, `Grow & <ISP> Knocking Data.xlsx`, one per ISP in Drive `SalesRabbit Reports For ISPs/<ISP>/` | Daily, first launchd tick after 7am (`com.grow.isp-export`) | `scripts/run-isp-export.sh`: registry, full crawl recompile, `knock-export.py --isp all --week`, TDS map crawl, sector maps | None. Force with `ISP_FORCE=1 bash scripts/run-isp-export.sh`. If an ISP says the workbook is stale, compare Drive ids in `data/isp-drive-ids.json` before rebuilding; a " 2" twin means Drive split the file, fix with `scripts/fix-drive-split.sh` |
| ISP sector maps, More > ISP Maps (corporate only) | Same nightly run | `sector-maps.py --all` writes `sector_maps`; i3 on its own sectors, SLIC and Surf on the Grow cut, Lyte on SalesRabbit areas exactly, TDS from its old tenant | "Add these to the map" after an import drop |
| Ezee Addresses sheet (every door knocked, in Ezee's own spelling, for Bria to match unpaid deals) | Daily after 7am (`com.grow.ezee-addresses`); sheet refreshes hourly via a standalone Apps Script | `rtr-activity-detail.mjs` into `ezee_knocks` / `ezee_addresses`; Sheet in Grow - Corporate / Reporting / Missing Deal Reconciliations | New Grow team on Ezee = add it to `data/rtr-sources.json` teams list |
| Install Slots page (earliest install date per ISP) | TDS 6:30 / 11:30 / 15:30, Surf at :45 (WolfOffice `slots-*` workers) | `scripts/install-slots.mjs` into `install_slots` | Other ISPs blocked on ISP permission |
| Rep GPS map, Ops > Rep Map | After every SalesRabbit tick | `rep-locations-sync.mjs` into `rep_gps`, noon to 10pm, 31 days kept | None |
| Monday manager meeting deck (Canva) and More > Meeting board | Weekly, Monday morning | Pull numbers the morning of the meeting (Bria backfills overnight). Deck columns: AVG DOORS, REP PRA, CLOSE RATE, TOTAL DEALS; ranked table by average of PRA rank and deals rank. Board freezes last week on first corporate open; commitment grid shows leaders by week vs their PRA goal | Goals set on the call, typed into the board (`goals` table, PATCH in place; it has no delete policy). Recipe in `docs/knowledge/meetings-and-decks.md` |
| Weekly rep email and `?snapshot=<rep>` page | Manual send, no cron | `api/weekly-rep-email.js` control panel: `GET /api/weekly-rep-email?key=<EMAIL_ADMIN_KEY>` for preview and Send to all; Gmail SMTP | Decide whether to keep sending now that reps live in Bria |
| Crawler failure email | On failure only, one email per outage (since Oct 19) | `sync-marker.sh` calls `alert-email.py` via Gmail; fast sources must fail twice in a row | Goes to the mailbox in `.env.prod` |
| Bria knock feed (`knock_board_company` view) | Only while someone has the dashboard open | Board rows published with subs and teams resolved | A server cron is the upgrade |

**Retired, do not revive:** Pronto chat sync and digest, Ask Grow search, web push notifications, the Ops task board and Flags page (Sep 16), the WolfOffice office site (Oct 14), the daily 9am manager text (`mgrcards`, unloaded Oct 14; it sent from Josh's personal iMessage and never delivered reliably), the Monday `weekly-summary` push and the `sync-watchdog` (both retired Oct 14).

**Training content** lives in Canva (Grow Playbook v2, ISP guides including T-Fiber `DAHUEcj13TE` and Omni `DAHKzf_gLPY`), the 4-Year Window financial course on the site (`money.html`, `quiz.html`, `calculator.html`), and the `TrainingVideos/` ffmpeg + whisper pipeline (`PIPELINE.md`). Footage is on Drive, not in git.

## 10. Access, accounts and secrets

**Who signs in to the dashboard** (`access_codes` table, managed at Admin > Access):

| Role | How | Sees |
| --- | --- | --- |
| Corporate / admin | access code, or email login | everything |
| Manager | scoped access code or email login (Sequifi roster decides who is a leader) | only pages ticked for them, their team |
| Caller / caller lead | access code | Cancel Center and Deal Check queues only |
| Reps | nobody; rep codes were disabled Sep 11 2026 | reps use Bria |

Security is a UI gate, not row-level security: the anon key in the page can still read and write tables. A read-only Supabase key for anyone building on the data is the first thing to mint (`GrowSales/docs/API.md` section 6).

**Secrets** never live in git. Two stores: Vercel project env feeds `api/*`; gitignored `.env*` files feed `scripts/*`. `GrowSales/.env.example` lists every name. Most Vercel values are marked Sensitive and cannot be read back, so they must be copied into a company password manager from wherever they were first obtained, or rotated.

| Where | Names |
| --- | --- |
| Vercel env | SUPABASE_SERVICE_KEY, CRON_SECRET, SYNC_TRIGGER_KEY, SEQUIFI_TOKEN, BRIA_SUPABASE_PUBLISHABLE_KEY, BRIA_SUPABASE_READONLY_KEY, GMAIL_USER, GMAIL_APP_PASSWORD, EMAIL_ADMIN_KEY, SHEET_SYNC_KEY, SHEET_SYNC_URL |
| `GrowSales/.env.local`, `.env.prod`, `.env.bria`, `.env.install-slots` | SALESRABBIT_API_KEY, SR_ACCOUNT_KEY, GMAIL_USER, GMAIL_APP_PASSWORD, BRIA_*, SURF_USER_ID, SURF_PIN |
| `GrowSales/data/.sector-map-key`, `data/.sequifi-token` | sector map write key, Sequifi token |
| `~/.geocodio.env`, `~/.terros.env` | GEOCODIO_API_KEY, TERROS_API_KEY |
| `~/Grow/RepText/.env`, `~/Grow/TrainingVideos/.env` | GROW_ACCESS_CODE, PEXELS_API_KEY, GEMINI_API_KEY |
| Apps Script project settings (each sheet script) | SUPABASE_KEY, WEB_TRIGGER_KEY, onboarding Sequifi token |

Login sessions (`data/sr-auth*.json`, `.rtr-profile*/`, `.amplify-profile*/`, `.sr-profile-tds/`) are tied to a person and are re-created by the successor with `bash bootstrap.sh logins`.

**Accounts to transfer** (details and order in `handoff/BEFORE-YOU-LEAVE.md`): Supabase org (projects Grow Sales `cmkfohwbejcztctrpdnt` and Wolf Office `hydnqquciomyfuntavhr`), the work Vercel team (a personal Vercel login cannot see it), GitHub `joshwolfer-grow`, every Google Apps Script (their triggers die when the owner's account is suspended; redeploying the Rep Sales web app changes `SHEET_SYNC_URL`), the "Grow - Corporate" shared drive, the Gmail mailbox used for ISP intake and sends, Sequifi admin seat, SalesRabbit main and TDS tenants, Amplify, Opendoor portal, Surf portal, Bria contact, Canva team, Terros, Geocodio, Pexels, Gemini keys.

## 11. Known broken and open items (Oct 21 2026)

Verify against the live site and database before acting; some may have been fixed without the notes catching up. The full Oct 14 audit is `GrowSales/docs/audit-2026-10-14.md`; the longer historical list is `docs/knowledge/open-items.md`.

**Broken now**

| What | Since | Fix |
| --- | --- | --- |
| `com.grow.isp-export` red | Oct 21 | Two new SalesRabbit import batches have no ISP label: `node scripts/isp-registry.mjs --label <id> <ISP>`, then `ISP_FORCE=1 bash scripts/run-isp-export.sh` |
| 17 ISP files parked in `imports/isp/parked` | up to Oct 21 | Each needs the isp-leads review (Amboy, Granville, Hennepin, Polo, Rock Falls IL; Atlanta 1.01 and 1.04; Glens Falls Q3; Carpentersville; NWCHIL, NRCHIL, NW2256 dated 10.21; MUNCIN02-SA13; Navarro County x2; Pearsall 1.2; a TDS Grow Cancel Report that goes to Cancel Center instead) |
| TDS Amplify knock sync (`com.grow.amplify-sync`) | Oct 5 | Login expired, then paused on the board. `node scripts/amplify-company-sync.mjs --source tds --login` (opens a window), then Resume |
| Sequifi syncs `require('./_notify.js')` | Oct 14 | The file was moved to `backups/api-retired-20261014/`; remove the require in `api/sequifi-sync.js` and `api/sequifi-teams-sync.js` or restore a stub before the next deploy |
| `data/.sequifi-token` missing on disk | | The sequifi-roster-check skill reads it; copy the Vercel `SEQUIFI_TOKEN` value there |
| Daily manager text and Thursday pay audit (`com.wolfoffice.mgrcards`, `payaudit`) | Sep 25 | Unloaded into `disabled-grow/`. Retire them or rebuild on the successor's Apple ID; the access code in `RepText/.env` is dead |
| Live code is uncommitted | Oct 21 | Five files differ from the last commit (`api/bria-sync.js`, `api/weekly-rep-email.js`, `index.html`, two data json). Commit before handing over |

**Built, not deployed or not finished**

- Upfront pay week locks: built Sep 17; the Pay History import into `upfront_paid` still needs a human go (backup `backup.upfront_paid_20260917`).
- Recruiting board (More > Recruiting, `/apply` form): needs `api/recruits.sql` run, Meta or Zapier env vars, deploy.
- Short version of the 4-Year Window guide (`money.html`) is local only.
- Ramp bonus pay amounts ($100 / $200 / $300) are placeholders.
- Ezee cancel-text flow (Texts tab) waits on a Twilio number with an approved 10DLC campaign.

**Data cleanups awaiting an OK**

- 3.3 GB of `data/*.pre-*` crawl store copies to delete, then `node scripts/compact-store.mjs`.
- 94 `index.html.bak-*` copies (keep the newest two) and 68 `.bak*` files under `scripts/` and `api/`.
- 720 `knocking` rows labelled `source=ezee` that are really SalesRabbit, and 1,000 `source=grow method=null` twins.
- Chris / Christopher Lagrange duplicate knocking rows (42 days, 1,802 phantom doors).
- 20 Uvalde addresses with pins over 60 m apart and ~615 leads sharing bad geocode pins need re-pinning, not deleting.
- Dead Supabase tables: `pronto_*`, `doc_chunks`, `push_subscriptions`, `earliest_spots`, `isp_contacts`, `app_users`, the `backup.*` schema.
- Stale names still in the local `.env.prod` (already removed from Vercel): `PRONTO_TOKEN`, `PUSH_AUTH_KEY`, `ASK_KEY`, `GEMINI_API_KEY`, `SALESRABBIT_API_KEY`.

**Numbers that still disagree between screens** (audit section 4): the rep email and meeting deck script sum overlapping knocking sources where the app takes the max; `meeting-deck-stats.py` hardcodes team rosters; the email's week boundary slips after 5 pm Mountain. The Oct 14 metric alignment pass fixed the app side; email and deck script are next.

**Blocked on someone else**

- Install availability bots for i3, SLIC, Omni, Bluepeak, Ezee: need ISP permission. Lyte is impossible.
- Native-app deep links in emails: waiting on a URL scheme from Sequifi and Bria.
- Aug 29 install-report hole (109 deals short): open with Sequifi and the ISP.
- Row-level security on Supabase (today the anon key in the page can write).
- `__roster_weeks__` from Master Manager Pay stopped at 2026-08-09 (Apps Script trigger).

## 12. Last-day checklist for the outgoing owner

The long form with every account is `handoff/BEFORE-YOU-LEAVE.md`. In order:

- [ ] Put every secret in section 10 into a company password manager vault. Most Vercel values cannot be read back, so copy them from where you first got them or rotate them now.
- [x] Refresh the handoff repo from live and commit: `bash handoff/build-from-live.sh`, then `git add -A && git commit` (done Oct 21). Push it to a company GitHub org and transfer it.
- [ ] Pack the data: `bash handoff/pack-data.sh` makes `~/Desktop/grow-data-<date>.tar.gz` (customer addresses inside; AirDrop or a restricted Drive link). Copy `TrainingVideos/` footage to a shared Drive folder.
- [ ] Invite the successor as Owner on the Supabase org and the work Vercel team, then remove yourself last.
- [ ] Google: share each Apps Script sheet as Editor and have the successor re-create the time triggers under their account; redeploy the Rep Sales web app as them and update `SHEET_SYNC_URL`. Export the Automated Onboarding script source into `GrowSales/scripts/`; it exists nowhere else.
- [ ] Create a shared mailbox for ISP lead intake and sends, put its app password in Vercel and `.env.prod`, tell ISPs the new address.
- [ ] Ask each vendor admin (Sequifi, SalesRabbit main and TDS, Amplify, Opendoor, Surf, Bria, Canva, Terros) to issue the successor their own seat.
- [ ] After the successor's `bash bootstrap.sh verify` is green: rotate the corporate access code, `CRON_SECRET`, `SYNC_TRIGGER_KEY` and `EMAIL_ADMIN_KEY`; revoke your Gmail app password and SalesRabbit tokens.
- [ ] Stop this Mac's jobs so two machines never crawl at once: `bash ~/Grow/GrowSales/scripts/install-all-agents.sh --remove` and unload every `com.wolfoffice.*` and `com.grow.*` plist.
- [ ] Remove yourself from Supabase, Vercel and GitHub last.
