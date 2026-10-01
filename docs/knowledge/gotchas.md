# Gotchas (the traps that cost real time)

Grouped by area. Each one has bitten at least once. Details live in the topic files; this is the checklist.

## Code (`GrowSales/index.html`)

1. **bootDashboard scope trap.** Render functions live inside `bootDashboard()`; `fetchLiveData()` can't see them. A bare call there throws a ReferenceError inside the same try/catch that just fetched data, blanking it while the network shows 200. Use `window.*` hooks and separate try blocks. Code outside bootDashboard doing `typeof x==='function'` silently gets 'undefined'. Inline `on*` handlers need `window.` functions.
2. Late-loaded data (Bria, rep_flags, report_config) arrives after first paint; views need a re-render hook. KPI cache tokens must include every input (flags, subs, onboarding length, manager lock) or stale numbers stick.
3. Never write the whole `index.html`; other sessions (historically) wrote it concurrently. Snapshot, string-edit, diff. Syntax-check the inline script after edits (`node --check` / `new Function()`); a missing `)` or an apostrophe in single-quoted template CSS bricked the app on "Connecting...".
4. html2canvas images on iOS Safari collapse word spaces unless the template root has `letter-spacing:0.3px` and a canvas-safe font stack (no `-apple-system`).
5. `[].slice.call(aSet)` returns `[]`; use `Array.from`.
6. Quirks-mode tables don't inherit color.
7. A new manager-visible page needs `_mgrLock` + `MGR_PAGES`; a new corporate page needs `CORP_SECS`/`CORP_MORE`, or it's open by default.
8. Reading a new column off the five big tables means adding it to the fetchLiveData column list; a newly cached table needs a `bump_version_<table>` trigger.
9. `growIsSub` looks up `rep_flags` by EXACT case-sensitive rep spelling.
10. "% Done" means different things in different places; the two named install rates must appear as a pair.

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
23. Supabase anon statement timeout ~3s: no select-all on big tables. Egress is the free-plan limit, not DB size.

## Syncs and files

24. **Crawl CSVs can be iCloud "dataless" stubs** that read as 0 bytes with no error → every dedupe says "all new". `stat -f "flags=%Sf ondisk=%b"` first. Keep the repo out of iCloud.
25. **The crawl keeps leads deleted in SalesRabbit** (no tombstones) → real doors dropped from imports. Purge ids after any bulk delete; verify deletions via `GET /loci/{id}` → 404.
26. Append-only stores bloat until ticks hit the 240s watchdog (exit 137): `node scripts/compact-store.mjs`.
27. Scheduled grow-sync is `--lean`: by-hand reports need a full CSV rebuild first. Lean compiles once dropped import_id/zip and sent every door to the state map (`how='map'`).
28. Stale token (fresh FAILED log line) vs dead launchd agent (no new lines). Plists hardcode paths; reinstall with `install-agents.sh` after any move.
29. Cadence changes need plist/schedule + watchdog + health-board config together; daily sources need an explicit `warn`.
30. Chrome 152 crashes Playwright downloads: fetch export URLs with `ctx.request`.
31. Opendoor reports: dropping scoping params/dropdowns silently returns every company's reps; long ranges time out; an empty Omni report exits 0 (green ≠ data).
32. Two runs writing a shared Drive file at once make Drive rename the shared original to "... 2" (frozen). Guard pins Drive ids; fix with `scripts/fix-drive-split.sh`.
33. isp-intake overwrites a same-town same-day import file.
34. Blank zips silently drop rows (now loud `DROPPED`). Multi-sheet workbooks = one import; customers included as Current Customer.
35. Profile locks: one Chrome profile can be open once; backfills use a copied profile.
36. `.vercelignore` must exclude data, jsonl and every browser profile (session cookies; upload caps).

## Deploy and environment

37. Vercel deploys the working directory, not git: anything uncommitted ships.
38. Wrong Vercel account → "Could not retrieve Project Settings". Sensitive env vars read back blank; never infer "unset" from `.env.local`.
39. Alias is `growsales.vercel.app`, not `grow-sales`.
40. Browser caches `index.html`: add `&cb=` when testing.
41. Sequifi Vercel token goes stale independently of the copy that works; tokens also duplicated in the onboarding Apps Script.
42. Apps Scripts live outside git (onboarding script has no version history) and run as a specific Google user; Workspace blocks service accounts.
43. Onboarding Apps Script: a manual form row permanently suppresses doc download for that rep; its alerting goes to a deleted Pronto channel.
44. Messages: scripts can't create group chats; images must be in `~/Pictures`; launchd can't drive System Events (-1743).
45. Canva MCP: one merge op per call; empty table cell text is black; owner may edit the deck mid-transaction; outside-team images can't be placed.

## Process

46. "Do whatever you need" is not permission to delete live data. "Most recent status" means best stage, not latest timestamp.
47. Literal specs: implement the owner's sentence verbatim before adding cleverness (Bonus lens reverted twice).
48. Sequifi grey loading skeletons look like redaction; screen recordings may expose PII.
