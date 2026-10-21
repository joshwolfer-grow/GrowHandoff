# WolfOffice (Grow-related parts only)

`WolfOffice/` is a local "office" web app plus launchd workers that the previous owner ran on his Mac. It also held personal workers (insurance, trading, personal, a texting assistant); those are out of scope for Grow and are disabled. Only the Grow side matters for the handoff.

## State as of Oct 14 to 21 2026 (current)

- **The office site is retired.** `com.wolfoffice.site` is unloaded (plist in `~/Library/LaunchAgents/disabled-grow/`), `site/index.html` and `flow.js` deleted. Its replacement is **More > Admin > Sources in GrowSales** (`GrowSales/sources.js`, loaded by index.html, copied by build.sh): the pathway graph of every job with Run now / Fix / Show log / Restart / Pause per node.
- **Office tables moved into the Grow Sales Supabase project** (`cmkfohwbejcztctrpdnt`) as `office_agents`, `office_events`, `office_snapshots`, `office_tasks` with anon read + write policies. The "Wolf Office" project `hydnqquciomyfuntavhr` from Oct 1 is no longer what the workers use (the service-key paste is moot). `WolfOffice/lib/env.mjs` now reads the Grow anon key out of `index.html`.
- **Workers still run from `~/WolfOffice`**: `workers/grow`, chief, runner; `site/help.js` FACTS hold the run commands. `com.wolfoffice.runner-grow` (60s) executes queued `office_tasks` rows and writes the result on the row. Pause: Grow crawlers use the shared `__paused__` flag by board key (sr, tds, rtr, isp, slots_tds, slots_surf); every other worker is `wo_<agent>`, checked by `~/bin/office-wrap`. Chief skips paused workers.
- `office_agents` names are plain job names (SalesRabbit crawl, Portal syncs, Morning brief, Task queue...). Non-Grow floors, `payaudit` and `mgrcards` were removed Oct 14 (mgrcards had been failing since Sep 25 because its access code was no longer in `access_codes`).
- Loaded workers on Oct 21: runner-grow 60s, chief-grow 08:00, analyst 07:30, installs 07:35, chaser 07:40, isp-i3/slic/lyte/surf/tds/ezee/omni 07:15 to 07:27, sales-lead 07:50, slots-tds 6:30/11:30/15:30, slots-surf 6:45/11:45/15:45. Install everything on a new Mac with `GrowSales/scripts/install-all-agents.sh`.
- Oct 14 fixes: `install-slots.mjs` failure rows now share keys with success rows (PGRST102 had been dropping every TDS run that had one failed market since Sep 24); `bria_deals` got `(sale_date)` and `(isp, sale_date)` indexes because the isp-* workers hit the 3s anon statement timeout.
- **Adding a job** = NODES/EDGES + SRC_FACTS in `sources.js`, FACTS in `~/WolfOffice/site/help.js`, a row in `office_agents`, and `workers.json` + `bin/install-workers.sh` for the schedule.
- **Oct 14 incident:** a Playwright verify loop from another session fired ~38k requests in 10 minutes and hung the Supabase project for 20 minutes (the owner restarted it from the dashboard). Never loop on sign-in state against production.

## State as of Oct 1 2026 (historical)

- The old WolfOffice Supabase project (`leryygruqanxjopwcqbd`) was deleted (410 then NXDOMAIN, Sep 30 2026 ~21:45 UTC); all its history was lost (no backup). The Grow Sales DB was untouched.
- Rebuilt Oct 1 2026 as Supabase project "Wolf Office" `hydnqquciomyfuntavhr` (us-west-1, same org as Grow Sales, free): **Grow only**, tables `office_agents`, `events`, `tasks`, `snapshots`; 22 Grow agents seeded (roles/sprites partly reconstructed). The service key must be pasted by a human (MCP can't read secret keys). Old env saved as `WolfOffice/.env.bak-20261001-deleted-project`.
- Non-Grow launchd plists were moved to `~/Library/LaunchAgents/disabled-wolfoffice/` (not deleted). Don't recreate non-Grow tables or re-enable those jobs.

## Grow workers

| Worker | Schedule | What |
|---|---|---|
| `mgrcards` (UNLOADED Oct 14 2026) | was daily 09:00 (launchd) | ran `GrowSales/scripts/daily-report-text.mjs --scheduled --send`; manager card PNGs texted to `Daily Report: <Manager>` Messages groups (see outbound-comms.md). Failed since Sep 25 (stale access code), no groups existed |
| `com.wolfoffice.slots-tds` | 6:30, 11:30, 15:30 | `WolfOffice/workers/grow/slots.mjs tds` → spawns `GrowSales/scripts/install-slots.mjs` (earliest TDS install dates → `install_slots`) |
| `com.wolfoffice.slots-surf` | :45 | same for Surf |

Logs: `~/Library/Logs/wolfoffice/slots-*.log`. Slot runners were only installed Sep 24 2026 10:09, so the Install Slots page sat a day stale before that.

The office site itself (RETIRED Oct 14 2026; kept for reading old code): launchd `com.wolfoffice.site`, serving 127.0.0.1:8787 from `WolfOffice/`. It has a Grow tab/desk cards by team (plain desk cards, one deep blue, thin lines, 14px monospace; no theatre). Restart: `launchctl kickstart -k gui/$(id -u)/com.wolfoffice.site`. Test changes first on `OFFICE_PORT=8799`. `GROW_DIR=<path>` points workers at a GrowSales checkout; `LEADDESK_QUIET=1` keeps a sandbox from touching real Drive folders. A "Lead desk" worker was landed Sep 21 2026 via `bin/land-leaddesk.py`; its sandbox flags (`GROW_DIR`, `LEADDESK_QUIET`) show it touches GrowSales and real Drive folders, but its exact job isn't recorded. Read its code before re-enabling.

## Working on WolfOffice

- The live office is the main checkout's UNCOMMITTED working tree (far ahead of any commit, as of Sep 21 2026). Git worktrees don't contain it. Run `git -C WolfOffice status` first and edit the main tree directly; sessions leave `.bak-YYYYMMDD` copies.
- From a worktree session the harness refuses Write/Edit on the base checkout: write self-contained new files, keep edits to existing live files to a few anchored one-liners in an idempotent landing script that makes `.bak-YYYYMMDD-<feature>` copies and stops if an anchor isn't found exactly once (`bin/land-leaddesk.py` is the model), prove it on an rsynced sandbox copy booted with `OFFICE_PORT=8799`, then hand over one command.
- Stop sandbox servers by port (`lsof -ti tcp:8799 | xargs kill`), never `pkill -f office-serve` (kills the live server too).
- Workers that shell out to `claude -p` fail silently if the terminal `claude` CLI is "Not logged in"; check `claude -p hi` with `CLAUDE*`/`ANTHROPIC_*` env vars unset.
- The harness denied `launchctl load` / install-workers from a session (a human runs it) but allowed `launchctl kickstart -k` of the site.
- Background launchd jobs hit macOS automation permission errors (-1743) on System Events; anything that needs Messages UI must run from Terminal (see outbound-comms.md).
- Note: the previous owner had decided to transition out of Grow; the office metaphor was kept for Grow only.
