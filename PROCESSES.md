# Grow Ops Handoff

As of Oct 21 2026. The live, shareable copy is the Claude doc "Grow Ops Handoff"; this file is the repo copy.

Everything that keeps growsales.vercel.app and the Grow field-ops routines running, written so a successor (or another AI tool) can run it without having built it. The code and the detailed knowledge base live in this repo; this page is the process layer on top. Start here, then `HANDOFF.md` for machine setup, then `docs/knowledge/` for detail.

## 1. The system in one map

Four layers. The first two run with no laptop; the last two run on one Mac that must stay awake.

| Layer | What it is | Where it lives | Needs a laptop |
| --- | --- | --- | --- |
| Dashboard | One static page (`GrowSales/index.html`) that reads Supabase directly from the browser. Corporate, manager and cancel-caller logins only; reps use Bria. | https://growsales.vercel.app, deployed with `vercel --prod` from `~/Grow/GrowSales` | No |
| Database | Supabase Postgres project `cmkfohwbejcztctrpdnt` (Grow Sales). Every table the site shows, plus `report_config` key/value markers. | Supabase org owned by Josh (transfer, see section 9) | No |
| Server syncs | Vercel serverless functions on daily crons: Bria sales, Sequifi users, Sequifi teams. The deals feed itself arrives hourly from the Rep Sales Google Sheet's Apps Script. | `GrowSales/api/*.js`, schedules in `vercel.json` | No |
| Local jobs | launchd agents on the Mac: SalesRabbit knock crawl, Opendoor portal pulls, TDS Amplify crawl, ISP file intake, ISP workbooks and sector maps, Ezee address sheet, plus two task bots (install slots, and the runner behind the Sources page buttons). | `GrowSales/scripts/`, plists in `scripts/launchd/`, installed with `scripts/install-all-agents.sh` | Yes |

**The one repo to clone** is https://github.com/joshwolfer-grow/GrowHandoff (private), cloned to `~/Grow` on the new Mac (paths assume that). It holds `GrowSales/`, the task bots, `RepText/`, the Grow Claude skills, `bootstrap.sh` for a new machine, and `docs/knowledge/` with the rules and traps in detail. Open Claude Code in that folder and say "Set me up. Follow HANDOFF.md."

**Upstream systems** and what each feeds:

| System | Feeds | Login type |
| --- | --- | --- |
| Bria (rep sales app) | `bria_sales_daily`, `bria_deals`, `bria_teams`: source of truth for sold, reps, teams | read-only Supabase role issued by Bria |
| Sequifi (comp platform) | `rep_onboarding`, weekly teams for login roles; the install report that becomes `deals` | admin seat, API token expires every ~60 days |
| SalesRabbit (door app, Grow tenant) | `knocking` method `sr_activity`, `knock_events`, `knocking_isp`, lead imports, areas | user login seeded into a Chrome profile |
| SalesRabbit old tenant (TDS) | TDS sector map only | separate login |
| Amplify (TDS company) | `knocking` source `tds` | cookie session in `.amplify-profile-tds/` |
| Opendoor / Realtime Results portal | Ezee, Bluepeak, Omni knocking and hours; Ezee addresses | SSO session in `.rtr-profile*/` |
| Surf MBS portal | Surf install slots, install-status checks | user id + PIN |
| Google Drive shared drive "Grow - Corporate" | raw ISP files, SalesRabbit import CSVs, ISP-facing workbooks | Drive for Desktop |
| Gmail app password | crawler failure emails, email-login codes | app password |
| Google Sheets (Rep Sales, upfront opt-in, Ezee Addresses) | deals feed, opt-in list, pay history log, Ezee address list | Apps Script run as the owner |
| Canva | Monday meeting deck, ISP guides, training decks | Canva team seat |

## 2. Your calendar

Most of the system runs itself. This is what a person still does. Say any of these to Claude Code in plain words.

