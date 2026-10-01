-- Cancel callback leads, assignments and caller logins.
-- Run once in the Grow Supabase project: SQL Editor -> paste -> Run. Re-runnable.
-- Same trust model as cancel_callbacks: the dashboard reads + writes with the anon key.
-- See api/cancel-callbacks.sql for the call log itself.

-- One row per customer on an ISP's cancel list (scripts/callback-import.mjs).
-- deal_key is set when the row matched a Grow deal, in the same shape as the
-- call log's key (customer | sale date | isp), so calls on a matched lead land
-- on the deal card too. Unmatched rows use 'lead:' || id as their key.
create table if not exists public.callback_leads (
  id           text        primary key,          -- '<isp slug>:<ISP order number>', e.g. 'lyte:WO-10778'
  isp          text        not null,
  order_no     text,
  isp_status   text,
  customer     text,
  phone        text,
  phone2       text,
  email        text,
  address      text,
  city         text,
  state        text,
  zip          text,
  area         text,
  isp_notes    text,
  cancel_date  date,
  dnc          boolean     default false,        -- the ISP's notes say do not call
  deal_key     text,                             -- matched Grow deal, null when not ours
  grow_rep     text,
  grow_manager text,
  grow_status  text,                             -- what our deals feed says (often still Pending)
  batch        text,                             -- file it came from
  imported_at  timestamptz default now(),
  updated_at   timestamptz default now()
);
create index if not exists callback_leads_deal_idx on public.callback_leads (deal_key);

-- Who works which lead. key is the call log's deal_key (Grow deals feed and
-- matched leads) or 'lead:<id>'. No row = unassigned.
create table if not exists public.callback_assign (
  key          text        primary key,
  assignee     text        not null,
  assigned_by  text,
  assigned_at  timestamptz default now()
);

alter table public.callback_leads  enable row level security;
alter table public.callback_assign enable row level security;
drop policy if exists "anon all callback_leads"  on public.callback_leads;
drop policy if exists "anon all callback_assign" on public.callback_assign;
create policy "anon all callback_leads"  on public.callback_leads  for all using (true) with check (true);
create policy "anon all callback_assign" on public.callback_assign for all using (true) with check (true);
grant select, insert, update, delete on public.callback_leads, public.callback_assign to anon;

-- Caller logins. caller sees only the Callbacks page and only their own leads;
-- caller_lead also sees everyone's and hands them out.
alter table public.access_codes drop constraint if exists access_codes_role_check;
alter table public.access_codes add constraint access_codes_role_check
  check (role = any (array['rep','manager','corporate','caller','caller_lead']));

create or replace function public.upsert_access_code(p_admin_code text, p_name text, p_role text, p_code text default null)
returns text language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare c text;
begin
  if not public._is_corp_admin(p_admin_code) then raise exception 'not authorized'; end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'name is required'; end if;
  if p_role not in ('rep','manager','corporate','caller','caller_lead') then raise exception 'bad role'; end if;
  c := nullif(btrim(upper(coalesce(p_code, ''))), '');
  if c is null then c := public._new_access_code();
  elsif exists (select 1 from public.access_codes a where a.code = c) then raise exception 'that code is already in use';
  end if;
  insert into public.access_codes (code, name, role, source) values (c, btrim(p_name), p_role, 'manual')
  on conflict (name, role) do update set active = true;
  select a.code into c from public.access_codes a where a.name = btrim(p_name) and a.role = p_role;
  return c;
end $$;

-- Names (never codes) of everyone who can take leads, for the assign menus.
create or replace function public.list_callers()
returns table(r_name text, r_role text) language sql security definer set search_path to 'public','pg_temp' as $$
  select a.name, a.role from public.access_codes a
   where a.active and a.role in ('caller','caller_lead')
   order by a.name;
$$;
grant execute on function public.list_callers() to anon;
