-- Callbacks pipeline: people you are in a conversation with (More > Callbacks > Pipeline).
-- Run once in the Grow Supabase project. Re-runnable.
-- Same trust model as callback_assign: the dashboard reads + writes with the anon key.
--
-- key is the call log's deal_key. stage is the board column. texting and call_on
-- are independent flags and can both be on: a live text thread, and a call owed
-- on that day. A due call_on puts the customer back at the top of the Queue.

create table if not exists public.callback_pipeline (
  key          text        primary key,
  stage        text        not null default 'working' check (stage in ('working','interested','won','dead')),
  texting      boolean     not null default false,
  call_on      date,
  customer     text,
  isp          text,
  updated_by   text,
  updated_at   timestamptz default now(),
  created_at   timestamptz default now()
);

alter table public.callback_pipeline enable row level security;
drop policy if exists "anon all callback_pipeline" on public.callback_pipeline;
create policy "anon all callback_pipeline" on public.callback_pipeline for all using (true) with check (true);
grant select, insert, update, delete on public.callback_pipeline to anon;

-- Anyone whose latest call is an open Call back joins the board, so nothing
-- promised before the pipeline existed drops out of the Queue.
insert into public.callback_pipeline (key, stage, call_on, customer, isp, updated_by)
select deal_key, 'working', coalesce(callback_on, (created_at at time zone 'America/Denver')::date + 1), customer, isp, caller
from (
  select distinct on (deal_key) deal_key, outcome, callback_on, created_at, customer, isp, caller
  from public.cancel_callbacks
  where outcome not in ('note', 'text')
  order by deal_key, created_at desc
) latest
where outcome = 'callback'
on conflict (key) do nothing;
