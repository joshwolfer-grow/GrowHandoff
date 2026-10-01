-- Team schedule + onboarding tracker (More > Schedule, and the /schedule form).
-- Run once in the Grow Supabase project. Re-runnable.
--
-- Trust model: the anon key ships in index.html, so these are readable by anyone
-- who opens devtools, same as every other table here. rep_schedules is written
-- only by api/schedule.js with the service key, because the form is a public
-- link and must not be able to touch anyone else's week. The roster and checks
-- tables are edited from the signed-in manager page, like rep_flags.
--
-- Reading code: renderSchedule() in index.html (search "TEAM SCHEDULE").

-- One row per rep per team per week. days = [{d:'2026-09-21', s:960, e:1200}],
-- minutes after midnight. An empty days array with off_week=true means the rep
-- said they are not working that week, which counts as submitted.
create table if not exists public.rep_schedules (
  team         text        not null,   -- manager name as the Sequifi teams sync writes it
  rep          text        not null,
  week_start   date        not null,   -- Sunday
  days         jsonb       not null default '[]'::jsonb,
  off_week     boolean     not null default false,
  hours        numeric,
  submitted_at timestamptz not null default now(),
  primary key (team, rep, week_start)
);
alter table public.rep_schedules enable row level security;
drop policy if exists rep_schedules_read on public.rep_schedules;
create policy rep_schedules_read on public.rep_schedules for select using (true);

-- Manager edits to a team's roster: reps added by hand (not on the Sequifi team
-- yet), reps hidden from the form, and each rep's committed weekly hours.
create table if not exists public.team_roster (
  team         text        not null,
  rep          text        not null,
  added        boolean     not null default false,  -- true = added by hand, not from Sequifi
  hidden       boolean     not null default false,
  sequifi_id   integer,                              -- set when an added rep was picked from Sequifi users
  commit_hours numeric,
  updated_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (team, rep)
);
alter table public.team_roster enable row level security;
drop policy if exists team_roster_all on public.team_roster;
create policy team_roster_all on public.team_roster for all using (true) with check (true);

-- Manual onboarding checks. Automatic ones (Sequifi, Bria account, first knock,
-- first sale) are computed in the app and never stored.
create table if not exists public.rep_checks (
  rep          text        not null,
  check_key    text        not null,   -- training | blitz | standards
  checked_at   timestamptz not null default now(),
  checked_by   text,
  primary key (rep, check_key)
);
alter table public.rep_checks enable row level security;
drop policy if exists rep_checks_all on public.rep_checks;
create policy rep_checks_all on public.rep_checks for all using (true) with check (true);
