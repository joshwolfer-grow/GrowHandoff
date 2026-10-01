-- Pronto deal-data tables. Run once in the Grow Supabase project:
-- SQL Editor -> paste -> Run. Re-runnable (IF NOT EXISTS).
--
-- pronto_messages      raw channel messages (source of truth, upsert on id)
-- pronto_deal_events   derived deal events (recomputed per bubble each sync,
--                      so the emoji-parsing rules can evolve without re-pulling)
-- pronto_sync_meta     one row per channel: last sync, tz, counts

create table if not exists public.pronto_messages (
  id             bigint primary key,          -- Pronto message id (monotonic)
  bubble_id      bigint not null,             -- channel id
  user_id        bigint,
  fullname       text,
  message        text,
  created_at_utc timestamptz,
  inserted_at    timestamptz default now()
);
create index if not exists pronto_messages_bubble_idx
  on public.pronto_messages (bubble_id, id);

create table if not exists public.pronto_deal_events (
  message_id     bigint  not null,
  seq            integer not null,            -- 1..N when one message adds N deals
  bubble_id      bigint,
  user_id        bigint,
  fullname       text,
  emoji          text,
  local_date     date,                        -- market-local calendar day
  local_hour     integer,                     -- market-local hour 0-23
  created_at_utc timestamptz,
  is_golden      boolean default false,       -- local 20:00-20:59
  bulk_flag      boolean default false,       -- backfill dump: keep in totals, skip in hourly curve
  updated_at     timestamptz default now(),
  primary key (message_id, seq)
);
create index if not exists pronto_events_bubble_date_idx
  on public.pronto_deal_events (bubble_id, local_date);

create table if not exists public.pronto_sync_meta (
  bubble_id      bigint primary key,
  market         text,
  tz             text,                        -- IANA zone, e.g. America/Chicago
  last_run       timestamptz,
  max_message_id bigint,
  raw_count      integer,
  event_count    integer,
  duration_ms    integer
);

-- The dashboard reads these with the public anon key, so allow read.
alter table public.pronto_messages    enable row level security;
alter table public.pronto_deal_events enable row level security;
alter table public.pronto_sync_meta   enable row level security;

drop policy if exists "anon read pronto_messages"    on public.pronto_messages;
drop policy if exists "anon read pronto_deal_events" on public.pronto_deal_events;
drop policy if exists "anon read pronto_sync_meta"   on public.pronto_sync_meta;

create policy "anon read pronto_messages"    on public.pronto_messages    for select using (true);
create policy "anon read pronto_deal_events" on public.pronto_deal_events for select using (true);
create policy "anon read pronto_sync_meta"   on public.pronto_sync_meta   for select using (true);
-- Writes come from api/pronto-sync.js using the service_role key, which bypasses RLS.
