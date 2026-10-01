-- supabase/0009_grow_roster.sql — the full Grow roster as it stood in the live project
-- (hydnqquciomyfuntavhr) on Oct 1 2026. Earlier files only seed some desks; the rest were
-- added through MCP/REST. Run this last. Safe to re-run: it upserts.
-- office_events.agent_id references office_agents.id, so any worker missing here cannot log.

-- Optional on-duty window per worker (read by site/status.mjs and the chief). Null = always on.
alter table public.office_agents add column if not exists duty jsonb;

insert into public.office_agents (id, floor, name, role, cadence_seconds, sprite, sort, team, lead) values
  ('runner-grow', 'grow', 'Runner', 'Front desk: runs queued tasks', 120, '{"hair":"#2C2C2A","shirt":"#E9B44C","prop":"satchel"}'::jsonb, -1, 'Front Desk', false),
  ('crawler', 'grow', 'Crawler', 'SalesRabbit sync', 300, '{"hair":"#4A1B0C","shirt":"#2E9C6D","prop":"net"}'::jsonb, 1, 'Ops', true),
  ('amplify', 'grow', 'Amplify runner', 'Amplify sync', 300, '{"hair":"#2C2C2A","shirt":"#2F6FBF","prop":"bolt"}'::jsonb, 2, 'Ops', false),
  ('rtr', 'grow', 'RTR runner', 'RTR sync', 1800, '{"hair":"#E9B44C","shirt":"#7F77DD","prop":"scroll"}'::jsonb, 3, 'Ops', false),
  ('courier', 'grow', 'Courier', 'ISP lead files', 300, '{"hair":"#D85A30","shirt":"#2E9C6D","prop":"satchel"}'::jsonb, 4, 'Ops', false),
  ('exporter', 'grow', 'Exporter', 'ISP exports and reports', 3600, '{"hair":"#5F5E5A","shirt":"#C48A4A","prop":"crate"}'::jsonb, 5, 'Ops', false),
  ('analyst', 'grow', 'Analyst', 'Rep outliers vs the team, mornings', 86400, '{"hair":"#3B2A1A","shirt":"#2F6FBF","prop":"ledger"}'::jsonb, 6, 'Ops', false),
  ('installs', 'grow', 'Installs watcher', 'Install date changes, mornings', 86400, '{"hair":"#4A1B0C","shirt":"#C48A4A","prop":"scroll"}'::jsonb, 7, 'Ops', false),
  ('chaser', 'grow', 'Chaser', 'Untouched cancel callbacks, mornings', 86400, '{"hair":"#D85A30","shirt":"#7F77DD","prop":"phone"}'::jsonb, 8, 'Ops', false),
  ('payaudit', 'grow', 'Pay Auditor', 'Upfront pay check, Thursdays', 604800, '{"hair":"#3B2A1A","shirt":"#B8552F","prop":"ledger"}'::jsonb, 9, 'Payroll', true),
  ('sales-lead', 'grow', 'Sales lead', 'All ISPs rolled into one view, mornings', 86400, '{"hair":"#2C2C2A","shirt":"#3F7D4E","prop":"scroll"}'::jsonb, 20, 'Sales', true),
  ('isp-i3', 'grow', 'i3 desk', 'i3 Broadband revenue read', 86400, '{"hair":"#E9B44C","shirt":"#2E9C6D","prop":"ledger"}'::jsonb, 21, 'Sales', false),
  ('isp-slic', 'grow', 'SLIC desk', 'SLIC revenue read', 86400, '{"hair":"#4A1B0C","shirt":"#2F6FBF","prop":"ledger"}'::jsonb, 22, 'Sales', false),
  ('isp-lyte', 'grow', 'Lyte desk', 'Lyte revenue read', 86400, '{"hair":"#5F5E5A","shirt":"#7F77DD","prop":"ledger"}'::jsonb, 23, 'Sales', false),
  ('isp-surf', 'grow', 'Surf desk', 'Surf revenue read', 86400, '{"hair":"#D85A30","shirt":"#C48A4A","prop":"ledger"}'::jsonb, 24, 'Sales', false),
  ('isp-tds', 'grow', 'TDS desk', 'TDS revenue read', 86400, '{"hair":"#2C2C2A","shirt":"#B8552F","prop":"ledger"}'::jsonb, 25, 'Sales', false),
  ('isp-ezee', 'grow', 'Ezee desk', 'Ezee revenue read', 86400, '{"hair":"#3B2A1A","shirt":"#3F7D4E","prop":"ledger"}'::jsonb, 26, 'Sales', false),
  ('isp-omni', 'grow', 'Omni desk', 'Omni revenue read', 86400, '{"hair":"#E9B44C","shirt":"#2F6FBF","prop":"ledger"}'::jsonb, 27, 'Sales', false),
  ('mgrcards', 'grow', 'Card sender', 'Daily manager cards to group texts, 9am', 86400, '{"hair":"#2C2C2A","shirt":"#3F7D4E","prop":"phone"}'::jsonb, 28, 'Sales', false),
  ('slots-tds', 'grow', 'TDS slots', 'Earliest TDS install dates, 3x a day', 28800, '{"hair":"#4A1B0C","shirt":"#E9B44C","prop":"bolt"}'::jsonb, 29, 'Sales', false),
  ('slots-surf', 'grow', 'Surf slots', 'Earliest Surf install dates, 3x a day', 28800, '{"hair":"#5F5E5A","shirt":"#E9B44C","prop":"bolt"}'::jsonb, 30, 'Sales', false),
  ('chief-grow', 'grow', 'Chief of staff', 'Roll call and the floor to-do', 86400, '{"hair":"#5F5E5A","shirt":"#3A2A20","prop":"scroll"}'::jsonb, 99, 'Leadership', true)
on conflict (id) do update set
  floor = excluded.floor, name = excluded.name, role = excluded.role,
  cadence_seconds = excluded.cadence_seconds, sprite = excluded.sprite,
  sort = excluded.sort, team = excluded.team, lead = excluded.lead;
