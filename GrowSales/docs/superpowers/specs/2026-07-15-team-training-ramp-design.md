# Team view — training accountability + onboarding-to-first-deal ramp

**Date:** 2026-07-15
**Status:** Approved design, pending implementation plan

## Goal

Replace the hard-to-read Bria training view with a single rep-centric "Team" screen that
answers "who is on track and who isn't" at a glance, and connect Sequifi onboarding to the
dashboard so every new hire's ramp (onboarded → training → first knock → first sale →
5 sales) is tracked against goals and correlated with training completion and experience
(veteran vs rookie).

Design was iterated with mockups (list, table, cards, timeline, and funnel variants);
the chosen layout is a **kanban-style funnel board + one detail sheet**:

- **Team screen** (More → Team): a four-column funnel board — **Onboarded →
  Into trainings → Out selling → Fully ramped** — with an "All reps" segment for the
  full-roster training list. One-line stat header (trained-vs-untrained speed),
  send icon (Pronto digest), gear icon (settings sheet).
- **Person detail sheet** (tap any card): milestone timeline with the required-path
  course chips expanded inline under the Training milestone, goal chips per milestone,
  Copy nudge / Text manager actions.
- **Manager scoping is free**: the existing Corporate/manager view picker scopes the same
  board to a manager's reps. The same content (their stuck cards + hires' stages)
  replaces the current `_briaMgrTraining` section in the weekly manager reports.

### Funnel buckets (the core rules — all computed, nothing manual)

| Bucket | In when… | Out when… | Stuck flag |
|---|---|---|---|
| **Onboarded** | Sequifi onboarding complete, 0 required lessons done | First required lesson completed | No training started ≤2d |
| **Into trainings** | Required path started, not finished | All required courses done + quiz passed | Path not done ≤7d from onboarding |
| **Out selling** | Path complete, <5 sales | 5th sale lands | No 5th sale ≤21d from onboarding |
| **Fully ramped** | 5+ sales | Card leaves the board 30 days after the 5th sale | — |

- **Training gates "Out selling"**: a rep who sells while untrained stays in
  Into trainings (their doors/sales still show on the card). Nobody is credited as
  Out selling until the path is done.
- **First sale is a card stat, not a column**: cards show "0 sales" / "2 sales · 1st
  on d2"; first-sale speed still feeds the cohort stats and goals.
- **Day counter** (d12) always counts from `onboarded_at`, whatever the column.
- **Card anatomy**: name + R/V chip, day pill (hot red when stuck), training badge
  (green done / amber in progress / red overdue), doors + sales line. Stuck cards get a
  red border and sort to the top of their column.
