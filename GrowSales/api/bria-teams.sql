-- Bria teams as the dashboard's roster source (Sep 29 2026).
-- bria_deals.team_id = the team each sale was booked under.
-- bria_teams / bria_memberships are stored raw because the read-only role
-- cannot show column names ahead of time; the app reads name/manager from raw.
alter table public.bria_deals add column if not exists team_id text;

create table if not exists public.bria_teams (
  id         text primary key,
  name       text,
  raw        jsonb,
  updated_at timestamptz default now()
);
create table if not exists public.bria_memberships (
  id         text primary key,
  user_id    text,
  rep        text,
  team_id    text,
  raw        jsonb,
  updated_at timestamptz default now()
);
alter table public.bria_teams enable row level security;
alter table public.bria_memberships enable row level security;
drop policy if exists bria_teams_read on public.bria_teams;
create policy bria_teams_read on public.bria_teams for select to anon, authenticated using (true);
drop policy if exists bria_memberships_read on public.bria_memberships;
create policy bria_memberships_read on public.bria_memberships for select to anon, authenticated using (true);
