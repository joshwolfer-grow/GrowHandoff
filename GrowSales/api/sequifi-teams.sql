-- api/sequifi-teams.sql
-- Run ONCE in the Supabase SQL editor.
--
-- Backs api/sequifi-teams-sync.js (the weekly roster pulled from Sequifi's
-- /v1/teams) and the sub rule that rides on it.

-- ---------------------------------------------------------------------------
-- 1. Sync meta, so the watchdog can tell "ran fine" from "quietly stopped".
--    Same singleton shape as sequifi_sync_meta.
-- ---------------------------------------------------------------------------
create table if not exists sequifi_teams_sync_meta (
  id           int primary key,
  last_run     timestamptz,
  week_count   int,
  team_count   int,
  people_count int,
  duration_ms  int,
  error        text
);

alter table sequifi_teams_sync_meta enable row level security;

-- Read-only for the dashboard's anon key (it shows sync health on the Ops
-- board); only the service key writes, from the sync function.
drop policy if exists sequifi_teams_sync_meta_read on sequifi_teams_sync_meta;
create policy sequifi_teams_sync_meta_read on sequifi_teams_sync_meta
  for select using (true);

insert into sequifi_teams_sync_meta (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. rep_flags.roster_status — the manual override on top of the Sequifi rule.
--
--    The rule is: on a Sequifi team that week = internal; selling that week with
--    no Sequifi record at all = subcontractor. That is right most of the time
--    and wrong exactly when someone sells before payroll has set them up, which
--    is common enough that it needs a one-tap answer in the app.
--
--    is_sub already exists and already means "always a sub, every week". It
--    cannot express the opposite, because `false` is also its default — there is
--    no way to say "I looked at this person and they ARE internal". This column
--    is that third state:
--
--      null       -- no one has ruled; derive from Sequifi
--      'internal' -- a human says internal, whatever Sequifi shows
--      'sub'      -- a human says subcontractor
--
--    is_sub stays authoritative when true so nothing that reads it today
--    changes behaviour; roster_status is what new code checks first.
-- ---------------------------------------------------------------------------
alter table rep_flags add column if not exists roster_status text
  check (roster_status is null or roster_status in ('internal', 'sub'));

alter table rep_flags add column if not exists roster_status_at timestamptz;
alter table rep_flags add column if not exists roster_status_by text;

create index if not exists rep_flags_roster_status_idx
  on rep_flags (roster_status) where roster_status is not null;

-- Anyone already flagged is_sub has effectively been ruled a sub; carry that
-- forward so the new column starts out agreeing with the old one instead of
-- reading as "nobody has decided".
update rep_flags
   set roster_status = 'sub',
       roster_status_at = coalesce(roster_status_at, updated_at),
       roster_status_by = coalesce(roster_status_by, 'migrated from is_sub')
 where is_sub and roster_status is null;
