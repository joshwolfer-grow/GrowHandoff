-- Cancel callbacks: one row per call attempt on a cancelled deal.
-- Run once in the Grow Supabase project: SQL Editor -> paste -> Run. Re-runnable.
-- Same trust model as goals/flags/upfront_paid: dashboard reads + writes with the anon key.
--
-- deals is delete-and-reinsert on every sheet sync, so deals.id is NOT stable.
-- deal_key is built client side from customer + sale date + ISP (see _cbKey in
-- index.html) and is what ties attempts back to a deal across syncs.
-- The latest row per deal_key is the deal's state; older rows are its history.

create table if not exists public.cancel_callbacks (
  id           bigserial   primary key,
  deal_key     text        not null,
  customer     text,
  phone        text,
  isp          text,
  rep          text,
  manager      text,
  cancel_date  date,
  outcome      text        not null,   -- no_answer | voicemail | callback | saved | not_interested | bad_number
  notes        text,
  callback_on  date,                   -- set when outcome = callback
  caller       text,
  created_at   timestamptz default now()
);

create index if not exists cancel_callbacks_key_idx  on public.cancel_callbacks (deal_key, created_at desc);
create index if not exists cancel_callbacks_time_idx on public.cancel_callbacks (created_at desc);

alter table public.cancel_callbacks enable row level security;

drop policy if exists "anon read cancel_callbacks"   on public.cancel_callbacks;
drop policy if exists "anon insert cancel_callbacks" on public.cancel_callbacks;
drop policy if exists "anon delete cancel_callbacks" on public.cancel_callbacks;

create policy "anon read cancel_callbacks"   on public.cancel_callbacks for select using (true);
create policy "anon insert cancel_callbacks" on public.cancel_callbacks for insert with check (true);
-- Delete exists only for the Undo button right after logging a call.
create policy "anon delete cancel_callbacks" on public.cancel_callbacks for delete using (true);
