# Bria manager portal: Daily Standards checklist

Hand this to the Bria devs. Everything lives in the **Grow Sales** Supabase project
(the same one Bria already reads `knock_board_company` and writes `goals` from), using
the same anon key. Backend is live: `api/manager-standards.sql` in GrowSales.

## What the manager sees

A card on the manager portal home, right under the goal strip, titled **Today's standards**.

```
Today's standards                                   Thu 10/8
[ ] Morning meeting held
[ ] Role plays done

This week
Morning meetings    3 / 5   ███████░░░
Role plays          3 / 5   ███████░░░
1 on 1s             4 / 7   ██████░░░░   (tap to open the rep list)
Your hours       17.6 / 42  ████░░░░░░
Team avg hours   18.3 / 42  ████░░░░░░
Leadership meeting    Attended / Missed / Not marked yet
Manager meeting       Attended / Missed / Not marked yet
```

* The two daily boxes are the only thing the manager taps every day.
* 1 on 1s opens a list of the manager's reps for the week, one checkbox each.
* Hours and meeting attendance are read only. Hours are automatic, attendance is
  marked by corporate in GrowSales.
* A day can be checked **today or yesterday only**. Older days show as locked.
  The server enforces this, so the UI should just hide the box for older days.
* No dashes in any copy.

## Who the manager is

`manager` is the manager's name exactly as our Knocking board writes the team,
which is the `team` column of `knock_board_company` (e.g. `Damien Anderson`,
`Will Gabor`). Use the same name the portal already uses for that manager's team.

## Reads (GET, anon key)

All under `https://cmkfohwbejcztctrpdnt.supabase.co/rest/v1/`.

| What | Request |
|---|---|
| Today's two boxes | `manager_checks?manager=eq.<name>&date=eq.<YYYY-MM-DD>` (Denver date) |
| Week scorecard | `manager_standards_weekly?manager=eq.<name>&week_start=eq.<Sunday>` |
| Day by day for the week | `manager_checks?manager=eq.<name>&date=gte.<Sunday>&date=lte.<Saturday>` |
| Reps for 1 on 1s | `knock_board_company?team=eq.<name>&week_start=eq.<Sunday>&select=rep` (distinct, minus the manager) |
| 1 on 1s done | `manager_one_on_ones?manager=eq.<name>&week_start=eq.<Sunday>` |

`manager_standards_weekly` columns: `morning_meetings`, `roleplays`, `one_on_ones`,
`team_reps`, `manager_hours`, `team_avg_hours` (null when no rep has Time Track
hours), `reps_no_hours`, `leadership_meeting` and `manager_meeting` (true, false, or
null = not marked yet), plus pass flags `meetings_ok`, `roleplays_ok`,
`one_on_ones_ok`, `manager_hours_ok`, `team_hours_ok`, `attendance_ok`.

Weeks run Sunday to Saturday. "Today" is America/Denver.

## Writes (POST to `/rest/v1/rpc/<fn>`, anon key)

Direct inserts into the tables are blocked. Only these two functions write:

```js
// tap a daily box (p_done false to uncheck). p_date optional, defaults to today;
// only today or yesterday is accepted, anything else returns an error.
rpc('set_manager_check', { p_manager: 'Will Gabor', p_item: 'meeting',  p_done: true, p_by: '<bria user email>' })
rpc('set_manager_check', { p_manager: 'Will Gabor', p_item: 'roleplay', p_done: true, p_by: '<bria user email>' })

// tick a rep's weekly 1 on 1 (optional p_note). Accepted for the current week,
// and for last week through Monday.
rpc('set_one_on_one', { p_manager: 'Will Gabor', p_rep: 'Rep Name', p_done: true, p_by: '<bria user email>' })
```

Always send `p_by` so corporate can see who checked it. Every write stamps
`checked_at`, and corporate sees a "checked late" marker when a box was ticked the
day after.

## What corporate sees

GrowSales > More > Team > **Standards**: every manager for the week, red/green on
all four standards, a Today line naming who has not checked in yet, a day by day
breakdown per manager, and the Leadership / Manager meeting buttons corporate uses
to mark attendance.
