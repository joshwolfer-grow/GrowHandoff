# Metric definitions

## Weeks and dates

- **Weeks are Sunday-anchored.** `tmISO`/`thisMon` (names say Mon, values are Sundays), every `deals.week` and knocking week key hold the Sunday starting the week. Week "2026-07-05" = Sun Jul 5 to Sat Jul 11. Working days are anchor+1 (Mon) to anchor+6 (Sat); Monday-anchored math silently drops Saturdays. `lmISO`/`tmISO` helpers in some places are Monday-anchored; compute a fresh Sunday when matching `deals.week`.
- Sequifi `/v1/teams` and Bria blitz groups are Sunday..Saturday too.
- Upfront pay cycle is different: sales Thu to Wed, processed Thu, paid Fri (see pay-and-payroll.md).
- Bonus month = review-date based (see below).

## PRA (per rep average)

- **Daily PRA ("true PRA") = sales ÷ days worked**, never ÷ sale-days. Dividing by sale-days (before Jul 29 2026) inflated every PRA ~14% (career avg 3.448 → 2.965; Spencer Cory read 14.75, true 5.13).
- `window.PRA_MIN_KNOCKS` = 10. A worked day needs **more than 10 doors** ("so that someone who has a random pin doesn't count").
- Two worked-day rules coexist on purpose:
  - **KPI layer (`_kwBase` / `_kwRollup`), since Aug 27 2026: only days with >10 doors count.** A sale no longer mints a worked day. A rep with zero door-qualified days in the period is out of PRA on BOTH sides (`r.praSales`); their deals still count in sales totals. `salesPerRepDay = praSales/praDayCount`. August 2026: 2.48 under old rule, 2.51 under new.
  - **Weekly PRA, Weeks table, Meeting board, meeting deck, daily manager card: worked = a day over 10 doors OR a sale** (Bria sale for the deck). Union needed because knocking history doesn't reach as far back as deals. **SUPERSEDED Oct 14 2026 (metric alignment pass, deployed):** the ten-door rule is now the one PRA denominator on every surface (KPIs, Weeks and drills, weekly summary text/image, rep email `buildPraGoals`, Meeting board, deck script, manager card): a sale alone is not a worked day; reps with no door-qualified day show a dot and leave the numerator. Verify any change with `scripts/verify-metrics.mjs`. The deck SQL recipe (meetings-and-decks.md) still uses "over 10 doors OR a Bria sale" by the owner's Sep 7 ruling; check which the current week's deck used.
- `window._praWorkedByRep` and `window._praUnionWorked(into, weekISO, mgr, repOk)` (built after `_mergeKnockingSources`) are the shared worked-day source; never recompute from sale dates. `p._knockingIndex[rep|week].praDays` = days with doors > 10. `repDayCount` (any doors > 0) is a different denominator, used for doors per day.
- **Weekly PRA = deals sold that week ÷ reps who WORKED that week** (chosen Aug 3 2026 over "reps who sold" or "whole roster"). `growWorkedReps(week, repOk, sellers)` is the single denominator; `growBriaWeek` returns `reps` (worked) and `sellers`. A rep's weekly PRA is just their deal count, so there is no per-rep PRA goal.
- **The bar is 20 deals per rep per week**; actuals sit near 9 to 10 (Jul 19: 819 ÷ 84 = 9.8). Set it in Edit Goals (`pra_weekly`).
- PRA and close-rate denominators are **clipped at the report coverage date** on the KPI layer (see "Report lag" below).
- Check: Copy Company Report and the KPIs page must print the same PRA for the same week. Since Oct 14 2026 the same holds for the rep email and the Sales by Week page; the weekly summary sold/PRA come from `_mgrWeekSales` (report first, Bria fills past THRU), knocking rows take MAX per rep/day across grow-side methods everywhere (the email used to SUM), `growIsSub` is the only sub rule, `GROW_INTAKE` accounts are filtered at load, and close rate goes through `_crCell` / `closeRate()` (null, never 0% or >100%). Known remaining drift: Weeks page is Bria-only while KPIs are report + Bria fill; `meeting-deck-stats.py` hardcodes teams.

## Close rate and knocking ratios

