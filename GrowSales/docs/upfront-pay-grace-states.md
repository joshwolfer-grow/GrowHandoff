# Upfront pay: three-state status + grace period + active weeks

Payroll → Upfront. Built 2026-07-29, live in `index.html`.

Replaces the binary On/Off with green / yellow / red, adds a grace period before a
rep loses upfront, changes the window from rolling calendar weeks to each rep's last
4 **active** weeks, and rebuilds the rep drill-down so the deals behind a rate are
readable.

## 1. Status model

Was binary: `status:(rate==null||rate>=75)?'On':'Off'`. A rep at 74% flipped off
upfront the same week they dipped, with no warning and no path back. Now:

| State | Rate | Paid upfront? | Meaning |
|---|---|---|---|
| Green | 75%+, or no settled deals yet | Yes | Good. Nothing to do. |
| Yellow | 65 to 74% | **Yes** | Just under. Needs a message. Grace clock running. |
| Red | Under 65%, or grace expired | No | Off upfront, paid on install. |

Rules:

- **Yellow keeps getting paid.** That is the point of grace. A yellow rep is still on
  upfront while they climb back.
- **Under 65% is red immediately.** No grace.
- **Grace is 2 weeks.** Two consecutive windows under 75% keeps the rep yellow; the
  third consecutive window under flips them red even if the rate is still in the band.
- **Recovery is instant.** Back at 75%+ and the rep is green, clock zeroed.
- **New reps are green.** `rate==null` (no settled deals) stays green.

Constants live in one place, and every label and meter mark is derived from them, so
changing the policy is a one-line edit:

```js
var UF_HIST=4,UF_WIN=4,UF_LINE=75,UF_FLOOR=65,UF_GRACE=2,UF_MIN_DOORS=10,UF_LOOKBACK=26;
```

## 2. The window is each rep's last 4 ACTIVE weeks

Previously the window was the last 4 calendar weeks for everyone. A rep who took a
week off burned a window slot on nothing, so their rate was computed on a thinner
sample, and an old bad week hung around longer than it should.

Now a week only counts toward a rep's window if **they knocked at least 10 leads that
week** (`UF_MIN_DOORS`, from `DATA.knocking_daily.doors`, Sunday-anchored to match the
week key on deal rows). Weeks off are skipped entirely, so the window is the last 4
weeks the rep actually worked, however far back that reaches, up to a 26-week lookback.

Fallback that matters: if the knocking feed has nothing for a rep (a closer who does
not knock, or a stale knocking sync), the window falls back to the weeks they sold in.
Without this, a missing knock record would silently blank out a rep who is clearly
producing, and they would drop out of the tab and the pay run entirely. The drill-down
says so explicitly when the fallback is in play.

## 3. Grace clock: derived, no new table

The clock needs to know how many consecutive windows a rep has been under 75%. That
needs no persistence. `_ufWeeksUnderFor(tal, act)` walks back **one active week at a
time** over the same per-week tally the current rate is built from:

- offset 0 = active weeks `[0..3]` (the live window)
- offset 1 = active weeks `[1..4]`, and so on

A window with no settled deals breaks the streak rather than extending it (favours the
rep). A rep also cannot go red from grace expiry until they have enough history: with
only 4 active weeks the streak caps at 1, and 6 active weeks is the first point a full
3-window streak can be proven.

Two caveats worth knowing:

- It reconstructs history from *current* deal records, so a deal that later flipped
  Pending → Cancelled counts as cancelled in back-computed windows too. It self-corrects
  toward truth and can never flip a rep red unless they are also under the line right
  now, but it is **not an audit trail**. If it ever needs to be one, snapshot weekly
  status to Supabase instead.
- The clock is in *active* weeks, not calendar weeks. A rep who works every other week
  burns grace more slowly in wall-clock time. That is intentional.

## 4. The threshold was hardcoded in four places

This was the real hazard. The 75% rule existed in four independent copies, and one of
them is the money path:

1. `computeUpfront` — the status field.
2. **`computePayrun`** — had its own `var on=(rate==null||rate>=75)`. It did **not** read
   `r.status`. Adding yellow only to `computeUpfront` would have shown yellow reps as
   on-upfront in the roster while the pay run flagged them off, so they would have lost
   real money while the UI said they were fine.
3. `_ufOptinCardHtml` — a third copy.
4. `computeUpfrontPay` — dead code (`_ufPayHtml` is never called), and its copy also
   referenced an out-of-scope `r`, so it would have thrown if revived. Fixed anyway.

All four now route through:

```js
function _ufStatus(rate,weeksUnder){
  if(rate==null||rate>=UF_LINE)return 'green';
  if(rate<UF_FLOOR)return 'red';
  return (weeksUnder||0)>UF_GRACE?'red':'yellow';
}
function _ufPaidUpfront(st){return st!=='red';}   // green and yellow both pay
```

`status` values are the strings `green`/`yellow`/`red` internally, with display labels
derived (`_ufStatusLabel` full, `_ufStatusShort` compact for list columns).

## 5. Visual treatment

`--amber` / `--amber-bg` already existed, so no new tokens.

- `.uf-pill.warn`, `.uf-onoff.warn`, `.uf-kpi.click.warn2`, `.uf-am` dot.
- Roster pills: `On` / `Grace 2w` / `Off`, compact so columns stay aligned. The pill
  columns widened 62px → 74px to fit.
- Yellow rows carry a `! needs a message` badge. Visual only, no persistence — tracking
  who actually sent it was explicitly not wanted.
- KPI row is now 4 cards (team, on, grace, off); mobile drops to 3 columns under the
  full-width team card.
- Sort is red, then yellow, then green, worst rate first inside each band. Manager group
  headers count all three.
- Menu subtitle shows `N on · N grace · N off`.

## 6. Rep drill-down

Was a "Cancels this window" list capped at 12. You saw *only* cancels, so there was no
telling 3-of-40 from 3-of-6, and pending deals (the only ones still winnable) were
invisible. Now one list over the whole window, grouped by effect on the rate:

- **Hurting the rate** — cancelled, newest first, with cancel date and reason.
- **Still open** — pending, with age in days and a `parked` tag when the deal is 7d+ past
  the ISP booking median. Above the installs, because these are actionable.
- **Helping the rate** — installed, collapsed in a `<details>`.

Each group caps at 20 with a `+N more` line. Header shows the arithmetic:
`19 settled · 14 installed · 5 cancelled = 74%`.

Also added: a grace line under the pill (weeks remaining for yellow; floor-vs-expiry for
red, since those are different conversations), a 65% mark alongside the 75% mark on the
meter, and the window label `Last 4 active weeks · Jun 28 to Jul 25`. The sparkline now
runs over the rep's own active weeks and its amber band retuned to the 65% floor.

## 7. Verification

`_ufStatus`, `_ufPaidUpfront`, `_ufGraceLeft`, `_ufWeekOf`, `_ufWeekAnchors`,
`_ufDoorsByRepWeek`, `_ufActiveWeeks`, `_ufRateOver` and `_ufWeeksUnderFor` were
extracted from `index.html` and run against synthetic deals and knocking rows: 46
assertions covering the band edges (65/74/75), the floor bypassing grace, grace expiry
at the third window, the pay gate keeping yellow paid, Sunday week anchoring, active
weeks skipping time-off weeks, and the not-enough-history cap.

Then checked against live data in the browser (18,276 deals): 185 on, 43 in grace, 81
off; a rep at 74% correctly showed `In Grace · Still paid upfront`, "Under 75% for 1
week. 2 weeks of grace left", a Jun 28 to Jul 25 active window, and the three deal
groups.
