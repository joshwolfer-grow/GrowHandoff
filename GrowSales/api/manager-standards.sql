-- Manager standards: the daily checklist in the Bria manager portal, and the
-- weekly scorecard corporate uses to make sure it is being followed.
-- Run once in the Grow Supabase project. Re-runnable.
--
-- The four standards (from the manager expectations slide):
--   1. Weekly attendance of leadership and manager meetings  -> marked by CORPORATE only
--   2. 5 full morning meetings each week, training + role plays -> manager checks daily in Bria
--   3. Weekly 1 on 1 with each rep                            -> manager checks per rep in Bria
--   4. 42 hr/wk knocking, manager AND team average            -> automatic, from knock_board_daily
--
-- Days are America/Denver. Weeks are Sunday anchored, like everything else here.
--
-- Trust model: the anon key ships in index.html and in Bria, so nothing here
-- relies on table policies for honesty. Tables are read-only to anon; every
-- write goes through a function:
--   * manager checks can only be set for TODAY or YESTERDAY (Denver). A manager
--     cannot fill in last Tuesday on Friday night. checked_at records when they
--     actually tapped it, so a late check is visible.
--   * meeting attendance requires a corporate access code or a signed in
--     corporate user (_is_corp_admin from app-auth.sql).
--   * corporate can correct any day with set_manager_check_admin.

-- ---------------------------------------------------------------- tables

-- One row per manager per day per item. item: meeting | roleplay
create table if not exists public.manager_checks (
  manager     text        not null,      -- team name as knock_board_daily writes it (the manager)
  date        date        not null,
  item        text        not null check (item in ('meeting','roleplay')),
  done        boolean     not null default true,
  checked_by  text,                      -- who tapped it (Bria user name / email), or 'corporate:<who>'
  checked_at  timestamptz not null default now(),
  primary key (manager, date, item)
);
create index if not exists manager_checks_date_idx on public.manager_checks (date);

-- One row per manager per rep per week.
create table if not exists public.manager_one_on_ones (
  manager     text        not null,
  week_start  date        not null,      -- Sunday
  rep         text        not null,
  done        boolean     not null default true,
  note        text,
  checked_by  text,
  checked_at  timestamptz not null default now(),
  primary key (manager, week_start, rep)
);

-- Leadership + manager meeting attendance. Corporate marks it.
create table if not exists public.manager_meeting_attendance (
  manager     text        not null,
  week_start  date        not null,      -- Sunday
  meeting     text        not null check (meeting in ('leadership','manager')),
  attended    boolean     not null,
  marked_by   text,
  marked_at   timestamptz not null default now(),
  primary key (manager, week_start, meeting)
);

-- Who is held to the standard. The scorecard lists every manager the Knocking
-- board names as a team; set active=false to drop one (market teams like
-- "Houston" never show because they are not people).
create table if not exists public.manager_standards_roster (
  manager     text        primary key,
  active      boolean     not null default true,
  updated_by  text,
  updated_at  timestamptz not null default now()
);

alter table public.manager_checks             enable row level security;
alter table public.manager_one_on_ones        enable row level security;
alter table public.manager_meeting_attendance enable row level security;
alter table public.manager_standards_roster   enable row level security;

drop policy if exists manager_checks_read             on public.manager_checks;
drop policy if exists manager_one_on_ones_read        on public.manager_one_on_ones;
drop policy if exists manager_meeting_attendance_read on public.manager_meeting_attendance;
drop policy if exists manager_standards_roster_read   on public.manager_standards_roster;
create policy manager_checks_read             on public.manager_checks             for select using (true);
create policy manager_one_on_ones_read        on public.manager_one_on_ones        for select using (true);
create policy manager_meeting_attendance_read on public.manager_meeting_attendance for select using (true);
create policy manager_standards_roster_read   on public.manager_standards_roster   for select using (true);

revoke insert, update, delete on public.manager_checks, public.manager_one_on_ones,
  public.manager_meeting_attendance, public.manager_standards_roster from anon, authenticated;
grant select on public.manager_checks, public.manager_one_on_ones,
  public.manager_meeting_attendance, public.manager_standards_roster to anon, authenticated;

-- ---------------------------------------------------------------- helpers

create or replace function public._denver_today() returns date
language sql stable as $$ select (now() at time zone 'America/Denver')::date $$;

create or replace function public._week_sunday(d date) returns date
language sql immutable as $$ select d - extract(dow from d)::int $$;

-- ---------------------------------------------------------------- manager writes (Bria)

-- Daily check. p_date defaults to today. Only today or yesterday is accepted.
create or replace function public.set_manager_check(
  p_manager text, p_item text, p_done boolean, p_by text default null, p_date date default null)
