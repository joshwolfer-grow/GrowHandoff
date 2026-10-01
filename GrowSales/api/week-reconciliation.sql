-- Per-week reconciliation workbook state for the Weeks tab.
-- The green "completed" check is MANUAL — set only when a human closes the week,
-- never derived from source counts matching. Run once in the Grow SQL editor.

create table if not exists public.week_reconciliation (
  week_start   date        primary key,      -- Sunday-anchored week start
  status       text        default 'open',   -- open | review | completed | reopened
  checked      jsonb       default '{}'::jsonb, -- { dealKey: { note, at } } resolved items
  closed_keys  jsonb       default '[]'::jsonb, -- the flagged-deal keys present at completion
  completed_by text,
  completed_at timestamptz,
  reopened_at  timestamptz,
  note         text,
  updated_at   timestamptz default now()
);

alter table public.week_reconciliation enable row level security;
drop policy if exists "anon read week_reconciliation"  on public.week_reconciliation;
drop policy if exists "anon write week_reconciliation" on public.week_reconciliation;
create policy "anon read week_reconciliation"  on public.week_reconciliation for select using (true);
create policy "anon write week_reconciliation" on public.week_reconciliation for all using (true) with check (true);
