# Teams, roster, subs and rep identity

## Current state (Oct 1 2026)

**Teams come from Bria, everywhere** (owner's choice Sep 29 2026), read from `report_config.__bria_teams__` (same shape as the old `__sequifi_teams__`). Readers: `index.html`, `api/weekly-rep-email.js`, `api/schedule.js`. Rollback = point those readers back at `__sequifi_teams__` (backup `index.html.bak-pre-briateams-*`). The email-login leader check (`app-auth.sql`, `login_role_for()`) still uses Sequifi on purpose.

How `api/bria-sync.js` builds it (`buildBriaRoster`):
1. **Blitz group that week** (real weekly management crews): Bria `learning_groups` (`trainer_id` = the MANAGER, `start_date`/`end_date` = the week, `primary_course_id` → `teams.guide_course_id` = market) + `learning_group_assignments` (`user_id`). Grant landed Sep 30 2026. Coverage was partial (4 crews on Sep 27) until managers build their groups.
2. Nearest blitz group 3 weeks back / 2 ahead.
3. Bria **market team** from sales: rep-week team = team with most Bria sales that week; current week adds membership-team reps (membership fill-in only for reps with no Bria sale in the last 3 weeks). Bria teams are MARKETS (22: Houston/Ezee, Illinois/i3, East Texas/Lyte, Pennsylvania/Glo...), not crews; Bria has no manager field.
- A sale is moved to the Bria team carrying its ISP when its `team_id` doesn't (Pennsylvania/Glo team had 66 Ezee sales). Ezee and Omni (two teams each) split by the rep's usual team for that ISP.
- Starts 2026-05-03 (pre-cutover rows have no team). `config.market_teams` lists non-person keys (client reads into `_BRIA_TEAM_NAMES`); `_teamKeyIsPerson()` stops "Houston" being treated as a selling leader; `_leaderTeam()` maps a manager login to the Bria team they sell under.
- Raw tables `bria_teams`, `bria_memberships`, `bria_deals.team_id` (`api/bria-teams.sql`).
- Manager-named config (goals scopes, `__meeting_teams__` labels/folds, `team_of`) was keyed on Sequifi manager names and may not match market names.

**No Bria team:** the knocking board (and its Bria feed) calls `growIsSub(rep,week,true)` → team "Unassigned", visible (owner Sep 30: "I didn't say to hide them, just cluster them in an unassigned bucket"). Only an explicit `rep_flags` sub mark hides.

## Who is a sub

- **From week 2026-09-27 (`SUBS_LIST_START`) on: only `rep_flags` `roster_status='sub'` makes a sub, anywhere (KPI, PRA, pay).** No Bria team ≠ sub. Earlier weeks keep the old rule (off every team = sub) so past pay numbers don't move. Deployed Oct 1 2026.
- **Weekly subs list** (until Bria separates subs): each week the subs list is pasted into chat (lines like "Thomas Shelton (c) (L)", "James Acharte - GHOST", "(Sun-Thur)", "leaves the 2nd"). Process:
  - Match each name to the EXACT spelling in knocking / deals / bria_sales_daily (`growIsSub` looks up `rep_flags[rep]` by exact, case-sensitive key, e.g. "jaime Butts", "lucas zepeda", "cash Conner"). Ask about any name that does not match confidently.
  - Upsert `rep_flags` with `is_sub=true`, `roster_status='sub'`, `roster_status_by='weekly subs list'`, annotation in `note`.
  - Diff against last week's 'weekly subs list' rows; for anyone dropped ASK whether they left or went internal; never clear silently.
  - The flag is not per week, so it reclassifies the rep's whole history.
  - Anyone NOT on the list is not a sub (owner, Oct 1 2026). Blaise Churba, Jacob Stenberg, Reuben Dodson marked `internal`.
  - Oct 1 2026 first list: 16 marked incl. Dallin Cory (removed him from Bria's East Texas team); Mason Brinks had no data yet.
- `rep_flags.roster_status` ('internal'/'sub'/null) beats every source in both directions; also settable from Rep Cards "Not on a team this week".
- Known subs: Kyle Camp (confirmed, not in Sequifi), Attia Abdelgawad (flagged Aug 27 2026, zero doors, 223 Aug deals), Parker Seng, Sheltons, Corys, Kohen Springer (marked only from 8/02), Finlinson, Paulsen, Escobar, Hernandez, C. Ramirez, Martin Jr Garcia, Ty Mair, McNair, Samaniego. Many subs were never in Sequifi at all (22 of 27 in Jul 2026), so sub revenue in Sequifi-based numbers is unreliable; their sales partly show only in knocking.
- Display: subs bucketed as "Subs", included in company totals with a breakdown; Weeks has the Combined/Internal/Subs lens; KPIs are employees only.

## Rep identity (by email, Sep 29 to 30 2026)

- `rep_identity` (email PK = Sequifi login email, employee_id `grow000xxx`, display_name, alt_emails for SalesRabbit addresses) and `rep_identity_alias` (`name_key = rep_name_key(name)` → email). A trigger stamps `rep_email` on `knocking` and `knock_events`. After editing aliases: `select * from restamp_rep_email();`. Schema `api/rep-identity.sql`; seed `api/rep-identity-seed-2026-09-29.sql` (536 ids, 609 aliases) loaded via MCP `execute_sql`. 95.4% of doors stamped.
- Names not in Sequifi are subs: leave `rep_email` null, don't invent identities. Review list `data/rep-identity-review-2026-09-29.csv`. 9 near matches confirmed (Damien→Damion Anderson, Aspen Johnson→Landon Johnson, Kierfer→Kiefer Neal, ...). Nick Boyd and Quaid Rasmussen have two Sequifi accounts; alias points at the one their SR login uses.
- Never load the Sequifi export's Personal Info sheet (DOB, address, emergency contacts); Basic Info columns only.
- App side (deployed Sep 30): `_loadRepIdentity`; `_canonRowsByEmail` renames deals/knocking/bria rows to one name per email (deal-feed spelling wins; rows are COPIED so `sbFetchCached` keys don't collide); `growRepAlias` checks email first; `growIsSub`/`growInSequifi` use `_rosterHas`; `_authIndex` merges history across a person's spellings. Knocking 468 names → 459 people.

## Name aliases

- `api/_name-aliases.js` (CommonJS, keyed on lowercased "first last") is applied at ingest by `sequifi-sync.js` (`canonicalFirstLast`, `canonicalDisplayName` on manager_name), `bria-sync.js`, `scripts/import-timetrack.mjs`, and mirrored in `index.html` `BRIA_REP_ALIAS`, `api/rep-aliases.sql` / live `rep_aliases` table. Strips `*12345` suffixes.
- **Direction matters: point the alias at the spelling the deal feed already uses**, not the prettier one. `'allison lauriano' → Alli Lauriano` (flipped Sep 10 2026; backwards it split her knocking and imported 25 rep-days twice = 1,471 phantom doors). Chris/Christopher Lagrange had the same problem (42 days, 1,802 phantom doors); twin rows were deleted Sep 14. Conflicting conventions: `_name-clean.mjs` + `_name-aliases.js` + master-pay-sync.gs use "Christopher Lagrange"; roster-import.py and the deals feed use "Chris Lagrange"; `MGR_ALIAS`/`growMgrName` map Chris/Chris Legrange → Christopher Lagrange for manager keys.
- Examples: Samantha Boyd → Sammi Boyd (first, Jul 17 2026), chris legrange → Christopher Lagrange, Kaimana McGuire, dalton hymus, slone pots, damion anderson, nate boyd, quaid rasmussenin, Pennsylvaniary → Glory Ellison, the new-Bria legal names (see data-sources.md).
- Fuzzy matcher `growMakeRepMatcher` (Jul 24 2026) is part-wise: first name exact | same NICK group | prefix ≥3 | same initial and lev ≤1 (≤2 if either ≥6 chars); different first initial disqualifies; last name lev ≤2; best score wins; no match rather than a guess. Correctly refuses sibling surnames (Neal, Boyd, Smith, Schwieger, Shelton) and Kallia vs Alaina Fuller. `window._rosterLookup()` is the one fuzzy rep→manager resolver. `_authKey` needs plausible first names (`_authFirstOk`).
- Sequifi/new Bria carry legal names; our roster/Bria-old carry nicknames: resolve through aliases before any "not on a team = sub" rule.
- Unmatched is the safe failure (row sits unattributed instead of inflating a colleague).

## Roster history (how attribution worked before Bria teams)

1. Jul 2026: weekly roster paste (`scripts/parse-week-paste.mjs <file> <sunday>` → `team-current.json` / `team-assignments.json`, deploy). Then Admin › Roster paste → `report_config.__roster_current__` (no deploy). `scripts/roster-import.py <xlsx> [--week] [--write]` parsed the Blitz Sign Up sheet export (row 1 Sunday dates, col A region anchors, block-first name = manager; fill FF00FF = sub, FF0000 = bailed). Manager identity came from the roster, never from Sequifi (Sequifi has no hierarchy).
2. Aug 17 2026: **Master Manager Pay** sheet = roster of record (pay-owning manager, vs Blitz = team lead knocked under). Full history in `__roster_weeks__` via `scripts/master-pay-sync.gs` or `parse-team-assignments.mjs --push`; `__roster_current__` only for the in-progress week. Master export stalled at 2026-08-09.
3. Sub marks persisted in `__subs_weeks__` (`_subsWeeksSync`, carry-forward to unmarked weeks) because the Master grid has no Subs bucket.
4. Sep 10 2026: `api/sequifi-teams-sync.js` (daily cron 45 8 UTC) walks Sundays from 2026-08-09 into `__sequifi_teams__` (refuses empty history, drops empty weeks, `?dry=1`). `_authMgr` exact-week Sequifi for weeks ≥ `_SEQ_START`. Sep 15: `_seqCarryMgr` places a rep on the nearest Sequifi team within 3 weeks back / 2 ahead (Sequifi rosters drop people week to week).
5. Sep 29 2026: Bria teams (above). The carry-forward logic is reused unchanged.

`deals.manager` is dead ('Unassigned' since Aug 16 2026); query the roster stores instead. Rep→manager must always be resolved per week (a time-invariant map left ~36% of a week unattributed). Fix Attribution screen and `rep_manager_overrides` are retired. The Sequifi teams sync still runs.

## Managers and markets seen in Sep 2026 (for orientation; verify current)

Ezee TX: Damien "Damo" Anderson + Brandon Romain (earlier Devon + Danny, Daniel DuBose block). Chicago (Ezee IL): Tate Golightly (Jovan Washington counts on Chicago). i3: Will Gabor. Lyte: Dalton Hymas with Jace Wagstaff and Will Archer (Dalton was at Bluepeak Pawhuska OK in early Sep; Conner Gardner's Coastal Bend crew is Lyte TX). Omni/Ezee MI: Jake Hogue + Judd (+ Isaiah Wiggins). TDS: Tyler Dodenbier (earlier Damion). Surf: Chris Lagrange. SLIC: Will Archer (no activity late Sep). T-Fiber/Kentucky: Caleb Neal (no knocking feed). Will Gabor (i3) and Will Archer (SLIC/Lyte) are two different people. Check each rep's ISP+city against the team's market; Sequifi membership can be wrong.
