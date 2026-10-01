-- Per-rep flags set from the dashboard, not from a synced source.
--
-- is_sub marks a subcontractor. Subs already group under a "Subs" bucket when
-- they appear on the weekly team sheet (team-assignments.json), but that file is
-- edited by hand and only covers weeks someone remembered to add. This table is
-- the durable version: flag once, it sticks for every week, past and future.
--
-- email exists because most subs are not in Sequifi at all, so rep_onboarding
-- has no row and therefore no address for them. Without this the weekly rep
-- email can never reach them. Anything here wins over onboarding.
--
-- Run once in the Supabase SQL editor.

create table if not exists rep_flags (
  rep         text primary key,
  is_sub      boolean not null default false,
  email       text,
  note        text,
  updated_at  timestamptz not null default now()
);

create index if not exists rep_flags_sub_idx on rep_flags (is_sub) where is_sub;

alter table rep_flags enable row level security;

-- Same trust model as rep_manager_overrides / bria_recon_flags: the dashboard
-- writes with the anon key.
drop policy if exists rep_flags_all on rep_flags;
create policy rep_flags_all on rep_flags
  for all using (true) with check (true);
