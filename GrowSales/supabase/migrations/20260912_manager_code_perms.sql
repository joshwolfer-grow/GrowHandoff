-- Sep 12 2026: per-code page settings for manager codes.
-- perms = {"pages": {"<page key>": "team" | "company"}, "isps": ["i3", ...]}
-- A page that is not listed is off. Only a corporate code can write it.

alter table public.access_codes
  add column if not exists perms jsonb not null default '{}'::jsonb;

-- Return shape grows a column, so the function has to be dropped first.
drop function if exists public.redeem_access_code(text);
create function public.redeem_access_code(p_code text)
returns table (r_name text, r_role text, r_perms jsonb)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  update public.access_codes a set seen = now()
   where a.code = p_code and a.active and a.role in ('corporate','manager','caller','caller_lead');
  return query select a.name, a.role, a.perms from public.access_codes a
   where a.code = p_code and a.active and a.role in ('corporate','manager','caller','caller_lead');
end $function$;
revoke all on function public.redeem_access_code(text) from public, authenticated;
grant execute on function public.redeem_access_code(text) to anon;

drop function if exists public.preview_access_code(text, text);
create function public.preview_access_code(p_admin_code text, p_code text)
returns table (r_name text, r_role text, r_active boolean, r_perms jsonb)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not public._is_corp_admin(p_admin_code) then
    raise exception 'not authorized';
  end if;
  return query
    select a.name, a.role, a.active, a.perms
      from public.access_codes a
     where a.code = p_code;
end
$function$;
revoke all on function public.preview_access_code(text, text) from public, authenticated;
grant execute on function public.preview_access_code(text, text) to anon;

create or replace function public.set_access_code_perms(p_admin_code text, p_code text, p_perms jsonb)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not public._is_corp_admin(p_admin_code) then
    raise exception 'not authorized';
  end if;
  if p_perms is null or jsonb_typeof(p_perms) <> 'object' then
    raise exception 'perms must be an object';
  end if;
  update public.access_codes a set perms = p_perms
   where a.code = p_code and a.role = 'manager';
  return found;
end
$function$;
revoke all on function public.set_access_code_perms(text, text, jsonb) from public, authenticated;
grant execute on function public.set_access_code_perms(text, text, jsonb) to anon;
