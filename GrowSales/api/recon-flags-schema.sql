-- Reconciliation flags: "I'm looking at this rep's week."
--
-- One row per rep per week (Sunday-anchored, matches deals.week). Corporate
-- flags a rep from the Reconcile workbook; the flag then shows on that rep's
-- ?rep= dashboard and in their weekly email, so they know it's being watched
-- before they ever ask. Deleting the row clears the flag.
--
-- bria_n / report_n snapshot the counts at the moment of flagging, so the flag
-- still makes sense later even after reports catch up.
--
-- Run once in the Supabase SQL editor.

create table if not exists bria_recon_flags (
  id          bigserial primary key,
  rep         text not null,
  week        date not null,
  status      text not null default 'flagged',
  bria_n      int,
  report_n    int,
  note        text,
  flagged_by  text,
  updated_at  timestamptz not null default now(),
  unique (rep, week)
);

create index if not exists bria_recon_flags_week_idx on bria_recon_flags (week);
create index if not exists bria_recon_flags_rep_idx  on bria_recon_flags (rep);

alter table bria_recon_flags enable row level security;

-- Same trust model as rep_manager_overrides / knocking: the app writes with the
-- anon key.
drop policy if exists bria_recon_flags_all on bria_recon_flags;
create policy bria_recon_flags_all on bria_recon_flags
  for all using (true) with check (true);
