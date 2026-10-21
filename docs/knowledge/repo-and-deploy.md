# Repo layout, deploy and environment

## Where things live (handoff repo paths)

| Handoff path | Was on the old Mac | What |
|---|---|---|
| `GrowSales/` | `~/Grow/GrowSales` | The dashboard (`index.html`), `api/` (Vercel serverless), `scripts/` (syncs, ISP tooling), `supabase/`, `data/` |
| `WolfOffice/` | `~/WolfOffice` | Local "office" site + launchd workers (only Grow workers matter now) |
| `RepText/` | `~/Grow/RepText` | iMessage group texting helpers for the daily manager cards |
| `TrainingVideos/` | `~/Grow/TrainingVideos` | Video editing pipeline + training decks |

Absolute paths like `/Users/joshuawolfer/...` will not exist on a new machine. History: sessions used to open in `~/Desktop/Grow/GrowSales`, a near-empty stray (symlink/old partial copy without `scripts/`); the real repo was always `~/Grow/GrowSales`. `vercel --prod` from the stray shipped an EMPTY deploy. The move off Desktop (Aug 2026) also broke every launchd plist that hardcoded the Desktop path (Aug 8 to 10 2026).

Machine-specific paths referenced elsewhere (recreate on the new machine): `~/Library/LaunchAgents/com.grow.*.plist`, `~/Library/CloudStorage/GoogleDrive.../SalesRabbit Reports For ISPs/<ISP>/` and `.../SalesRabbit Leads/<ISP>/`, `~/Library/Messages/chat.db`, `~/Pictures/GrowReports/`, `~/Library/Logs/wolfoffice/`.

## Deploying GrowSales

- `vercel --prod --yes` from `GrowSales/`. Vercel deploys the **working directory, not git**. That is how ~30 `api/` and `scripts/` files ran in prod for months while untracked. Commit before deploying so live and git match.
- `vercel.json` buildCommand is `bash build.sh` (a file because of a 256-char limit). `build.sh` copies root `index.html`, `sw.js`, `manifest.json`, icons, `apply.html`, `schedule.html`, `calculator.html` (added Sep 29), `training.html`, `maps/view.html` into `public/` (`outputDirectory: "public"`). It also publishes `scripts/*` and `_name-aliases.js` to `/scripts/*` (plus `anon-key.txt`) and deletes `install-slots.mjs` from `public/scripts` so the bot is never published. **Never edit or recreate a local `public/`**; it is build-generated and git/vercel-ignored (since Jul 16 2026).
- Preview URLs are behind Vercel SSO (curl gets 302). Verify builds locally with `vercel build` and inspect `.vercel/output/static/`.
- Alias is `growsales.vercel.app` (not `grow-sales`, which 404s DEPLOYMENT_NOT_FOUND).
- `.vercelignore` must exclude `data`, `*.jsonl`, every Chrome profile dir (`.rtr-profile*`, `.amplify-profile*`, `.sr-profile*`), `leads_export-*.csv`, `.xlsx`, `bria/`, `.claude`, `api/*.sql`, `api/*.md`. Before Jul 29 2026 deploys tried to upload 852 MB including live session cookies (limit 10 MB). A deploy that uploaded a copied profile burned Vercel's 5000 files/day upload cap (Oct 1 2026).
- **Vercel account split:** GrowSales lives under the work team (org `team_oSOmKgeLQqq9XYXHB191M43B`, project `prj_1Dlh9sojAWqLtzOeBvexlDKxbjAK` / `project-djlm1`). Logged into a personal account, `vercel --prod` fails with "Could not retrieve Project Settings"; `vercel teams ls` succeeds while `vercel whoami` says "Not authorized". Check with `curl -H "Authorization: Bearer $T" https://api.vercel.com/v2/user` (token in the Vercel CLI `auth.json`). Fix: `vercel logout`, log in with the work account.
- `.vercel/` once shipped in repo-link mode (`repo.json`), which needs a git repo; fixed Aug 18 2026 with a normal `project.json` (projectId/orgId) and `repo.json.disabled`.
- Sensitive Vercel env vars are write-only: `vercel env pull` returns `KEY=""` for them and `.env.local` is blank for the same reason. Never conclude a var is unset from a local file. Set a sensitive var with e.g. `vercel env add SEQUIFI_TOKEN production --sensitive`; pipe values from the source (`pbpaste | vercel env add ...`) because chat UIs mask JWT-looking keys as `••••` and a pasted mask causes a ByteString error at runtime.
- In Sep 2026 the agent permission classifier blocked Claude from running `vercel --prod`, DELETE/PATCH on prod DB, renames of shared Drive files, and `--send` of texts; the human ran those.

