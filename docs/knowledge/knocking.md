# Knocking data

## The `knocking` table

One row per rep per day per source: `rep, date, hours, first_disp, last_disp, doors, unique_doors, contacts, sold, source, method, market, rep_email, created_at`.

- `source` = which feed/account (`grow` = SalesRabbit Grow tenant, `ezee`, `bluepeak`, `omni`, `tds`). **It is NOT the ISP the rep sold.** Filtering `source='ezee'` to mean "Ezee data" returns reps with zero Ezee deals. Default `'grow'` (`api/knocking-source.sql`); every sync scopes its deletes by source.
- `method` = how it was collected: `sr_activity` (SalesRabbit crawl), `timetrack` (Time Track report import), `amplify` (TDS Amplify). Added Jul 28 2026 because sr_activity and timetrack overlapped on 568 rep-days.
- `market` (Oct 1 2026): Ezee rep-days tagged Houston / Chicago / Michigan (and Albuquerque) from Ezee's Time_Track `BU_Level_3` team column, mapped in `data/rtr-sources.json` `ezee.market.teams` by city prefix (Detroit → Michigan). New city = add to `ezee.market.cities` or rows land null and the log says "WARNING no market". Untagged rows show plain "Ezee"; no guessing from deals or crews (owner rejected that).
- `rep_email`: stamped by a BEFORE INSERT/UPDATE trigger from `rep_identity_alias` (see teams-roster-subs.md).
- **`sold` on knocking rows is overwritten from Bria per rep-day** by the syncs. SalesRabbit "Sold" pins match Bria for only ~9% of reps. Where `sold` is still raw pins (some older paths, Manager Report weekly table, coach alerts), it disagrees widely with Bria/report.
- Sales-only rows exist (doors=0, contacts=0, sold>0, hours=0): a sale on a day with no tracked knocking. Never count them as days out.
- Anon can insert/delete; **no anon UPDATE** (PATCH returns 204 and changes nothing). No unique constraint on rep+date: writers delete exact rep/day cells then insert. Never full-replace this table (an Apps Script once wiped it hourly).
- Intake/admin accounts excluded: Nick Boyd, Daxton Day (`window.GROW_INTAKE`, `KW_EXCLUDE`); "Josh Wolfer" account shows admin noise too.

## Feeds

