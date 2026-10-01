-- Table the upfront opt-in sync writes into and the dashboard reads.
-- Run once in the Grow Supabase project: SQL Editor -> paste -> Run.
-- Re-runnable (IF NOT EXISTS).
--
-- Source of truth is the "upfront pay reps" tab of the Google Sheet; the sync
-- (api/upfront-optin-sync.js) mirrors it here so the dashboard and the weekly
-- rep email both read one place instead of two hand-maintained arrays.

-- One row per opted-in rep. Name is the join key everywhere downstream, so it
-- must match the rep name as it appears in Sequifi/Bria deal data.
create table if not exists public.upfront_optin (
  name        text primary key,
  email       text,
  active_date date,                 -- first day on upfront pay
  end_date    date,                 -- last day (enrollment window close)
  updated_at  timestamptz default now()
);

-- Single-row status/heartbeat for the last sync (mirrors bria/sequifi meta).
create table if not exists public.upfront_optin_sync_meta (
  id          integer primary key,
  last_run    timestamptz,          -- only advanced on a SUCCESSFUL, non-empty pull
  rep_count   integer,
  duration_ms integer,
  error       text
);

-- The dashboard reads these with the public anon key, so allow read.
alter table public.upfront_optin           enable row level security;
alter table public.upfront_optin_sync_meta enable row level security;

drop policy if exists "anon read upfront_optin"           on public.upfront_optin;
drop policy if exists "anon read upfront_optin_sync_meta" on public.upfront_optin_sync_meta;

create policy "anon read upfront_optin"           on public.upfront_optin           for select using (true);
create policy "anon read upfront_optin_sync_meta" on public.upfront_optin_sync_meta for select using (true);
-- Writes come from the sync using the service_role key, which bypasses RLS.
