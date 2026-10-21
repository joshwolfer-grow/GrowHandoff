# Access and logins (GrowSales)

## Who can sign in (Oct 2026)

| Who | How | Sees |
|---|---|---|
| Corporate / admin | access code (role corporate) or email login with `app_users` role corporate | everything |
| Managers | scoped access code (role manager, since Sep 12 2026) or email login (leaders, Sep 16 2026) | only pages ticked for them, team-scoped |
| Callers (label was "Cancel callers" until Oct 7 2026) | access code role `caller` (own assigned leads) or `caller_lead` (everyone's, Assign tab) | Cancel Center Today (caller), + Reports (caller_lead), and the Deal Check queue behind a "Cancel calls / Deal check" switch; dashboard data never fetched |
| Reps | nobody. All 70 rep and 19 manager codes were DISABLED (not deleted) Sep 11 2026; rep codes stay off; "NO reps will ever be on this" | Bria serves reps |

## Access codes

- Table `access_codes` (code, name, role, active, seen, source, perms) managed at Admin > Access, checked through SECURITY DEFINER RPCs: `redeem_access_code`, `upsert_access_code`, `list_access_codes`, `set_access_code_active`, `set_access_code_perms` (needs a corporate code), `_is_corp_admin`, `list_callers()`. `sync_roster_codes` mints nothing now.
- `redeem_access_code` accepts corporate, caller, caller_lead and (since Sep 12) manager; returns `r_perms`. Session revalidate reloads when perms change.
- `ACCESS_ROLES` client side = corporate/caller/caller_lead(/manager); saved rep sessions are ignored; a cached `growAccessOn='0'` no longer skips the gate; the `require_code` toggle no longer opens the site; startup runs `fetchLiveData` only for an allowed role. Before Sep 11 the full dashboard downloaded and rendered behind the gate overlay for anyone.
- Param-link bypasses are gone: `?rep=`, `?share=`, `?mgr=`, `?training` all hit the code gate (`accParamLink()` returns false; `accLegacyManager()` clears crumbs). Legacy `report_config.__corp_users__` was emptied (it held an active corporate code readable with the anon key).
- Rotating a code: `upsert_access_code` keeps the old code for the same name+role, so rotating means a new name (e.g. a new "<Name> W" entry) and disabling the old one.
- Codes are short (5 chars) and redeem has no rate limit.
- Live callers as of Sep 2026: Spencer Ales (caller_lead), Trevor Prince (caller).
- The daily manager-text job signed in with a corporate access code stored in `RepText/.env` (see outbound-comms.md). That code was deactivated by late Sep 2026 (only the corporate code named "Admin" is active), which silently broke the job until it was unloaded Oct 14. Any headless job that signs in needs a code that is still in `access_codes`; `scripts/verify-metrics.mjs` avoids this by answering `redeem_access_code` locally.
- Manager Standards RPCs (Oct 8 2026) reuse `_is_corp_admin` for the corporate-only writes; see dashboard-app.md.

## Manager scoping (Sep 12 2026)

- `access_codes.perms` / `app_users.perms` jsonb: `{pages:{key:'team'|'company'|'on'}, isps:[...], team_of}`. A page not listed = off. Email leaders: null pages = every page at team scope; company is clamped to team; ISP Maps excluded. `team_of` makes `_mgrMode().name` that leader's team.
- Client: `MGR_PAGES` catalog, `_mgrMode()`, `_mgrLock(key)` (off pages lock to team), `_mgrRoute` in `sideGo` + openMoreSection guard, `_inTeam(rep,date,M)` memoised on `_authMgr`. `scopedIds()` and `growBriaRepOk()` lock to `window._mgrCur`. A manager with no pages gets "nothing turned on" and no data fetch. `_railKey.ops` shows Ops when any Ops page is ticked.
- **DATA is never swapped/filtered** (payload precomputes index-based caches; a filtered copy scrambles lookups). Each page's own loop checks `_inTeam`. **A new page that shows rep data needs its own `_mgrLock('<key>')` check plus an `MGR_PAGES` entry**, or managers see it company-wide or not at all. KPI cache tokens include the lock.
- Manager-only pages: `myteam` (Team this week) and `mgr1on1` (inline `/api/weekly-rep-email?snapshot=` iframe, rendered with `embed:true`; `accBoot` refuses to run inside any frame). Meeting and Training are read-only for managers. Corporate "View as" a manager code = sessionStorage `growMgrPreview` + `?mgrpreview=1`.
- Route guard is the choke point: `window._corpOnlyTarget(o)` + `CORP_SECS`/`CORP_MORE` in `sideGo` bounce non-corporate users. Add new corporate screens to those maps or they are open by default. `window._coachNow()` decides coach state from `_grow.coach()` → `body.coach-view` → URL params (must not rely on `_grow` alone; it is defined late).
- PWA `manifest.json` `start_url:"."` opens the bare URL; identity must persist (historical `growShareMgr` fix).

## Email + password login (Sep 16 2026)

- Real Supabase Auth users. `api/auth.js` emails a 6-digit code via `GMAIL_USER` (not Supabase SMTP), then creates the user or sets the password with the admin API. App signs in with the password grant and calls `rpc whoami()` with the user token. Session keeps the code-session shape (code `'@email'` plus auth tokens); `accRpc` sends the user token so `_is_corp_admin` recognises corporate emails. SQL `api/app-auth.sql`.
- `login_role_for()`: `app_users` role set wins; otherwise manager only if their Sequifi name is a manager key on `__sequifi_teams__` in the last 5 weeks (is_manager flag alone is stale); else 'none'. Access codes still work via "Use an access code".
- Rollback = `vercel rollback` to the previous deploy; DB changes are additive. The leader page picker + `team_of` needed another deploy after Sep 16 (status unconfirmed).

## Honest security limits

UI boundary only. The Supabase anon key ships in `index.html`; every signed-in browser downloads all tables; console/curl defeats page hiding. Still public: `/scripts/*` (copied by build.sh) incl. `anon-key.txt`, `team-*.json` rosters, `apply.html`, `schedule.html`, `calculator.html`, `/api/weekly-rep-email?snapshot=<rep>` (unauth render-only GET by design). Recruiting applicant names/phones and payroll data are readable by anyone who views source. Real lockdown ("level 3") = Supabase Auth + RLS keyed on manager, or server-side filtered loads; not built. `rep_onboarding` is service-key only.

## Admin keys for API endpoints

- `SYNC_TRIGGER_KEY` (Vercel env, readable via env pull): fires any sync `?key=`. If lost, rotate: `vercel env rm SYNC_TRIGGER_KEY production` + `vercel env add` (human authorises).
- `CRON_SECRET`: Sensitive, unknowable by design.
- `EMAIL_ADMIN_KEY`: weekly email admin key; `authorized()` accepts it first, then CRON_SECRET / SYNC_TRIGGER_KEY. New admin endpoints should accept the same trio so there is one key prompt (dashboard stores it in localStorage `grow_email_key`).
- `PRONTO_SYNC_KEY`: browser-driven syncs (Pronto bookmarklet, Bria browser sync); embedded in `api/PRONTO_SETUP.md` (retired with Pronto).
- `ASK_KEY`: optional gate for the retired Ask Grow API.
- `RECRUIT_INTAKE_KEY`: keyed recruiting intake.
