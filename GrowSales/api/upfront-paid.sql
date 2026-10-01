-- Upfront payroll persistence: per-rep paid checkmarks + per-week run close.
-- Run once in the Grow Supabase project: SQL Editor -> paste -> Run. Re-runnable.
-- Same trust model as goals/flags: dashboard reads + writes with the anon key.

-- One row per (pay week, rep) the payroll person has marked paid.
create table if not exists public.upfront_paid (
  pay_week   date        not null,   -- Thursday that starts the Thu-Wed pay week
  rep        text        not null,
  paid       boolean     default true,
  paid_by    text,                   -- who ticked it (VIEW / name)
  paid_at    timestamptz default now(),
  primary key (pay_week, rep)
);

-- One row per pay week once payroll closes it out (locks the run).
create table if not exists public.upfront_pay_runs (
  pay_week       date        primary key,
  closed         boolean     default false,
  closed_by      text,
  closed_at      timestamptz,
  total_paid     integer,            -- snapshot at close
  total_clawback integer,
  updated_at     timestamptz default now()
);

alter table public.upfront_paid     enable row level security;
alter table public.upfront_pay_runs enable row level security;

drop policy if exists "anon read upfront_paid"      on public.upfront_paid;
drop policy if exists "anon write upfront_paid"     on public.upfront_paid;
drop policy if exists "anon read upfront_pay_runs"  on public.upfront_pay_runs;
drop policy if exists "anon write upfront_pay_runs" on public.upfront_pay_runs;

create policy "anon read upfront_paid"      on public.upfront_paid     for select using (true);
create policy "anon write upfront_paid"     on public.upfront_paid     for all    using (true) with check (true);
create policy "anon read upfront_pay_runs"  on public.upfront_pay_runs for select using (true);
create policy "anon write upfront_pay_runs" on public.upfront_pay_runs for all    using (true) with check (true);