## Git state

- Origin was set to a GitHub repo but historically never pushed; Aug 18 2026 everything was committed (`ac7fea1`, 37 commits) for a GitHub handoff. Work accumulates uncommitted in the main tree between commits; check `git status` before trusting HEAD.
- **Never build dashboard changes in a git worktree** branched from HEAD; worktrees were always stale versus the live uncommitted main tree. Edit main directly.
- `.gitignore` is deny-by-default for `data/` (`data/*` plus an allowlist; note `data/*` not `data/`, or git won't reach the negations). `data/` mixes safe config (`isps.json`, `rtr-sources.json`, `amplify-sources.json`, `terros-reps.json`, `sr-lookups.json`) with **live bearer tokens** (`data/sr-auth.json`, `data/sr-auth-tds.json`, `data/salesrabbit-lead-endpoint.json`, `data/.sector-map-key`), API probe dumps and rep-email PII. Read a file before allowlisting it.
- The Supabase **anon** key is in `index.html` by design (ships to every browser). Seeing `eyJ...` there is not a leak; a `service_role` key would be. `process.env.SUPABASE_SERVICE_KEY` hits are names only. The local `SUPABASE_SERVICE_KEY` is blank (Sensitive), so DB seeds were loaded via the Supabase MCP `execute_sql` in ~20 KB batches.
- Backups of `index.html` before big passes live next to it as `index.html.bak-pre-<feature>-<date>` (e.g. `bak-pre-cleanup-20260911`, `bak-pre-mgrperms-20260912-130842`, `bak-pre-briateams-*`, `bak-pre-egress-20260930-122650`, `bak-pre-payfreeze-*`, `bak-pre-flagsremoval-*`).

## Supabase projects

- **Grow Sales DB:** project ref `cmkfohwbejcztctrpdnt` (anon URL + key at the top of `index.html`; most tables have anon read). Free plan; see dashboard-app.md for the egress fix.
- **New Bria (read only):** `oofisagqyhfcpmfmcjwt` (see data-sources.md).
- **Wolf Office:** `hydnqquciomyfuntavhr` (rebuilt Oct 1 2026, see wolfoffice.md).
- Grow schema `backup` holds dated snapshots (`*_20260911` Bria tables, `upfront_paid_20260917`), anon revoked.

## Local testing

- The app sits behind a sign-in gate, so local previews stop at sign-in. Options used: stub an access session in localStorage (older: `growCorpAuth` `{name,code,at}`), serve with `python3 -m http.server` from `GrowSales/`, or lift functions into a Node harness. `.claude/launch.json` must serve the real directory.
- Browsers serve cached `index.html`; add `&cb=<n>` or you test the old build.
- Browser-pane screenshots go blank when hidden; verify via DOM text.
- Old Mac constraints (8 GB RAM, Desktop on iCloud) caused folder-picker hangs and 0-byte "dataless" files; keep the repo out of iCloud-synced folders on the new machine.
- **New Mac (Oct 2026):** `bash scripts/install-all-agents.sh` installs the GrowSales launchd agents and the WolfOffice workers together (see syncs-and-schedules.md for the live list). Unloaded plists are parked in `~/Library/LaunchAgents/disabled-grow/`, not deleted.
- **Retired API files** live in `GrowSales/backups/api-retired-20261014/` (`sync-watchdog.js`, `weekly-summary.js`, `vapid-public-key.js`, `_notify.js`); two live syncs still require `_notify.js` (see syncs-and-schedules.md). `vercel.json` crons list only bria-sync, sequifi-sync, sequifi-teams-sync.
- Extra pages copied by build.sh since Oct 2026: `sources.js`, `money.html`, `quiz.html`, `calculator.html`, `maps/reps.html`, `maps/view.html`.
- State on Oct 21 2026: 20 modified and 5 deleted files uncommitted on main (the deletions of ask / pronto / push endpoints are intentional); prod matches disk, not git.
