-- Access-code routing: one URL for the company, a code per person.
-- See docs/superpowers/specs/2026-08-05-access-code-routing-design.md
--
-- The table is RLS-denied to anon on purpose. The page ships the anon key
-- (index.html:759), so a directly-readable code table would let any rep dump
-- every code in the company. All access goes through the security-definer
-- functions below: redeem takes one code and answers about that code only,
-- and everything else demands an active corporate code.
--
-- This gates what the app OPENS, not what the anon key can READ. fetchLiveData
-- still pulls every table for every visitor. Stated plainly in the spec.

-- ---------------------------------------------------------------- table

create table if not exists public.access_codes (
  code    text primary key,
  name    text not null,
  role    text not null check (role in ('rep','manager','corporate')),
  active  boolean not null default true,
  added   timestamptz not null default now(),
  seen    timestamptz,
  source  text not null default 'manual' check (source in ('roster','manual'))
);

-- One code per person per role. Makes roster minting idempotent: re-pasting the
-- same roster every week mints nothing new.
create unique index if not exists access_codes_name_role_idx
  on public.access_codes (name, role);
create index if not exists access_codes_role_idx on public.access_codes (role);

alter table public.access_codes enable row level security;

-- No policies are created, so RLS denies anon and authenticated outright.
-- The revoke is belt-and-braces against a future default grant.
revoke all on public.access_codes from anon, authenticated;

-- ---------------------------------------------------------------- helpers

-- 8 chars from an alphabet with no 0/O/1/I/L, so a code read off an email can be
-- thumbed into a phone without ambiguity. The old generator was 6 numeric digits
-- (index.html:19213) — a million-key space, too small once redeem is a public RPC.
create or replace function public._gen_access_code()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  res text := '';
  i int;
begin
  for i in 1..8 loop
    res := res || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return res;
end
$$;

create or replace function public._new_access_code()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c text;
  tries int := 0;
begin
  loop
    c := public._gen_access_code();
    exit when not exists (select 1 from public.access_codes a where a.code = c);
    tries := tries + 1;
    if tries > 50 then
      raise exception 'could not generate a unique access code';
    end if;
  end loop;
  return c;
end
$$;

create or replace function public._is_corp_admin(p_code text)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.access_codes a
    where a.code = p_code and a.role = 'corporate' and a.active
  );
$$;

-- ---------------------------------------------------------------- redeem

