---
name: sequifi-roster-check
description: Checks a pasted weekly door-to-door sales schedule against live Sequifi users and reports who is missing or has a name spelling mismatch. Use this skill whenever the user pastes a schedule grid (names with annotations like "(c)", "(k)", day ranges, section headers like SUMMER/BLITZ) and wants to know who isn't in Sequifi yet. Also triggers when user says things like "find who's not in Sequifi", "check the roster", "who's missing from Sequifi", or "run the roster check". Always use this skill for that workflow — don't try to do it manually.
---

# Sequifi Roster Check

## What this skill does

Given a pasted weekly schedule (tab/newline grid with names like `Caleb Trapp (c)`, `Kiefer Neal (k) Wed-Sun 1`, section headers like `SUMMER`, `BLITZ`, `closed`), this skill:

1. Extracts every clean name from the schedule
2. Fetches all active users from the Sequifi API
3. Fuzzy-matches to split results into:
   - **Truly missing** — no close match found in Sequifi (need to be onboarded)
   - **Name variants** — person exists but spelled differently on the schedule vs Sequifi
4. Outputs a clear, actionable report

## Step-by-step instructions

### 1. Save the schedule to a temp file

Ask the user to paste their schedule if they haven't already. Then write the full pasted text to `/tmp/sequifi_schedule.txt`.

### 2. Run the bundled script

The script lives at `scripts/check_roster.py` relative to this skill. Run it:

```bash
python3 <skill_dir>/scripts/check_roster.py \
  --schedule /tmp/sequifi_schedule.txt \
  --token ~/Grow/GrowSales/data/.sequifi-token
```

The script will:
- Read the token from `data/.sequifi-token` (gitignored; same Sequifi API token as the Vercel SEQUIFI_TOKEN) (strips all whitespace)
- Fetch all users from `https://marketplace-api.sequifi.com/v1/users` (paginates automatically)
- Extract clean names from the schedule (strips annotations, day ranges, section headers, placeholders)
- Fuzzy-match each schedule name against Sequifi names (difflib, cutoff 0.78)
- Print a formatted report

### 3. Present the report to the user

The script prints two sections:
- **NAME VARIANTS** — schedule spelling → Sequifi spelling (the person exists, names just differ)
- **TRULY MISSING** — no close match found (these people need to be added to Sequifi)

After showing the output, briefly note the count of each group and ask if the user wants to take any action (e.g., create missing users, or note the variants for data cleanup).

## What gets stripped from schedule names

The script removes:
- Parenthetical tags: `(c)`, `(k)`, `(L)`, `(d)`, `(n)`, `(g)`, `(m)`, `(w)`, etc.
- Day/date ranges: `Mon-Thurs`, `Wed - Sun`, `Tues-Sun`, `Thur-Sun`
- Trailing numbers: ` 1`, ` 2`, ` 3`
- Trailing ` -` markers
- Section headers: `SUMMER`, `BLITZ`, `SPRING`, `FALL`, `WINTER`, `First Week`, `Open`, `closed`
- Placeholder entries: `Rep 1`, `Rep 2`, anything without a recognizable last name

## Token handling

If the API returns 401, tell the user their token in `~/Grow/GrowSales/data/.sequifi-token` may be expired and ask them to provide a fresh curl command with a valid bearer token so you can update the file.

## Output format

Always present the report in this structure:

```
============================================================
NAME VARIANTS (N people — in Sequifi but spelled differently)
============================================================
  Schedule: "Ben Ogara"    →  Sequifi: "Benjamin Ogara"
  Schedule: "Chris Lagrange"  →  Sequifi: "Christopher Lagrange"
  ...

============================================================
TRULY MISSING FROM SEQUIFI (N people)
============================================================
  Brandon Romain
  Caden Giles
  ...
```

End with a one-line summary: e.g., "**23 people need to be added to Sequifi; 17 are already there under a different name.**"
