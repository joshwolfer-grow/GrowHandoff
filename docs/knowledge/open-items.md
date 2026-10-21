# Open items (pending, not built, not deployed, blocked)

Each item carries the date it was last noted. Many may have been finished later without the memory being updated: verify against the code, the database and the live site before acting. Newest first within each section.

## As of Oct 21 2026 (owner's last day; verified on the live Mac that morning)

### Broken or pending right now

- **isp-export is RED today:** `scripts/isp-registry.mjs` found 2 unlabeled SalesRabbit import batches (exit 2 turns the daily runner red). Fix: `node scripts/isp-registry.mjs --label <id-prefix> <ISP>` for each, then `ISP_FORCE=1 bash scripts/run-isp-export.sh`.
- **17 ISP files sit in `imports/isp/parked/`** waiting for a human review via the isp-leads skill (the watcher only archives and parks). Several may already have been imported by hand; check Drive `<ISP>/Imports/` before building.
- **`api/sequifi-sync.js` (line 21) and `api/sequifi-teams-sync.js` (line 32) still `require('./_notify.js')`**, but `_notify.js` was moved to `GrowSales/backups/api-retired-20261014/` on Oct 14 together with `sync-watchdog.js`, `weekly-summary.js` and `vapid-public-key.js`. The crons are still configured (08:30 / 08:45 UTC) and will fail at module load (FUNCTION_INVOCATION_FAILED) on the next deploy that lacks the file, if they do not already. Fix: replace the require with the same `console.warn` stub `bria-sync.js` got on Oct 16, then redeploy. Verify with `sequifi_sync_meta` / `__sequifi_teams__` dates.
- **`data/.sequifi-token` does not exist on disk**: local scripts that call the Sequifi API directly have no token. Use the `rep_onboarding` mirror (employee_id + email) for identity work, or re-set the Vercel `SEQUIFI_TOKEN` and copy it locally when needed.
- **TDS Amplify login expired Oct 5 2026**; `com.grow.amplify-sync` is paused on the board (`__paused__` key `tds`). Fix: `node scripts/amplify-company-sync.mjs --source tds --login` (opens a signed-in window, warn first), then Resume in the Live badge popover or Sources page.
- **Daily manager text is OFF.** `com.wolfoffice.mgrcards` and `com.wolfoffice.payaudit` were unloaded Oct 14 (plists in `~/Library/LaunchAgents/disabled-grow/`): the `GROW_ACCESS_CODE` in `RepText/.env` is no longer in `access_codes` (only the corporate code named "Admin" is active) and no `Daily Report: <Manager>` Messages groups exist. Reviving means a valid code in that .env, the groups made by hand, and reinstalling the worker.
- **3.3 GB of `data/*.pre-*` store copies** (6 files) plus 94 `index.html.bak-*` (145 MB) and 68 `.bak*` under scripts/ and api/. Delete the old `pre-*` copies BEFORE running `compact-store.mjs` (it writes another `.pre-compact`). Needs the owner's OK pattern: confirm before deleting.
- **Git is behind the deploy:** 20 modified and 5 deleted files uncommitted on main as of Oct 14; Vercel ships the working tree, so prod = disk, not git. Commit before any branch work.
- **Dead Supabase tables to drop (needs OK):** `pronto_messages` (46k rows), `pronto_deal_events`, `pronto_sync_meta` (index.html still fetched the last two on every load as of Oct 14, wasted egress), `doc_chunks` + `vector`, `push_subscriptions`, `backup.*` schema, `knocking_method_backfill_20260806`, `earliest_spots`, `isp_contacts`, `app_users`. `knocking` has 1,141 `method = null` rows (Jan 18 to May 29, source grow) worth stamping `sr_activity`.
- **money.html short version (~790 words, Oct 15) is local only; the long Oct 14 version is what is live.** Backup `money.html.bak-pre-simple-20261015`. Next `vercel --prod` ships the short one. The four per-step 4-Year Window .pptx decks and the artifact page still carry the pitchy copy; `Money After Commission.pptx` (Oct 15) is the plain replacement, not uploaded to Canva/LMS.
- **Ramp bonus pay amounts are placeholders** ($100 base / $200 stretch / $300 graduation in `RAMP` config of `api/weekly-rep-email.js`); the owner never set them. See pay-and-payroll.md.
- **Cancel Center Texts tab deliberately not built** until a Twilio number with an approved 10DLC campaign exists (mockup only).
- **Deal Check:** the seeded Ezee call script in `dealcheck_scripts` is a DRAFT nobody reviewed; no Ezee file had been seen so `dealcheck-import.mjs` has no column PROFILES yet.
- **Bria data hygiene (Bria's side, not ours):** first-name-only logins "Kanyon" (= Reuben Dodson by Sequifi deals) and "Jacob" (= Jacob Stenberg), "mana" (= mana boyde), plus same-customer-two-reps duplicates (Will Gabor/Kanyon Oct 3, Conner Gardner/Ryan Ewell, Isaiah Wiggins/Kaden Neff, Trenton Dennis). `BRIA_EXCLUDE` in `api/bria-sync.js` is the stopgap; entries take effect on the next bria-sync run. Reps Isaiah Wiggins, Quay Manuel, Slone Potts and the Hogues stopped entering deals in Bria after Sep 24 while install reports kept showing sales.
- **Rep identity gaps:** Caden Meese opt-in vs "Cade Meese" in report + Bria, no `rep_identity` row for his email (Oct 13). Aidan Larsen and Jayden Barefield not in Sequifi, left null (subs rule).
- **Metric drift still open after the Oct 14 alignment:** `meeting-deck-stats.py` hardcodes teams (the Oct 20 deck was built with one SQL instead); Weeks page is Bria-only while KPIs are report + Bria fill; the weekly-summary endpoint is retired rather than fixed.
- **Lyte map:** 14,060 doors are grey because Beeville, Pittsburg, Lake Jackson, the Navarro towns and Atlanta have few or no numbered SalesRabbit area drawings; two SR areas both titled "2.04B" in Beeville.
- **Ezee Addresses sheet:** a stray copy in the owner's personal My Drive (`1Uc0HIRVOSAPgesygXTQZ4ydhi_DI7RTl7mlTpxGUTwU`) can be trashed; the standalone Apps Script "Ezee Addresses" runs as the owner's Google account (needs re-homing when that account goes).
- **Omni Guide:** the Oct 21 Field Recon / Partner Directory URLs went in as plain text (MCP cannot add hyperlinks); hyperlink them by hand in Canva (both `DAHKzf_gLPY` and v2 `DAHQVF4qAK4`).
- **Manager Standards page** (More > Team > Standards, built Oct 8, memory said "not deployed"): later full deploys (Oct 14, Oct 16) shipped the whole tree, so it is probably live; verify. Bria's side of the checklist (spec `docs/bria-manager-checklist.md`) is with Bria's devs.
- **Health board rows for retired cloud jobs** (watchdog, weekly summary) may still render as blue reference rows; confirm in `_growSyncStatus`.
- Stale Vercel env vars (`PRONTO_*`, `PUSH_AUTH_KEY`, `ASK_KEY`, `GEMINI_API_KEY`, `SALESRABBIT_API_KEY`, old `BRIA_*`) are GONE from Vercel as of Oct 21; do not expect them.

### Finished since the Oct 1 list (do not redo)

- Oct 21: Ezee Addresses daily list (`ezee_knocks` / `ezee_addresses`, `com.grow.ezee-addresses`, Sheet + Apps Script) live. Omni Guide updates applied.
- Oct 20: Ramp strip on the rep snapshot live (`rep_ramp_weeks` view, `docs/ramp-bonus-baseline.md`). TDS cancel report first import (557 rows).
- Oct 19: crawler failure alerts cut to ONE email per outage, no recovered or reminder mails.
- Oct 16: Cancel Center (Today / Reports / Setup, promos, reason tags) live; Bria demo-company filter in `bria-sync.js` deployed and run with `?force=1`, demo rows deleted; `notifyPush` crash in bria-sync stubbed. MBS Surf portal cancel audit done.
- Oct 14: metric alignment pass deployed (one PRA / sold / dedupe / subs / intake rule); Sales by Week became the ISP week page (projection retired); Lyte map follows SalesRabbit areas exactly; WolfOffice site retired into More > Admin > Sources, office tables moved into the Grow Supabase project; retired API files moved to `backups/api-retired-20261014/`; Vercel crons trimmed to bria-sync / sequifi-sync / sequifi-teams-sync; `install-slots.mjs` PGRST102 fix; `bria_deals` indexes; `calculator.html`, `money.html`, `quiz.html` went live (rode along on a deploy). Audit written to `GrowSales/docs/audit-2026-10-14.md`.
- Oct 13: Lyte ISP map released on Lyte serving areas; upfront opt-in spelling wins by email (`_canonRowsByEmail` with optin); `BRIA_EXCLUDE` stopgap (moved server-side Oct 14).
- Oct 8: Manager Standards tables + RPCs + page built. Surf Sterling import (hand over the import csv only).
- Oct 7: Deal Check queue live; Rep GPS map (Ops > Rep Map, `rep_gps`) live; `ezee-lead-fix.py` first run (138 no-order pins).
- Oct 6: Ezee Activity_Detail export script + fraud audit (Quay / Isaiah / Slone / Jailen).
- Oct 5: crawler Pause/Resume (`__paused__`) built and deployed.
- Oct 1 to 2: Ezee market backfill (4,440 rows); knocking YTD dupe check (only Xaiver/Xavier Lopez, fixed by alias).
- Superseded: "WolfOffice service key must be pasted for `hydnqquciomyfuntavhr`" (the office tables now live in the Grow project `cmkfohwbejcztctrpdnt`; the Wolf Office project is unused); "Daily manager text groups not created" (worker unloaded instead); `calculator.html` not deployed (live Oct 14); ISP map redesign testing (Lyte done Oct 13 to 14); `com.grow.timetrack-reminder` / `timetrack-import` "likely stale" (confirmed unloaded into `disabled-grow/`, Oct 14).

## Not deployed / needs a human step (Oct 1 2026 list, annotated)

- **Oct 1 2026:** knocking source cleanup awaiting approval: 720 rows created 2026-08-06 labelled `source=ezee` are really SalesRabbit-side knocking (from a one-off `restore-knocking.mjs` copy of the "Rep Sales Data" sheet), and 1000 `source=grow method=null` rows (Apr 2 to May 29) are exact twins of ezee rows. Proposed: relabel to grow/sheet, delete the twins, guard `_kbIspRecs`.
- **Oct 1 2026:** Ezee market tags missing for Apr 16 to 22 and Apr 30 to May 6 (Ezee's Time_Track never renders them).
- **Oct 1 2026:** WolfOffice service key must be pasted for the rebuilt project `hydnqquciomyfuntavhr`. (SUPERSEDED Oct 14: office tables moved into the Grow Sales project; see wolfoffice.md.)
- **Sep 30 2026:** subs/no-Bria-team: on weeks before 2026-09-27, every page except the knocking board still excludes no-Bria-team reps as subs; 7 knockers with 129 Sequifi deals and zero Bria deals suggests Bria-sourced sold is missing sales. Owner hadn't ruled on other pages (the Oct 1 SUBS_LIST_START change covers weeks from 9/27).
- **Sep 30 2026:** `__meeting_teams__`, goals scopes, `team_of` are keyed on Sequifi manager names and may not match Bria market/crew keys.
- **Sep 29 2026:** `GrowSales/calculator.html` built and verified locally, NOT deployed (DONE: live since Oct 14). 4-Year Window decks not uploaded to Canva/LMS (still open; a plain 15-slide replacement exists, see training-content.md). Open question: does the tax person's $1,000/yr include payroll.
- **Sep 29 2026:** `callback_leads` address backfill for the 1,336 Lyte cancel-before-install leads was blocked; app-side fill covers matched ones only.
- **Sep 24 2026:** ISP map redesign: owner was testing and expected to ask for changes. (Lyte map added Oct 13, switched to exact SalesRabbit areas Oct 14; no further asks recorded.)
- **Sep 23 2026:** Bria knock feed (`knock_board_daily`) only refreshes while someone has the app open; a server cron is the upgrade.
- **Sep 23 2026:** Not-out-yet strip: JaQuan Batts, Alli Lauriano, Leon Fitarau had no knocks since 9/14 (alias or feed mismatch?).
- **Sep 22 2026:** Commitment grid shipped without a browser test; verify on prod after sign-in.
- **Sep 22 2026:** 20 Uvalde addresses with pins >60 m apart and 615 leads on shared bad-geocode pins (e.g. 209 in Jefferson) need re-pinning; Corsicana/Wortham/Dawson/Barry ~3,000 leads sharing pins not yet addressed.
- **Sep 22 to 24 2026:** Install availability bots: only TDS and Surf live; i3 (VPN), SLIC (Inservio), Omni, Bluepeak, Ezee pending ISP buy-in; Lyte impossible. Alternative: derive from deals feed (install date minus sale date).
- **Sep 17 2026:** Upfront pay locks built (index.html), **import of Pay History into `upfront_paid` and deploy pending**; backup `backup.upfront_paid_20260917`.
- **Sep 16 2026:** Daily manager text: Messages groups `Daily Report: <Manager>` not all created; Full Disk Access/Accessibility for launchd node+osascript untested; first `--send` test by a human. (RETIRED Oct 14: worker unloaded, see above.)
- **Sep 16 2026:** Email login leader page picker + `team_of` needed another deploy. Level 3 security (RLS / server-side filtered loads) not built.
- **Sep 16 2026:** Schedule page: Bria training tables not shared with `grow_sales_readonly` (trainings stay manually tappable); also the sync skips training completion for the same reason (since Sep 11).
- **Sep 15 2026:** Ezee Sequifi team missing several reps who knocked/sold Ezee (Isaiah Wiggins, Jailen Jordan, Slone Potts, Alli Lauriano, Josh Whiteman, Kaden Neff); owner to confirm.
- **Sep 14 2026:** Knocking audit still open: Time Track has no burst filter; `knocking.sold` read as deals by some views (Manager Report weekly table, coach alerts); Bria-only spellings jai jordan, Kaiya Goodwin, Emma G Liljenquist, Porter Harris.
- **Sep 14 2026:** SR areas drawn under old sector names (Mass→MASS, GF→GLFA, Wate2→WTRT) need renaming by hand in SalesRabbit.
- **Sep 11 2026:** Recruiting board: run `api/recruits.sql`, deploy, set `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_PAGE_TOKEN`, `RECRUIT_INTAKE_KEY` (start with Zapier rather than a Meta app). Status unknown.
- **Sep 11 2026:** Callbacks: deals-feed cancel notes still missing (sheet's deals tab isn't in the Drive export; Apps Script hardcodes `cancel_reason ''`); "Saved" outcome notifies nobody. (Callbacks became Cancel Center Oct 16; reason tags are now typed by callers, the feed gap remains.)
- **Sep 11 2026:** Upfront audit adjustments being settled by payroll (recover $6,950 / pay $1,300 / 5 rep-weeks $900 never run); a Drive file (sheet 2) couldn't be moved to Backup; Julian Chavez never paid (13 Bria-only deals, verify real).
- **Sep 11 2026:** New Bria: Jacob S Taylor / John Patrick Holthaus pre-May rows split from new spellings unless renamed.
- **Sep 2 2026:** Aug 29 install-report hole (109 short) still open with Sequifi/ISP.
- **Sep 2 2026:** Five Aug 18 training videos have late-drifting captions (old `_remap` bug); rebuild from their cue sheets.
- **Sep 2 2026:** Stray Canva doc "i3 Guide v2" `DAHUEa1R8p0` to trash; T-Fiber guide gaps (buyout, referral, promos).
- **Sep 1 2026:** Markets page Sold differs from Weeks on settled weeks (deals feed vs Bria); flagged, unresolved.
- **Aug 31 2026:** Bonus install window semantics (installs that occurred in window vs deals sold in window) never settled; shipped code uses the cohort model. Ghost-presale filter not extended to Ezee/TDS/i3.
- **Aug 27 2026:** `__roster_weeks__` from Master Manager Pay stopped at 2026-08-09 (Apps Script trigger `mphPush` in the sheet). Historical sub marks thin (Kohen Springer June/July).
- **Aug 21 2026:** Pre-existing console error `window._growStartOfDay is not a function` at the weeks section.
- **Aug 17 2026:** Onboarding Apps Script: no working alerting (Pronto bubble deleted); `PROCESSED_IDS` email-path suppression of document sync; no repo copy/version history of the live script.
- **Aug 11 2026:** Crawl tombstones not implemented (manual purge after deletes).
- **Aug 3 2026:** Upfront audit flags: eligibility windows Sunday-anchored vs Thu to Wed cycle; no rep-name aliasing on upfront joins; `active_date`/`end_date` partially read; 10%/90-day holdback not in code; weekly email upfront section a pre-grace stub; dead code `_ufPayHtml`/`computeUpfrontPay`/`computeUpfrontVerify`. Opt-in list still sourced from a Google Sheet (plan: Supabase table with in-app toggle).
- **Aug 3 2026:** Training comp override figures conflict between decks; pay doc placeholder for profit share / manager override; Canva consolidation (Morning Meeting duplicate libraries) not built.
- **Jul 31 2026:** NLF Jul 7 town files (Spirit River 936, Sexsmith 1,110, Rycroft 440) appear never uploaded to SalesRabbit; confirm with Nick before regenerating.
- **Jul 30 2026:** `scripts/roster-sync.gs` never run in the Blitz Sign Up sheet (now largely superseded by Bria teams).
- **Jul 24 2026:** `scripts/rep-sales-sync.gs` presale lowercase fix must be pasted into the sheet's script editor and run (status unknown); until then `deal_type` stays wrong for old rows. Also the 'Allison Lauriano':'Alli Lauriano' DISPLAY_FIX line for that script.
- **Jul 24 2026:** Subs section for the corporate weekly summary email not wired.
- **Jul 22 2026:** Native-app deep links for email buttons awaiting Sequifi/Bria (Universal Links or a URL scheme).
- **Jul 21 2026:** Gmail app password validity for weekly emails ("App Password not available" seen); manual emails for unmatched reps (Trey Neal = Richard Neal, Isabella Hansen, Dyson Bridges).
- **Jul 20 2026:** Rotate the Supabase service-role key embedded in the Rep Sales Apps Script; rotate the Ask Grow Gemini key pasted in chat once (low risk).
- **Jul 16 2026:** Onboarding SMS (Twilio) dormant pending a toll-free number; Pronto user creation, badge packets and offboarding sync parked.

## Likely stale or retired (verify, then delete or revive)

- Ask Grow RAG search (live Jul 23 2026, widget hidden Jul, `api/ask.js` deleted in the Sep 10 2026 deploy).
- Pronto sync / digest / push endpoints (`api/pronto-*.js`, `send-push.js`, `subscribe.js` deleted Sep 10 2026), yet `sync-watchdog` reads `pronto_sync_meta`. (Watchdog itself retired Oct 14.)
- Health board / Start-of-day card / Ops Automations board (Ops page removed Sep 16 2026; status dot may remain).
- `com.grow.timetrack-reminder` and `com.grow.amplify-knocking` (Grow Amplify daily sync, 7:15am) launchd agents, superseded by rtr-sync and the SR crawl. (Confirmed: timetrack-import and timetrack-reminder are unloaded into `~/Library/LaunchAgents/disabled-grow/` as of Oct 14.)
- App polish design (Jul 23 2026) phases: manager desktop drill-in pages, scope bar, knocking funnels, week notes, `ops_tasks` table: superseded by the corporate-only pivot.
- Weekly rep email sending after reps moved to Bria (Sep 11 2026).
- Meeting deck script `scripts/meeting-deck-stats.py` hard-codes team rosters (refresh weekly or switch to Bria teams). Since Oct 6 the deck has been built from `__bria_teams__` by SQL, not the script.
- `api/weekly-summary.js` and `api/sync-watchdog.js`: retired Oct 14 (files in `backups/api-retired-20261014/`, crons removed). The watchdog pushed to a dead web-push subscription; the summary was Monday-anchored and counted Sequifi deals.
