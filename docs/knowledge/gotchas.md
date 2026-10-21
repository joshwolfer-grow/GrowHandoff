# Gotchas (the traps that cost real time)

Grouped by area. Each one has bitten at least once. Details live in the topic files; this is the checklist.

## Code (`GrowSales/index.html`)

1. **bootDashboard scope trap.** Render functions live inside `bootDashboard()`; `fetchLiveData()` can't see them. A bare call there throws a ReferenceError inside the same try/catch that just fetched data, blanking it while the network shows 200. Use `window.*` hooks and separate try blocks. Code outside bootDashboard doing `typeof x==='function'` silently gets 'undefined'. Inline `on*` handlers need `window.` functions. Bit again Oct 13 2026 (`_briaExclude` defined inside, called from fetchLiveData: every sign-in showed "No data available"). Check: on the live login page `typeof <fn>` in the console must print "function" for anything fetchLiveData calls. Same trap inside the knocking-board closure: `renderHome` must sit right after `window.renderKnockBoard=renderKnockBoard;`, not before `</script>`.
2. Late-loaded data (Bria, rep_flags, report_config) arrives after first paint; views need a re-render hook. KPI cache tokens must include every input (flags, subs, onboarding length, manager lock) or stale numbers stick.
3. Never write the whole `index.html`; other sessions (historically) wrote it concurrently. Snapshot, string-edit, diff. Syntax-check the inline script after edits (`node --check` / `new Function()`); a missing `)` or an apostrophe in single-quoted template CSS bricked the app on "Connecting...".
4. html2canvas images on iOS Safari collapse word spaces unless the template root has `letter-spacing:0.3px` and a canvas-safe font stack (no `-apple-system`).
5. `[].slice.call(aSet)` returns `[]`; use `Array.from`.
6. Quirks-mode tables don't inherit color.
7. A new manager-visible page needs `_mgrLock` + `MGR_PAGES`; a new corporate page needs `CORP_SECS`/`CORP_MORE`, or it's open by default.
8. Reading a new column off the five big tables means adding it to the fetchLiveData column list; a newly cached table needs a `bump_version_<table>` trigger.
9. `growIsSub` looks up `rep_flags` by EXACT case-sensitive rep spelling.
10. "% Done" means different things in different places; the two named install rates must appear as a pair.
10a. **Never loop a Playwright sign-in check against production.** Oct 14 2026: one verify loop fired ~38k requests in 10 minutes and hung the Supabase project for 20 minutes. Use `scripts/verify-metrics.mjs` (serves the file locally, answers `redeem_access_code` itself) and count only `load` events for a reload guard.
10b. Global blocks after bootDashboard (Cancel Center, Deal Check) must never assume `DATA` exists.

## Data

11. **Weeks are Sunday-anchored** even where names say Mon. Mon to Sat = anchor+1..+6.
12. `knocking.source` is the feed, not the ISP. `knocking.sold` may be SalesRabbit pins, not deals. Sales-only rows (doors 0, sold > 0) aren't days out.
13. Never divide a deals-complete numerator by a knocking-sparse denominator (close rate >100%, PRA collapses). Clip at report coverage (`_kwSalesThru`), fill holes (`_kwThruHoles`).
14. Report lag looks like a sales collapse; check `window._kwSalesThru()` against the last knocking date before debugging any PRA/close drop. If a paid PRA moves days later, check holes before blaming knocking.
15. Bria vs install report disagree constantly; compare by ISP via `_ispKey()`, and know which surface uses which (metrics-definitions.md).
16. `deals.manager` is dead; resolve managers per week from the roster store. A time-invariant rep→manager map drops ~36% of a week.
17. Legal names (Sequifi, new Bria) vs nicknames (our data). Aliases must point at the deal feed's spelling; backwards aliases duplicate knocking rows (Alli Lauriano 1,471 phantom doors, Chris Lagrange 1,802).
18. Presales stored as Standard (lowercase "presale" bug). Lyte "ghost presales" (Pending, no install date). Upfront over-counted presale until fixed.
19. PostgREST: 1000-row cap, and offset paging without a unique `order` silently drops/duplicates rows. Page by primary key.
20. `report_config` and `goals` have no anon DELETE: delete-then-insert silently stacks duplicates; upsert/PATCH instead. `knocking` and `rep_onboarding` have no anon UPDATE: PATCH returns 204 and changes nothing.
21. `created_at` on knocking can't prove rows are new (a full grow-sync resets it).
22. Bria's `isp` label is unreliable for team assignment; UUID rep names exist.
23. Supabase anon statement timeout ~3s: no select-all on big tables. Egress is the free-plan limit, not DB size. Server-side readers need indexes too (`bria_deals(sale_date)` added Oct 14 after the morning brief bots timed out).
23a. The `deals` table is rebuilt on every sheet sync (ids and `created_at` change): never diff deals by id across days.
23b. Bria is not a closed system: a demo company (31 fake reps, 3,105 fake sales) leaked in Oct 14 to 16 2026; same-customer-two-reps entries and first-name-only logins ("Kanyon", "Jacob") inflate counts. `bria-sync.js` filters by `BRIA_COMPANY_ID` and applies `BRIA_EXCLUDE`; a Leaderboard Club count that disagrees with its click-in list is the tell.
23c. Surf lead files repeat each house per past account holder: lead the report with "<raw> rows = <houses> houses" or a halved count reads as dropped leads.
23d. SalesRabbit `/profile_locations` ignores limit/page and returns every row: always filter by date (rep GPS sync retired Oct 21 2026, but the trap stays).
23e. Ezee Activity_Detail renders nothing before Aug 17 2026; `Distance` is feet, not metres.

