# GrowSales Handoff

Everything you need to build on top of the GrowSales stack: what the pieces are, every connection and endpoint, where the credentials live, and what to search for when you're looking for something. Prepared Aug 2026.

---

## 1. The system in one map

Four layers, thin to thick:

| Layer | What it is | Where |
|---|---|---|
| **Dashboard** | A single static page (`index.html`, ~22k lines, 36 screens) that queries the database directly from the browser. No app server. | https://growsales.vercel.app |
| **Database** | Supabase Postgres, read over its auto-generated REST API (PostgREST). This is the integration surface: anything the site shows, the API can return. | `cmkfohwbejcztctrpdnt.supabase.co` |
| **Server syncs** | Vercel serverless functions on daily crons: Sequifi → `deals`, Bria → `bria_sales_daily`, Pronto → chat tables, plus a watchdog. | `api/*.js` in the repo |
| **Local scrapers** | launchd jobs on Josh's Mac crawling SalesRabbit, Opendoor/Ezee, and Amplify into the `knocking` tables. You almost certainly don't need to touch these. | `scripts/*.mjs` |

Repo docs worth reading in order: `CLAUDE.md` (rules of the road), `docs/API.md` (the full data-consumer guide, the most important file for you), `INVENTORY.md` (everything that runs and when), `SETUP.md` (machine setup, only if you inherit the scrapers).

## 2. The data API (start here)

If you're building off this project, this section is probably 90% of what you need. Base URL:

    https://cmkfohwbejcztctrpdnt.supabase.co/rest/v1

Every request carries the same key twice:

    apikey: <KEY>
    Authorization: Bearer <KEY>

> **Do not use the anon key from the dashboard source.** The key embedded in `index.html` is technically public, but the current row-level security policies give it INSERT and DELETE on core tables; whoever holds it can delete the deals table. Get a read-only key from Josh instead (the recipe is in `docs/API.md` §6, ~15 minutes to mint). Everything below works identically with either key.

### Tables worth pulling

| Table | Grain | Notes |
|---|---|---|
| `deals` | one row per sale (~20k) | The deals feed, synced nightly from Sequifi. Most questions are answered here. Contains customer PII columns; `select=` around them. |
| `bria_sales_daily` | rep × day (~10k) | **Source of truth for sold and install counts**, not `deals`. Reaches back to Feb 2025. |
| `bria_deals` | deal-level Bria detail | Contains customer PII. |
| `knocking` | rep × day door metrics | **Always filter `method`**: `sr_activity` for doors/contacts, `timetrack` for real clock hours. The methods overlap on the same rep-days; unfiltered reads double count. |
| `knock_events` | per-door events (~97k) | Raw grain under `knocking`; only for door-level analysis. |
| `leaderboard`, `goals`, `rep_onboarding`, `training_completion`, `rep_aliases`, `rep_manager_overrides` | — | Roster, goals, and correction tables. `rep_onboarding` has rep emails/phones. |

**Off-limits**: `pronto_messages` (raw internal chat), `manager_contacts`, the `upfront_*` pay tables, `access_codes`, `push_subscriptions`, `report_config`, `doc_chunks`.

### Query syntax and mechanics

Standard PostgREST: `?status=eq.Serviced&sale_date=gte.2026-07-01&order=sale_date.desc&limit=1000`. Pages cap at 1000 rows by default, so pull full history with `limit`/`offset` until a short page returns. No GROUP BY over REST; pull rows and aggregate client-side. Full column dictionaries, worked curl examples, and freshness metadata tables (`*_sync_meta`) are in `docs/API.md`.

### Definitions your numbers must match

- **Weeks are Sunday-anchored.** Use `deals.week`; an ISO (Monday) week shifts every weekly total.
- **Sales/installs come from Bria** (`bria_sales_daily`), not the deals feed.
- **Rep → manager changes weekly** and is corrected by `rep_manager_overrides`; never treat it as a fixed mapping.
- **PRA divides by days worked** (>10 knocks or a sale), not sale-days. **Install Rate** = installs ÷ sold; **Completed IR** = installs ÷ (installs + cancels). Two different numbers.
- **Excluded everywhere:** Daxton Day and Nick Boyd (intake accounts), plus bursts of 10+ stage changes by one rep in 60 seconds.
- **Name splits:** the same rep can appear under two spellings; `rep_aliases` (and `api/_name-aliases.js`) is the consolidation map.

## 3. Serverless endpoints and crons

All under `https://growsales.vercel.app/api/…`. The syncs authenticate with a shared secret: Vercel cron sends `Authorization: Bearer <CRON_SECRET>`; a manual run is `GET /api/<name>?key=<secret>`, where the secret can be `CRON_SECRET`, `SYNC_TRIGGER_KEY`, or `PRONTO_SYNC_KEY`.

| Endpoint | Schedule (UTC) | Does |
|---|---|---|
| `/api/sequifi-sync` | 08:30 daily | Sequifi → `deals` |
| `/api/pronto-sync` | 08:45 daily | Pronto chat → pronto tables |
| `/api/bria-sync` | 09:00 daily | Bria → `bria_sales_daily`, `bria_deals`, `bria_reps` |
| `/api/sync-watchdog` | 10:00 daily | Verifies the three syncs ran; push-alerts if not |
| `/api/weekly-summary` | 14:00 Mondays | Weekly digest |
| `/api/weekly-rep-email` | manual | Per-rep snapshot email, fired from the control panel |
| `/api/sheet-sync` | manual | "Sync now" button for the Rep Sales Google Sheet |
| `/api/vapid-public-key`, subscribe/send-push | — | Web-push plumbing for the dashboard's notifications |

