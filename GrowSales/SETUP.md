# Setting this up on a new Mac

(Aug 2026 runbook. The current one is `../bootstrap.sh` + `../HANDOFF.md`; this page is kept for the explanations.)

Everything the dashboard shows comes from scrapers that run on **one Mac**
via launchd. The Vercel side (the dashboard itself and everything under `api/`)
is not tied to a machine and needs nothing from you when you switch laptops.

So a laptop move is really three jobs: get the repo, put the secrets back, and
re-seed the logins the scrapers hold in browser profiles.

---

## 1. Repo

```bash
git clone https://github.com/joshwolfer-grow/growsales.git
cd growsales
npm install
```

## 2. Secrets — the part git cannot do for you

`.env.local` is **deliberately not in git** and is required by the scripts in
`scripts/`. Copy it from the old machine (or your password manager):

```bash
scp oldmac:~/Grow/GrowSales/.env.local .
```

The `api/` functions do **not** read this file — their env vars live in the
Vercel project settings and survive the move untouched. If you ever need to see
which names the code expects:

```bash
grep -rhoE "process\.env\.[A-Z_]+" api/ scripts/ | sort -u
```

Also not in git, for the same reason, and worth copying across if you want the
syncs working immediately rather than after a re-login:

| Path | What it is |
|---|---|
| `data/sr-auth.json` | live SalesRabbit bearer token |
| `data/salesrabbit-lead-endpoint.json` | same token, endpoint probe |
| `.rtr-profile*/` | Chrome profiles holding the Opendoor SSO session |
| `.amplify-profile*/` | Chrome profile for Amplify |

Everything else under `data/` is either regenerated or was never needed —
`.gitignore` allowlists the handful of config files that *are* tracked
(`isps.json`, `rtr-sources.json`, `amplify-sources.json`, `sr-lookups.json`;
`terros-reps.json` is leftover from the retired Terros import).

## 3. The scrapers

```bash
bash scripts/install-all-agents.sh
```

That rewrites the launchd plists for this machine's repo path and node install,
then loads them. It is safe to re-run any time. `--list` shows what is loaded,
`--remove` takes them back off.

Then seed the three logins, once each. Each opens a real browser window:

```bash
node scripts/grow-sync.mjs --seed                        # SalesRabbit
node scripts/rtr-sync.mjs --login                        # Opendoor (SSO)
node scripts/amplify-company-sync.mjs --source tds --login
```

## 4. Check it worked

Open the dashboard → **Admin › Ops**. The **Automations** board at the top is the
whole answer: one row per pipeline, green when it has run recently. A red row
names the command that fixes it. (The board now lives at More > Admin.)

| Row | Runs | Notes |
|---|---|---|
| SalesRabbit knock sync | every 10 min | doors, contacts, dispositions |
| Opendoor hours (RTR) | hourly, 8am–10pm | clock hours; exit 3 = SSO expired |
| TDS Amplify sync | every 10 min | separate company, separate login |
| ISP export, ISP intake, Ezee addresses | daily / 5 min / daily | see `../docs/knowledge/syncs-and-schedules.md` |

Give it 10–15 minutes after seeding before judging the board — the interval
agents have to tick once.

---

## Things that will bite you

**launchd has no shell.** No `$HOME`, no `~`, no profile, no nvm. That is the
entire reason `install-agents.sh` exists: the plists in `scripts/launchd/` carry
absolute paths, and hand-copying them to a machine with a different username or
node version produces agents that fail silently forever. Always install through
the script.

**The Mac has to be awake to sync.** `StartInterval` agents coalesce whatever
they slept through into one catch-up run on wake, so a closed lid costs freshness
but never data. If numbers look stale, check the machine was actually on.

**Sessions expire without warning.** Opendoor SSO and the Amplify profile both
die on their own schedule. Both surface as a red row on the Automations board and
a macOS notification naming the re-login command. Nothing else tells you.

**Vercel deploys the working directory, not git.** `vercel --prod` ships whatever
is in the folder, including uncommitted edits. Commit first so what is live and
what is in git are the same thing.