- **Close rate = sold ÷ CONTACTS** (house convention, corrected Aug 16 2026). sold ÷ doors is "doors per sale", a different stat. Never mix denominators in one table; say which one a ranking used (switching reorders leaderboards).
- Restrict to rep-days with contacts > 0. `_closeRate(sold,contacts)` returns null unless `contacts>0 && sold<=contacts` (sales-only rows once produced 1500%). Never divide a deals-complete numerator by a knocking-sparse denominator without a coverage check.
- Ezee baseline (Aug 2026): 8.56% overall on contacts (175 reps, 88,066 contacts, 7,542 deals); ~12% strong, 20%+ exceptional; 2.65% on doors. ~12% of Ezee deals come from reps with no knocking rows.
- **Contact** = Not Interested, Call Back, No English, Do Not Knock, Sold (5 stages; `grow-sync.mjs` widened from 3 to 5 on Sep 14 2026 to match `knock-report.py` / `knock-export.py`; i3's own sheets also count Sold). "Answered" additionally counts Current Customer and Business.
- **A knock** = a SalesRabbit `stage_updated` made AT THE DOOR: `AT_DOOR_M = 1000` m (grow-sync.mjs, knock-report.py, knock-export.py). Past 100 km marks are 89% "New Lead" bulk assignment from a desk.
- Doors per sale pools raw doors ÷ raw sales over the window (never average weekly ratios). Under 8 sales, prefix "~" (dashboard) or "still settling" (email).
- Averages are per rep DAY WORKED; sales-only rows (doors=0, sold>0) count in total sold but never in days out (a date counts as a day out only when doors > 0).
- Vacants are excluded from ISP report denominators ("knockable doors"); 60% lifetime contact rate is the ISP-report goal.
- Meeting "AVG DOORS / DAY" = team doors ÷ rep-days over 10 doors. (The in-app Meeting board and its 60-door bar were retired Oct 21 2026.)

## Install rates (two named metrics, always shown as a pair)

- **Completed IR = installs ÷ (installs + cancels).** Only resolved deals. The 80% goal (`ir`) is set against this. Age-neutral, so the KPI Why panel and KPI cards use it.
- **Install Rate = installs ÷ sold** (all sold incl. pending; used to be "% Done"). Elsewhere "% Done" sometimes means (installs + cancels) ÷ sold (resolution rate), a third thing; check the formula before reusing a label.
- On the KPI page the install-side denominator is `dealSold` (deals in the install report), never reconciled `sales` (Bria-only sales can never install).
- Unsettled periods show the live rate plus a STILL LANDING/FLOOR banner ("N of M still open, tracking to <completedIR>"). Never hide the number. Settled = period end + wait (`window._kwIrWait`, default 4 weeks) ≤ today, time only.
- **Presale is out of the install side** of the KPI page (still counts in sales/PRA/close). **Lyte ghost presales** (Pending with no install date, `_kwGhostPresale`, regex `^lyte`) are excluded from the install side everywhere the presale filter runs; cancels kept. Lyte 2026 IR 65.3% → 87.4%. Same shape exists at Ezee (687), TDS (253), i3 (178), deliberately not swept up (one-line regex change).
- **Projected IR** (weekly email recap): `(inst + pend*r) / (inst + canc + pend)`, r = settle rate from cohorts sold 5+ weeks back (per manager with ≥25 resolved matured deals, else company; company r = 0.769 in Jul 2026). Standard deals only.
- Meeting deck install rate = CURRENT month-to-date Completed IR by ISP+state; pending presales not counted as installed (tried Sep 15 2026, Ezee jumped 72.3% → 95.2%, rejected). Show PENDING when a market has zero resolved.
- Days to install = sale → install date. Booking lag = sale → planned_install (`Df 'pd'`).

## KPI page (Sales / Knocking / Bonus lenses)

- KPIs and Knocking read one rollup `_kwBase(gran)`. Sales on these pages = **install report only** (since Aug 5 2026; a Bria-only sale can never install, so blending inflated PRA and dragged IR).
- **Report lag clip:** `_kwSalesThru()` = last day where report sales ≥ 70% of Bria's count (over Bria selling days with ≥10 deals). Past it, `praDays`/`ctcDays` are skipped; close rate uses `ctcContacts`. Volume totals are not clipped. `_kwThruNote(R)` prints "counted thru <date>".
- **Bria fill:** for `sd > _kwSalesThru()` where the report has no row for that rep-day, `_kwBase` fills `r.feed` from `_kwBriaByRepDay()` (sales/PRA/close only, never `dealSold`). `_kwCovThru()` = max(report thru, last Bria day) drives the clip. Aug 2026: PRA 2.41 → 2.44 with 418 filled sales.
- **Holes:** `_kwSalesThru` records `holes` (days within 14 days behind THRU where report < 70% of Bria); Bria keeps filling them. `window._kwThruHoles()`. Aug 29 2026 hole had dropped a paid August PRA from 2.48 to 2.37 (fixed Sep 2, reads 2.50). Do NOT add a PRA lock feature (rejected).
- Sales page is month-only (Aug 21 2026); Knocking keeps week/month/year.
- **Core reps toggle** `kwCore()` (localStorage `kwCoreOnly`): drops reps with fewer than 2 (week) / 4 (month) / 10 (year) PRA days.
- KPIs are employees only (subs excluded); `KW_EXCLUDE` = Nick Boyd, Daxton Day (intake accounts).
- **Bonus lens (final model, Aug 31 2026, do not reinterpret):** the review DATE is the only control. Install rate = `_kwCohortIR(asOf)` = the 4 Sunday weeks ending 2 weeks before the review date, scored as of that date from `install_date`/`cancel_date` (cancel wins over install; deals sold after asOf excluded), install-report rows only, presale and ghost presale out, per-week subs out. Badge FLOOR (open = miss) vs SETTLED. Constants `_KW_MB_BUF` / `_KW_MB_WEEKS`. PRA and close rate = the PRIOR calendar month (a month is reviewed after it closes: Jun 2 reviews May). History rows each on their own review date (same day-of-month); in-progress month shows a row with blank cohort columns. Week-by-week tracking card `_kwWeekTrack(n)` (must mirror `_kwCohortIR` rules) shows only when the review date is today, NEXT REVIEW badge. Bonus as-of control `window._kwBonusAsOf` (localStorage `kwBonusAsOf`). Open question never settled: whether the install window should count installs that occurred in the window instead of deals sold in it.
- **Meeting baseline** (`_kwMeetingBase(asOf)`, collapsed `<details>` on the Month lens): pick meeting date, skip 2 full Sunday weeks, take the 4 weeks before as cohort, score as of that date; install rate = installs/sold with open in denominator.
- KPI Why panel (`_kwWhyHtml`): per period vs previous, install-rate delta by team, PRA delta by team, booking distance with ISP drift, stuck pending >14d; sparklines `_kwSpark`, streaks `_kwStreak`; drills `_kwDrill(id)` open the underlying deals.

## Sales source per surface (summary)

Implementation: `growBriaIndex()` / `growBriaWeek()` / `growBriaRepOk()` in index.html; Bria carries only rep + date, so manager/ISP scoping is resolved per rep per WEEK via `growBriaMgrOf` (falls back to the roster `_authMgr` when the deal feed says Unassigned) / `growBriaIspOf`. Every table falls back to install-report numbers when Bria has no rows for a week. `_praUnionWorked` also clips knocked days past `_kwSalesThru()` and inside `_kwThruHoles()`. Intake accounts (Nick Boyd, Daxton Day) are dropped from `knocking_daily` at ingest via `window.GROW_INTAKE` (their deals kept).


- Weeks / leaderboards / Markets current week / knock board sold: Bria.
- Weeks Inst/Canc/IR/booking: install report.
- KPI page: install report + Bria fill past coverage.
- Records "All Reps" leaderboard: Sold + PRA from Bria YTD (`_BRIA_YTD_START` 2026-01-01), installs from the deal feed (Serviced), joined by exact name. Leaderboard Club milestones (10/12/16/20 a day, 30/40/50/60 a week) from Bria all-time (back to 2025-02-17); Install Records stay on the deal feed.
- Markets page settled weeks: deals feed (so market rows sum); current week from Bria with market inferred from the rep's last reported market. Market = ISP + state; Deals/Rep, never PRA.
- Meeting deck: per day, install report up to that ISP's latest reported sale_date this week, then new Bria for the days after.
- Upfront pay: one source per rep per Sunday blitz week (report if any, else Bria).
- Daily manager card (retired Oct 14) and weekly rep email (retired Oct 21): Bria only for sold / report + Bria max; history only.
