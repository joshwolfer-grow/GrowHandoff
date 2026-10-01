-- Upfront eligibility tiers (green / yellow / red) as announced to the team.
--
-- The rate that decides a tier is now cumulative install rate on ALL deals
-- since 2026-07-01, not a rolling 4-active-week window. That part needs no
-- schema: it recomputes from deals every open.
--
-- The ladder, per the owner:
--   >= 75%      green, paid upfront
--   65% to 74%  yellow, still paid, 2 pay weeks of grace, 3rd week goes red
--   < 65%       red immediately, no grace at all
-- A rep returns to green the moment the cumulative rate is back over 75%.
-- Under 10 settled deals since 7/1 nobody comes off: the rate is noise at that
-- volume and would red a new rep on their first cancel.
--
-- What DOES need storage is the grace clock and the chargeback. "Two weeks in
-- yellow, then red, and we claw back everything paid during those yellow
-- weeks" is a money claim about the past, and the app cannot back-compute it
-- from deal rows: a deal is read at its CURRENT status, so a week that was
-- yellow at pay time can look green (or red) weeks later. The tier a rep was
-- actually paid under has to be frozen at close, next to the dollars.
--
-- 1) Freeze the tier and the deal list on each closed pay-run snapshot.
--    status: 'green' | 'yellow' | 'red' at the moment the run closed.
--    deals_json: [{c: customer, sd: sale_date, src: 'bria'|'report'}] so a
--    chargeback can name the deals it is reversing, even months later, without
--    re-deriving them from deal rows that have since moved.
alter table public.upfront_paid add column if not exists status     text;
alter table public.upfront_paid add column if not exists deals_json jsonb;

-- 2) Tier history per rep per pay week, written on every close whether or not
--    the rep was paid. upfront_paid only carries reps with money in the week,
--    so it cannot answer "was Cody yellow the week he sold nothing?" — and
--    that week still burns grace.
create table if not exists public.upfront_tier (
  pay_week    date    not null,        -- Thursday that starts the pay window
  rep         text    not null,
  status      text    not null,        -- green | yellow | red
  rate        integer,                 -- cumulative install rate since 2026-07-01
  installed   integer,                 -- installs counted in that rate
  settled     integer,                 -- installs + cancels counted in that rate
  yellow_since date,                   -- first yellow week of the current run
  recorded_at timestamptz default now(),
  primary key (pay_week, rep)
);
create index if not exists upfront_tier_rep_idx on public.upfront_tier (rep, pay_week desc);

-- 3) Chargebacks raised when a rep goes red, one row per red event. Kept
--    separate from upfront_paid so a chargeback survives reopening the week
--    that triggered it, and so the export can read it directly.
create table if not exists public.upfront_chargeback (
  id           bigserial primary key,
  rep          text not null,
  raised_week  date not null,          -- pay week the rep went red
  yellow_since date not null,          -- take-off date for Sequifi
  weeks        integer,                -- yellow weeks being reversed
  deals        integer,                -- deals paid upfront while yellow
  amount       integer,                -- dollars charged back (positive)
  deals_json   jsonb,                  -- the named deals moving to normal pay
  voided       boolean default false,  -- set when a red is reversed, never deleted
  created_by   text,
  created_at   timestamptz default now(),
  unique (rep, raised_week)
);
create index if not exists upfront_chargeback_week_idx on public.upfront_chargeback (raised_week desc);

alter table public.upfront_tier       enable row level security;
alter table public.upfront_chargeback enable row level security;
-- Same posture as upfront_paid: anon read/write, guarded in the app by the
-- payroll code prompt. Tighten with the rest of the payroll tables when RLS
-- lands properly.
drop policy if exists upfront_tier_all on public.upfront_tier;
create policy upfront_tier_all on public.upfront_tier for all using (true) with check (true);
drop policy if exists upfront_chargeback_all on public.upfront_chargeback;
create policy upfront_chargeback_all on public.upfront_chargeback for all using (true) with check (true);
