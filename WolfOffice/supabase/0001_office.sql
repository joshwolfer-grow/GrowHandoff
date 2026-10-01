-- supabase/0001_office.sql
create table if not exists public.office_agents (
  id              text primary key,             -- 'crawler'
  floor           text not null,                -- 'grow' (the only floor)
  name            text not null,                -- 'Crawler'
  role            text not null,                -- one line, shown under the name
  cadence_seconds integer,                      -- null = on demand
  buttons         jsonb not null default '[]',  -- [{label, kind, args}]
  sprite          jsonb not null default '{}',  -- {hair, shirt, prop}
  sort            integer not null default 0
);

create table if not exists public.office_events (
  id          bigint generated always as identity primary key,
  agent_id    text not null references public.office_agents(id),
  run_id      text not null,
  kind        text not null check (kind in ('start','finish','blocked','heartbeat')),
  ok          boolean,
  status      text not null default '',
  data        jsonb not null default '{}',
  tokens_in   integer,
  tokens_out  integer,
  created_at  timestamptz not null default now()
);
create index if not exists office_events_agent_time on public.office_events(agent_id, created_at desc);

create table if not exists public.office_tasks (
  id           bigint generated always as identity primary key,
  agent_id     text not null references public.office_agents(id),
  kind         text not null,
  args         jsonb not null default '{}',
  state        text not null default 'queued' check (state in ('queued','running','done','failed')),
  requested_at timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  run_id       text
);

create table if not exists public.office_snapshots (
  agent_id text not null references public.office_agents(id),
  day      date not null,
  data     jsonb not null,
  primary key (agent_id, day)
);

alter table public.office_agents    enable row level security;
alter table public.office_events    enable row level security;
alter table public.office_tasks     enable row level security;
alter table public.office_snapshots enable row level security;

-- ---------------------------------------------------------------------------------
-- READ POLICIES: FILL IN BEFORE RUNNING
-- The office server and every worker use the SERVICE key, which bypasses RLS, so the
-- office works with no policies at all (RLS on + no policy = nothing readable with the
-- anon key, which is the safe default). These policies only matter if you want to read
-- the office tables from a browser signed in to this Supabase project.
--
-- To use them: create your user in this project (Authentication > Users), copy its
-- User UID, and replace every <SUCCESSOR_AUTH_UID> below with it, e.g.
--   ... using (auth.uid() = '11111111-2222-3333-4444-555555555555');
-- If you do not need browser access, delete these five lines instead.
-- Left as-is, the placeholder is not a valid uuid and this block errors on purpose.
-- (The live project rebuilt on Oct 1 2026 has NO policies; it runs on the service key.)
-- ---------------------------------------------------------------------------------
create policy office_agents_read    on public.office_agents    for select to authenticated using (auth.uid() = '<SUCCESSOR_AUTH_UID>');
create policy office_events_read    on public.office_events    for select to authenticated using (auth.uid() = '<SUCCESSOR_AUTH_UID>');
create policy office_tasks_read     on public.office_tasks     for select to authenticated using (auth.uid() = '<SUCCESSOR_AUTH_UID>');
create policy office_tasks_insert   on public.office_tasks     for insert to authenticated with check (auth.uid() = '<SUCCESSOR_AUTH_UID>');
create policy office_snapshots_read on public.office_snapshots for select to authenticated using (auth.uid() = '<SUCCESSOR_AUTH_UID>');

insert into public.office_agents (id, floor, name, role, cadence_seconds, sprite, sort) values
  ('crawler',  'grow', 'Crawler',        'SalesRabbit sync',        300,  '{"hair":"#4A1B0C","shirt":"#2E9C6D","prop":"net"}',    1),
  ('amplify',  'grow', 'Amplify runner', 'Amplify sync',            300,  '{"hair":"#2C2C2A","shirt":"#2F6FBF","prop":"bolt"}',   2),
  ('rtr',      'grow', 'RTR runner',     'RTR sync',                1800, '{"hair":"#E9B44C","shirt":"#7F77DD","prop":"scroll"}', 3),
  ('courier',  'grow', 'Courier',        'ISP lead files',          300,  '{"hair":"#D85A30","shirt":"#2E9C6D","prop":"satchel"}',4),
  ('exporter', 'grow', 'Exporter',       'ISP exports and reports', 3600, '{"hair":"#5F5E5A","shirt":"#C48A4A","prop":"crate"}',  5)
on conflict (id) do nothing;