1. **SalesRabbit crawl (Grow tenant)** → `node scripts/grow-sync.mjs`. Incremental: `es_search` newest-first down to the watermark in `data/sr-sync-state.json`, re-fetch activity for changed leads, rebuild CSVs (`sr-activity.csv`, `sr-lead-history.csv`, `sr-doors-by-area.csv` (with `import_id`), `sr-knocking.csv`, `rep-emails.json`), replace `method=sr_activity` rows. Storage `data/sr-store.jsonl` (append-only, latest wins; the old `sr-activity.jsonl` is corrupt, never resurrect it). Flags: `--skip-crawl` recompile only, `--no-push`, `--full-csv`, `--lean`, `--scheduled`, `--isp-only`, `--push-days N`, `--seed` (token). Full re-crawl fallback `scripts/sr-lead-history.mjs --go` (~68 leads/s, resumable, `--report`). A knock = at-door `stage_updated` within `AT_DOOR_M=1000` m; stage changes within 2 min of the actor's own lead reassignments are dropped (bulk distribution artifacts). Each knock is bucketed into the LEAD's timezone (SR returns UTC). Bursts of 10+ stage changes by one rep in 60s are excluded in reports (~12% of marks).
2. **Opendoor RTR portal** → `scripts/rtr-sync.mjs --source <ezee|bluepeak|omni>` (config `data/rtr-sources.json`). Always `--dry` first when adding a source. Traps: Bluepeak's `UserID`/`ReportByTypeID` query params are what scope the report to Grow; dropping them returns every business unit (CSG rows appeared), so a `scope` check re-verifies `BU_Level_3 = "Grow Marketing"`. Omni is scoped by cascading Company then Region dropdowns (`dropdowns: [{ctl,name,value}]`); Region "All" returns 34 BUs. Bluepeak has no raw contacts column: `Textbox32 × ValidAttempts` recovers the integer; a tripwire fails the run if contacts > doors. Omni `cadence: "daily"` with stamp `imports/done/rtr-last-daily-<src>` written only on success. Range limits: ~2 months (Ezee/Bluepeak), ~3 weeks (Omni); market backfills a week at a time. Ezee does 2 renders per tick: Highlight report (our numbers + start/end) and plain Time_Track (team column only, its StartTimeNotDistant/EndTimeNotDistant skip distant knocks). Market backfill: `node scripts/rtr-sync.mjs --source ezee --market-only --from M/D/YYYY --to M/D/YYYY` writes `data/_market/*.json`, applied via a temp staging table + SQL (no anon UPDATE).
3. **TDS Amplify** → `scripts/amplify-company-sync.mjs --source tds` (ids in `data/amplify-sources.json`, discover with `--probe`). TDS account: activityTypeId 2451 (2452 empty), timezone Central, data from 2026-06-08. Origins: keep 4915 "At location" + 4910 "Near location"; drop 4911 "Not at location" and 4913 "Unknown" (6am nightly import, fakes early first_disp). Writes `knock_events` (upsert on id; Amplify ids are global across companies). Wipe: `delete from knocking where source = 'tds'`. "Mana McGuire" = Kaimana McGuire (aliased); Jesse Maxwell has no Bria match.
4. **Time Track file import** → `node scripts/import-timetrack.mjs <file>` / `--scan` (timetrack-import skill, folder watcher). Columns map D2DRep→rep, Date Worked→date, Time Span→hours, First/Last Disposition, Doors Knocked, Unique, Sold; contacts = Attempts × Contact%. Applies the alias map. Idempotent per rep/day; two different reports for the same rep/day would clobber. Mostly superseded by rtr-sync for Ezee.

## Merging sources in the app

`_mergeKnockingSources` (index.html) and `mergeKnockingSources` (api/weekly-rep-email.js) must stay in sync:
- Grow + TDS Amplify rows for the same rep/day: doors/unique/contacts ADD (verified distinct); sold does NOT add (Bria tracks the person); hours = earliest first_disp to latest last_disp.
- Time Track rows (empty first_disp, hours 0, doors == unique) must not be summed with Amplify rows; prefer timed rows.
- Every non-tds source reduces with `max` per rep-day; Bluepeak and Omni have zero same-day overlap with other sources (re-check if a rep ever knocks two ISPs in one day).
- `source='ezee'` and `source='grow'` double-covered 1,504 rep-days historically: dedupe `MAX(doors)` per rep-day before using doors as a denominator.
- The knock board dedupes rep|date or days double count.
- KPI layer: `_kwBase` reads the merged rows; `_kwCanon()` folds spellings onto the report's name.
- Time parsers accept optional seconds ("2:22:42 PM"); before Sep 14 2026, 3,234 Time Track rep-days showed 0 hours.

## Door to ISP (`knocking_isp`)

Rule (Sep 20 2026): SalesRabbit (`source=grow`) doors get the ISP of their **import batch**; `method=amplify` is always TDS; each Opendoor source IS its own company (ezee → Ezee, bluepeak → Bluepeak, omni → Omni). Nothing inferred from geography or the rep's usual market. `grow-sync.mjs` splits SR rep-days per ISP into `knocking_isp` (rep, date, isp, doors, contacts, sold, hours, how); `knocking` stays one row per rep/day/source. Bria's sold uplift is allocated to the ISP the rep knocked that day. Change `isp_territory.py` and `grow-sync.mjs` together or the board and ISP workbooks disagree. Sep 29 2026 bug: lean compiles read only `region`, so every door fell to the state map (`how='map'` en masse); fixed, repaired with `--skip-crawl --isp-only --lean --push-days 14`. For analysis by ISP at rep level, tag each rep-day by the rep's dominant `bria_deals.isp` within ±14 days.

## Knocking board features