| When | Task | How |
| --- | --- | --- |
| Every morning | Glance at the status dot on the dashboard's Updated badge (top bar). Green = all sources current. Red = tap it, the row names the fix command, usually a re-login. | section 4 |
| When an ISP sends a file | Drop it in `GrowSales/imports/isp/`, then "process the parked file from <ISP>". Review, build the SalesRabbit CSV, upload it in SalesRabbit by hand, then "add these to the map". | isp-leads skill, section 3 |
| When a cancel list arrives from an ISP | Load it into Cancel Center. TDS sends a "Grow Cancel Report.xlsx"; it is the only source of TDS phones. | cancel-list-import skill, section 7 |
| When an ISP hands over a deal list to verify | Load it into Deal Check. | dealcheck-import skill, section 7 |
| Monday morning | Pull the numbers for the manager meeting deck in Canva. | section 8 |
| Thursday | Upfront pay run: Payroll > Upfront > Pay & Reconcile, tick paid, close the run, export the 6-column Sequifi file. Sales Thu to Wed, processed Thu, paid Fri. | section 6 |
| Monthly | Bonus review on the KPI page Bonus lens (review date is the only control). | section 5 |
| Every day or two | SalesRabbit crawl token expires (exit 3, red row). Run `node scripts/grow-sync.mjs --seed`, sign in once. | section 4 |
| When it goes red | Opendoor SSO expired: `node scripts/rtr-sync.mjs --login`. Amplify expired: `node scripts/amplify-company-sync.mjs --source tds --login`. | section 4 |
| Every ~60 days | Sequifi API token expires: the Vercel sync fails with 401. Mint a new one and update `SEQUIFI_TOKEN` in Vercel. | section 9 |
| As needed | Deploy a dashboard change: commit, then `cd ~/Grow/GrowSales && vercel --prod`. Vercel ships whatever is on disk. | section 9 |

## 3. Runbook: an ISP lead file, from file to SalesRabbit

Grow knocks doors for several fiber ISPs. Each sends spreadsheets of addresses; those become SalesRabbit leads assigned to a rep. The rule: **a person reviews every file.** The intake job only archives and parks.

1. **Arrival.** Save the ISP's file into `GrowSales/imports/isp/`.
2. **Intake.** `com.grow.isp-intake` (every 5 min) detects the ISP from the file name, folder or the towns inside, archives the raw file to Drive `SalesRabbit Leads/<ISP>/Raw/<date> <name>`, parks it in `imports/isp/parked/`, and notifies.
3. **Review.** Tell Claude "process the parked file from i3" (isp-leads skill). It shows the headers and first rows first, because ISPs change layouts between sends. You confirm the rep to assign.
4. **Build.** `python3 scripts/isp-intake.py <file> --assign "<rep>"` runs `lead-import.py`, dedupes against the live crawl, and writes **one CSV per workbook** named `SR <CODE>-<TOWN> (<m d>).csv` to `imports/isp/ready/` and the ISP's Drive `Imports/` folder, plus a `<name> - dupes.xlsx` review sheet in `Raw/`. Counts must close: source = in-file dupes + already in SR + new + DROPPED.
5. **Upload.** Open SalesRabbit, import the CSV by hand (Flatfile, no API). Hand over only the import CSV; the dupes report stays on Drive.
6. **Map.** "Add these to the map": `sector-build.py --extend` cuts new areas, `sector-maps.py` publishes to the ISP Maps page. New areas get the What's new chip.

**Rules that have cost real doors**

- One workbook in = ONE import, even with several sheets or towns. Split only when told.
- Existing customers go in the same import as `Current Customer` (SLIC `Customer` column, Surf `MBS Status`, NLF `Activated`). Never a second file.
- Blank zips are dropped silently by the dedupe key. The script prints a loud DROPPED block; use `--fill-zip-from-city` or look the zip up.
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

**Which ISP owns a door:** by SalesRabbit import batch (`scripts/isp-registry.mjs` labels batches into `data/isp-imports.json`; `isp_territory.py` resolves batch, then zip majority, then the `isps.json` map). Never by geography alone. A new batch with an unknown prefix turns the ISP workbook job red until you label it: `node scripts/isp-registry.mjs --label <id> <ISP>`.

