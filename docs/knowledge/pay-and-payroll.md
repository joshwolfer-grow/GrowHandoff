# Pay and payroll (upfront pay)

## The upfront pay program (opt-in)

- Per deal: **$50 paid upfront** at sale (off Bria/report before installs confirm), **remainder paid on install**, **final 10% held and paid 90 days later** (the 10% holdback exists nowhere in code).
- **Pay cycle:** sales counted Thursday to Wednesday, processed the following Thursday, paid Friday. A week starting W is only "due" once W+8 has passed. Sequifi pay periods are Sun to Sat (different).
- **Presales are never paid upfront.** Report side: only `deal_type === 'Standard'`. Bria has no deal type; a Bria row counts only with an install date, and one that pairs to a report Presale is dropped.
- **Tier (since 2026-08-05):** cumulative install rate on ALL deals since `UF_START` = 2026-07-01 (`_ufSinceTally`), installs ÷ (installs + cancels). ≥75 green; 65 to 74 yellow, **still paid**, 2 pay weeks grace, red on the 3rd; under 65 red immediately; under 10 settled deals nobody comes off. Recovery to 75+ is instant. Constants on one line: `UF_LINE/UF_FLOOR/UF_GRACE/UF_MIN_DOORS/UF_WIN/UF_LOOKBACK`; labels derive from them. All checks route through `_ufStatus`/`_ufPaidUpfront`; never re-add a bare `>=75` (it was hardcoded in four places incl. `computePayrun`). Earlier rule (superseded): rolling last 4 ACTIVE weeks (10+ doors) at 75%.
- Stored history (`api/upfront-tiers.sql`, applied Aug 5): `upfront_tier` (tier per rep per pay week, written for every roster rep on close), `upfront_chargeback` (one row per red event, keyed rep+raised_week), `upfront_paid.status`, `upfront_paid.deals_json`. History can't be derived because deals are read at current status.
- **Two different clawbacks, never sum them.** Weekly reconciliation = a deal paid off Bria that the install report never confirms (happens to green reps too). Tier chargeback = reversal of everything paid across the yellow run, only on red. Cancels alone never claw.
- Export to Sequifi keeps exactly 6 columns: `Payouts, Start Date, End Date, Deals, Upfront Pay, Note`; numeric amounts (no "$1,200" strings); a rep coming off gets one negative row with Start Date = first yellow week (`_ufExportChargebacks`).
- Opt-in list: `upfront_optin` table (synced from the "upfront pay reps" tab of a Google Sheet owned by someone else); `active_date`/`end_date` columns. Six reps dropped off on expired `end_date` while still selling (Sep 2026); check the sheet's End date before calling it underpayment.

## Source rule (Sep 10 2026, owner's words)

"It should basically be an Or system. If there's an install report for that day, go off of that. If not, go off of Bria." Implemented **per rep per Sunday to Saturday blitz week**: if the install report has any Standard deal for the rep in that blitz week, Bria rows for that week are skipped ("Bria could be a mis-add or even a fake deal"). `repWk[rep|sunday]` in `computePayrun`, built over the whole deals feed with `_ufWeekOf`. A pay window spans two blitz weeks, so a rep can be report-paid Thu to Sat and Bria-paid Sun to Wed. Bria only pays rows with an install date.
- The old code ADDED report + Bria and deduped by exact customer name; reps type first names into Bria ("Jeff" vs "JEFF MICHAELIS"), so deals were double paid (Jaylen Brandon Aug 27: 20 real, paid 33). Never re-add a path that counts both sources for the same period.
- ISP report cadence is observed from the feed, never hard-coded. ISP labels differ ("i3 Broadband" vs "i3 Fiber", "GFiber" vs "Google Fiber"): `_ufIspKey()` strips suffixes and maps g→google.
- Customer names: reps log FIRST NAME + LAST INITIAL ("Monica V" = Monica Vian). `_ufNameScore` / `_ufPairDeals` handle that plus possessives; they now drive only reconciliation and "in Bria too" ticks, not pay.
- Clawback must be symmetric with pay: reconcile against the closed run's `deals_json` rows with `src:'bria'`; without a snapshot apply the same `dd.id && !_ufReportHasDay` filter.
- `_canonBriaReps` order: hand alias naming a roster rep → exact case-insensitive → `growRepAlias` → roster fuzzy only if nothing knew the name, unique max ≥0.9.
- Known leftover: ISPs the report never names (T-Mobile, Ting, GigabitNow, blank) are never paid upfront (7 deals).

## Paid weeks lock (built Sep 17 2026)