- **Fresh stamps:** `scripts/_rep-fresh.mjs` snapshots knocking before each sync's delete+insert and stamps reps whose doors/contacts/sold moved into `report_config.__knock_fresh_<source>__` ({rep: iso}, 14 days). Shown under the rep name. `created_at` cannot prove rows are new (a full grow-sync resets it); use these stamps or the rep/day count in `imports/done/sr-sync.log`.
- **Not out yet strip** (Today only, Sep 23 2026): roster reps with zero doors after a flat 1 PM local (`KB_OUT_BY = 13*60`), hidden if crawl age > 20 min (`KB_OUT_STALE`). Owner rejected schedule-based cutoffs. Teams nobody knocked for in 14 days are skipped. With Bria teams it only flags reps who knocked earlier this week. Name/feed mismatches are fixed with aliases, not special cases.
- **Bria feed:** Bria shows our board to reps by reading view `knock_board_company` (= `knock_board_daily` where not is_sub; table PK rep,date with team, is_sub, doors, contacts, sold, hours, first_knock, last_knock; `api/knock-board-feed.sql`). Writer `window._kbPublish` runs in the browser after late tables load (needs `DATA._repOnboarding`), last 40 days, throttled 10 min (localStorage `kbPubAt`), anon upsert. **Only fresh while someone has the app open**; a server cron is the upgrade. No-Bria-team reps publish as team "Unassigned", visible.
- `knock_events` (per-disposition events from Amplify, TDS now): a revisit = same rep, same lead_id, 2+ distinct dates; Not Home 1/2/3 labels are only ~69% reliable, don't count with them.
- Knocking report picture (Admin > Reporting, `openKnockText()`): pick managers/sources/reps, period, renders a card and copies as image.

## Data quality notes (audit Sep 14 2026)

Fixed: hours regex; Chris/Christopher Lagrange and Alli/Allison Lauriano same-day twin rows (75 deleted, aliases added, `*12345` suffixes stripped); contact set widened; timetrack agent path. Open: `knocking.sold` is pins in some readers; Time Track has no burst filter (Slone Potts 49 doors in 8 min); Bria-only spellings jai jordan, Kaiya Goodwin, Emma G Liljenquist, Porter Harris. Oct 1 2026: 720 rows created 2026-08-06 labelled source=ezee are actually SalesRabbit-side knocking copied from the "Rep Sales Data" sheet by a one-off `restore-knocking.mjs`, and 1000 `source=grow method=null` rows (Apr 2 to May 29) are exact twins of ezee rows; proposed fix (relabel to grow/sheet, delete twins, guard `_kbIspRecs`) awaits approval. Ezee Time_Track never renders Apr 16 to 22 and Apr 30 to May 6 (untaggable).

Some reps have no knocking feed (Caleb Neal's Kentucky crew, T-Fiber team; 8 reps with zero SR rows in Jul 2026 needed SR accounts, not code). Sammi Boyd had no SR user as of Jul 2026.

## Reports off the crawl

- `python3 scripts/knock-report.py --list --state NY | --city "glens falls" | --match "a|b" --name "Area"` → xlsx (Summary/Waves/Reps/Doors) to Downloads; `--gap N` wave gap (default 5 days); `--rebuild-doors`; `--isp <name>` ISP-facing workbook.
- `scripts/knock-report.py` and `knock-export.py` read `data/sr-doors-by-area.csv` + `data/sr-activity.csv`. Before trusting any report or dedupe, check the crawl has content: `stat -f "flags=%Sf ondisk=%b" data/sr-doors-by-area.csv data/sr-activity.csv` (iCloud "dataless" stubs read as 0 bytes with no error, making every dedupe say "all new").
- The crawl never purges leads deleted in SalesRabbit (no tombstones). After a bulk delete, purge those ids from `sr-store.jsonl`, `sr-leads.jsonl`, `sr-lead-history.csv`, `sr-doors-by-area.csv` (holding the pid lock) or real doors get dropped from imports as "existing".
- Per-knock address lookup for Ezee ("who knocked this address"): pull `/Ezee Fiber/Activity_Detail` for the date range, match house + street + zip.