returns public.manager_checks
language plpgsql security definer set search_path = public as $$
declare d date := coalesce(p_date, public._denver_today()); r public.manager_checks;
begin
  if nullif(btrim(p_manager),'') is null then raise exception 'manager required'; end if;
  if p_item not in ('meeting','roleplay') then raise exception 'item must be meeting or roleplay'; end if;
  if d > public._denver_today() or d < public._denver_today() - 1 then
    raise exception 'checks can only be set for today or yesterday';
  end if;
  insert into public.manager_checks (manager, date, item, done, checked_by, checked_at)
  values (btrim(p_manager), d, p_item, coalesce(p_done,true), p_by, now())
  on conflict (manager, date, item) do update
    set done = excluded.done, checked_by = excluded.checked_by, checked_at = now()
  returning * into r;
  return r;
end $$;

-- Weekly 1 on 1. Accepted for this week, and for last week through Monday so a
-- Saturday night 1 on 1 can still be logged.
create or replace function public.set_one_on_one(
  p_manager text, p_rep text, p_done boolean, p_by text default null, p_note text default null, p_week date default null)
returns public.manager_one_on_ones
language plpgsql security definer set search_path = public as $$
declare
  t date := public._denver_today();
  w date := public._week_sunday(coalesce(p_week, t));
  r public.manager_one_on_ones;
begin
  if nullif(btrim(p_manager),'') is null or nullif(btrim(p_rep),'') is null then raise exception 'manager and rep required'; end if;
  if not (w = public._week_sunday(t) or (w = public._week_sunday(t) - 7 and extract(dow from t) <= 1)) then
    raise exception '1 on 1s can only be logged for this week';
  end if;
  insert into public.manager_one_on_ones (manager, week_start, rep, done, note, checked_by, checked_at)
  values (btrim(p_manager), w, btrim(p_rep), coalesce(p_done,true), nullif(btrim(p_note),''), p_by, now())
  on conflict (manager, week_start, rep) do update
    set done = excluded.done, note = coalesce(excluded.note, manager_one_on_ones.note),
        checked_by = excluded.checked_by, checked_at = now()
  returning * into r;
  return r;
end $$;

grant execute on function public.set_manager_check(text,text,boolean,text,date) to anon, authenticated;
grant execute on function public.set_one_on_one(text,text,boolean,text,text,date) to anon, authenticated;

-- ---------------------------------------------------------------- corporate writes

