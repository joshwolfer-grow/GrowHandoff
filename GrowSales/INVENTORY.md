# GrowSales — what exists

Inventory as of Jul 28 2026. Grouped by how it runs, because that's what
determines whether it can rot silently.

---

## 1. Automatic — Vercel crons (server-side, no laptop needed)

| When (UTC) | Endpoint | Does |
|---|---|---|
| 09:00 daily | `api/bria-sync.js` | Bria → `bria_sales_daily` (installs, sales, comp source of truth) |
| 08:30 daily | `api/sequifi-sync.js` | Sequifi → `deals` (the deals feed the dashboard runs on) |
| 08:45 daily | `api/pronto-sync.js` | Pronto chat → `doc_chunks` / pronto tables |
| 10:00 daily | `api/sync-watchdog.js` | Checks the three above actually ran; push alert if not |
| 14:00 Mondays | `api/weekly-summary.js` | Weekly digest |

These are the reliable tier. If something must not be forgotten, it belongs here.

## 2. Automatic — launchd on your Mac (needs the laptop awake)

| When | Job | State |
|---|---|---|
| 07:15 daily | `com.grow.amplify-knocking` → `run-amplify-sync.sh` → `amplify-knocking-sync.mjs` | **BROKEN (exit 126) and should be removed** — see Cleanup |
| — | `com.grow.timetrack-import` → `run-timetrack-scan.sh` | **BROKEN (exit 78)** — plist still says `REPLACE_HOME`, never substituted |
| 09:00 weekdays | `com.grow.timetrack-reminder` | Notification telling you to download the Time Track report |

## 3. Manual — the daily knock system (built Jul 28)

| Command | Does |
|---|---|
| `node scripts/grow-sync.mjs` | Incremental SalesRabbit crawl → rebuilds all knock data files → refreshes `knocking` (`method=sr_activity`) |
| `python3 scripts/lead-import.py <file> --assign "<rep>"` | ISP address file → SR import file + dupes report, deduped against the crawl |
| `python3 scripts/knock-report.py --isp <name>` | ISP-facing workbook: knockable doors, contact rate vs 60%, waves, per-wave leads |
| `python3 scripts/knock-report.py --list` | What areas exist, doors, % knocked, last knock |

## 4. Manual — other scripts that still matter

| Script | Does |
|---|---|
| `scripts/import-timetrack.mjs` | Time Track xlsx → `knocking` (`method=timetrack`). Real clock hours, which the crawl can't produce |
| `scripts/harvest-timetrack-mail.mjs` | Pulls the Time Track report out of email |
| `scripts/sr-lead-history.mjs` | Full ~40-min SalesRabbit crawl. Fallback if `sr-store.jsonl` is ever lost |
| `scripts/amplify-company-sync.mjs` | TDS (second company on Amplify) → `knocking` (`method=amplify`, `source=tds`) |
| `scripts/geocode-file.mjs` | Geocodio address → lat/lng |
| `scripts/push-to-terros.mjs` | Terros upload |
| `scripts/parse-week-paste.mjs`, `parse-team-assignments.mjs` | Turn pasted schedules into structured data |
| `scripts/index-content.mjs` | Builds the Ask Grow search index (`doc_chunks`) |
| `scripts/build_guide_site.py` | ISP field guide site |
| `scripts/_xlsx2csv.mjs` | **Do not use** — corrupted 230 rows of the Kingsbury file. Use openpyxl |

## 5. The dashboard (`index.html`, ~14.9k lines, 36 screens)

overview · daily · weeks · weekShape · reps · team · teamBoard · office · knocking ·
allDeals · dealClock · aging · slippage · speed · cohort · outlier · whatIf ·
cancels · cancel · ttc (time-to-cancel) · recon · briaAudit · dedup · assign ·
upfront · club · goals · schedule · training · isps · customReport · emailBlast ·
notifications · pushNotify · shareLinks · sheetSync

Plus Ask Grow (`api/ask.js`), push notifications (`api/send-push.js`,
`subscribe.js`, `vapid-public-key.js`), the manual rep email
(`api/weekly-rep-email.js`) and the Rep Sales sheet button (`api/sheet-sync.js`).

## 6. Supabase tables

`deals` · `bria_sales_daily` · `knocking` · `knock_events` · `amplify_leads` ·
`doc_chunks` · `push_subscriptions` · `report_config` · `manager_contacts` ·
`isp_contacts` · `rep_flags` · `bria_recon_flags` · `week_reconciliation` ·
`upfront_optin_sync_meta` · `upfront_paid` · `upfront_pay_runs` ·
`pronto_sync_meta` · `earliest_spots`

---

# Cleanup candidates

**1. Kill the Amplify knocking cron.** `com.grow.amplify-knocking` still fires at
07:15 daily and writes the exact rows we deleted today — the ones that agreed
with Time Track on zero days. It's failing with exit 126, which is the only
reason it hasn't already re-poisoned the table. Unload it:

    launchctl unload ~/Library/LaunchAgents/com.grow.amplify-knocking.plist

**2. Fix or delete `com.grow.timetrack-import`.** Its plist still contains the
literal string `REPLACE_HOME`, so it has never worked (exit 78). Either run
`scripts/install-timetrack-agents.sh` properly or unload it.

**3. Delete the probe scripts.** `probe-amplify.mjs`, `probe-amplify2/3/4`,
`probe-reports`, `probe-salesrabbit`, `probe-sr-hosts` — seven files that were
one-off endpoint discovery. Their findings are in memory and in the working
scripts.

**4. Retire the superseded knock scripts.** `sr-activity-to-knocking.mjs`,
`upload-amplify-knocking.mjs`, and `amplify-lead-crawl.mjs` are all folded into
`grow-sync.mjs` now. `amplify-knocking-sync.mjs` goes with cleanup #1.

**5. `scripts/_xlsx2csv.mjs` is dangerous.** It silently shifted columns on a
real import today. Delete it, or put a warning at the top.

**6. Decide about Amplify entirely.** After #1 and #4 the only thing still using
it is TDS (`amplify-company-sync.mjs`, 118 rows). If TDS doesn't need it, the
whole Amplify integration can go.

**7. The dashboard double-counts knocking.** `knocking` now has three methods and
sr_activity overlaps timetrack on 568 rep/days. Nothing in `index.html` filters
on `method` yet.

**8. 36 dashboard screens** is the big one, but only you know which are dead.
