-- Ezee Fiber addresses, as Ezee spells them. Fed daily from the Opendoor RTR
-- "Activity_Detail" report (one row per knock) by scripts/ezee-addresses-sync.mjs,
-- mirrored into the "Ezee Addresses" Google Sheet on the corporate Drive by
-- scripts/ezee-addresses-sheet.gs. Ezee only credits a deal when the address
-- matches their own record, so Bria uses this list to find deals we are missing.
-- Run once in the Grow Supabase project: SQL Editor -> paste -> Run.

-- One row per knock. form_instance_id is Ezee's own id for the submission, so
-- re-pulling a date range is idempotent and knock counts never double.
create table if not exists public.ezee_knocks (
  form_instance_id text primary key,
  address_id   text not null,           -- ezee_addresses.id
  agent        text,
  team         text,                    -- BU_Level_3 e.g. "Houston Contractor Team 5"
  disposition  text,
  submitted    timestamp,               -- Ezee local time as printed on the report
  date         date not null,
  sale         boolean not null default false,
  customer_name text,
  distance_ft  numeric
);
create index if not exists ezee_knocks_address_idx on public.ezee_knocks (address_id);
create index if not exists ezee_knocks_date_idx    on public.ezee_knocks (date);

-- One row per address. Rebuilt from ezee_knocks for every address a sync touches.
create table if not exists public.ezee_addresses (
  id            text primary key,       -- Ezee Customer_Nbr, or addr:<normalized> when blank
  customer_nbr  text,
  house         text,
  street        text,
  unit          text,
  city          text,
  state         text,
  zip           text,
  address       text,                   -- "14 N HUDSON ST" exactly as Ezee prints it
  team          text,
  segment       text,
  property_type text,                   -- cust_misc1 (NonSub / Sub ...)
  area          text,                   -- Cust_Misc8 e.g. "Downers Grove #1"
  first_seen    date,
  last_seen     date,
  knocks        integer not null default 0,
  last_disposition text,
  last_rep      text,
  sold          boolean not null default false,
  sold_date     date,
  sold_rep      text,
  customer_name text,
  updated_at    timestamptz not null default now()
);
create index if not exists ezee_addresses_last_seen_idx on public.ezee_addresses (last_seen desc);
create index if not exists ezee_addresses_zip_idx       on public.ezee_addresses (zip);

alter table public.ezee_knocks    enable row level security;
alter table public.ezee_addresses enable row level security;
drop policy if exists "anon read ezee_knocks"     on public.ezee_knocks;
drop policy if exists "anon write ezee_knocks"    on public.ezee_knocks;
drop policy if exists "anon read ezee_addresses"  on public.ezee_addresses;
drop policy if exists "anon write ezee_addresses" on public.ezee_addresses;
create policy "anon read ezee_knocks"     on public.ezee_knocks    for select using (true);
create policy "anon write ezee_knocks"    on public.ezee_knocks    for all using (true) with check (true);
create policy "anon read ezee_addresses"  on public.ezee_addresses for select using (true);
create policy "anon write ezee_addresses" on public.ezee_addresses for all using (true) with check (true);