**SalesRabbit housekeeping tools** (dry by default, a person runs the write step): `dedupe-delete.mjs` for duplicate leads (`--go` deletes, backups per run in `data/dedupe-backup-<date>/`), `sr-area-create.mjs` to draw areas from sector polygons, `sr-area-group.mjs` to move areas between teams.

## 4. Runbook: knocking data, the Mac jobs and the health board

Every door, contact and hour comes from scrapers on one Mac. Nothing here runs if the laptop is asleep, so it stays plugged in, open, with sleep prevented on power.

**The six `com.grow.*` launchd jobs** (install, list or remove only with `bash scripts/install-all-agents.sh`; never hand-copy a plist, they hardcode absolute paths)

| Job | Schedule | Does | Health row and fix |
| --- | --- | --- | --- |
| `com.grow.sr-sync` | every 10 min 11am to 10pm, every 2 h overnight (73 runs/day, written by `scripts/knock-schedule.py`) | `run-grow-sync.sh`: SalesRabbit crawl into `data/sr-store.jsonl`, pushes `knocking` (method `sr_activity`), `knock_events`, `knocking_isp` | exit 3 = token expired: `node scripts/grow-sync.mjs --seed` (sign in once, recurs every day or two). exit 137 = killed by the 240 s watchdog: `node scripts/compact-store.mjs` |
| `com.grow.rtr-sync` | same calendar, 8am to 11pm | `run-rtr-sync.sh`: Opendoor portal Time Track for Ezee (team column gives `knocking.market`), Bluepeak, Omni (daily); first run of the day re-pulls yesterday | exit 3 = SSO expired: `node scripts/rtr-sync.mjs --login`, then copy `.rtr-profile` to `.rtr-profile-backfill` |
| `com.grow.amplify-sync` | same calendar | `run-amplify-sync.sh`: TDS knocks from Amplify, `source=tds` | exit 3 = login expired: `node scripts/amplify-company-sync.mjs --source tds --login`, then Resume on the board. Paused since Oct 5 |
| `com.grow.isp-export` | hourly tick, works once a day after 7am | ISP workbooks to Drive, sector maps, TDS map (section 8) | exit 2 = an import batch has no ISP label: label it, then `ISP_FORCE=1 bash scripts/run-isp-export.sh`. Needs Drive mounted |
| `com.grow.isp-intake` | every 5 min | archives and parks new ISP files (section 3) | |
| `com.grow.ezee-addresses` | once a day after 7am | Ezee per-knock addresses into `ezee_knocks` / `ezee_addresses` (section 8) | exit 3 = same Opendoor re-login |

**Task bots** (`com.wolfoffice.*`, code in `~/WolfOffice/workers/grow`, logs in `~/Library/Logs/wolfoffice/`): `slots-tds` and `slots-surf` check earliest install dates three times a day; `runner-grow` runs every minute and executes the Run / Fix / Restart buttons on More > Admin > Sources. The syncs run fine without either.

**Health board.** Every runner stamps `report_config.__<name>__` through `scripts/sync-marker.sh` (ok or fail, detail, fix command, cadence). The dashboard shows a status dot on the Updated badge; tap it for one row per source with Pause / Resume switches (shared `__paused__` flag, a paused runner writes no marker and sends no email). More > Admin > Sources draws the whole pipeline and can Run, Fix or Restart a job. Logs: `imports/done/<job>.log` and `<job>-agent.err`; `scripts/sync-status.sh` summarises. A failure sends one email per outage (fast sources must fail twice in a row).

**Reading `knocking`** (full detail in `docs/knowledge/knocking.md`): one row per rep per day per `source` (grow, ezee, tds, bluepeak, omni = the feed) and `method` (sr_activity, timetrack, amplify). Methods overlap on the same rep-days, so any reader takes the MAX per rep-day, never a sum; hours are a span. `knocking.sold` is SalesRabbit sold pins, not deals. Door ownership per ISP lives in `knocking_isp`.

