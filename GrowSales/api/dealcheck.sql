-- Deal Check: a call queue for verifying ISP deal lists before they go back to the ISP.
-- Run once in the Grow Supabase project: SQL Editor -> paste -> Run. Re-runnable.
-- Same trust model as the Callbacks tables: the dashboard reads + writes with the anon key.
--
-- An ISP (Ezee first) hands over a list of deals it wants checked. A caller works
-- the list with the script on screen and marks each one Clean Deal, Didn't order,
-- No Answer or Bad Phone Number. The result goes back to the ISP as a CSV.
-- Tables mirror Callbacks: leads (the list), calls (every attempt), assign (who
-- works what), scripts (the call script, one per ISP, edited in the app).

create table if not exists public.dealcheck_leads (
  id           text        primary key,          -- '<isp slug>:<order number>' when the list has one, else phone or address
  isp          text        not null,
  list         text        not null,             -- which handed-over list (file name or the name given at import)
  row_no       integer,                          -- position in that list; the queue keeps the ISP's order
  order_no     text,
  customer     text,
  phone        text,
  phone2       text,
  email        text,
  address      text,
  city         text,
  state        text,
  zip          text,
  package      text,
  list_notes   text,                             -- whatever the ISP wrote on the row
  sale_date    date,
  deal_key     text,                             -- matched Grow deal (customer|sale date|isp), null when no match
  grow_rep     text,
  grow_manager text,
  grow_status  text,
  imported_at  timestamptz default now(),
  updated_at   timestamptz default now()
);
create index if not exists dealcheck_leads_list_idx on public.dealcheck_leads (isp, list, row_no);

-- One row per call attempt. key is 'dc:' || dealcheck_leads.id. The newest row
-- per key is the lead's state; older rows are its history.
create table if not exists public.dealcheck_calls (
  id           bigserial   primary key,
  key          text        not null,
  customer     text,
  phone        text,
  isp          text,
  list         text,
  rep          text,
  outcome      text        not null,   -- clean | didnt_order | no_answer | bad_number | note
  notes        text,
  caller       text,
  created_at   timestamptz default now()
);
create index if not exists dealcheck_calls_key_idx  on public.dealcheck_calls (key, created_at desc);
create index if not exists dealcheck_calls_time_idx on public.dealcheck_calls (created_at desc);

create table if not exists public.dealcheck_assign (
  key          text        primary key,
  assignee     text        not null,
  assigned_by  text,
  assigned_at  timestamptz default now()
);

create table if not exists public.dealcheck_scripts (
  isp          text        primary key,
  script       text        not null default '',
  updated_by   text,
  updated_at   timestamptz default now()
);

alter table public.dealcheck_leads   enable row level security;
alter table public.dealcheck_calls   enable row level security;
alter table public.dealcheck_assign  enable row level security;
alter table public.dealcheck_scripts enable row level security;
drop policy if exists "anon all dealcheck_leads"   on public.dealcheck_leads;
drop policy if exists "anon all dealcheck_calls"   on public.dealcheck_calls;
drop policy if exists "anon all dealcheck_assign"  on public.dealcheck_assign;
drop policy if exists "anon all dealcheck_scripts" on public.dealcheck_scripts;
create policy "anon all dealcheck_leads"   on public.dealcheck_leads   for all using (true) with check (true);
create policy "anon all dealcheck_calls"   on public.dealcheck_calls   for all using (true) with check (true);
create policy "anon all dealcheck_assign"  on public.dealcheck_assign  for all using (true) with check (true);
create policy "anon all dealcheck_scripts" on public.dealcheck_scripts for all using (true) with check (true);
grant select, insert, update, delete on public.dealcheck_leads, public.dealcheck_calls, public.dealcheck_assign, public.dealcheck_scripts to anon;

-- A starting script for Ezee. Edit it in the app (Deal Check > Edit script).
-- {first} {customer} {rep} {isp} {address} {caller} fill in from the lead.
insert into public.dealcheck_scripts (isp, script, updated_by) values ('Ezee Fiber',
'Hi, is this {first}? This is {caller} calling with Grow on behalf of Ezee Fiber.

I am following up on the fiber internet order at {address} that was placed with our rep {rep}. This will only take a minute.

1. Did you sign up for Ezee Fiber service with {rep}?
2. Is {address} the right install address?
3. Has anyone from Ezee reached out about your install date yet?

That is everything I needed. Thanks for your time, and welcome to Ezee Fiber.', 'seed')
on conflict (isp) do nothing;