-- The only function anon may call without already holding a corporate code.
-- One code in, one answer out: no way to enumerate.
-- Output columns are r_name/r_role rather than name/role to avoid plpgsql
-- ambiguity against the table's own columns.
create or replace function public.redeem_access_code(p_code text)
returns table (r_name text, r_role text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.access_codes a
     set seen = now()
   where a.code = p_code and a.active;

  return query
    select a.name, a.role
      from public.access_codes a
     where a.code = p_code and a.active;
end
$$;

-- ---------------------------------------------------------------- admin

create or replace function public.list_access_codes(p_admin_code text)
returns setof public.access_codes
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public._is_corp_admin(p_admin_code) then
    raise exception 'not authorized';
  end if;
  return query
    select * from public.access_codes
     order by case role when 'corporate' then 0 when 'manager' then 1 else 2 end,
              name;
end
$$;

-- Mints codes for roster names that don't have one. Idempotent.
--
-- A name in p_managers gets a manager code and is skipped for rep even if it
-- also appears in p_reps: block leaders on the weekly paste often sell too, and
-- two codes for one person is a support call waiting to happen. Manager wins
-- because it is the broader view.
--
-- Nobody is deactivated here. Auto-retiring on roster absence would cut off
-- someone who was out sick or between teams.
create or replace function public.sync_roster_codes(
  p_admin_code text,
  p_managers   text[],
  p_reps       text[]
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n text;
  minted int := 0;
begin
  if not public._is_corp_admin(p_admin_code) then
    raise exception 'not authorized';
  end if;

  foreach n in array coalesce(p_managers, '{}')
  loop
    n := btrim(n);
    continue when n = '';
    if not exists (select 1 from public.access_codes a where a.name = n) then
      insert into public.access_codes (code, name, role, source)
      values (public._new_access_code(), n, 'manager', 'roster');
      minted := minted + 1;
    end if;
  end loop;

  foreach n in array coalesce(p_reps, '{}')
  loop
    n := btrim(n);
    continue when n = '';
    if not exists (select 1 from public.access_codes a where a.name = n) then
      insert into public.access_codes (code, name, role, source)
      values (public._new_access_code(), n, 'rep', 'roster');
      minted := minted + 1;
    end if;
  end loop;

  return minted;
end
$$;

create or replace function public.upsert_access_code(
  p_admin_code text,
  p_name       text,
  p_role       text,
  p_code       text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c text;
begin
  if not public._is_corp_admin(p_admin_code) then
    raise exception 'not authorized';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'name is required';
  end if;
  if p_role not in ('rep','manager','corporate') then
    raise exception 'bad role';
  end if;

  c := nullif(btrim(upper(coalesce(p_code, ''))), '');
  if c is null then
    c := public._new_access_code();
  elsif exists (select 1 from public.access_codes a where a.code = c) then
    raise exception 'that code is already in use';
  end if;

  insert into public.access_codes (code, name, role, source)
  values (c, btrim(p_name), p_role, 'manual')
  on conflict (name, role) do update
    set active = true;

  -- On conflict the existing row kept its own code; report what the caller
  -- should actually hand out.
  select a.code into c
    from public.access_codes a
   where a.name = btrim(p_name) and a.role = p_role;

  return c;
end
$$;

create or replace function public.set_access_code_active(
  p_admin_code text,
  p_code       text,
  p_active     boolean
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public._is_corp_admin(p_admin_code) then
    raise exception 'not authorized';
  end if;

  -- Don't let the last working corporate code turn itself off: that locks
  -- everyone out of the only screen that can turn codes back on.
  if p_active is false
     and exists (select 1 from public.access_codes a
                  where a.code = p_code and a.role = 'corporate' and a.active)
     and (select count(*) from public.access_codes a
           where a.role = 'corporate' and a.active) <= 1 then
    raise exception 'cannot disable the last active corporate code';
  end if;

  update public.access_codes a set active = p_active where a.code = p_code;
  return found;
end
$$;

create or replace function public.delete_access_code(
  p_admin_code text,
  p_code       text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public._is_corp_admin(p_admin_code) then
    raise exception 'not authorized';
  end if;

  if exists (select 1 from public.access_codes a
              where a.code = p_code and a.role = 'corporate' and a.active)
     and (select count(*) from public.access_codes a
           where a.role = 'corporate' and a.active) <= 1 then
    raise exception 'cannot remove the last active corporate code';
  end if;

  delete from public.access_codes a where a.code = p_code;
  return found;
end
$$;

-- ---------------------------------------------------------------- grants

-- Postgres grants EXECUTE on a new function to PUBLIC by default, so revoking from
-- anon alone leaves it callable — the first version of this migration did exactly
-- that and the test suite caught it. Every revoke below must name `public`.
--
-- Helpers stay private. _is_corp_admin especially: it answers "is this a corporate
-- code?" for any string, which is a brute-force oracle against the codes that
-- matter most.
revoke all on function public._gen_access_code()   from public, anon, authenticated;
revoke all on function public._new_access_code()   from public, anon, authenticated;
revoke all on function public._is_corp_admin(text) from public, anon, authenticated;

-- The six entry points: anon only. The app has no Supabase Auth and never holds an
-- authenticated JWT, so `authenticated` would widen the surface for a role that
-- does not exist here.
revoke all on function public.redeem_access_code(text)                    from public, authenticated;
revoke all on function public.list_access_codes(text)                     from public, authenticated;
revoke all on function public.sync_roster_codes(text, text[], text[])     from public, authenticated;
revoke all on function public.upsert_access_code(text, text, text, text)  from public, authenticated;
revoke all on function public.set_access_code_active(text, text, boolean) from public, authenticated;
revoke all on function public.delete_access_code(text, text)              from public, authenticated;

grant execute on function public.redeem_access_code(text)                    to anon;
grant execute on function public.list_access_codes(text)                     to anon;
grant execute on function public.sync_roster_codes(text, text[], text[])     to anon;
grant execute on function public.upsert_access_code(text, text, text, text)  to anon;
grant execute on function public.set_access_code_active(text, text, boolean) to anon;
grant execute on function public.delete_access_code(text, text)              to anon;

-- The Supabase linter flags these as "anon can execute a SECURITY DEFINER function"
-- and "RLS enabled with no policy". Both are the intended design, not oversights:
-- anon MUST be able to redeem a code, and the table MUST be unreachable except
-- through these functions.

-- ---------------------------------------------------------------- migration

-- Carry the existing corporate codes over verbatim so nobody has to learn a new
-- one. Source: report_config.__corp_users__ (index.html:19110).
insert into public.access_codes (code, name, role, active, added, seen, source)
select u->>'code',
       u->>'name',
       'corporate',
       coalesce((u->>'active')::boolean, true),
       coalesce((u->>'added')::timestamptz, now()),
       nullif(u->>'seen','')::timestamptz,
       'manual'
  from public.report_config rc,
       jsonb_array_elements(rc.config->'users') u
 where rc.manager = '__corp_users__'
   and coalesce(u->>'code','') <> ''
   and coalesce(u->>'name','') <> ''
on conflict do nothing;