**Store hygiene.** `data/sr-store.jsonl` and `sr-leads.jsonl` are append-only and bloat until ticks hit the watchdog; compact when grow-sync nags. The scheduled run is lean and skips the big CSVs, so run plain `node scripts/grow-sync.mjs` before `knock-report.py` or `knock-export.py` by hand. Keep all `knock_events` rows.

## 5. Runbook: sales data and the definitions every number must match

**Two feeds, one rule each.** Sold, reps and PRA come from **Bria** (`bria_sales_daily`). Installs, cancels and install rates come from the **install report** (`deals`). Never blend them for the same period.

| Sync | Runs | Writes | If it fails |
| --- | --- | --- | --- |
| Rep Sales Google Sheet Apps Script (`scripts/rep-sales-sync.gs`, lives in the sheet) | hourly, plus the Sync now button (`api/sheet-sync.js`) | `deals` (full replace every run, so ids change daily), `leaderboard`, `upfront_optin` | Runs as the owner's Google account; the successor must re-create the trigger and redeploy the web app, then update `SHEET_SYNC_URL` |
| `api/bria-sync.js` | Vercel cron 09:00 UTC daily | `bria_sales_daily`, `bria_deals`, `bria_reps`, `bria_teams`, `__bria_teams__` roster; filtered to the Grow company id (a Bria demo company once leaked 31 fake reps) | last run in `bria_sync_meta`; `?force=1` bypasses the shrink guard |
| `api/sequifi-sync.js` | 08:30 UTC daily | `rep_onboarding` (Sequifi users, emails, employee ids) | 401 = token expired, ~60 days; `sequifi_sync_meta` |
| `api/sequifi-teams-sync.js` | 08:45 UTC daily | `__sequifi_teams__` (only for email-login manager roles) | `?dry=1` to test |

Those three are the only Vercel crons. Manual run of any: `GET https://growsales.vercel.app/api/<name>?key=<SYNC_TRIGGER_KEY>`.

**Definitions** (full detail in `docs/knowledge/metrics-definitions.md`; `scripts/verify-metrics.mjs` checks them headless before and after a change)

| Term | Definition |
| --- | --- |
| Week | Sunday-anchored everywhere. `deals.week` holds the Sunday. A Monday week silently drops Saturdays. |
| Worked day | More than 10 doors (`PRA_MIN_KNOCKS`). A sale alone does not make a worked day. |
| PRA (daily) | Sales ÷ days worked. Never ÷ sale-days (that inflated every PRA ~14%). |
| Weekly PRA | Deals sold that week ÷ reps who worked that week. Team bar is 20; actuals sit near 10. |
| Close rate | Sold ÷ contacts, only on rep-days with contacts. Not sold ÷ doors. |
| Contact | Not Interested, Call Back, No English, Do Not Knock, Sold. |
| Knock | A SalesRabbit stage update made within 1 km of the door. |
| Install Rate | Installs ÷ sold. |
| Completed IR | Installs ÷ (installs + cancels). The 80% goal is against this one. |
| Report lag clip | PRA and close rate stop at the last day the install report covers at least 70% of Bria, so a late sheet never reads as a sales collapse. Bria fills past that date. |
| Subs | Excluded from KPIs, PRA and pay. Only a `rep_flags.roster_status = 'sub'` mark makes a sub; the weekly subs paste is retired, so marks stay as they are until someone edits `rep_flags`. |
| Intake accounts | Daxton Day and Nick Boyd are excluded from knocking everywhere; their deals still count. |
| Bonus lens | Review date is the only control: install rate = the 4 Sunday weeks ending 2 weeks before the review date; PRA and close = the prior calendar month. Do not reinterpret. |
| Markets page | Market = ISP + state, deals feed only, so Deals per Rep, never PRA. |

**Teams come from Bria** via `report_config.__bria_teams__`: the manager's blitz group for the week first, nearest group within 3 weeks back or 2 ahead second, Bria market team by sales third. No Bria team = shown as Unassigned, never hidden. Rep to manager is always resolved per week.

