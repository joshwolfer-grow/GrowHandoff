-- Tables the Bria sync writes into and the dashboard reads.
-- Run once in the Grow Supabase project: SQL Editor -> paste -> Run.
-- Re-runnable (IF NOT EXISTS). The sync upserts on the natural keys below.

-- Per-rep / per-course training completion (one row per rep+course).
create table if not exists public.training_completion (
  rep           text        not null,
  course        text        not null,
  start_date    date,
  lessons_done  integer,
  lessons_total integer,
  lesson_pct    integer,
  quiz          text,                 -- 'pass' | 'fail NN%' | 'not taken' | '—'
  complete      boolean     default false,
  overdue_days  integer,
  updated_at    timestamptz default now(),
  primary key (rep, course)
);

-- Per-rep / per-day deal counts from Bria's sales table.
create table if not exists public.bria_sales_daily (
  rep        text    not null,
  sale_date  date    not null,
  deals      integer default 0,
  installs   integer default 0,
  updated_at timestamptz default now(),
  primary key (rep, sale_date)
);

-- Deal-level Bria records (for customer-name reconciliation vs the dashboard).
create table if not exists public.bria_deals (
  bria_id      text    primary key,   -- Bria sales.id (stable natural key)
  rep          text,
  customer     text,
  phone        text,
  isp          text,                 -- Bria sales.client_company_name (the ISP)
  product      text,                 -- Bria sales.product_label (the package)
  sale_date    date,
  install_date date,
  install_time     text,            -- Bria sales.install_time (install window start)
  install_end_time text,            -- Bria sales.install_end_time (window end)
  updated_at   timestamptz default now()
);
-- If the table already existed, add the newer columns:
alter table public.bria_deals add column if not exists phone text;
alter table public.bria_deals add column if not exists isp text;
alter table public.bria_deals add column if not exists product text;
alter table public.bria_deals add column if not exists install_time text;
alter table public.bria_deals add column if not exists install_end_time text;

-- Single-row status/heartbeat for the last sync.
create table if not exists public.bria_sync_meta (
  id               integer primary key,
  last_run         timestamptz,
  completion_rows  integer,
  sales_daily_rows integer,
  bria_sales_total integer,
  bria_users       integer,
  duration_ms      integer
);

-- The dashboard reads these with the public anon key, so allow read.
alter table public.training_completion enable row level security;
alter table public.bria_sales_daily   enable row level security;
alter table public.bria_deals         enable row level security;
alter table public.bria_sync_meta     enable row level security;

drop policy if exists "anon read training_completion" on public.training_completion;
drop policy if exists "anon read bria_sales_daily"   on public.bria_sales_daily;
drop policy if exists "anon read bria_deals"         on public.bria_deals;
drop policy if exists "anon read bria_sync_meta"     on public.bria_sync_meta;

create policy "anon read training_completion" on public.training_completion for select using (true);
create policy "anon read bria_sales_daily"   on public.bria_sales_daily   for select using (true);
create policy "anon read bria_deals"         on public.bria_deals         for select using (true);
create policy "anon read bria_sync_meta"     on public.bria_sync_meta     for select using (true);
-- Writes come from the sync using the service_role key, which bypasses RLS.
