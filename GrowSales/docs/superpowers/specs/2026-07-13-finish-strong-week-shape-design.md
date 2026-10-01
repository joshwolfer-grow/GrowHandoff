# Finish Strong — Week Shape section

Date: 2026-07-13. Session was non-interactive, so the brainstorming decisions below
were made autonomously, grounded in the live data.

## Goal

Show reps and managers how deal production trends across the week — who ramps into
Saturday vs who starts great and slows down — and make the coaching case for
finishing the week stronger.

## What the live data says (basis for the design)

Computed 2026-07-13 from Supabase (`bria_sales_daily` 29,344 deals Feb 2025–Jul 2026,
cross-checked against `deals` and `pronto_deal_events`):

- **Recent 8 weeks (May 17 – Jul 5) the team fades**: Monday 20.6% of deals declining
  to Friday 13.4% and Saturday 13.9%.
- **All-time, Saturday is the biggest day** (19.6% of deals in Bria) — the ceiling is
  proven; the current season just isn't reaching it.
- **Friday is the launchpad**: rep-weeks with any Friday production average 3.71
  Saturday deals vs 1.44 when Friday is a zero (~2.6×). Controlling for Mon–Thu pace,
  the gap is 3–5× at every production level.
- Recent per-rep shapes: almost nobody ramps; top producers are flat or fading.

## Approaches considered

1. **New "Finish Strong" More section** (chosen) — full coaching view mirroring the
   Deal Clock pattern: team curve, evidence, per-rep ramp/fade list.
2. Extend the Overview pace block with a fade warning — too cramped for the evidence.
3. Standalone report artifact — not persistent, doesn't live where managers already look.

## Design

New More-menu item **🏁 Finish Strong** (key `weekshape`) under Stats, in both
Corporate and manager menus. Renders on demand like Deal Clock.

**Data**: merged per rep|date daily counts from `_unifiedIdx()` — Bria value wins for
a rep-date, dashboard `deals` fill the rest. Sunday-anchored completed weeks only
(anchor < `tmISO`); Sunday activity folds into the Monday bucket per app convention.
Coach views scope to `_coachRoster()`.

**Components** (top to bottom):
1. Header + window chips: 4w / 8w / All completed weeks.
2. Verdict line + hero tiles: Mon–Wed share, Thu–Sat share, Saturday share.
3. Week-shape bar chart Mon–Sat (hand-rolled flex bars, Deal Clock style); Saturday
   bar green, weakest weekday amber; all-time Saturday share cited under the chart.
4. "Friday launchpad" evidence card: avg Saturday deals after a working Friday vs a
   zero Friday (computed live, all completed weeks, rep-weeks ≥3 deals), with a
   same-pace check (Mon–Thu ≥6) to preempt the "they just work more" objection.
5. Per-rep list (≥6 deals in window): avatar, mini Mon–Sat bar sparkline, Thu–Sat
   share, total, pill — Finishes strong / Fades / Steady by relative best-fit slope
   (±0.10 threshold on slope ÷ mean-per-day). Sorted by volume; tap opens rep card.
6. Coaching footer: three bullets computed from the live numbers (protect Friday,
   Saturday is the proven peak, momentum compounds).

**Non-goals**: no new tables or sync changes; no changes to Overview/pace block;
no hourly dimension (Deal Clock covers that).

## Files

- `index.html` (main working copy): new more-section div, menu items, dispatch line,
  `_wsData`/`_wsWeeks`/`_wsSlope`/`renderWeekShape` near Deal Clock.
- `public/index.html`: synced copy before deploy (`vercel --prod`).

Per this project's convention, main stays uncommitted and deploys directly via
Vercel, so this spec is saved but not committed.
