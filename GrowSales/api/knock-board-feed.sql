-- Knocking board feed for Bria. Run once in the Grow Supabase project. Re-runnable.
--
-- Bria shows our Knocking board to reps but cannot work out subs or teams: both
-- come from the Sequifi roster, carry-forward, rep_flags and aliases, which only
-- index.html resolves. So the app publishes the board's own per rep-day rows here
-- (window._kbPublish, after the late tables load) and Bria reads the view.
--
-- Rows are the SAME numbers the board shows: all feeds summed per rep-day, sold
-- topped up from Bria exactly as renderKnockBoard does, team as the board names it.
-- Subs are kept with is_sub=true rather than skipped, so a rep who flips from sub
-- to company (or back) is corrected by the next upsert instead of lingering.
--
-- Trust model: same as every table here. The anon key ships in index.html and
-- the app writes with it.

create table if not exists public.knock_board_daily (
  rep          text        not null,
  date         date        not null,
  week_start   date        not null,   -- Sunday
  team         text        not null,
  is_sub       boolean     not null default false,
  doors        integer     not null default 0,
  contacts     integer     not null default 0,
  sold         integer     not null default 0,
  hours        numeric     not null default 0,
  first_knock  text,                    -- "2:45 PM", earliest across feeds that day
  last_knock   text,                    -- latest across feeds that day
  updated_at   timestamptz not null default now(),
  primary key (rep, date)
);
create index if not exists knock_board_daily_date_idx on public.knock_board_daily (date);

alter table public.knock_board_daily enable row level security;
drop policy if exists knock_board_daily_read   on public.knock_board_daily;
drop policy if exists knock_board_daily_insert on public.knock_board_daily;
drop policy if exists knock_board_daily_update on public.knock_board_daily;
create policy knock_board_daily_read   on public.knock_board_daily for select using (true);
create policy knock_board_daily_insert on public.knock_board_daily for insert with check (true);
create policy knock_board_daily_update on public.knock_board_daily for update using (true) with check (true);
grant select, insert, update on public.knock_board_daily to anon, authenticated;

-- What Bria reads: company reps only.
create or replace view public.knock_board_company
with (security_invoker = true) as
  select rep, date, week_start, team, doors, contacts, sold, hours, first_knock, last_knock, updated_at
  from public.knock_board_daily
  where not is_sub;

grant select on public.knock_board_company to anon, authenticated;
