-- supabase/0008_mgrcards.sql — Manager cards desk on the Grow floor (applied 2026-09-16 via REST).
insert into public.office_agents (id, floor, name, role, cadence_seconds, sprite, sort, team, lead) values
  ('mgrcards', 'grow', 'Card sender', 'Daily manager cards to group texts, 9am', 86400, '{"hair":"#2C2C2A","shirt":"#3F7D4E","prop":"phone"}', 28, 'Sales', false)
on conflict (id) do nothing;
