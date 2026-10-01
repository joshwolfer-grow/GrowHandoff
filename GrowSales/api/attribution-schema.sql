-- Manual manager attribution overrides.
--
-- The weekly Sequifi Master roster misses people: brand-new reps, subs, anyone
-- who genuinely has no manager, and the odd blank cell. Those deals land under
-- "Unassigned". This table lets the dashboard fix a rep's attribution in a few
-- clicks without editing the sheet or waiting for a re-sync.
--
-- One row per rep per week. week = the Sunday-anchored week (matches deals.week).
-- Setting manager to 'Unassigned' is meaningful: it means "checked, this rep
-- really has no manager", so the triage list can stop showing them.
--
-- Run once in the Supabase SQL editor.

create table if not exists rep_manager_overrides (
  id          bigserial primary key,
  rep         text not null,
  week        date not null,
  manager     text not null,
  note        text,
  updated_at  timestamptz not null default now(),
  unique (rep, week)
);

create index if not exists rep_manager_overrides_week_idx on rep_manager_overrides (week);

alter table rep_manager_overrides enable row level security;

-- Same trust model as the other dashboard-written tables (knocking, doc_chunks):
-- the app holds only the anon key and writes directly.
drop policy if exists rep_manager_overrides_all on rep_manager_overrides;
create policy rep_manager_overrides_all on rep_manager_overrides
  for all using (true) with check (true);
