-- Event-level knocking data from the Amplify sync (one row per disposition).
-- Powers revisit tracking: same lead_id across multiple dates = rep went back.
-- Run once in the Grow Supabase project: SQL Editor -> paste -> Run.

create table if not exists public.knock_events (
  id          bigint primary key,   -- Amplify report row id (stable, makes re-syncs idempotent)
  lead_id     text,                 -- SalesRabbit lead (customerId): the door
  rep         text not null,
  rep_id      text,
  team_id     integer,
  activity_id integer,
  activity    text,                 -- 'Not Home 1', 'Sold', ... ('Other' for rare ones)
  at          timestamptz,          -- exact event time (UTC)
  date        date not null         -- local knocking date (matches knocking.date)
);

create index if not exists knock_events_lead_idx     on public.knock_events (lead_id);
create index if not exists knock_events_rep_date_idx on public.knock_events (rep, date);
create index if not exists knock_events_date_idx     on public.knock_events (date);

alter table public.knock_events enable row level security;
drop policy if exists "anon read knock_events"  on public.knock_events;
drop policy if exists "anon write knock_events" on public.knock_events;
create policy "anon read knock_events"  on public.knock_events for select using (true);
create policy "anon write knock_events" on public.knock_events for all using (true) with check (true);
