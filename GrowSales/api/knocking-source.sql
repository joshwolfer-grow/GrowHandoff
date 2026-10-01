-- Add a `source` column to knocking + knock_events so a second company's Amplify
-- data can live in the same tables, filterable and deletable on its own.
-- Existing Grow rows default to 'grow'. Run once in the Supabase SQL editor.

alter table knocking     add column if not exists source text not null default 'grow';
alter table knock_events add column if not exists source text not null default 'grow';

create index if not exists knocking_source_idx     on knocking (source);
create index if not exists knock_events_source_idx on knock_events (source);

-- To wipe a company's rows later (example): the label is whatever you passed as
--   node scripts/amplify-company-sync.mjs --source <slug>
-- delete from knocking     where source = '<slug>';
-- delete from knock_events where source = '<slug>';
