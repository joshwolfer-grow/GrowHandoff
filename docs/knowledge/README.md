# Grow knowledge base

Operational know-how for the Grow systems (GrowSales dashboard, syncs, ISP lead pipeline, payroll, WolfOffice Grow workers), converted from the previous owner's (Josh's) Claude memory as of Oct 1 2026. Paths are relative to the handoff repo root (`GrowSales/`, `WolfOffice/`, `RepText/`, `TrainingVideos/`); `/Users/joshuawolfer/...` paths from the old Mac don't exist here. Facts carry dates; when something looks off, trust the code and live data over these notes and update the note.

Read **user-preferences.md**, **repo-and-deploy.md** and **gotchas.md** before your first change. Then read the topic file for the task.

| File | What's in it | Read it when |
|---|---|---|
| [user-preferences.md](user-preferences.md) | House rules: no dashes in UI copy, minimal chrome, knocking never totals, confirm before deleting live data, literal specs, deploy via `vercel --prod` | Before any UI/copy change, data deletion or deploy |
| [repo-and-deploy.md](repo-and-deploy.md) | Folder layout, Vercel deploy procedure and traps, build.sh, git/.gitignore/.vercelignore, Supabase projects, local testing | Setting up the machine, deploying, anything "it worked locally" |
| [gotchas.md](gotchas.md) | Checklist of ~50 traps that each cost real time (scope trap, Sunday weeks, dataless crawl files, aliases, PostgREST paging...) | Before debugging anything that "looks like a failed fetch" or a wrong number |
| [data-sources.md](data-sources.md) | Source of truth per question; Bria (new/old), install report sheet, Sequifi API + onboarding Apps Script, Pronto, SalesRabbit, Amplify, Opendoor RTR (Ezee/Bluepeak/Omni), TDS, Terros, Geocodio | Touching a sync, a table, or asking "where does this number come from" |
| [metrics-definitions.md](metrics-definitions.md) | PRA (daily, weekly, 10-door rule), close rate, contacts, install rates (Completed IR vs Install Rate), report-lag clip, Bria fill, Bonus lens, sales source per surface | Any metric question or a number that moved |
| [dashboard-app.md](dashboard-app.md) | index.html architecture, nav, pages (Knocking, Weeks, Payroll, Ops tools, Markets, Callbacks, Recruiting, Schedule...), tables, report_config keys, API endpoints, egress fix, security limits | Editing the app |
| [syncs-and-schedules.md](syncs-and-schedules.md) | launchd agents, Vercel crons, Apps Scripts, cadences, markers/health colours, exit codes, store compaction, Chrome download fix | A sync is red/stale, changing a schedule, new machine setup |
| [knocking.md](knocking.md) | knocking table semantics, feeds (SR crawl, RTR portal, TDS Amplify, Time Track), merge rules, door→ISP (`knocking_isp`), board features, Bria knock feed, data-quality notes | Anything about doors/contacts/hours or the Knocking board |
| [isp-pipeline.md](isp-pipeline.md) | ISP lead file intake and imports, per-ISP quirks (NLF, Lyte, SLIC, Surf, GFiber...), batch ownership, Drive layout, daily ISP workbooks, sector maps, SalesRabbit areas API, duplicate cleanup | An ISP sends a file, an ISP workbook/map question |
| [teams-roster-subs.md](teams-roster-subs.md) | Bria teams roster (current), weekly subs list procedure, rep identity by email, name aliases and matcher, roster history | Team attribution, who is a sub, name mismatches, the weekly subs paste |
| [pay-and-payroll.md](pay-and-payroll.md) | Upfront pay model, tiers, one-source-per-blitz-week rule, paid-week locks, Sep 2026 audit, payroll page | Anything payroll or upfront pay |
| [access-and-logins.md](access-and-logins.md) | Access codes, roles, manager scoping, email login, admin API keys, honest security limits | Giving someone access, adding a page managers can see |
| [outbound-comms.md](outbound-comms.md) | Daily manager card texts (RepText + mgrcards), weekly rep email/snapshot API, corporate recap, other sends | Texts or emails didn't go out, changing their content |
| [meetings-and-decks.md](meetings-and-decks.md) | Monday manager meeting Canva deck recipe + Canva MCP gotchas, More > Meeting board, commitment grid, goals table, Bria Manager Portal design | Building the weekly deck, meeting numbers, goals |
| [training-content.md](training-content.md) | Canva training library, Grow Playbook v2, ISP guides (T-Fiber), video editing pipeline, PII in recordings, 4-Year Window financial course + calculator | Training decks, videos, ISP guides |
| [wolfoffice.md](wolfoffice.md) | Grow parts of WolfOffice: rebuilt Supabase project, mgrcards and install-slot workers, how to edit the live office safely | The 9am cards or install slots stop, editing WolfOffice |
| [open-items.md](open-items.md) | Everything pending / not deployed / blocked, with the date noted, plus things likely retired | Planning work, or before assuming a feature is live |

Secrets: none of these files contain secret values. Env var and file names are listed so you know what to set; values live in the password manager / Vercel. See `handoff/_secrets-found-in-memory.txt`.
