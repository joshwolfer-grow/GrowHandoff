-- supabase/0005_payaudit.sql — Pay Auditor desk on the Grow floor.
insert into public.office_agents (id, floor, name, role, cadence_seconds, sprite, sort) values
  ('payaudit', 'grow', 'Pay Auditor', 'Upfront pay check, Thursdays', 604800, '{"hair":"#3B2A1A","shirt":"#B8552F","prop":"ledger"}', 9)
on conflict (id) do nothing;