create or replace function public.set_meeting_attendance(
  p_admin_code text, p_manager text, p_week date, p_meeting text, p_attended boolean, p_by text default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public._is_corp_admin(p_admin_code) then raise exception 'not authorized'; end if;
  if p_meeting not in ('leadership','manager') then raise exception 'meeting must be leadership or manager'; end if;
  if p_attended is null then
    delete from public.manager_meeting_attendance
     where manager = btrim(p_manager) and week_start = public._week_sunday(p_week) and meeting = p_meeting;
    return;
  end if;
  insert into public.manager_meeting_attendance (manager, week_start, meeting, attended, marked_by, marked_at)
  values (btrim(p_manager), public._week_sunday(p_week), p_meeting, p_attended,
          coalesce(p_by, auth.jwt()->>'email', 'corporate'), now())
  on conflict (manager, week_start, meeting) do update
    set attended = excluded.attended, marked_by = excluded.marked_by, marked_at = now();
end $$;

-- Corporate correction of any day's check (no date window).
create or replace function public.set_manager_check_admin(
  p_admin_code text, p_manager text, p_date date, p_item text, p_done boolean, p_by text default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public._is_corp_admin(p_admin_code) then raise exception 'not authorized'; end if;
  if p_item not in ('meeting','roleplay') then raise exception 'bad item'; end if;
  insert into public.manager_checks (manager, date, item, done, checked_by, checked_at)
  values (btrim(p_manager), p_date, p_item, coalesce(p_done,true),
          'corporate:' || coalesce(p_by, auth.jwt()->>'email', 'code'), now())
  on conflict (manager, date, item) do update
    set done = excluded.done, checked_by = excluded.checked_by, checked_at = now();
end $$;

create or replace function public.set_manager_standards_active(
  p_admin_code text, p_manager text, p_active boolean)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public._is_corp_admin(p_admin_code) then raise exception 'not authorized'; end if;
  insert into public.manager_standards_roster (manager, active, updated_by, updated_at)
  values (btrim(p_manager), p_active, coalesce(auth.jwt()->>'email','code'), now())
  on conflict (manager) do update set active = excluded.active, updated_by = excluded.updated_by, updated_at = now();
end $$;

grant execute on function public.set_meeting_attendance(text,text,date,text,boolean,text) to anon, authenticated;
grant execute on function public.set_manager_check_admin(text,text,date,text,boolean,text) to anon, authenticated;
grant execute on function public.set_manager_standards_active(text,text,boolean) to anon, authenticated;

-- ---------------------------------------------------------------- the scorecard

-- One row per manager per week. Managers = every team on the Knocking board
-- that is also a person who knocks (so market fallback teams drop out), plus
-- anyone who logged a check, minus inactive roster rows.
-- Team hours average only over reps whose feed carries hours (Time Track);
-- reps_no_hours says how many reps it could not see, so a 0 is never mistaken
-- for a lazy team.
create or replace view public.manager_standards_weekly
with (security_invoker = true) as
with people as (select distinct rep from public.knock_board_daily),
mgr_weeks as (
  select distinct k.team as manager, k.week_start from public.knock_board_daily k
   where k.team <> 'Unassigned' and k.team in (select rep from people)
  union select manager, public._week_sunday(date) from public.manager_checks
  union select manager, week_start from public.manager_one_on_ones
  union select manager, week_start from public.manager_meeting_attendance
),
mgr_hours as (
  select rep as manager, week_start, sum(hours) as hrs from public.knock_board_daily group by 1,2
),
rep_week as (
  select team as manager, week_start, rep, sum(hours) as hrs
    from public.knock_board_daily
   where not is_sub and rep <> team
   group by 1,2,3
),
team_hours as (
  select manager, week_start,
         count(*) as reps,
         count(*) filter (where hrs > 0) as reps_with_hours,
         avg(hrs) filter (where hrs > 0) as avg_hrs
    from rep_week group by 1,2
),
checks as (
  select manager, public._week_sunday(date) as week_start,
         count(*) filter (where item = 'meeting'  and done) as meetings,
         count(*) filter (where item = 'roleplay' and done) as roleplays
    from public.manager_checks group by 1,2
),
ones as (
  select o.manager, o.week_start,
         count(*) filter (where o.done) as one_on_ones,
         count(*) filter (where o.done and r.rep is not null) as one_on_ones_on_team
    from public.manager_one_on_ones o
    left join rep_week r on r.manager = o.manager and r.week_start = o.week_start and r.rep = o.rep
   group by 1,2
),
att as (
  select manager, week_start,
         bool_or(attended) filter (where meeting = 'leadership') as leadership,
         bool_or(attended) filter (where meeting = 'manager')    as manager_mtg
    from public.manager_meeting_attendance group by 1,2
)
select m.manager, m.week_start,
       coalesce(c.meetings,0)              as morning_meetings,     -- of 5
       coalesce(c.roleplays,0)             as roleplays,            -- of 5
       coalesce(o.one_on_ones,0)           as one_on_ones,
       coalesce(t.reps,0)                  as team_reps,            -- company reps who knocked for this team this week
       round(coalesce(h.hrs,0)::numeric,1) as manager_hours,        -- of 42
       round(t.avg_hrs::numeric,1)         as team_avg_hours,       -- of 42, null when no rep has hours
       coalesce(t.reps,0) - coalesce(t.reps_with_hours,0) as reps_no_hours,
       a.leadership                        as leadership_meeting,   -- null = not marked yet
       a.manager_mtg                       as manager_meeting,
       (coalesce(c.meetings,0)  >= 5)      as meetings_ok,
       (coalesce(c.roleplays,0) >= 5)      as roleplays_ok,
       (coalesce(o.one_on_ones_on_team,0) >= coalesce(t.reps,0)) as one_on_ones_ok,
       (coalesce(h.hrs,0) >= 42)           as manager_hours_ok,
       (coalesce(t.avg_hrs,0) >= 42)       as team_hours_ok,
       (coalesce(a.leadership,false) and coalesce(a.manager_mtg,false)) as attendance_ok
  from mgr_weeks m
  left join public.manager_standards_roster s on s.manager = m.manager
  left join checks     c on c.manager = m.manager and c.week_start = m.week_start
  left join ones       o on o.manager = m.manager and o.week_start = m.week_start
  left join team_hours t on t.manager = m.manager and t.week_start = m.week_start
  left join mgr_hours  h on h.manager = m.manager and h.week_start = m.week_start
  left join att        a on a.manager = m.manager and a.week_start = m.week_start
 where coalesce(s.active, true);

grant select on public.manager_standards_weekly to anon, authenticated;

-- Today at a glance: which managers have not checked the morning meeting /
-- role play yet. Bria's card and the corporate page both read this.
create or replace view public.manager_standards_today
with (security_invoker = true) as
select w.manager, public._denver_today() as date,
       coalesce(bool_or(c.done) filter (where c.item = 'meeting'),  false) as meeting_done,
       coalesce(bool_or(c.done) filter (where c.item = 'roleplay'), false) as roleplay_done,
       max(c.checked_at) as last_checked_at
  from (select distinct manager from public.manager_standards_weekly
         where week_start >= public._week_sunday(public._denver_today()) - 7) w
  left join public.manager_checks c on c.manager = w.manager and c.date = public._denver_today()
 group by w.manager;

grant select on public.manager_standards_today to anon, authenticated;
