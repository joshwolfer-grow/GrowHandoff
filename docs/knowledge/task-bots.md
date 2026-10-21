# Task bots (the Mac-side runners behind Sources and Install Slots)

Three small launchd jobs on the Mac that GrowSales depends on. They live in the `~/WolfOffice` folder on the owner's Mac (its old name; the folder also holds the retired "office" site and the brief workers, see below). Only these three matter:

| Job | Schedule | What |
|---|---|---|
| `com.wolfoffice.runner-grow` | every 60s | executes `office_tasks` rows queued by **More > Admin > Sources** (Run now / Fix / Restart) and writes the result back on the row |
| `com.wolfoffice.slots-tds` | 6:30, 11:30, 15:30 | `workers/grow/slots.mjs tds` → spawns `GrowSales/scripts/install-slots.mjs` (earliest TDS install dates → `install_slots`) |
| `com.wolfoffice.slots-surf` | 6:45, 11:45, 15:45 | same for Surf |

Install them on a new Mac with `GrowSales/scripts/install-all-agents.sh` (installs the GrowSales agents and these three together). Logs: `~/Library/Logs/wolfoffice/*.log`.

## How they plug into GrowSales (Oct 14 2026)

- **More > Admin > Sources** (`GrowSales/sources.js`, loaded by index.html, copied by build.sh) is the pathway graph of every job with Run now / Fix / Show log / Restart / Pause per node. It reads `office_agents`, `office_events`, `office_snapshots`, `office_tasks`, which live in the **Grow Sales Supabase project** (`cmkfohwbejcztctrpdnt`) with anon read + write policies. The old "Wolf Office" project `hydnqquciomyfuntavhr` (Oct 1) is unused; `WolfOffice/lib/env.mjs` reads the Grow anon key out of `index.html`.
- Pause: Grow crawlers use the shared `__paused__` flag by board key (`sr`, `tds`, `rtr`, `isp`, `slots_tds`, `slots_surf`); `~/bin/office-wrap` checks the flag before a bot runs.
- `office_agents` names are plain job names (SalesRabbit crawl, Portal syncs, Task queue...).
- **Adding a job** = NODES/EDGES + SRC_FACTS in `sources.js`, a row in `office_agents`, and `workers.json` + `bin/install-workers.sh` in `~/WolfOffice` for the schedule.
- Oct 14 fixes: `install-slots.mjs` failure rows now share keys with success rows (PGRST102 had been dropping every TDS run that had one failed market since Sep 24); `bria_deals` got `(sale_date)` and `(isp, sale_date)` indexes.
- **Oct 14 incident:** a Playwright verify loop from another session fired ~38k requests in 10 minutes and hung the Supabase project for 20 minutes (the owner restarted it from the dashboard). Never loop on sign-in state against production.
- Slot runners were only installed Sep 24 2026, so the Install Slots page sat a day stale before that.

## Retired (Oct 2026)

- **Brief workers, retired Oct 21 2026:** `analyst`, `installs`, `chaser`, `sales-lead`, `chief-grow`, `isp-i3/slic/lyte/surf/tds/ezee/omni` (the 07:15 to 08:00 morning snapshots). `bash handoff/retire-2026-10-21.sh` unloads them and parks the plists in `~/Library/LaunchAgents/disabled-grow/`. Nothing in GrowSales reads their output.
- **mgrcards** (9 AM manager card texts) and `payaudit`: unloaded Oct 14 2026 (see outbound-comms.md).
- **The office site** (`com.wolfoffice.site`, 127.0.0.1:8787): retired Oct 14 2026, replaced by Sources. Its code is still in the folder for reading only.
- Personal (non-Grow) workers were disabled before Oct 1 2026 (plists in `~/Library/LaunchAgents/disabled-wolfoffice/`). Don't recreate non-Grow tables or re-enable those jobs.
- History: the first office Supabase project (`leryygruqanxjopwcqbd`) was deleted Sep 30 2026 with no backup; the Grow Sales DB was untouched.

## Working in the `~/WolfOffice` folder

- It is the main checkout's UNCOMMITTED working tree; worktrees don't contain it. Run `git -C WolfOffice status` first and edit the main tree directly.
- Workers that shell out to `claude -p` fail silently if the terminal `claude` CLI is "Not logged in"; check `claude -p hi` with `CLAUDE*`/`ANTHROPIC_*` env vars unset.
- The harness denied `launchctl load` / install-workers from a session (a human runs it).
- Background launchd jobs hit macOS automation permission errors (-1743) on System Events; anything that needs Messages UI must run from Terminal.