- **Board population**: reps onboarded via Sequifi still ramping (not yet 30d past 5th
  sale), plus **any** rep with an incomplete required path (they appear in
  Into trainings regardless of hire date — that's the accountability net).
- Column headers show count + the stage goal (e.g. "goal: done ≤7d"); Fully ramped
  shows the running avg days-to-ramp.

## Decisions made

| Question | Decision |
|---|---|
| Scope of "simplify" | Both: one required course path + rebuilt dashboard view |
| Accountability | Worst-first list, manager ownership, copy-nudges, funnel-linked |
| Funnel clock | Sequifi `onboarding_complete` → first **sold** deal (dashboard `sd`) |
| Goals | Full ramp milestones; goal windows **editable in settings**, tuned later (ship with placeholder defaults 7d training / 7d first sale / 21d five sales) |
| Required path | One path for **everyone** (no veteran skip) |
| Digest | **Manual only** (button posts to Pronto); no scheduled sends |
| Menu name | **Team** — replaces the training tab of "Deal & Training Audit"; the deals tab remains (renamed "Deal audit") |
| Layout | **Funnel board** (kanban, take 1 of the funnel explorations) with buckets Onboarded / Into trainings / Out selling / Fully ramped |
| Gate rule | **Training gates Out selling** — sales don't advance an untrained rep |
| First sale | Card stat + cohort metric, not a column boundary |
| Graduation | Fully ramped cards stay **30 days** after the 5th sale |

## Architecture

All new pieces copy existing patterns in this repo (bria-sync cron + Supabase tables +
single-file dashboard views).

### 1. Sequifi sync — `/api/sequifi-sync.js` (new Vercel cron, hourly)

Pulls `GET https://marketplace-api.sequifi.com/v1/users` (paginated, ~440 users) with
`SEQUIFI_TOKEN` env var. Upserts into Grow Supabase:

**`rep_onboarding`** (natural key `sequifi_id`):
- `sequifi_id`, `employee_id`, `first_name`, `last_name`, `email`, `mobile_no`
- `office_name`, `manager_name` (from nested `manager`), `position_name`,
  `sub_position_name`, `experience` — `'veteran'` if `sub_position_name` = Veteran else `'rookie'`
- `status_id`, `worker_type`, `sequifi_created_at`
- `onboarded_at` — **stamped with `now()` the first run where `onboarding_complete=1`
  and previously unseen/0**; never overwritten on later runs. For users already complete
  on the very first sync, backfill `onboarded_at = sequifi_created_at` and set
  `onboarded_backfilled = true` (day-level accuracy is fine; flag lets the UI mark them).
- `last_seen_at`

**`sequifi_sync_meta`** (single row): `last_run`, `user_count`, `error`. Dashboard shows a
stale-sync warning if `last_run` > 26h old (Sequifi tokens expire ~60 days; the meta error
surface is how expiry gets noticed, same as the Bria flow).

SQL file `api/sequifi-sync.sql` mirrors `bria-sync.sql` (anon read, service-role write).
Cron entry added to `vercel.json` **with `functions.maxDuration: 60`** (bria-sync ran
17.5s; the Vercel default 10s limit silently kills slow cron functions). Manual trigger:
`/api/sequifi-sync?key=CRON_SECRET`.

### 2. Settings tables (edited from the gear sheet)

**`required_path`**: `course_title` (must match Bria course titles in
`training_completion.course`), `sort_order`, `active`. Only active rows count toward
training accountability; all other Bria courses are ignored ("optional · not tracked").

**`team_settings`** (single row): `training_start_goal_days` (default 2),
`training_goal_days` (default 7), `first_sale_goal_days` (default 7, cohort metric only),
`five_sales_goal_days` (default 21). Editable any time; bucket/stuck flags recompute
client-side from these.

### 3. Client data + computation (index.html)

Load `rep_onboarding`, `required_path`, `team_settings`, `sequifi_sync_meta` alongside the
existing fetches (same try/catch pattern as `_briaComp`).

Per person (matched via the existing `growMakeRepMatcher` fuzzy matcher — Sequifi
`first_name + ' ' + last_name` → dashboard rep; unmatched names surface in a list like the
current Bria unmatched panel):

- **Training status**: from `training_completion` filtered to `required_path` titles —
  done count, incomplete list with lesson %, quiz pass/fail, days overdue
  (`today − onboarded_at − training_goal_days`, floor 0). Reps with no `onboarded_at`
  (pre-Sequifi veterans) fall back to the existing Bria `overdue_days`.
- **Milestones**: `onboarded_at`; training done (all required complete — date = max
  completion date); first knock (earliest `knocking` row for the rep); first sale
  (earliest deal `sd`); 5 sales (5th deal `sd`).
- **Bucket + stuck**: each person is assigned one funnel bucket per the rules table
  above; `stuck` = the current bucket's goal window has elapsed (red border, top of
  column, hot day pill). Board population = Sequifi-onboarded reps not yet 30 days past
  their 5th sale, plus any rep with an incomplete required path (capped at 60 days
  since onboarding for hires who stall out entirely — they drop to the All list with a
  red status rather than haunting the board forever).
- **Cohort stats**: among hires with a first sale — mean days-to-first-sale split by
  (a) required path complete *before* first sale vs not, (b) veteran vs rookie. Shown in
  the stat strip; also feeds the digest's correlation line. Hide a split while either
  side has n < 3 (show "collecting data…") to avoid nonsense averages early on.

