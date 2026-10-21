-- Rep GPS trail (More > Rep Map). One row per SalesRabbit profile_location ping
-- (about every 5 min while the app runs). Filled by scripts/rep-locations-sync.mjs
-- on every SalesRabbit tick. Kept small: noon to 10pm in the rep's own zone only,
-- and nothing older than 31 days (prune_rep_gps(), called by the sync; this
-- project has no pg_cron). Points never change, so inserts ignore duplicates and
-- there is no update policy. ~2.4 MB for a full month as of 2026-10-07.
create table if not exists rep_gps (
  id          uuid primary key,
  profile_id  uuid not null,
  rep         text,
  ts          timestamptz not null,
  lat         real not null,
  lng         real not null
);
create index if not exists rep_gps_ts on rep_gps using brin (ts);
alter table rep_gps enable row level security;
drop policy if exists rep_gps_read on rep_gps;
create policy rep_gps_read on rep_gps for select to anon, authenticated using (true);
drop policy if exists rep_gps_insert on rep_gps;
create policy rep_gps_insert on rep_gps for insert to anon with check (ts > now() - interval '31 days');

create or replace function prune_rep_gps() returns integer
language sql security definer set search_path = public as $$
  with d as (delete from rep_gps where ts < now() - interval '31 days' returning 1)
  select count(*)::int from d;
$$;
revoke all on function prune_rep_gps() from public;
grant execute on function prune_rep_gps() to anon, authenticated;

-- The first, fat version of this table. Nothing reads it. Drop by hand:
-- drop table if exists rep_locations;
