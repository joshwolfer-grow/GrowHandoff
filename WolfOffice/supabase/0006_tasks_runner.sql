-- supabase/0006_tasks_runner.sql — task queue columns for the per-floor Runner, and the Grow Runner and Chief desks.
-- Applied 2026-09-15 via MCP.
alter table public.office_tasks drop constraint if exists office_tasks_state_check;
alter table public.office_tasks add constraint office_tasks_state_check check (state in ('queued','waiting','running','done','failed'));
alter table public.office_tasks add column if not exists floor text;              -- which Runner picks it up
alter table public.office_tasks add column if not exists requested_by text;       -- 'page' | worker id | 'chief'
alter table public.office_tasks add column if not exists note text;               -- plain-English why
alter table public.office_tasks add column if not exists result text;             -- last output line or error
alter table public.office_tasks add column if not exists approved_at timestamptz; -- set when a waiting task is approved
alter table public.office_tasks add column if not exists timeout_seconds integer not null default 600;
create index if not exists office_tasks_floor_state on public.office_tasks(floor, state, requested_at);
insert into public.office_agents (id, floor, name, role, cadence_seconds, sprite, sort) values
  ('runner-grow',     'grow',     'Runner', 'Front desk: runs queued tasks', 120, '{"hair":"#2C2C2A","shirt":"#E9B44C","prop":"satchel"}', -1)
on conflict (id) do nothing;
-- Chief of staff desks (applied 2026-09-15 via MCP).
insert into public.office_agents (id, floor, name, role, cadence_seconds, sprite, sort) values
  ('chief-grow',     'grow',     'Chief of staff', 'Roll call and the floor to-do', 86400, '{"hair":"#5F5E5A","shirt":"#3A2A20","prop":"scroll"}', 99)
on conflict (id) do nothing;
-- Teams and leads (applied 2026-09-15 via MCP). A lead's card rolls up the team; alerts name the team.
alter table public.office_agents add column if not exists team text;
alter table public.office_agents add column if not exists lead boolean not null default false;
-- Grow: Field Data (crawler*, amplify, rtr) · Leads & Files (courier*, exporter) · Coaching (analyst*, installs, chaser) · Payroll (payaudit*)
-- Runners are 'Front Desk'; Chiefs are 'Leadership' and lead = true.
-- 2026-09-15: Grow reorganised. Sales team = sales-lead* + isp-i3, isp-slic, isp-lyte, isp-surf, isp-tds, isp-ezee, isp-omni (one script, workers/grow/isp.mjs <isp>).
-- Ops team = crawler*, amplify, rtr, courier, exporter, analyst, installs, chaser. Payroll = payaudit*.