### 4. Team view UI

New More-menu item **Team** (corporate and manager views). The existing "Deal & Training
Audit" entry becomes **Deal audit** (deals reconciliation tab only); `renderBriaAudit`'s
training tab is removed. The flashcards feature (`training_cards`) is untouched.

- Header: title + view picker, then a one-line stat strip (to-1st-sale trained /
  untrained / vet vs rookie; each side hidden until n ≥ 3), send icon (digest), gear
  icon (settings). Last-sync stamp as a muted footer line.
- Segmented control: **Board** (default — the four-column funnel per the bucket rules
  above) / **All · N** (full roster as a compact worst-first training list, one line per
  rep: dot, name, status).
- Board columns scroll horizontally on the phone (snap per column); on desktop all four
  fit. Tapping a card opens the detail sheet; the nudge action lives on the sheet.
- Gear → settings sheet: required-path editor (order, active toggles) + the goal
  windows (start ≤2d, path done ≤7d, 5 sales ≤21d — stepper inputs, editable anytime).
- Detail sheet (tap a card): header card (name, team, experience, day N, bucket +
  stuck pill),
  vertical milestone timeline — Training milestone shows course chips
  (green done / amber partial / red untouched / quiz fail) — then Copy nudge / Text
  manager action row and the nudge preview text.
- Alerts feed: stuck cards and 7d+ overdue training produce entries in the existing
  alerts system (same pattern as the current TRAINING alert, which this replaces).
- Weekly manager reports: replace the `_briaMgrTraining` block with the team-scoped
  training + new-hires blocks (respecting the existing `showTraining` report toggle).

### 5. Nudges + digest

- **Nudge** (per rep): builds a personal plain-text message ("Jake — 4 courses left on
  your required path (12 days past due): …") and copies to clipboard via the existing
  `_briaCopy` helper. No auto-DM.
- **Digest** (manual button): plain text — TRAINING section grouped by manager
  (worst-first), FUNNEL section (stuck cards spelled out with bucket + day count,
  on-track compressed to one line), correlation line ("Trained reps reach their first
  sale 2.2x faster"), link line. Posts to Pronto via a new `/api/pronto-post.js` endpoint using the stored Pronto
  token (same auth as `pronto-sync.js`); on failure (expired token), falls back to
  copying the digest to the clipboard with an explanatory alert. Target channel id is a
  constant in the endpoint (leadership channel), like `PRONTO_BUBBLE` in the onboarding
  script.

## Error handling

- Sequifi token expiry → sync writes `error` to meta; Team view shows stale-data banner.
- Unmatched Sequifi names → "Unmatched" card (same as Bria unmatched panel); metrics
  simply exclude them rather than guessing.
- Missing knocking data for a rep → first-knock milestone shows "—" and is skipped in
  pace calculation (no false "off pace" from a data gap).
- Required-path titles that no longer match any Bria course → flagged in the settings
  sheet ("no matching Bria course").
- Weeks stay Sunday-anchored per dashboard convention.

## Testing

- Unit-style: bucket assignment + stuck flags (incl. the training gate and the
  sold-while-untrained case), cohort split math, onboarded_at
  stamp-once semantics (run sync twice, date unchanged), required-path filtering.
- Manual: run sync against live Sequifi, verify counts vs Sequifi admin; open Team as
  Corporate and as a manager; tap through detail sheet; copy a nudge; post a digest to a
  test Pronto channel first.
- Deploy checklist: create tables via SQL editor, add `SEQUIFI_TOKEN` to Vercel, sync
  `index.html` → `public/` before `vercel --prod` (repo convention).

## Out of scope (explicitly deferred)

- Scheduled/auto digest posts and auto-DM nudges.
- Veteran-skip-basics path variants.
- Restructuring Bria course content itself (curating the required path list is the
  simplification lever; editing courses happens in Bria whenever).
- Pushing dashboard data back into Sequifi.