Deploys: `vercel --prod` from the repo root, on the **work Vercel team** (a personal Vercel login gets "Could not retrieve Project Settings"). The serverless functions read their env vars from Vercel project settings, not from the repo. Anything read before ~09:15 UTC may be a day stale; each sync exposes its last run in `bria_sync_meta` / `sequifi_sync_meta` / `pronto_sync_meta`.

## 4. The dashboard and deep links

The whole app is one file: `index.html` at the repo root (~1.2 MB; `public/` is build output, never edit it). Useful URLs:

| URL | Shows |
|---|---|
| `growsales.vercel.app` | Main dashboard (36 screens via the sidebar) |
| `?rep=<name>` | A rep's personal view |
| `?snapshot=<rep>` | The canonical weekly rep snapshot, the same page embedded in the rep/manager/corporate emails |
| Admin › Ops | The Automations board: one row per pipeline, green when it ran recently, red rows name the fix command. The first place to look when data seems stale. |

## 5. Upstream systems and credentials

Two secret stores, deliberately separate: **Vercel project env** feeds `api/*`; **`.env.local`** (not in git, on Josh's machine / password manager) feeds `scripts/*`. To see exactly which names the code expects:

    grep -rhoE "process\.env\.[A-Z_]+" api/ scripts/ | sort -u

| System | Feeds | Auth |
|---|---|---|
| **Sequifi** (comp platform) | `deals` | `SEQUIFI_URL/BASE/TOKEN` in Vercel env |
| **Bria** (sales app) | `bria_*` tables | `BRIA_URL`, `BRIA_EMAIL`, `BRIA_PASSWORD`, `BRIA_ANON_KEY` |
| **Pronto** (team chat) | `pronto_*` tables | `PRONTO_SYNC_KEY`-gated sync |
| **SalesRabbit** (door app) | `knocking` / `knock_events` via crawl | `SALESRABBIT_API_KEY` + live bearer in `data/sr-auth.json` |
| **Amplify** (TDS company) | `knocking` (`source=tds`) | Cookie-auth only, a Chrome profile in `.amplify-profile*/`. No working API key. |
| **Opendoor/Ezee portal** (RTR hours) | `knocking` hours | SSO session in `.rtr-profile*/`; expires on its own schedule |
| **Google Sheets** (Rep Sales, Master Manager Pay) | roster + pay truth | Apps Script webhooks; `SHEET_SYNC_URL`/`SHEET_SYNC_KEY`. Scripts live in Google, copies in `scripts/*.gs`. |
| **Gmail** (email sends) | weekly emails, alerts | `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `EMAIL_ADMIN_KEY` |
| **Geocodio** | address → lat/lng imports | API key in `.env.local` |
| **Web push** | dashboard notifications | `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` |

> **None of these secret values are in this document or in git.** Whatever you need, get from Josh directly through a password manager. Most likely you only need the read-only Supabase key from §2.

## 6. What to search for

The dashboard is one big file, so knowing the landmark strings is how you navigate it:

| Search | In | Finds |
|---|---|---|
| `var OPS=[` | `index.html` | The Ops tab task list, the source of truth for what runs when |
| `MORE_ITEMS` | `index.html` | Single source for the More menu / navigation items |
| `_kwBase` | `index.html` | The merged knocking base every KPI reads from |
| `bootDashboard` | `index.html` | App bootstrap; note functions inside it are invisible to `fetchLiveData` (a swallowed ReferenceError looks like a failed fetch) |
| `sideGo(` | `index.html` | Navigation + the manager access route guard |
| `_name-aliases` | `api/` | Rep name consolidation applied in the syncs |
| `*.sql` files | `api/` | The schema for every table, one file per feature |
| `grep process.env` | `api/ scripts/` | Every secret name the code expects |

For history and rationale, the repo's `INVENTORY.md` and the `docs/` folder beat reading code.

## 7. Gotchas that will bite you

- **The live code is mostly uncommitted.** `index.html` in the working tree (>1 MB) is the app; the last commit holds an old 422 KB version. Git worktrees are stale. Edit main directly, and treat working-tree state, not git, as truth.
- **Vercel deploys the working directory**, not git. `vercel --prod` ships uncommitted edits.
- **Filter `knocking.method`** or you double count (§2).
- **Sunday weeks, Bria-sourced sales, true-PRA denominators.** The definitions in §2 aren't stylistic; every disagreement with the dashboard's numbers so far has traced to one of them.
- **The anon key can write.** Until a read-only key exists, anything holding the dashboard's key can modify or delete production tables.
- **Local scraper data freshness depends on one Mac being awake.** If `knocking` looks stale, it's the laptop, not your query. Check Admin › Ops.

## 8. Access checklist

What to actually hand over, in order:

1. **[Josh]** Mint the **read-only Supabase key** (recipe: `docs/API.md` §6, Option A) and share it via password manager.
2. **[Josh]** Repo access. Clone + `npm install`. The build is just `bash build.sh`; no framework.
3. **[Optional]** Vercel **work-team** invite, only if the coworker will deploy or edit serverless functions.
4. **[Optional]** Supabase dashboard invite, only if they need to run SQL or see logs directly.
5. **[Not needed]** Scraper credentials (SalesRabbit, Opendoor, Amplify, Bria login). Those pipelines keep running on Josh's machine; the coworker consumes their output through the database.

> **Minimum viable handoff:** the read-only key + `docs/API.md`. That alone lets someone build anything read-oriented on top of this data without being able to break production.
