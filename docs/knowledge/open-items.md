# Open items (as of Oct 21 2026, the owner's last day)

Verify against the code, the database and the live site before acting; dates are when each item was last confirmed.

## Open

- **17 ISP files sit in `GrowSales/imports/isp/parked/`** waiting for a human review via the isp-leads skill (the intake watcher only archives and parks). Several may already have been imported by hand; check Drive `SalesRabbit Leads/<ISP>/Imports/` before building. New lead files now arrive by hand into `imports/isp/` (the mailbox watcher was retired Oct 21 2026).
- **TDS Amplify login expired Oct 5 2026**; `com.grow.amplify-sync` is paused on the board (`__paused__` key `tds`). Fix: `node scripts/amplify-company-sync.mjs --source tds --login` (opens a signed-in window, warn first), then Resume in the Live badge popover or the Sources page.
- **Cancel Center Texts tab deliberately not built** until a Twilio number with an approved 10DLC campaign exists (mockup only).
- **Install availability bots** (Install Slots): only TDS and Surf live; i3 (VPN), SLIC (Inservio), Omni, Bluepeak, Ezee blocked on ISP permission; Lyte impossible (schedule after payment). Alternative: derive from the deals feed (install date minus sale date).
- **Meeting deck script `scripts/meeting-deck-stats.py` hardcodes teams** in its `T` dict. The Monday Canva deck is kept; since Oct 6 the numbers have been pulled with one SQL from `__bria_teams__` (recipe in meetings-and-decks.md), so either refresh the dict weekly or keep using the SQL.

## Fixed Oct 21 2026

`_notify.js` stubbed in `sequifi-sync.js` / `sequifi-teams-sync.js`; the 2 unlabeled Ezee SalesRabbit import batches labeled (isp-export green again); GrowSales committed and deployed (prod = git); the 3.3 GB `data/*.pre-*` store copies and old `.bak` files deleted. The same day the owner retired the mailbox watcher, rep GPS sync and Rep Map, the morning brief task bots, the Master Manager Pay / Blitz Sign Up Apps Scripts, the Meeting board, Standards, Recruiting, Roster paste, the weekly rep email, the training pages, the merch tool, the weekly subs paste, the Sequifi roster check, Terros and Time Track imports and the training video pipeline; those are noted as "retired Oct 21 2026" in the topic files where history needs them.
