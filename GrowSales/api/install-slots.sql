-- Earliest install availability per ISP market, written by scripts/install-slots.mjs
-- 2 or 3 times a day. One row per market per run; the latest row per (isp, market)
-- is the current read. grid = [{date, windows}] of bookable days the flow offered.
create table if not exists public.install_slots (
  id bigserial primary key,
  isp text not null,
  market text not null,
  address text,
  checked_at timestamptz not null default now(),
  earliest_date date,
  days_out int,
  windows_first_day int,
  windows_next_7d int,
  grid jsonb,
  ok boolean not null default true,
  error text
);
create index if not exists install_slots_isp_market_idx on public.install_slots (isp, market, checked_at desc);

alter table public.install_slots enable row level security;
drop policy if exists install_slots_read on public.install_slots;
create policy install_slots_read on public.install_slots for select to anon, authenticated using (true);
drop policy if exists install_slots_insert on public.install_slots;
create policy install_slots_insert on public.install_slots for insert to anon with check (true);

create or replace view public.install_slots_latest with (security_invoker = true) as
select distinct on (isp, market) *
from public.install_slots
where ok
order by isp, market, checked_at desc;
grant select on public.install_slots_latest to anon, authenticated;
