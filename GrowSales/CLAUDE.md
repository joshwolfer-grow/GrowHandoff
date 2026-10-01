# GrowSales

## The one rule: edit main, never a worktree

The live app is a single file:

    ~/Grow/GrowSales/index.html

(`~/Desktop/Grow/GrowSales` is a stale scratch folder of exports, not the app.)

It is roughly 1.2 MB and **mostly uncommitted**. The last commit only holds a
422 KB version, so every git worktree under `.claude/worktrees/` contains an
`index.html` that is missing ~740 KB of live work.

Editing `index.html` from inside a worktree therefore looks like it worked,
passes every check, and never appears in the app. This has already happened
more than once.

**Before any edit to `index.html`, `api/*`, or `scripts/*`:**

1. Use the absolute path `~/Grow/GrowSales/<file>` (expanded to the real home folder).
   Never a relative path, and never a path containing `.claude/worktrees/`.
2. Sanity check the size. Live `index.html` is > 1 MB. If the file you are
   about to edit is ~422 KB, you are in the wrong copy — stop.

`public/index.html` is build output. Never edit it by hand.

## Deploying

    cd ~/Grow/GrowSales && vercel --prod

Deploy from main only, not from a worktree. Skip GitHub.

## The daily loop

    node scripts/grow-sync.mjs                 # knock data: crawl, rebuild, push
    python3 scripts/lead-import.py <file> --assign "<rep>"   # ISP file -> SR import
    python3 scripts/knock-export.py --isp <name> --all       # CSVs for Drive

The sync health board (More > Admin) shows every scheduled source, its cadence
and its last run; a red row names the command that fixes it. The old Ops tab and
its `OPS` task array were removed Sep 16 2026. How each process works is written
up in `docs/knowledge/` at the root of the handoff repo.

## Where knock data lives

`data/sr-store.jsonl` is the append-only store (latest line per lead wins).
Everything else in `data/sr-*.csv` is regenerated from it by `grow-sync.mjs`.

Whose door it is, per feed: SalesRabbit doors carry the ISP of their import
batch (`data/isp-imports.json`, the order of evidence lives in
`scripts/isp_territory.py`); `source` names the company for every other feed
(ezee, bluepeak, omni, and `method=amplify` is TDS). `grow-sync.mjs` pushes the
SalesRabbit split to the `knocking_isp` table, one row per rep/date/ISP, which
is what the Knocking board's ISPs view reads. `knocking` itself stays one row
per rep/day per source, so no rollup downstream had to change.

Not on every run, though. The 5-minute launchd sync passes `--scheduled`, which
implies `--lean`: it writes only `sr-knocking.csv` (what the push needs) and
`rep-emails.json`, and leaves `sr-activity.csv`, `sr-lead-history.csv` and
`sr-doors-by-area.csv` as the last FULL run made them. Those three cost ~150s of
a ~200s compile and nothing reads them on a tick — only knock-report.py,
knock-export.py and city-overlay.py do, by hand. Before this the scheduled run
had grown past run-grow-sync.sh's 240s watchdog and ticks were being killed at
exit 137 mid-compile. So: run `node scripts/grow-sync.mjs` (no flags) before any
of those reporting scripts, or the addresses they read are as old as your last
manual run.
`data/sr-activity.jsonl` is dead — a corrupted 774 MB file that reads as empty.
Do not try to read or resurrect it.

`knocking` in Supabase has a `method` column: `sr_activity` (the crawl),
`timetrack` (real clock hours, the only source for hours), `amplify` (TDS only,
and distrusted for Grow). sr_activity and timetrack overlap on ~568 rep/days, so
anything reading that table must filter on `method` or it double counts.

## Definitions that must stay consistent

A knock is a `stage_updated` mark. Contact = Not Interested, Call Back,
No English, Do Not Knock, Sold. Vacant / For Sale doors come out of the
denominator ("knockable doors"). The 60% contact rate is an **area** standard,
not a per-rep one — reps are compared to team medians instead. Daxton Day and
Nick Boyd are intake accounts, excluded everywhere, along with bursts of 10+
stage changes by one rep inside 60 seconds.

These live in three places and must match: `scripts/grow-sync.mjs`,
`scripts/knock-report.py`, `scripts/knock-export.py`.