## Syncs and files

24. **Crawl CSVs can be iCloud "dataless" stubs** that read as 0 bytes with no error → every dedupe says "all new". `stat -f "flags=%Sf ondisk=%b"` first. Keep the repo out of iCloud.
25. **The crawl keeps leads deleted in SalesRabbit** (no tombstones) → real doors dropped from imports. Purge ids after any bulk delete; verify deletions via `GET /loci/{id}` → 404.
26. Append-only stores bloat until ticks hit the 240s watchdog (exit 137): `node scripts/compact-store.mjs`.
27. Scheduled grow-sync is `--lean`: by-hand reports need a full CSV rebuild first. Lean compiles once dropped import_id/zip and sent every door to the state map (`how='map'`).
28. Stale token (fresh FAILED log line) vs dead launchd agent (no new lines). Plists hardcode paths; reinstall with `install-agents.sh` (or `install-all-agents.sh` for everything) after any move. A grey row is PAUSED on purpose (`__paused__`): runners skip silently, no marker, no red, no email.
28a. Since Oct 19 2026 a failing source mails ONCE per outage and never mails "recovered"; fast sources need two consecutive fails. No email does not mean no problem; look at the board.
28b. `_notify.js` (web push) was retired Oct 14 2026; every API file that required it now carries a `console.warn` stub (fixed Oct 21). Do not re-add a require on a retired file.
29. Cadence changes need plist/schedule + watchdog + health-board config together; daily sources need an explicit `warn`.
30. Chrome 152 crashes Playwright downloads: fetch export URLs with `ctx.request`.
31. Opendoor reports: dropping scoping params/dropdowns silently returns every company's reps; long ranges time out; an empty Omni report exits 0 (green ≠ data).
32. Two runs writing a shared Drive file at once make Drive rename the shared original to "... 2" (frozen). Guard pins Drive ids; fix with `scripts/fix-drive-split.sh`.
33. isp-intake overwrites a same-town same-day import file.
34. Blank zips silently drop rows (now loud `DROPPED`). Multi-sheet workbooks = one import; customers included as Current Customer.
35. Profile locks: one Chrome profile can be open once; backfills use a copied profile.
36. `.vercelignore` must exclude data, jsonl and every browser profile (session cookies; upload caps).

## Deploy and environment

37. Vercel deploys the working directory, not git: anything uncommitted ships (three unfinished training pages went live Oct 14 2026 that way). `vercel --prod` from the Desktop folder ships an EMPTY deploy (no index.html there); always deploy from `~/Grow/GrowSales`.
38. Wrong Vercel account → "Could not retrieve Project Settings". Sensitive env vars read back blank; never infer "unset" from `.env.local`.
39. Alias is `growsales.vercel.app`, not `grow-sales`.
40. Browser caches `index.html`: add `&cb=` when testing.
41. Sequifi Vercel token goes stale independently of the copy that works; tokens also duplicated in the onboarding Apps Script.
42. Apps Scripts live outside git (onboarding script has no version history) and run as a specific Google user; Workspace blocks service accounts.
43. Onboarding Apps Script: a manual form row permanently suppresses doc download for that rep; its alerting goes to a deleted Pronto channel.
44. Messages (RepText): scripts can't create group chats; images must be in `~/Pictures`; launchd can't drive System Events (-1743). The mgrcards job is retired (Oct 14); a stale access code in `RepText/.env` made it fail silently for three weeks before that.
45. Canva MCP: one merge op per call; empty table cell text is black; owner may edit the deck mid-transaction; outside-team images can't be placed.

## Process

46. "Do whatever you need" is not permission to delete live data. "Most recent status" means best stage, not latest timestamp.
47. Literal specs: implement the owner's sentence verbatim before adding cleverness (Bonus lens reverted twice).
48. Sequifi grey loading skeletons look like redaction; screen recordings may expose PII.
49. After an ISP import, hand over ONLY the import csv (Oct 8 2026); the dupes report stays on Drive. Markdown links to repo paths do not open from the Desktop session; attach files.
50. Meeting deck: never take per rep-day max(report, Bria) for deals (double counts); report where it covers the week, Bria after; if the report's last day is partial, cut the day before. The owner edits the Canva deck while a transaction is open: re-read before committing.
51. The Claude browser pane pins programmatic and fragment scrolling; anchor deep links must be verified in a real browser.
