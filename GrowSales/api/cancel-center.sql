-- Cancel Center (More > Callbacks: Today / Reports / Setup). Run once. Re-runnable.
-- Same trust model as the other callback tables: the app reads and writes with the anon key.
--
-- 1. Promos the callers may offer, per ISP. Shown as a picker on the call card and
--    counted on Reports > Promos. Managed on Setup.
-- 2. Two tags on every logged call: the reason the caller heard and the promo they
--    offered. Both optional; Reports read them.
-- 3. Queue rules (wait days, window, retries) so Setup can change them without a deploy.

create table if not exists public.cancel_promos (
  id          bigserial   primary key,
  isp         text        not null,          -- matches deals.isp / callback_leads.isp, or '*' for every ISP
  offer       text        not null,          -- what the caller says: "3 months free"
  detail      text,                          -- fine print for the caller
  cost        text,                          -- who pays, rough cost, free text
  ends_on     date,                          -- null = open ended
  active      boolean     not null default true,
  sort        int         not null default 0,
  updated_by  text,
  updated_at  timestamptz default now(),
  created_at  timestamptz default now()
);
alter table public.cancel_promos enable row level security;
drop policy if exists "anon all cancel_promos" on public.cancel_promos;
create policy "anon all cancel_promos" on public.cancel_promos for all using (true) with check (true);
grant select, insert, update, delete on public.cancel_promos to anon;
grant usage, select on sequence public.cancel_promos_id_seq to anon;

alter table public.cancel_callbacks add column if not exists reason text;   -- price | install_wait | didnt_know | moved | kept_isp | no_service | other
alter table public.cancel_callbacks add column if not exists promo  text;   -- cancel_promos.offer as offered, or 'none'
-- Reports change the caller's own mind later ("that was really a price cancel"):
-- let the newest row be edited in place.
drop policy if exists "anon update cancel_callbacks" on public.cancel_callbacks;
create policy "anon update cancel_callbacks" on public.cancel_callbacks for update using (true) with check (true);
grant update on public.cancel_callbacks to anon;

create table if not exists public.cancel_settings (
  key         text        primary key,
  value       text        not null,
  updated_by  text,
  updated_at  timestamptz default now()
);
alter table public.cancel_settings enable row level security;
drop policy if exists "anon all cancel_settings" on public.cancel_settings;
create policy "anon all cancel_settings" on public.cancel_settings for all using (true) with check (true);
grant select, insert, update, delete on public.cancel_settings to anon;
insert into public.cancel_settings (key, value) values
  ('wait_days', '7'), ('window_days', '0'), ('retry_days', '2'), ('max_tries', '3'), ('save_goal_pct', '25')
on conflict (key) do nothing;