- `_ufSnapRow` is the one row shape for checkbox, check all and Close: deals, amount, clawback, deals_json (late adds flagged `late` + `fromWeek`).
- `_ufApplyLocks`: a rep-week with `upfront_paid.deals` set renders from the save. `computePayrun(wi,true)` = raw live recompute (cache `window._ufRawCache`).
- `_ufLateAdds`: live deals in a locked week that weren't paid roll into pay week index 1 (being processed), or 0 once that is locked. Skips weeks ending ≤ `UF_AUDIT_THRU`. Count-only locks take the newest N deals as late.
- Clawback base: no paid row = no claw; count-only lock caps Bria claw at paid count minus report rows.
- Model the owner expects: every deal is paid once; lock what was paid, roll the rest forward.
- Status: built, **import of Pay History into `upfront_paid` and deploy were pending** as of Sep 17 (import blocked by permission layer; backup `backup.upfront_paid_20260917`). Fill only where amount is null; Sep 3 ticked reps with no Pay History row = paid 0.
- **Pay History tab in the Rep Sales sheet is the payout log** (94 rows Jul 2 to Sep 3, counts not names). Neither `deals` nor `bria_deals` keeps arrival history (full reload each sync), so "when did a deal arrive" can't be proven; `backup.bria_deals_20260911` is the only dated snapshot.

## The September 2026 audit

- Nine settled pay weeks 2026-07-02 to 2026-09-02, rebuilt under the source rule, against the Pay History tab (the owner's pasted copy is the truth; the Drive extract differed by $150): paid $36,400 vs owed $30,750, net $5,650 overpaid before true-up (payroll had already clawed back $2,750 via "Sequifi report shows Bria N deals lower" deductions); recover $6,950 from reps (largest Kiefer Neal $1,300, Jaylen Brandon $750), owed $1,300 (Dawson Woodward $600, Will Gabor $300), 5 rep-weeks never run ($900). (The memory index summarised this audit as "net $3,550 overpaid"; that figure does not reconcile with the detailed numbers above, so trust the audit sheet. Under the final Sunday blitz-week rule the same nine weeks measured paid $36,400 / owed $31,350 / net $5,050.)
- Pay History traps: part-week rows (key by the pay week CONTAINING the start date); Note column "NOT PAID YET, BUT PUT IN SEQUIFI FOR NEXT PAYROLL" isn't money moved; two rows for one rep-week must be summed.
- Deliverables: Google Sheet "Upfront Pay Audit — Adjustments" (`1SYsmGo6nAninT0juDESd-TlKltbq7ts6LKvuGQLWO8c`); payroll handoff sheet "0 · PAYROLL — start here" (`1oBGloUgndh1BFNE9O24ug6ji8UBl4LyYxQB40bsA9Hw`) with per-rep RETRACT/PAY amounts and net_pay from the last three Sequifi runs (only ~$1,400 nettable from the current run; seven reps $950 have nothing scheduled, direct recovery only). Deal-level sheets moved to a Backup subfolder. Give payroll per-rep totals only.
- **`UF_AUDIT_THRU = 2026-09-02`**: `computePayrun` empties `lastOnly` when `recWin.end <= UF_AUDIT_THRU` (otherwise four reps lost the same $50 twice). Never reconcile a week the audit covers.
- Julian Chavez has never been paid (13 deals only in Bria under a misspelling, no install dates); confirm the deals are real first.
- Re-run gotcha: page PostgREST by primary key with keyset filters.

## Payroll page (UI)

Payroll rail item → Upfront: Status tab (rep-facing tiers) and Pay & Reconcile (`_ufMode` 'payrecon', 1-2-3 ritual strip `window._ufStepsStrip`). One table grouped (pay this week | last-week Bria | last-week report), click to expand deals. Selected rep card: "Deals paid this week" block (one line per `payMerged` deal with Report/Bria pill `.ufd-src`) then "Weekly reconciliation" that buckets every last-week Bria row (presales in report · same deal as a standard report deal · no install date/placeholder · paid from Bria) and says where the report filed each unconfirmed row (`gapDeals[].reportSd`). Week-strip cards show net payable from `computePayrun(n)`. Do not bring back a week-wide "Deals paid this run" table. Paid checkboxes and Close pay run persist to `upfront_paid` (pay_week, rep) and `upfront_pay_runs` (`api/upfront-paid.sql`). `__payroll_code__` is a client-side pay-run confirm. ~26% of opted-in Bria deals have placeholder customer names ("Past Sale"), bucketed separately.

Test pay logic with a Node harness that lifts functions out of index.html (seed `window._ufPaid={}` etc. first; `_ufPayrunHtml` reads `window._ufPaid` unguarded). Drive the real UI via `window._grow.oms('upfront')`.

## Bonus

Manager/company bonus review uses the KPI Bonus lens (install-rate cohort, PRA, close rate, days to install). See metrics-definitions.md. Paid PRA accelerators: August 2026 PRA was paid at 2.48.

## Other comp facts seen

- T-Fiber comp grid: base $225; 300 Mb $50 flat; 1 Gig base minus $25; 2 Gig base plus $50.
- Training comp override figures conflict between decks (How Pay Works $15/$37/$15 vs Recruiting Training $15/$10/$7 to 37); unresolved.
- Financial course: ~$230/deal and 80% install used for S Corp math (see training-content.md).
