# House rules for this codebase

These are standing rules the previous owner (Josh) set while building the Grow systems. Treat them as the default style and safety policy unless the new owner says otherwise. Dates are when the rule was set or last reconfirmed.

## Copy and UI style

- **No dashes anywhere in UI copy, digests, nudges, texts, emails, on-screen video copy or slide copy** (no hyphens used as punctuation, no em dashes). Use commas, colons or middle dots (·). Example: "Jake: 2/6 courses, 8d overdue", not "Jake — 2/6 courses · 8d overdue". (Jul 15 2026.) In the dashboard all `—` placeholders were replaced with `·` (Sep 11 2026).
- **Minimal chrome.** No small explainer/helper text under headers or footers, no caption/definition lines unless asked. Keep columns aligned. (Jul 15 2026.)
- **No colour on numbers** in ledgers/tables. A heat-shaded grid was built and rejected. The only coloured cells allowed are the Completed IR / Proj IR pills (house style). (Markets page, Sep 2026.)
- **Knocking data never totals.** Doors are always shown as averages (doors per rep day on ledgers; daily then avg per day worked in rep sheets). Totals/Σ only for sales-side counts. Averages stay averages; totals grouped at the end. (Jul 23 2026, standing rule.)
- **Redesign, never trim.** Every existing view keeps its exact functionality and data; all existing data must keep a home. (Jul 23 2026.) Note this was later overridden for specific removals the owner asked for (Team tab, Flags, Ops tasks, rep views); do not remove things on your own initiative.
- **GrowSales is a data tool only.** No task lists, to-dos or alert pages inside the app; those live in the owner's separate tool. (Sep 16 2026.)
- **Rep-facing surfaces stay simple.** Deep stats belong in the snapshot/email, not on rep cards. Rep contact cards are contact info only. (Aug and Sep 2026.)
- **Visual taste:** Grow brand, not generic iOS. Black chrome `#0b0c0b`, warm paper `#f2f2ec`, brand green `#2fc352` (deep `#157a34`), Archivo Black for titles and big numbers, Garet for body (training decks). For the task-bot / HUD views: one deep blue, thin lines, 14px monospace, no ornament; the owner called glow/hex/Orbitron "super cheesy" and dense views "super confusing". Ask for a reference before any new visual. Plain-English wording ("simplify the crap out of it"): "areas" not "sectors", "Days since knocked", "Answered the door".
- **Alerts once, then quiet.** Failure emails go out once per outage, no "recovered" mails, no reminders ("just once and that's it", Oct 19 2026); the health board is where you look for recovery.
- **Plain, not pitchy.** Rep-facing explainers (money guide, Oct 14 to 15 2026) were called "too pitchy and cheesy" and then "needs to be way more simple overall": one paragraph plus one key box per section, no sub headers, no sales-letter openers. Quiz and verbatim items stay exactly as the owner wrote them.
- **Lead with the number the reader will check.** A Surf import report must open with "<raw> rows = <houses> houses" (Oct 5 2026); the owner judges an import by row count against the raw file, and "in-file duplicates" sounds like loss.
- When source data is wrong, **surface the conflict, don't paper over it**. The dashboard is how the source gets fixed (e.g. deals Pending in Sequifi but with an install date show an amber "update status" chip; status always wins).

## Spec handling

- **The owner's spec sentences are literal.** Implement them verbatim before adding any cleverness. Bonus lens lesson (Aug 31 2026): "from the review date, go back 2 weeks, then do the 4 week lookback" meant exactly that; extra interlocks and "accumulating" reinterpretations had to be reverted twice.
- Do not goal-seek metrics (e.g. "get PRA above 2.4"). If a definition changes, record the honest range under each definition.
- Don't re-litigate settled vendor or definition choices without new data (e.g. Geocodio vs Smarty).

## Safety with live data

- **Confirm before deleting, rolling back or overwriting live data** in any external system (Supabase, SalesRabbit, Sequifi, Drive). An ambiguous phrase ("it was a test at going live so do whatever you need") is not permission. Pick the non-destructive branch and ask one short question. "I left X in place, say the word and I'll remove it" is always safe. (Jul 23 2026.)
- **"Keep the most recent status" means the real disposition, not a date race.** Rank stages first (Sold > Current Customer > Not Interested / Call Back > ... > Vacant / New Lead / Not Home), use recency only to break ties. (Sep 22 2026, after 12 Uvalde keepers had to be restaged.)
- SalesRabbit deletes are permanent: prep and verify with dry runs, the human runs `--go`.
- Never push an unattended path from an ISP file to a SalesRabbit import; a person looks at the headers first (see isp-pipeline.md).
- Do not load PII you don't need (e.g. the Sequifi export's Personal Info sheet with DOB/addresses). Minors are present in onboarding data.
- Archive retired Canva designs; don't delete them.
- Never copy the whole of `GrowSales/index.html` over itself from a stale copy; use exact string edits.

## Deploying

- **Deploy directly to Vercel with `vercel --prod --yes` from the `GrowSales/` root. No GitHub PR workflow.** Prod alias: https://growsales.vercel.app (project `project-djlm1`). Verify live with `curl -s "https://growsales.vercel.app/?cb=<timestamp>"` and grep for a marker of the change.
- Historically (Jul 6, Aug 3, Aug 5 2026) the owner wanted auto deploys with no confirmation. Since Sep 2026 the practice became: **deploy only when nothing else uncommitted is sitting in the tree**, because Vercel ships the whole working directory, not git (other sessions' half-finished work went live more than once). Check `git status` / diff before deploying. Env-only changes: `vercel redeploy <current prod url> --target production` so no on-disk work ships.
- See repo-and-deploy.md for the full procedure and traps.

## Process habits worth keeping

- Snapshot `index.html` to a scratch copy before a multi-edit change; re-read the region before each edit; diff after. Never write the whole file.
- After editing `index.html`, syntax-check the inline script (`node --check` on the extracted script or `new Function()`); a single missing `)` once bricked the app on "Connecting...".
- When a number is questioned, verify against SQL rep by rep before claiming a fix.
- Deliver per-rep totals, not deal lists, as payroll action items (Sep 11 2026).
- After an ISP import, send only the one import csv to upload (Oct 8 2026); file the dupes report to Drive without sending it.
- Attach files rather than linking repo paths (links into `~/Grow/GrowSales` do not open from the Desktop session).
- Before any metric change, run `scripts/verify-metrics.mjs` on the backup and the edited file and compare; never loop a sign-in check against prod (Oct 14 2026 outage).
- Warn before opening a browser window on the owner's screen (TDS token capture, Amplify login); he disliked pop-ups.
- Keep all `knock_events` rows (full-year history wanted, Oct 7 2026); confirm before dropping any table, even a 55 MB one.
