# Bria → Grow comparison — setup

Pulls Bria training + sales nightly, computes completion and per-rep/day deal counts,
and writes them into Grow Supabase so the dashboard can flag missing deals and training gaps.

## One-time setup

1. **Create the tables.** In the Grow Supabase project → SQL Editor, paste and run
   [`api/bria-sync.sql`](bria-sync.sql). Creates `training_completion`, `bria_sales_daily`,
   `bria_sync_meta` (anon read, service-role write).

2. **Add the Bria credentials to Vercel** (Settings → Environments → Production).
   Pick ONE method:

   - **Option A — service_role key** (cleanest, if you can reach Bria's Supabase dashboard):
     `BRIA_API_KEY` = the `service_role` key (Settings → API).

   - **Option B — your Bria login** (no dashboard access needed):
     `BRIA_ANON_KEY` = Bria's public "anon" key,
     `BRIA_EMAIL` = your Bria email,
     `BRIA_PASSWORD` = your Bria password.

   Also add `CRON_SECRET` if not already set. (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
   are already set.)

3. **Deploy.** `vercel --prod`. The cron in [`vercel.json`](../vercel.json) runs the sync
   daily at 09:00 UTC.

## First run / manual trigger

```
curl "https://<your-app>/api/bria-sync?key=<CRON_SECRET>"
```
Returns row counts on success. Then open the dashboard → **More → 🎓 Training** (Corporate view).

## What the dashboard shows

- **Training** (new): per-manager, per-rep course completion. Incomplete courses first,
  overdue days shown, and an "Unmatched Bria reps" list for names that don't map to a
  dashboard rep (fix spelling or add to roster).
- **Reconciliation** (existing): deal counts vs Bria. `bria_sales_daily` now gives this a
  live, per-day source instead of the manual leaderboard paste.

## Notes

- Rep matching: Bria `users.name` → Grow `deals.rep` via the dashboard's fuzzy matcher
  (exact/case/nickname/typo/middle-initial/suffix). Genuine non-matches surface in the
  Unmatched list rather than being silently dropped.
- Deal reconciliation join is `rep + customer_name + sale_date` — Grow's `phone`/`address`
  are only ~25–30% populated, so they're used only as secondary confirmation.
- Manager-text integration is intentionally deferred until the numbers are confirmed.

## Update (2026-07-16): fully server-side now

- `vercel.json` sets `maxDuration: 60` for this function — the sync takes ~18s
  and the old 10s default was killing every cron run.
- Sign-in failures now error loudly instead of silently pulling 0 rows.
- Auth: use a dedicated Bria admin account (BRIA_EMAIL/BRIA_PASSWORD) or the
  service_role key (BRIA_API_KEY, takes priority). Do not tie it to a personal
  login whose password may change.
- Manual trigger accepts SYNC_TRIGGER_KEY as well as CRON_SECRET.
- The browser bookmark still works but is a fallback only.

## Update (2026-07-29): ISP on Bria deals

- The `sales` pull now includes `client_company_name` (the ISP) and `product_label`,
  stored as `bria_deals.isp` / `bria_deals.product`. Re-run `api/bria-sync.sql` to add
  those two columns before the first sync writes them.
- Until the columns exist the write is retried without them, so `bria_deals` keeps
  loading rather than coming back empty.
- The Deals reconciliation view shows the ISP mix for the window, and every Bria deal
  card / chase line carries its ISP next to the sold date. Rows Bria has no
  `client_company_name` for fall back to `product_label`, then to nothing shown.
- The browser-bookmark fallback posts its own column list, so it needs the two extra
  columns added there too if it's ever used again.

## Update (2026-09-11): new Bria

- Bria moved to the Supabase project `bria` (`oofisagqyhfcpmfmcjwt`), app at
  https://growfiber.vercel.app. The old `auth.getbria.com` host and its
  anon/email/password login are retired.
- Vercel (GrowSales): `BRIA_BASE=https://oofisagqyhfcpmfmcjwt.supabase.co` and
  `BRIA_API_KEY=<service_role key>`. Do not touch growfiber's `GROW_SALES_SUPABASE_*`.
- Before the first run, `node scripts/bria-schema-check.mjs` (key in `.env.bria`)
  confirms every table/column, the sales date range and the company list.
- The sync now holds existing data when a pull has under 90% of the last sync's
  sales. Add `&force=1` to the manual trigger when that drop is expected.

## Update (2026-09-11, later): read-only role instead of service_role

- Grow Sales reads the new Bria with a SELECT-only role, not a service_role key.
  Vercel (GrowSales only): `BRIA_SUPABASE_URL`, `BRIA_SUPABASE_PUBLISHABLE_KEY`
  (sent as `apikey`), `BRIA_SUPABASE_READONLY_KEY` (sent as `Bearer` only, never
  as the apikey). Setting the read-only key is what switches the sync over.
- The new Bria's sales start 2026-01-01 and run ~730 short of the old Bria for
  Jan to Apr, so only sale_date >= `BRIA_CUTOVER` (default 2026-05-01) is replaced.
  Earlier rows are frozen old-Bria history; a copy of every Bria table as of the
  switch is in Grow's `backup` schema (`*_20260911`).
- The read-only role cannot read the training tables yet. Until the Bria side
  grants SELECT on courses, lessons, quizzes, learning_groups,
  learning_group_assignments, learning_group_courses, lesson_completions and
  quiz_results, the sync leaves `training_completion` as it is.
- `product_label` moved from the sale to the team; the sync fills it from `teams`.
- Six reps are stored under legal names in the new Bria; aliases in
  `api/_name-aliases.js` map them back.
