-- Lead records crawled from Amplify, keyed by SalesRabbit's own lead id
-- (the `customerId` that knock_events.lead_id already carries). This is the
-- table that makes "how many times was this door knocked" answerable: the CSV
-- lead export has no id column, so it can never be joined to event history.
--
-- Run once in the Grow Supabase project: SQL Editor -> paste -> Run.

create table if not exists public.amplify_leads (
  id           text primary key,     -- SalesRabbit lead id (== knock_events.lead_id)
  source       text not null default 'grow',
  street       text,
  street2      text,
  city         text,
  state        text,
  zip          text,
  status       text,                 -- current disposition ('Not Interested', ...)
  status_id    integer,
  owner        text,                 -- assigned rep, resolved to a display name
  owner_id     text,
  lat          double precision,
  lng          double precision,
  created_at   timestamptz,
  modified_at  timestamptz,          -- Amplify's own last-modified, not a bulk import stamp
  crawled_at   timestamptz not null default now()
);

create index if not exists amplify_leads_zip_idx    on public.amplify_leads (zip);
create index if not exists amplify_leads_city_idx   on public.amplify_leads (lower(city));
create index if not exists amplify_leads_status_idx on public.amplify_leads (status);
create index if not exists amplify_leads_owner_idx  on public.amplify_leads (owner);

alter table public.amplify_leads enable row level security;
drop policy if exists "anon read amplify_leads"  on public.amplify_leads;
drop policy if exists "anon write amplify_leads" on public.amplify_leads;
create policy "anon read amplify_leads"  on public.amplify_leads for select using (true);
create policy "anon write amplify_leads" on public.amplify_leads for all using (true) with check (true);

-- The payoff: real knock counts per door. knock_events is one row per
-- disposition, so counting them per lead gives attempts, and max(at) gives the
-- genuine last-knocked time (not the export's Updated column, which bulk
-- reassignments overwrite en masse).
create or replace view public.lead_knock_history as
select
  l.id, l.street, l.city, l.state, l.zip, l.status, l.owner,
  count(e.id)                          as knocks,
  count(distinct e.date)               as days_knocked,
  count(distinct e.rep)                as reps,
  min(e.at)                            as first_knock,
  max(e.at)                            as last_knock,
  (array_agg(e.rep  order by e.at desc))[1] as last_knocked_by,
  (array_agg(e.activity order by e.at desc))[1] as last_disposition
from public.amplify_leads l
left join public.knock_events e on e.lead_id = l.id
group by l.id, l.street, l.city, l.state, l.zip, l.status, l.owner;
