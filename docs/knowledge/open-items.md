# Open items (pending, not built, not deployed, blocked)

Each item carries the date it was last noted. Many may have been finished later without the memory being updated: verify against the code, the database and the live site before acting. Newest first within each section.

## Not deployed / needs a human step

- **Oct 1 2026:** knocking source cleanup awaiting approval: 720 rows created 2026-08-06 labelled `source=ezee` are really SalesRabbit-side knocking (from a one-off `restore-knocking.mjs` copy of the "Rep Sales Data" sheet), and 1000 `source=grow method=null` rows (Apr 2 to May 29) are exact twins of ezee rows. Proposed: relabel to grow/sheet, delete the twins, guard `_kbIspRecs`.
- **Oct 1 2026:** Ezee market tags missing for Apr 16 to 22 and Apr 30 to May 6 (Ezee's Time_Track never renders them).
- **Oct 1 2026:** WolfOffice service key must be pasted for the rebuilt project `hydnqquciomyfuntavhr`.
- **Sep 30 2026:** subs/no-Bria-team: on weeks before 2026-09-27, every page except the knocking board still excludes no-Bria-team reps as subs; 7 knockers with 129 Sequifi deals and zero Bria deals suggests Bria-sourced sold is missing sales. Owner hadn't ruled on other pages (the Oct 1 SUBS_LIST_START change covers weeks from 9/27).
- **Sep 30 2026:** `__meeting_teams__`, goals scopes, `team_of` are keyed on Sequifi manager names and may not match Bria market/crew keys.
- **Sep 29 2026:** `GrowSales/calculator.html` built and verified locally, NOT deployed. 4-Year Window decks not uploaded to Canva/LMS. Open question: does the tax person's $1,000/yr include payroll.
- **Sep 29 2026:** `callback_leads` address backfill for the 1,336 Lyte cancel-before-install leads was blocked; app-side fill covers matched ones only.
- **Sep 24 2026:** ISP map redesign: owner was testing and expected to ask for changes.
- **Sep 23 2026:** Bria knock feed (`knock_board_daily`) only refreshes while someone has the app open; a server cron is the upgrade.
- **Sep 23 2026:** Not-out-yet strip: JaQuan Batts, Alli Lauriano, Leon Fitarau had no knocks since 9/14 (alias or feed mismatch?).
- **Sep 22 2026:** Commitment grid shipped without a browser test; verify on prod after sign-in.
- **Sep 22 2026:** 20 Uvalde addresses with pins >60 m apart and 615 leads on shared bad-geocode pins (e.g. 209 in Jefferson) need re-pinning; Corsicana/Wortham/Dawson/Barry ~3,000 leads sharing pins not yet addressed.
- **Sep 22 to 24 2026:** Install availability bots: only TDS and Surf live; i3 (VPN), SLIC (Inservio), Omni, Bluepeak, Ezee pending ISP buy-in; Lyte impossible. Alternative: derive from deals feed (install date minus sale date).
- **Sep 17 2026:** Upfront pay locks built (index.html), **import of Pay History into `upfront_paid` and deploy pending**; backup `backup.upfront_paid_20260917`.
- **Sep 16 2026:** Daily manager text: Messages groups `Daily Report: <Manager>` not all created; Full Disk Access/Accessibility for launchd node+osascript untested; first `--send` test by a human.
- **Sep 16 2026:** Email login leader page picker + `team_of` needed another deploy. Level 3 security (RLS / server-side filtered loads) not built.
- **Sep 16 2026:** Schedule page: Bria training tables not shared with `grow_sales_readonly` (trainings stay manually tappable); also the sync skips training completion for the same reason (since Sep 11).
- **Sep 15 2026:** Ezee Sequifi team missing several reps who knocked/sold Ezee (Isaiah Wiggins, Jailen Jordan, Slone Potts, Alli Lauriano, Josh Whiteman, Kaden Neff); owner to confirm.
- **Sep 14 2026:** Knocking audit still open: Time Track has no burst filter; `knocking.sold` read as deals by some views (Manager Report weekly table, coach alerts); Bria-only spellings jai jordan, Kaiya Goodwin, Emma G Liljenquist, Porter Harris.
- **Sep 14 2026:** SR areas drawn under old sector names (Mass→MASS, GF→GLFA, Wate2→WTRT) need renaming by hand in SalesRabbit.
- **Sep 11 2026:** Recruiting board: run `api/recruits.sql`, deploy, set `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_PAGE_TOKEN`, `RECRUIT_INTAKE_KEY` (start with Zapier rather than a Meta app). Status unknown.
- **Sep 11 2026:** Callbacks: deals-feed cancel notes still missing (sheet's deals tab isn't in the Drive export; Apps Script hardcodes `cancel_reason ''`); "Saved" outcome notifies nobody.
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
- Pronto sync / digest / push endpoints (`api/pronto-*.js`, `send-push.js`, `subscribe.js` deleted Sep 10 2026), yet `sync-watchdog` reads `pronto_sync_meta`.
- Health board / Start-of-day card / Ops Automations board (Ops page removed Sep 16 2026; status dot may remain).
- `com.grow.timetrack-reminder` and `com.grow.amplify-knocking` (Grow Amplify daily sync, 7:15am) launchd agents, superseded by rtr-sync and the SR crawl.
- App polish design (Jul 23 2026) phases: manager desktop drill-in pages, scope bar, knocking funnels, week notes, `ops_tasks` table: superseded by the corporate-only pivot.
- Weekly rep email sending after reps moved to Bria (Sep 11 2026).
- Meeting deck script `scripts/meeting-deck-stats.py` hard-codes team rosters (refresh weekly or switch to Bria teams).
