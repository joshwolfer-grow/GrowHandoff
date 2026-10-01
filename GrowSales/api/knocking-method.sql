-- Add `method` to knocking: HOW a row was produced, as opposed to `source`
-- (which company it belongs to). Without this the only thing separating an
-- Amplify-derived row from a Time Track import is the created_at timestamp of
-- the load, which is not something anyone should have to reverse engineer.
--
-- Run once in the Grow Supabase project: SQL Editor -> paste -> Run.

alter table public.knocking add column if not exists method text;

-- Backfill from what we can still tell apart by load time. Verified Jul 28 2026:
--   grow, loaded Jul 20-21  ->  809 rows, Jun 1..Jul 20, the Amplify backfill
--   grow, loaded Jul 28     -> 4141 rows, Jan 18..Jul 27, the Time Track import
--   ezee, loaded Jul 29     -> 4141 rows, byte-identical to the grow set above
--   tds,  loaded Jul 23     ->  118 rows, from the Amplify company sync
update public.knocking set method = 'amplify'
  where method is null and source = 'grow' and created_at < '2026-07-22';
update public.knocking set method = 'timetrack'
  where method is null and source = 'grow' and created_at >= '2026-07-22';
update public.knocking set method = 'timetrack'
  where method is null and source = 'ezee';
update public.knocking set method = 'amplify'
  where method is null and source = 'tds';

create index if not exists knocking_method_idx on public.knocking (method);

-- Check before anything gets deleted or loaded.
select method, source, count(*) as rows, min(date) as from_date, max(date) as to_date
from public.knocking group by method, source order by method, source;
