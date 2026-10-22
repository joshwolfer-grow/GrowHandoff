# Taking over Grow ops

You are inheriting the dashboard at growsales.vercel.app, the scripts that keep
its data fresh, and the routines around ISP lead files, knocking reports, pay
and meetings. You do not need to read code to run it. Claude Code does the
heavy lifting, and everything it needs to know is in this repo.

**Read `PROCESSES.md` first.** It is the one-page process handoff (what runs where, your weekly calendar, a runbook per process, what is broken as of Oct 21 2026). This page is the machine setup that follows it.

## The fastest path

1. Get a Mac laptop. The scheduled syncs only run on a Mac, and only while it is
   awake, so leave it plugged in and open on weekdays (System Settings > Battery:
   prevent sleep when the display is off, on power adapter).
2. Install **Claude Code** (desktop app or `npm i -g @anthropic-ai/claude-code`).
3. Clone this repo **into `~/Grow`** (the exact folder matters):

       git clone https://github.com/joshwolfer-grow/GrowHandoff.git ~/Grow

4. Open Claude Code in `~/Grow` and say: **"Set me up. Follow HANDOFF.md."**
   It will run `bootstrap.sh` step by step and tell you what it needs from you.

The rest of this page is what Claude will walk you through, so you know what
to expect.

## What you need from the previous owner (or your admin)

- Access to the company **password manager vault** with the Grow secrets
- **Owner** on the Supabase org and the Vercel team; admin on the GitHub repo
- Membership on the Google shared drive **"Grow - Corporate"**, with
  **Google Drive for Desktop** installed and signed in
- Your own logins for: SalesRabbit (main tenant + TDS tenant), Amplify (TDS),
  the Opendoor / Realtime Results portal for Ezee, Bluepeak and Omni, Sequifi
  (admin), Canva team, and Surf (only if install slots are kept)
- The data archive `grow-data-<date>.tar.gz` (AirDrop or a restricted Drive link)
- A Gmail app password for the mailbox that sends login codes and crawler
  failure emails

## Setup, step by step

| Step | Command | What it does |
|---|---|---|
| 1 | `bash bootstrap.sh check` | Lists missing tools: Xcode tools, node 20 (via nvm), Python 3.10+, Chrome, Drive for Desktop, Vercel CLI |
| 2 | `bash bootstrap.sh install` | npm + pip packages, links the Grow skills into Claude, creates empty `.env` files |
| 3 | fill in secrets | Copy values from the vault. `GrowSales/.env.example` says which name goes in which file |
| 4 | `bash bootstrap.sh data <archive>` | Unpacks the crawl store and state files (~2 GB) |
| 5 | `bash bootstrap.sh logins` | Prints the sign-in commands. Each opens Chrome; sign in with **your** account |
| 6 | `bash bootstrap.sh jobs` | Installs the 6 scheduled jobs (below) plus the 3 task bots |
| 7 | `bash bootstrap.sh verify` | Health check. Then watch the dashboard health board (More > Admin) turn green over a day |

macOS will ask for permissions the first time some jobs run (Files and Folders,
Full Disk Access, Automation). Say yes for bash, node, python3 and Terminal.

## What runs by itself

**On Vercel** (no laptop needed): `bria-sync` (Bria sales), `sequifi-sync`
(Sequifi user mirror), `sequifi-teams-sync` (weekly teams). Schedules in
`GrowSales/vercel.json`. Deals come hourly from the Rep Sales Google Sheet's
Apps Script, not from Vercel.

**On your Mac** (launchd; `bash GrowSales/scripts/install-all-agents.sh --list`):

| Job | When | Does |
|---|---|---|
| com.grow.sr-sync | every 10 min 11:00 to 22:00, every 2 h overnight | SalesRabbit knock crawl → `knocking` |
| com.grow.amplify-sync | same | TDS knocks from Amplify |
| com.grow.rtr-sync | same, 08:00 to 23:00 | Ezee / Bluepeak / Omni knocks and hours from Opendoor |
| com.grow.isp-export | hourly, first run after 07:00 does the work | ISP knocking workbooks onto the shared drive, sector maps |
| com.grow.isp-intake | every 5 min | Archives new lead files dropped in `GrowSales/imports/isp/` to Drive and parks them for review |
| com.grow.ezee-addresses | hourly, first run after 07:00 does the work | Ezee-spelled address list → `ezee_addresses` → the "Ezee Addresses" Sheet |

Plus the three **task bots** from `~/WolfOffice` (`runner-grow` executes
Run / Fix / Restart from More > Admin > Sources; `slots-tds` and `slots-surf`
feed Install Slots). See `docs/knowledge/task-bots.md`.

## What still needs a person

Ask Claude for any of these in plain words. The skill or knowledge file it will
use is in brackets.

**When a file arrives**
- An ISP sends a lead or sector spreadsheet: drop it in `GrowSales/imports/isp/`
  (or it is already parked in `imports/isp/parked`) and say "process the parked
  file from i3" (isp-leads skill). Claude builds **one** SalesRabbit CSV per
  workbook; you upload it to SalesRabbit by hand. Then the sector map: "add
  these to the map".
- An ISP cancel list: cancel-list-import skill.
- An ISP deal list to verify by phone: dealcheck-import skill.
- A leads export to clean: leads-dedup skill.

**Weekly**
- **Upfront pay**: pay week runs Thu to Wed, processed Thursday, paid Friday
  (`docs/knowledge/pay-and-payroll.md`).
- **Manager meeting**: the Monday Canva deck
  (`docs/knowledge/meetings-and-decks.md`).
- **Bonus review**: KPI Bonus lens (`docs/knowledge/metrics-definitions.md`).

**Every ~60 days**: the Sequifi token expires (the Vercel sync starts failing
with 401). Mint a new one and update `SEQUIFI_TOKEN` in Vercel and
`GrowSales/data/.sequifi-token`.

## When something breaks

1. Dashboard > More > Admin > health board. A red row names the source and the
   command that fixes it. Most common: a login expired, so re-run its line from
   `bash bootstrap.sh logins`.
2. Logs are in `GrowSales/imports/done/*.log`.
3. Ask Claude: "the SalesRabbit sync is red, figure out why". It knows to read
   `docs/knowledge/gotchas.md` and `syncs-and-schedules.md` first.
4. Open problems as of the handoff are in `docs/knowledge/open-items.md`.

## Deploying a dashboard change

    cd ~/Grow/GrowSales && vercel --prod

Commit and push first: the deploy ships whatever is on disk.
