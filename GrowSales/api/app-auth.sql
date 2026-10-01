-- Email + password sign in, tied to Sequifi. Level 1 of moving off access codes.
-- Applied live Sep 16 2026. Re-runnable.
--
-- Accounts are real Supabase Auth users, created by api/auth.js after the person
-- proves the email with a 6 digit code (Gmail SMTP, not Supabase's mailer). The
-- app signs in with the password grant and asks whoami() who it is. Nothing in
-- here changes what data the anon key can read; that is level 3.
--
-- Who gets in (login_role_for):
--   app_users row, not disabled, role set   -> that role (corporate or manager)
--   ran a team on the Sequifi weekly roster in the last 5 weeks -> manager
--   anyone else                               -> 'none' (in Sequifi, no access yet)
-- Sequifi's is_manager flag alone is NOT enough: people keep it after they stop
-- running a team.

create table if not exists public.app_users (
  email      text primary key,               -- lower case
  role       text check (role in ('corporate','manager','none')),  -- null = decide from Sequifi
  name       text,                            -- overrides the Sequifi name (must match the roster name for managers)
  perms      jsonb,                           -- manager page perms, same shape as access_codes.perms; null = every page, team scope
  disabled   boolean not null default false,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.app_users enable row level security;

-- One pending code per email. Service role only.
create table if not exists public.auth_codes (
  email      text primary key,
  code_hash  text not null,
  expires_at timestamptz not null,
  attempts   int not null default 0,
  sent_at    timestamptz not null default now(),
  hour_start timestamptz not null default now(),
  hour_sends int not null default 1
);
alter table public.auth_codes enable row level security;

create or replace function public.login_role_for(p_email text)
returns table(r_email text, r_name text, r_role text, r_perms jsonb, r_in_sequifi boolean)
language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare
  e text := lower(btrim(coalesce(p_email,'')));
  u public.app_users;
  o record;
  nm text;
  mgr boolean := false;
begin
  if e = '' then return; end if;
  select * into u from public.app_users a where a.email = e;
  if found and u.disabled then return; end if;
  select first_name, last_name into o from public.rep_onboarding r
   where lower(btrim(r.email)) = e
   order by r.is_manager desc, r.onboarding_complete desc, r.last_seen_at desc nulls last limit 1;
  nm := coalesce(nullif(btrim(u.name),''), nullif(btrim(coalesce(o.first_name,'')||' '||coalesce(o.last_name,'')),''));
  if u.email is not null and u.role is not null then
    return query select e, coalesce(nm, e), u.role, u.perms, o.first_name is not null or o.last_name is not null;
    return;
  end if;
  if nm is null then return; end if;   -- not in Sequifi and not added by hand
  select exists (
    select 1 from public.report_config r, jsonb_each(r.config->'weeks') w
     where r.manager = '__sequifi_teams__'
       and w.key >= to_char(current_date - 35, 'YYYY-MM-DD')
       and w.value ? nm
  ) into mgr;
  return query select e, nm, case when mgr then 'manager' else 'none' end, u.perms, true;
end $$;
revoke all on function public.login_role_for(text) from public, anon, authenticated;
grant execute on function public.login_role_for(text) to service_role;

-- The signed in person. Called by the app with the user's access token.
create or replace function public.whoami()
returns table(r_email text, r_name text, r_role text, r_perms jsonb)
language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare e text := lower(coalesce(auth.jwt()->>'email',''));
begin
  if e = '' or coalesce(auth.role(),'') <> 'authenticated' then return; end if;
  return query select l.r_email, l.r_name, l.r_role, l.r_perms from public.login_role_for(e) l;
end $$;
revoke all on function public.whoami() from public, anon;
grant execute on function public.whoami() to authenticated;

-- Admin RPCs keep taking p_admin_code; an email corporate session passes '' and
-- is recognised from its token instead.
create or replace function public._is_corp_admin(p_code text)
returns boolean language sql security definer set search_path to 'public','pg_temp' as $$
  select exists (select 1 from public.access_codes a where a.code = p_code and a.role = 'corporate' and a.active)
      or exists (select 1 from public.app_users u
                  where coalesce(auth.role(),'') = 'authenticated'
                    and u.email = lower(coalesce(auth.jwt()->>'email',''))
                    and u.role = 'corporate' and not u.disabled);
$$;

-- Everyone with an account or a hand-added row, with the role they resolve to.
create or replace function public.list_app_users(p_admin_code text)
returns table(email text, set_role text, name text, disabled boolean, perms jsonb, resolved_role text, resolved_name text, has_account boolean, last_sign_in timestamptz)
language plpgsql security definer set search_path to 'public','pg_temp','auth' as $$
begin
  if not public._is_corp_admin(p_admin_code) then raise exception 'not authorized'; end if;
  return query
  with emails as (
    select a.email from public.app_users a
    union select lower(x.email) from auth.users x where x.email is not null
  )
  select m.email, a.role, a.name, coalesce(a.disabled,false), a.perms,
         l.r_role, l.r_name, x.id is not null, x.last_sign_in_at
    from emails m
    left join public.app_users a on a.email = m.email
    left join auth.users x on lower(x.email) = m.email
    left join lateral public.login_role_for(m.email) l on true
   order by (a.role = 'corporate') desc nulls last, x.last_sign_in_at desc nulls last, m.email;
end $$;

create or replace function public.upsert_app_user(p_admin_code text, p_email text, p_role text, p_disabled boolean default false, p_name text default null, p_perms jsonb default null)
returns boolean language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare e text := lower(btrim(coalesce(p_email,'')));
begin
  if not public._is_corp_admin(p_admin_code) then raise exception 'not authorized'; end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'enter a valid email'; end if;
  if p_role is not null and p_role not in ('corporate','manager','none') then raise exception 'bad role'; end if;
  insert into public.app_users (email, role, disabled, name, perms, updated_by, updated_at)
  values (e, p_role, coalesce(p_disabled,false), nullif(btrim(p_name),''), p_perms, lower(coalesce(auth.jwt()->>'email','code')), now())
  on conflict (email) do update set role = excluded.role, disabled = excluded.disabled,
    name = excluded.name, perms = excluded.perms, updated_by = excluded.updated_by, updated_at = now();
  return true;
end $$;
