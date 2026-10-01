# App polish + Ops tab design

Date: 2026-07-23. Status: design approved pending Josh review, nothing deployed.
Mockups: https://claude.ai/code/artifact/cfdbab17-b2cf-42ce-bc45-e574640bb15d

## Goal

Make the dashboard feel like one app instead of forty panels, and give Josh a
built in place to track every process that is still manual. Two personas, two
tab bars, no admin leakage into manager views. Less fluff everywhere.

## Desktop first for corporate (added after Josh feedback, same day)

Josh uses corporate on a computer 99% of the time; the core use is week by
week numbers plus running totals. So corporate gets a desktop shell: left
sidebar (Season, Daily, Team, Ops, Offices, More) that collapses to the
phone tab bar under ~900px. Managers and reps stay phone shaped.

Season (desktop home): stat row (deals to date, doors to date, goal
progress, projected finish weighted to recent form) above a week ledger.
Ledger columns: week, deals, delta vs prior week, doors, D/deal, selling,
installs, then a blue running total column group (Σ deals, Σ doors,
Σ installs) on every row. Current week highlighted. Rows expand to per
office, then per rep, same columns.

Offices: one ledger row per office with Σ columns. Clicking a manager (or
using the picker) opens a drill in page, not the manager's phone layout:
breadcrumb Corporate / Offices / Name, their week ledger with running
totals left, Reps this week + Ramp cards right, Copy share link action.
Optional compare: check 2 or 3 offices, ledgers as adjacent column groups.

Extra ideas floated (not committed): Cmd K jump box, Monday 7am ledger row
email to Josh and Bria, /tv wall mode, copy as image on every ledger via the
report image pipeline, per week note field for outliers.

## Grow brand system (Josh round 4: "looks generic, nothing special to Grow")