**Name splits.** The same rep can appear under two spellings (Bria nicknames, Sequifi legal names). `api/_name-aliases.js` is applied at ingest; point an alias at the spelling the deal feed already uses, never the prettier one, or you create phantom doors. `rep_identity` maps every spelling to one email and stamps `knocking.rep_email`; after editing aliases run `select * from restamp_rep_email();`.

## 6. Runbook: upfront pay

**The program.** Opt-in reps get $50 per deal at sale, the remainder on install, with a final 10% held 90 days (the holdback exists only on paper, not in code). Presales are never paid upfront. Pay cycle: sales **Thursday to Wednesday, processed Thursday, paid Friday**. This differs from the Sunday reporting week and from Sequifi's Sun to Sat pay periods.

**Thursday run** (Payroll > Upfront > Pay & Reconcile, three-step strip):

1. Sync the opt-in list (Sync now button reads the "upfront pay reps" tab of the Google Sheet into `upfront_optin`; check a rep's End date before calling anything underpayment).
2. Review the table: pay this week, last-week Bria, last-week report. Click a rep to see deals paid and the weekly reconciliation buckets.
3. Tick paid, Close pay run. Paid rows persist to `upfront_paid` and `upfront_pay_runs`; a closed week is locked and late deals roll into the next run.
4. Export to Sequifi: exactly six columns, `Payouts, Start Date, End Date, Deals, Upfront Pay, Note`, numeric amounts. A rep coming off tier gets one negative row.
5. Give payroll per-rep totals, never deal lists.

**Source rule (one source per rep per day):** if the install report has a Standard deal for that rep in that blitz week, use it; otherwise use Bria rows that carry an install date. Never count both for the same period; that is how reps were double paid in Aug 2026.

**Tier:** cumulative Completed IR on all deals since 2026-07-01. 75%+ green; 65 to 74 yellow, still paid, two weeks grace; red on the third week or under 65 at once; under 10 settled deals nobody comes off. All checks go through `_ufStatus`; never re-add a bare 75 check.

**Two clawbacks, never summed:** weekly reconciliation (a Bria-paid deal the report never confirms) and tier chargeback (reversal of the yellow run, only on red). Cancels alone never claw. `UF_AUDIT_THRU = 2026-09-02`: never reconcile a week the Sep 2026 audit already covered.

**Pay History tab** in the Rep Sales sheet is the payout log (counts, not names).

## 7. Runbook: Cancel Center and Deal Check

**Cancel Center** (More > Cancel Center) is the call queue for cancelled customers. Callers sign in with a caller access code and see only the queue; corporate sees Today, Reports and Setup.

- **Sources.** Deals-feed rows marked Cancelled become callable 7 days after the cancel, for 45 days. ISP cancel lists in `callback_leads` are callable at once and are the cancel truth.
- **Loading an ISP cancel list:** cancel-list-import skill, `node scripts/callback-import.mjs <csv> --isp <ISP> --dry` first, then the Assign tab splits it between callers. A newer export of the same list updates in place by order number.
- **TDS:** convert the "Grow Cancel Report.xlsx" to CSV, then `--isp TDS`. Rows with a blank rep are TDS's own orders, not ours.
- **Card:** reason chips and promo chips (promos are set up on the Setup tab). Outcomes drive the queue; "Add note" never changes state.
- **Reports:** by caller, reason, rep, ISP and promo for week / 30 / 90 days.
- **Pipeline tab:** kanban Working / Interested / Won / Dead for customers being worked by text.
- **Settings** (wait days, window, retries, max tries, save goal) live in `cancel_settings`, edited on Setup.
- Texts tab stays a mockup until a Twilio number with an approved 10DLC campaign exists.

**Deal Check** (More > Deal Check) is a second queue for lists an ISP hands over to verify by phone (Ezee first). Same caller logins, switched with "Cancel calls | Deal check". Outcomes: Clean Deal, Didn't order, No Answer, Bad Phone Number. Load a list with the dealcheck-import skill: `node scripts/dealcheck-import.mjs <csv> --isp "Ezee Fiber" --list "<name>" --dry` first. Export CSV returns the list in the ISP's row order. The seeded Ezee call script is a draft; edit it in-app (admin only).

Tables: `cancel_callbacks`, `callback_leads`, `callback_assign`, `callback_pipeline`, `cancel_promos`, `cancel_settings`, `dealcheck_leads`, `dealcheck_calls`, `dealcheck_assign`, `dealcheck_scripts`.

## 8. Runbook: reports for ISPs and managers

| Output | Cadence | How it is made | Human step |
| --- | --- | --- | --- |
| ISP knocking workbooks, `Grow & <ISP> Knocking Data.xlsx`, one per ISP in Drive `SalesRabbit Reports For ISPs/<ISP>/` | Daily, first launchd tick after 7am (`com.grow.isp-export`) | `scripts/run-isp-export.sh`: registry, full crawl recompile, `knock-export.py --isp all --week`, TDS map crawl, sector maps | None. Force with `ISP_FORCE=1 bash scripts/run-isp-export.sh`. If an ISP says the workbook is stale, compare Drive ids in `data/isp-drive-ids.json` before rebuilding; a " 2" twin means Drive split the file, fix with `scripts/fix-drive-split.sh` |
| ISP sector maps, Ops > ISP Maps (corporate only) | Same nightly run | `sector-maps.py --all` writes `sector_maps`; i3 on its own sectors, SLIC and Surf on the Grow cut, Lyte on SalesRabbit areas exactly, TDS from its old tenant | "Add these to the map" after an import drop |
| Ezee Addresses sheet (every door knocked, in Ezee's own spelling, for Bria to match unpaid deals) | Daily after 7am (`com.grow.ezee-addresses`); sheet refreshes hourly via a standalone Apps Script | `rtr-activity-detail.mjs` into `ezee_knocks` / `ezee_addresses`; Sheet in Grow - Corporate / Reporting / Missing Deal Reconciliations | New Grow team on Ezee = add it to the teams list in `data/rtr-sources.json` |
| Install Slots page (earliest install date per ISP) | TDS 6:30 / 11:30 / 15:30, Surf at :45 (task bots) | `scripts/install-slots.mjs` into `install_slots` | Other ISPs blocked on ISP permission |
| Monday manager meeting deck (Canva) | Weekly, Monday morning | Pull numbers the morning of the meeting (Bria backfills overnight). One slide per team: AVG DOORS, REP PRA, CLOSE RATE, TOTAL DEALS; ranked table by average of PRA rank and deals rank. Worked = over 10 doors; deals from the install report up to its latest day, then Bria | Goals are set on the call. Recipe and Canva MCP gotchas in `docs/knowledge/meetings-and-decks.md`; `scripts/meeting-deck-stats.py` hardcodes team rosters, SQL via Supabase is the current way |
| Crawler failure email | On failure only, one email per outage | `sync-marker.sh` calls `alert-email.py` via Gmail; fast sources must fail twice in a row | Goes to the mailbox in `.env.prod` |
| Copy Company Report, manager texts | On demand, Admin > Reporting | in-app | |
| Bria knock feed (`knock_board_company` view) | Only while someone has the dashboard open | Board rows published with subs and teams resolved | A server cron is the upgrade |

Other pages that just read the data: Knocking board, Sales by Week, KPIs / Analysis, Markets, Records, Custom Report, Schedule (plus the public `/schedule` form).

**ISP guides and training decks** live in Canva (T-Fiber `DAHUEcj13TE`, Omni `DAHKzf_gLPY`, i3, Grow Playbook v2); the grow-training-deck skill builds new decks in the house style.

## 9. Access, accounts and secrets

**Who signs in to the dashboard** (`access_codes` table, managed at Admin > Access):

| Role | How | Sees |
| --- | --- | --- |
| Corporate / admin | access code, or email login | everything |
| Manager | scoped access code or email login (Sequifi roster decides who is a leader) | only pages ticked for them, their team |
| Caller / caller lead | access code | Cancel Center and Deal Check queues only |
| Reps | nobody | reps use Bria |

Security is a UI gate, not row-level security: the anon key in the page can still read and write tables. A read-only Supabase key for anyone building on the data is the first thing to mint (`GrowSales/docs/API.md` section 6).

**Secrets** never live in git. Two stores: Vercel project env feeds `api/*`; gitignored `.env*` files feed `scripts/*`. `GrowSales/.env.example` lists every name. Most Vercel values are marked Sensitive and cannot be read back, so they must be copied into a company password manager from wherever they were first obtained, or rotated.

| Where | Names |
| --- | --- |
| Vercel env | SUPABASE_SERVICE_KEY, CRON_SECRET, SYNC_TRIGGER_KEY, SEQUIFI_TOKEN, BRIA_SUPABASE_PUBLISHABLE_KEY, BRIA_SUPABASE_READONLY_KEY, GMAIL_USER, GMAIL_APP_PASSWORD, EMAIL_ADMIN_KEY, SHEET_SYNC_KEY, SHEET_SYNC_URL |
| `GrowSales/.env.local`, `.env.prod`, `.env.bria`, `.env.install-slots` | SALESRABBIT_API_KEY, SR_ACCOUNT_KEY, GMAIL_USER, GMAIL_APP_PASSWORD, BRIA_SUPABASE_*, SURF_USER_ID, SURF_PIN |
| `GrowSales/data/.sector-map-key` | sector map write key |
| Apps Script project settings (Rep Sales sheet, Ezee Addresses script) | SUPABASE_KEY, WEB_TRIGGER_KEY |

Login sessions (`data/sr-auth*.json`, `.rtr-profile*/`, `.amplify-profile*/`, `.sr-profile-tds/`) are tied to a person and are re-created by the successor with `bash bootstrap.sh logins`.

**Accounts to transfer** (details and order in `handoff/BEFORE-YOU-LEAVE.md`): Supabase org (projects Grow Sales `cmkfohwbejcztctrpdnt` and the small Wolf Office project `hydnqquciomyfuntavhr` that holds bot task tables), the work Vercel team (a personal Vercel login cannot see it), GitHub `joshwolfer-grow`, the Rep Sales and Ezee Addresses Apps Scripts (their triggers die when the owner's account is suspended; redeploying the Rep Sales web app changes `SHEET_SYNC_URL`), the "Grow - Corporate" shared drive, the Gmail app password, Sequifi admin seat, SalesRabbit main and TDS tenants, Amplify, Opendoor portal, Surf portal, Bria contact, Canva team.

## 10. Open items (Oct 21 2026)

- 17 ISP files sit in `imports/isp/parked` awaiting review (Amboy, Granville, Hennepin, Polo, Rock Falls IL; Atlanta 1.01 and 1.04; Glens Falls Q3; Carpentersville; NWCHIL, NRCHIL, NW2256 dated 10.21; MUNCIN02-SA13; Navarro County x2; Pearsall 1.2; a TDS Grow Cancel Report that belongs in Cancel Center).
- TDS Amplify knock sync is logged out since Oct 5 and paused: `node scripts/amplify-company-sync.mjs --source tds --login` (opens a browser window), then Resume on the board.
- TDS classic SalesRabbit token (`data/sr-auth-tds.json`) is expired too, so the TDS sector map stops updating until a signed-in `web.salesrabbit.com` window re-captures it (`scripts/run-tds-map.sh`). The other 8 ISP workbooks and maps are unaffected.
- Cancel Center Texts tab needs a Twilio number with an approved 10DLC campaign.
- Install availability for i3, SLIC, Omni, Bluepeak, Ezee needs ISP permission; Lyte is impossible.
- `scripts/meeting-deck-stats.py` hardcodes team rosters; the deck numbers are pulled by SQL instead.
