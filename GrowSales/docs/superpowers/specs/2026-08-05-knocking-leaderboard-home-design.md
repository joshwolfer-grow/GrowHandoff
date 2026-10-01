# Knocking leaderboard as the app home

Date: 2026-08-05

## Purpose

Make daily knocking the first thing anyone sees in the Grow Sales app, in the
spirit of the PestRoutes and Enzy boards: a live ranking of reps by the numbers,
no commentary, no flags, no coaching prompts. Just who did what today.

This became possible on 2026-08-05, when the SalesRabbit and Amplify syncs moved
from once a day to every ten minutes. A board that refreshes while people are
knocking is a different product from one that reports yesterday.

## Roles and what they see

Role comes from what the app already derives: `VIEW==='Corporate'`, manager share
links (`?share=` / `?mgr=` / `?view=`), and rep links (`?rep=`).

| Role | Sees |
| --- | --- |
| Corporate | Everyone, including the subs team |
| Manager | Internal teams only, subs excluded |
| Rep | Same as manager: internal teams, subs excluded |

Subs are identified by `growIsSub(rep, week)` (index.html:769), which reads the
"Subs" crew from the weekly roster or `is_sub` in rep flags. That flag already
exists and is already maintained by the team import; this page consumes it and
does not introduce a second notion of who is a sub.

### Known limit: this is a curtain, not a lock

The role check decides what is RENDERED, not what is SENT. Every client reads
Supabase with the anon key, so a manager who opens devtools can see sub numbers
regardless of what the page draws. That is acceptable for the stated goal — keep
the board focused and avoid mixing subs into team rankings — and is NOT
sufficient if the requirement ever becomes "managers must not learn these
numbers." Real enforcement needs RLS on `knocking`, which is separate work and
the same gap the manager access boundary hit.

## Data

The page reads the merged knocking base, not the raw table. `_mergeKnockingSources`
(index.html:994) already reconciles the sources correctly: `ezee` and `grow`
measure the SAME doors so they must not add, while `tds` is a separate division
whose doors genuinely do add. That reasoning stands and is not being redone here.

Two fixes land with this work, both of which the ten-minute sync exposed:

### 1. Freshness precedence for today

Today's board must come from the SalesRabbit rows (`source='grow'`,
`method='sr_activity'`), which are at most ten minutes old. The ezee sheet
arrives after the day is over, so it cannot feed a live board at all.

- For `date == today`: prefer `sr_activity` over every other grow-side row.
- For past dates: current precedence stands. Ezee wins there because it covers
  the whole roster where the crawl only returns reps still active in SalesRabbit.

In practice today's ezee row usually will not exist yet, but the rule must be
explicit rather than relying on that.

### 2. Pick one grow-side row, never sum

The current fallback is:

```js
if(!pick.length)pick=growSide.filter(function(k){return k.first_disp&&counted(k);});
```

That matches EVERY qualifying grow-side row and the caller then sums them. Legacy
`('grow', null)` rows and new `('grow','sr_activity')` rows both qualify, so a rep
with both gets their doors counted twice. On 2026-08-04 the table held 23
sr_activity rows and 19 grow/null rows, so this is live, not hypothetical.

Fix: the grow-side selection resolves to exactly one row, by explicit precedence
(today: sr_activity, ezee, other; past: ezee, sr_activity, other). TDS still adds
on top, unchanged.

## Page

Replaces the current landing view. The KPI dashboard keeps its own nav entry and
is one click away; it is not deleted and not stacked below the board.

- **Ranking**: sortable columns, sold descending by default. Any header re-ranks.
- **Columns**: rank, rep, sold, doors, contacts, hours.
- **Window**: Today / Week / Month chips, opening on Today.
- **Summary tiles**: sold, doors, reps out, PRA for the selected window.
- **Top three**: medals on the first three rows.
- **TDS reps**: ranked alongside everyone else. No separate section, no company
  column. Their rows are already in `knocking` with `source='tds'`.
- **Subs**: the existing lens (index.html:828) with its team / subs / all modes,
  with modes filtered by role per the table above. Defaults to team.
- **Refresh**: re-reads on a timer so an idle tab or a wall-mounted TV stays
  current without a manual reload. Cadence should be a little tighter than the
  ten-minute sync so the displayed data is never much older than the source.

## Out of scope

- RLS on `knocking` (noted above as the real fix for the visibility requirement)
- Any flagging, alerting, or coaching signal on the board
- Changes to how knocking data is collected; the syncs are already in place