The app wears the Grow deck identity, not iOS defaults:
- Chrome is Grow black (#0b0c0b): top bar, phone tab bar, desktop sidebar.
  Content sits on warm paper (#f2f2ec) with white cards.
- Brand green #2fc352 (deep text variant #157a34) replaces iOS blue
  everywhere: active nav, links, actions, Σ column tint, projection bars,
  updated chip. Semantic amber and red stay for warn and act.
- Sprout mark (two leaf + stem SVG, drawn from GROW LOGO.png) replaces the
  G square; white leaves + green stem on black chrome, all green on paper.
- Type: Archivo Black (self hosted woff2, ~10KB latin subset) for titles,
  card labels, table headers, and big numbers, matching the training deck
  template (Archivo Black titles, Garet body). Body stays the system stack
  (Garet is not freely licensable; system sans is the closest neutral).
- Card labels: 9.5px Archivo Black uppercase tracked wide. Secondary text
  on paper is #585d56 minimum (faint hints #767b74); never lighter, per Josh
  "grey text in the modals is hard to read". Buttons: black
  fill primary, green tint ghost.
- The spec artifact page itself is deck dark with the GROW wordmark, so the
  whole design reads as Grow before a single mockup loads.

## Scope bar + column registry (Josh feedback round 2)

Every ledger shares a three part scope bar: Range (this week, season, year,
all time, custom, and when scoped to a person: their tenure / their time in
this ISP, from Sequifi start dates), Rows (by week, month, year, ISP, rep,
manager), Scope (all ISPs, one ISP, one manager, one rep). Same columns
re-cut over whatever slice is picked; week vs week, ISP vs ISP, year vs
year, manager tenure are all the same table.

Column registry, fixed order everywhere: Doors, Sales, Δ, Cancels, Installs,
Install %, Avg bk, Med bk, then blue running Σ Sales and Σ Installs. Views
may drop columns they cannot compute but never reorder or rename. Avg bk /
Med bk = days from sale to booked install date. Σ columns exist only for
counts; rates and lags aggregate as averages over the slice, never totals.

Knocking NEVER totals, anywhere (Josh round 3, emphatic). Σ columns exist
only for sales side counts (Σ Sales, Σ Installs). The Doors column on every
ledger is doors per rep day, not weekly doors. Rep sheets show daily doors
then avg per day worked plus first knock time avg. Goals and KPI tiles use
doors per rep day too. Averages are the push, always.

## Projections (Josh round 3: wants lots of them)

Week projection card at the top of desktop Season and phone Home, and the
same card scoped per office on manager This Week:
- Solid bars for banked days, dashed blue bars for remaining days.
- Remaining days weighted by historical day of week shares (Finish Strong
  week shape data) blended with last 4 weeks of form; not straight line.
- Output is a band (e.g. projecting 58 to 63), tightens through the week,
  goes amber when the band top falls under last week.
- "To beat last week: N more by Sat" row.
- Install projection: installs booked this week discounted by real
  completion rate.
Season level: projected finish stat already in Season header (pace weighted
to recent form, flips amber when projection drops below goal).

## Data coverage promise

Redesign, not a trim: every existing metric and view keeps a home. Sales,
cancels, installs, install rate, avg and median booking lag as registry
columns; leads, installs pipeline, upfront pay under More · Pipeline;
records/leaderboard (Bria YTD) under More · Records; week shapes stay in
More · Analysis and power the projection; knocking map untouched; deal
audit in More; recon and office rollup in Ops; sync health in Needs
attention + Ops.

## Sheets, not popups

Every modal is a sheet: bottom slide up with grabber on phone, right slide
over (~330px) on desktop, dimmed page behind, ~300ms ease, drag or Esc to
dismiss, one open at a time, simple fade under reduced motion. Sheets open
on the range the user was viewing and carry their own scope chip so they can
be rescoped in place (e.g. a rep panel flipped from this week to full
summer).

## Navigation

Corporate: Home, Weeks, Team, Ops, More.
Manager: This Week, Weeks, Reps, More. No Ops, no admin, ever.
Rep link (?rep=) unchanged: single chromeless card. ?share= stays read only.

Weeks and Daily merge into one Weeks tab with a segmented control. All-Time
stays reachable as Records inside More.

## Ops tab (new, corporate only)

Four sections, worst first: Due now, Recurring, Finish setting up, Blocked.
Each task row: name, cadence chip, relative last done stamp (amber when the
cadence window has lapsed, which also promotes the task to Due now).

Tap opens a bottom sheet: one line purpose, step checklist with per step
location hints (panel, skill, script, sheet), Mark done button that stamps
last_done, and an "Automate next" line naming the one thing that would kill
the manual task. When that lands the task flips to a Live badge.

Seed tasks:
- Recurring: weekly rep email (Thu), Time Track import, leads dedup (daily),
  reconciliation, Sequifi roster check, TDS Amplify crawl, Terros geocode
  import (as needed), Pronto digest post, upfront pay sheet update.
- Finish setting up: Ask Grow (Gemini key, ask-schema.sql, deploy, test),
  sync failure alerts deploy, weekly rep email Resend key, upfront pay list
  into Supabase, Bria admin login.
- Blocked: SalesRabbit Amplify API (awaiting SR docs), app deep links
  (awaiting Sequifi scheme).

Storage: new ops_tasks table — slug, title, section, cadence, last_done,
steps jsonb (label, hint, done), automate_next text. Steps editable in app so
checklist tweaks need no redeploy. Checkbox state persists per task.

## Admin relocation

Email blast, push notification, reconciliation, office rollup controls, sync
status and key entry all move from More/Admin into Ops. Keys (grow_email_key,
growSyncKey, push key) are entered once in Ops settings, never inline in
content views. More loses the Admin group entirely.

## More cleanup

Three groups plus search: Pinned (Deal audit, Finish Strong), Pipeline
(Leads, Installs, Upfront pay), Analysis (Knocking map, Week shapes, Office
rollup, Records). Everything else reachable via search over name and
keywords. Ask Grow search box sits at the bottom of More on both personas
once deployed.

## Home (corporate)

Recap hero + one This Week / Last Week segmented control + KPI row + goal
bars + a Needs attention card that folds together sync heartbeats, overdue
ops tasks, and team milestones. Rows deep link (sync row opens the matching
Ops task, team row opens the funnel board).

## Manager views

This Week: scoped KPIs, office goal bar, standouts, requests to corporate.
Reps: segmented Roster / Ramp. Roster rows: name, R/V chip, one status pill
(on pace, fades Fri, no sale d12), deals and doors right aligned. Ramp is the
manager slice of the corporate funnel board. Tap a row for the coaching card
with Copy nudge and Weekly report.

## Detail pass rules (apply to every view)

- One card grammar: 11px uppercase label, optional blue action right, content.
- Segmented controls for every in-view toggle. No mixed buttons and dropdowns.
- Kill helper text; if a view needs a sentence, fix the label.
- Emoji in the tab bar only; card labels and menu rows are plain text.
- Drill-ins get a real header (chevron, title, one action), no floating back.
- Status is always a three color pill: green good, amber watch, red act.
- Tabular numbers, names left, numbers right, everywhere.
- No dashes in copy (standing rule).

## Build order

1. Season ledger + desktop sidebar shell (phone layout untouched).
2. Ops tab (table, list, sheet, seed tasks).
3. Offices page + manager drill in + compare.
4. Move admin into Ops; More loses Admin.
5. More regroup and search.
6. Detail pass across all views, corporate and manager.
7. Home Needs attention card folding sync + ops + team signals.

## Knocking funnels by area (Josh round 5)

Every ISP and rep gets a doors → contacts → sales funnel from the knocking
data: doors per rep day (Time Track import), contacts per rep day + contact
rate (knock event dispositions), sales per rep day, plus doors per sale and
contacts per sale. ISP comparison table (Drs/day, Cont %, Cont/Sale,
Drs/Sale) with rep rows expanding under each ISP; the same three funnel
numbers appear on every rep slide over under the daily knocking. Obeys the
scope bar (week, tenure, year). All rates and per rep day averages, never
door totals. Purpose: name the leak per area (lots of doors + few contacts
= talk to more people; lots of contacts + few sales = pitch problem).

Implementation note: table ledgers must set color explicitly (quirks mode
does not inherit color into tables; bit us in the mockup).

## Sidebar tree + collapse (Josh round 6)

The app's desktop sidebar is a collapsible tree, not a flat list:
- Offices and More are expandable nodes (▸/▾). Offices expands to one child
  per ISP · manager; clicking a child opens that manager's drill in page and
  the child highlights green while you are inside it. More expands to its
  grouped views. Opening a manager any other way auto expands the Offices
  node so the tree always shows where you are.
- A «/» control in the brand row collapses the whole sidebar to a 48px rail
  (sprout only), for full width ledgers; same 250ms ease as the sheets.
- The spec artifact page has the same pattern (grouped section tree, scroll
  spy, ☰ collapse) so navigating the design doc feels like the app.

## Final sidebar IA + deals-only weeks (Josh round 7, supersedes earlier nav)

Corporate desktop sidebar, in order:
1. YTD · running totals, year vs year (Sales, Cancels, Pending, Installs,
   Inst %, booking lags), projected finish. Totals live here, not on Weeks.
2. Weeks · week by week DEALS ONLY: Sales, Δ, Cancels, Pending, Installs,
   Inst %, Avg bk, Med bk, Σ Sales, Σ Installs. NO knocking columns at this
   level; knocking (doors per rep day, funnels, dailies) appears only from
   the manager drill in down. Projection card on top. Week rows expand to
   offices; scope chip for tenure. Phone Home KPIs likewise deals only
   (Deals, Pending, Inst %, Selling).
3. Payroll · upfront pay lives HERE (not More): per rep this-cycle upfront
   ($50/deal), install rate status vs the 75% bar, 90 day 10% holdback with
   release dates, cycle labels (Thu–Wed, processed Thu, paid Fri).
4. Ops · unchanged (task checklists + relocated admin).
5. Offices · tree of ISP · manager children, drill in pages (knocking
   starts here).
6. Reporting · every send in one place: rep weekly emails (preview, send
   included), manager texts (copy nudge, text), Pronto digest (preview,
   post). Sending stamps the matching Ops task.
7. More · everything else, grouped + searchable.

Committed from the ideas list (Josh approved): Cmd K jump box everywhere;
Copy as image on every ledger (report image pipeline); per week note field
on ledger rows for outlier context. Still uncommitted: Monday auto email,
/tv wall mode.

## Same pages, new clothes (Josh round 8, GOVERNING BUILD RULE)

Literally every existing view keeps its exact functionality, content, and
interactions. The upfront pay page especially is THE page Josh has today,
untouched, re-skinned, filed under Payroll. The build is: (1) apply the
Grow token system to existing render functions, (2) relocate views into the
new sidebar IA, (3) convert modals to sheets. No content rewrites, no
dropped interactions. When in doubt, keep the existing behavior exactly.

## Rep card (round 8)

?rep= card keeps its current structure exactly (avatar + name, Sold /
Installed / Pending / Cancelled tiles, Performance row, tappable deal list,
This year block + see-all button), re-skinned. Two additions: a This Week /
Last Week / YTD segmented selector with This Week selected by default
(today's card starts at last week), and YTD stays one tap away. Still
chromeless.

## Weekly rep email restyle (round 8)

Same sections and logic as api/weekly-rep-email.js today (week tiles, day
detail, upfront money box green when on / amber with fix when off, CTA
buttons), re-dressed in brand: black masthead with sprout + GROW wordmark
and week range, paper body, white tiles, green money box, black primary +
green ghost buttons. Fonts must stay email safe (system stack in the html;
Archivo Black only if inlined safely, otherwise heavy system weight).

## Ops steps carry actions (round 8)

Each Ops step may have: an action button that deep links to where the step
happens (app panel like Email blast, or external URL like SalesRabbit
Reports / Supabase SQL editor), and/or an exact code snippet in a black
monospace box with a one tap Copy button (e.g. `node
scripts/import-timetrack.mjs --file ...`, `vercel --prod`, SQL to paste).
Checkbox is the circle; buttons and copy do not toggle the step.

## Adding ops tasks (round 8)

Both paths, by design, since ops_tasks is plain data:
- In app: an Add task button on the Ops tab opens a sheet (title, section,
  cadence, steps with hint + optional link/code per step). Steps editable
  any time, no redeploy. Good for quick capture.
- With Claude: when Josh mentions a new manual process in any session,
  Claude seeds or enriches the task (proper steps, exact commands, deep
  links, automate-next) directly in the table. Good for the fleshed out
  version. Quick capture in app, enrichment in session.

## Complete coverage map (round 9: every current feature -> new home)

Audited against renderMore() in live index.html. NOTHING is dropped; same
functionality, relocated + reskinned.

Tabs today -> new IA:
- Overview + Weeks + Daily -> Weeks (segmented Weekly/Daily; recap hero and
  goals bars at top; This/Last week toggle)
- All-Time -> More · Records (unchanged view)
- Team funnel board -> Offices · Ramp (segmented Ledger | Ramp on the
  Offices page; same board, same buckets, same digest + settings)
- More -> More (trimmed, searchable)

Pinned: Deal Audit -> More pinned. Goals -> Edit goals on YTD/Weeks header
(same editor). Share Links -> Reporting. Leads Dedup -> Ops task. Weekly
Email -> Reporting (send) + Ops task (cadence tracking).

Pipeline: Upfront -> Payroll (EXACT page). All Deals, Map, Install
Schedule, Booking Tracker, Cancels, Upsell -> More · Pipeline, unchanged.

Analysis: Records, Deal Clock, Finish Strong, What-If Calculator, Schedule
Slippage, Pending Aging, Cohort Install Curve, Time to Cancel, Outlier
Explorer -> More · Analysis, all unchanged (Finish Strong also powers the
projection card).

Team ops: Training flashcards -> More (and ?training= deep link works).
Custom Report -> More. Leaderboard Club -> More (?view=club works).
Notifications enable toggle -> More.

Admin: Reconciliation -> Ops. Office Rollup -> Offices page (it IS the
offices ledger). Push Notification send -> Reporting.

Coach/manager view: This Week, Weeks, Reps (roster + coaching cards,
nudges, weekly report, requests box), Sales/Stats/Tools menu -> unchanged
phone app, reskinned. ?share= read only guards unchanged.

Special modes all preserved: ?rep= card (+ This Week/YTD selector),
?share=, ?mgr=, ?training=, ?view=club, view picker, sync heartbeats,
alerts (fold into Needs attention), deal drill kanban, avatars, clipboard
and image copies, Pronto digest send, team settings sheet, push subscribe.

Judgment calls to flag: Team ramp board lives under Offices (not its own
sidebar item, per the final 7 item IA); Share Links lives in Reporting.
Both easy to move if Josh prefers.
