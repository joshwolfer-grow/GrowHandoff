# WolfOffice (Grow-related parts only)

`WolfOffice/` is a local "office" web app plus launchd workers that the previous owner ran on his Mac. It also held personal workers (insurance, trading, personal, a texting assistant); those are out of scope for Grow and are disabled. Only the Grow side matters for the handoff.

## State as of Oct 1 2026

- The old WolfOffice Supabase project (`leryygruqanxjopwcqbd`) was deleted (410 then NXDOMAIN, Sep 30 2026 ~21:45 UTC); all its history was lost (no backup). The Grow Sales DB was untouched.
- Rebuilt Oct 1 2026 as Supabase project "Wolf Office" `hydnqquciomyfuntavhr` (us-west-1, same org as Grow Sales, free): **Grow only**, tables `office_agents`, `events`, `tasks`, `snapshots`; 22 Grow agents seeded (roles/sprites partly reconstructed). The service key must be pasted by a human (MCP can't read secret keys). Old env saved as `WolfOffice/.env.bak-20261001-deleted-project`.
- Non-Grow launchd plists were moved to `~/Library/LaunchAgents/disabled-wolfoffice/` (not deleted). Don't recreate non-Grow tables or re-enable those jobs.

## Grow workers

| Worker | Schedule | What |
|---|---|---|
| `mgrcards` | daily 09:00 (launchd) | runs `GrowSales/scripts/daily-report-text.mjs --scheduled --send`; manager card PNGs texted to `Daily Report: <Manager>` Messages groups (see outbound-comms.md) |
| `com.wolfoffice.slots-tds` | 6:30, 11:30, 15:30 | `WolfOffice/workers/grow/slots.mjs tds` → spawns `GrowSales/scripts/install-slots.mjs` (earliest TDS install dates → `install_slots`) |
| `com.wolfoffice.slots-surf` | :45 | same for Surf |

Logs: `~/Library/Logs/wolfoffice/slots-*.log`. Slot runners were only installed Sep 24 2026 10:09, so the Install Slots page sat a day stale before that.

The office site itself: launchd `com.wolfoffice.site`, serving 127.0.0.1:8787 from `WolfOffice/`. It has a Grow tab/desk cards by team (plain desk cards, one deep blue, thin lines, 14px monospace; no theatre). Restart: `launchctl kickstart -k gui/$(id -u)/com.wolfoffice.site`. Test changes first on `OFFICE_PORT=8799`. `GROW_DIR=<path>` points workers at a GrowSales checkout; `LEADDESK_QUIET=1` keeps a sandbox from touching real Drive folders. A "Lead desk" worker was landed Sep 21 2026 via `bin/land-leaddesk.py`; its sandbox flags (`GROW_DIR`, `LEADDESK_QUIET`) show it touches GrowSales and real Drive folders, but its exact job isn't recorded. Read its code before re-enabling.

## Working on WolfOffice

- The live office is the main checkout's UNCOMMITTED working tree (far ahead of any commit, as of Sep 21 2026). Git worktrees don't contain it. Run `git -C WolfOffice status` first and edit the main tree directly; sessions leave `.bak-YYYYMMDD` copies.
- From a worktree session the harness refuses Write/Edit on the base checkout: write self-contained new files, keep edits to existing live files to a few anchored one-liners in an idempotent landing script that makes `.bak-YYYYMMDD-<feature>` copies and stops if an anchor isn't found exactly once (`bin/land-leaddesk.py` is the model), prove it on an rsynced sandbox copy booted with `OFFICE_PORT=8799`, then hand over one command.
- Stop sandbox servers by port (`lsof -ti tcp:8799 | xargs kill`), never `pkill -f office-serve` (kills the live server too).
- Workers that shell out to `claude -p` fail silently if the terminal `claude` CLI is "Not logged in"; check `claude -p hi` with `CLAUDE*`/`ANTHROPIC_*` env vars unset.
- The harness denied `launchctl load` / install-workers from a session (a human runs it) but allowed `launchctl kickstart -k` of the site.
- Background launchd jobs hit macOS automation permission errors (-1743) on System Events; anything that needs Messages UI must run from Terminal (see outbound-comms.md).
- Note: the previous owner had decided to transition out of Grow; the office metaphor was kept for Grow only.
