# Lead desk (2026-09-21)

The Courier's card opens `/leads.html`: parked ISP files on the left, the chosen file's columns on the right. Pick the rep, build, upload the csv to SalesRabbit yourself. No Claude Code session.

**Where AI is used.** Only to name the columns of a layout the desk has not built before. The first 9 rows of each unknown sheet go to Haiku through the logged-in `claude` CLI (`claude -p --model haiku --tools ""`), once. A layout that builds a real import is saved in `state/leaddesk-formats.json` under its header row, so the same layout never costs tokens again. The quoted email beside a mail-pulled file is shown to you and never sent to the model. If the CLI is not logged in (`claude` then `/login` in a terminal), the desk matches on column names, says so, and you fix any column with the dropdowns.

**What it runs.** `workers/grow/leaddesk.py normalize` rewrites every ticked sheet into one workbook with the headers `lead-import.py` always understands (Address, Street Number, Unit, City, State, Zip, Latitude, Longitude, Sector, Status, Customer), stacking sheets and splitting one-cell addresses. Then GrowSales' own `scripts/isp-intake.py` does what it always did: ISP, Drive archive, dedupe against the crawl, batch name, csv in `imports/isp/ready`. Sector goes to Notes (`--notes-from Sector`), a status column is honoured (`--status-from Status`), and "fill blank zips from the city" is `--fill-zip-from-city`. `isp-intake.py` forwards those three flags to `lead-import.py`; `bin/land-leaddesk.py` adds that pass-through.

**After a build.** The original moves from `parked/` to `done/` with its `.ask.txt`. The normalized copy is what gets archived to the ISP's `Raw/` folder beside the original the watcher archived. Read the output for a `DROPPED` block before uploading; the page repeats it in bold.

**From a terminal.** `node workers/grow/leaddesk.mjs list | inspect "<file>" | build "<file>" --rep "Nick Boyd" [--isp SLIC] [--fill-zip]`.

Sandbox: `GROW_DIR=<fake GrowSales> LEADDESK_FORMATS=<file> LEADDESK_QUIET=1 OFFICE_PORT=8799 node bin/office-serve.mjs`.
