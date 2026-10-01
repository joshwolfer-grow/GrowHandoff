-- Tables the Sequifi sync writes into and the Team view reads.
-- Run once in the Grow Supabase project: SQL Editor -> paste -> Run.
-- Re-runnable (IF NOT EXISTS). The sync upserts on sequifi_id.

-- One row per Sequifi user. onboarded_at is stamped the first time the sync
-- sees onboarding_complete=1 and is never overwritten after that.
create table if not exists public.rep_onboarding (
  sequifi_id           integer     primary key,
  employee_id          text,
  first_name           text,
  last_name            text,
  email                text,
  mobile_no            text,
  office_name          text,
  state_code           text,
  manager_name         text,
  manager_email        text,
  position_name        text,
  sub_position_name    text,
  experience           text,        -- 'veteran' | 'rookie'
  worker_type          text,
  status_id            integer,
  is_manager           boolean     default false,
  sequifi_created_at   timestamptz,
  onboarding_complete  boolean     default false,
  onboarded_at         timestamptz,
  onboarded_backfilled boolean     default false,
  last_seen_at         timestamptz default now(),
  updated_at           timestamptz default now()
);

-- Single-row status/heartbeat for the last sync.
create table if not exists public.sequifi_sync_meta (
  id              integer primary key,
  last_run        timestamptz,
  user_count      integer,
  onboarded_count integer,
  duration_ms     integer,
  error           text
);

-- The required training path: which Bria courses count for accountability.
-- course_title must exactly match training_completion.course.
create table if not exists public.required_path (
  course_title text    primary key,
  sort_order   integer default 0,
  active       boolean default true,
  updated_at   timestamptz default now()
);

-- Single-row goal windows, editable from the Team view settings sheet.
create table if not exists public.team_settings (
  id                       integer primary key,
  training_start_goal_days integer default 2,
  training_goal_days       integer default 7,
  first_sale_goal_days     integer default 7,
  five_sales_goal_days     integer default 21,
  board_cutoff_date        date,
  updated_at               timestamptz default now()
);
alter table public.team_settings add column if not exists board_cutoff_date date;
insert into public.team_settings (id) values (1) on conflict (id) do nothing;

-- Dashboard reads everything with the anon key; it also edits the two
-- settings tables from the client (same trust model as goals/flags).
alter table public.rep_onboarding    enable row level security;
alter table public.sequifi_sync_meta enable row level security;
alter table public.required_path     enable row level security;
alter table public.team_settings     enable row level security;

drop policy if exists "anon read rep_onboarding"    on public.rep_onboarding;
drop policy if exists "anon read sequifi_sync_meta" on public.sequifi_sync_meta;
drop policy if exists "anon read required_path"     on public.required_path;
drop policy if exists "anon read team_settings"     on public.team_settings;
drop policy if exists "anon write required_path"    on public.required_path;
drop policy if exists "anon write team_settings"    on public.team_settings;

create policy "anon read rep_onboarding"    on public.rep_onboarding    for select using (true);
create policy "anon read sequifi_sync_meta" on public.sequifi_sync_meta for select using (true);
create policy "anon read required_path"     on public.required_path     for select using (true);
create policy "anon read team_settings"     on public.team_settings     for select using (true);
create policy "anon write required_path"    on public.required_path     for all using (true) with check (true);
create policy "anon write team_settings"    on public.team_settings     for all using (true) with check (true);
-- rep_onboarding + meta writes come from the sync via service_role (bypasses RLS).
