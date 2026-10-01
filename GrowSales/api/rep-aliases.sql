-- api/rep-aliases.sql
-- Run ONCE in the Supabase SQL editor.
--
-- One person, several spellings. Source systems disagree (SalesRabbit says
-- "Eli Fridley", Sequifi says "Eli Fridey"), so their knocking and their deals
-- split into two half-people and both read wrong.
--
-- Why a table instead of pure fuzzy matching: at edit distance 1 to 2 code
-- cannot tell a typo from a different person. "Robert Bridges" and "Dyson
-- Bridges" are close and are two people; the dashboard's own matcher already
-- has a warning that it maps "Kallia Fuller" onto "Alaina Fuller". So the
-- detector only ever writes CANDIDATES, and nothing is applied until a human
-- flips it to confirmed.
--
-- This also replaces the three hand-maintained alias maps that had already
-- drifted apart (api/_name-aliases.js, window.BRIA_REP_ALIAS in index.html,
-- and a two-entry literal further down the same file).

create table if not exists rep_aliases (
  id             bigserial primary key,
  source_name    text not null,                -- the spelling as it appears in a source system
  canonical_name text not null,                -- the one name to show everywhere
  status         text not null default 'pending'
                 check (status in ('pending','confirmed','rejected')),
  -- Why the detector thought these were the same person. Kept so a reviewer can
  -- see the evidence instead of guessing.
  reason         text,
  edit_distance  int,
  knock_days     int,
  deal_count     int,
  reviewed_by    text,
  reviewed_at    timestamptz,
  created_at     timestamptz not null default now()
);

-- One decision per source spelling. Re-running the detector must not pile up
-- duplicate candidates for a name that was already judged.
create unique index if not exists rep_aliases_source_uniq
  on rep_aliases (lower(source_name));

create index if not exists rep_aliases_status_idx on rep_aliases (status);

alter table rep_aliases enable row level security;

-- Same posture as the other dashboard tables: the anon key reads and writes,
-- since the app is behind its own access control and has no server session.
drop policy if exists rep_aliases_all on rep_aliases;
create policy rep_aliases_all on rep_aliases for all using (true) with check (true);

-- Seed the aliases that already live in code, pre-confirmed: these were decided
-- previously and carry the canonical spellings the dashboard already shows.
-- NOTE canonical is "Christopher Lagrange" — api/_name-aliases.js and the client
-- map disagreed on Chris vs Christopher; this settles it on the server's answer.
insert into rep_aliases (source_name, canonical_name, status, reason, reviewed_by, reviewed_at)
values
  ('Samantha Boyd',        'Sammi Boyd',            'confirmed', 'migrated from api/_name-aliases.js', 'migration', now()),
  ('Mana McGuire',         'Kaimana McGuire',       'confirmed', 'migrated from api/_name-aliases.js', 'migration', now()),
  ('Chris',                'Christopher Lagrange',  'confirmed', 'migrated from api/_name-aliases.js', 'migration', now()),
  ('Chris Lagrange',       'Christopher Lagrange',  'confirmed', 'migrated from api/_name-aliases.js', 'migration', now()),
  ('Cristiano Mariano',    'Christopher Lagrange',  'confirmed', 'migrated from api/_name-aliases.js', 'migration', now()),
  ('Chris Legrange',       'Christopher Lagrange',  'confirmed', 'migrated from api/_name-aliases.js', 'migration', now()),
  ('Christopher Legrange', 'Christopher Lagrange',  'confirmed', 'migrated from api/_name-aliases.js', 'migration', now()),
  ('Allison Lauriano',     'Alli Lauriano',         'confirmed', 'direction corrected 2026-09-10: Alli is canonical', 'migration', now())
on conflict (lower(source_name)) do nothing;

-- Case-only differences: unambiguously the same person, so these go straight in
-- as confirmed. Nothing here changes who a row belongs to, only its casing.
insert into rep_aliases (source_name, canonical_name, status, reason, reviewed_by, reviewed_at)
values
  ('erin rust',       'Erin Rust',       'confirmed', 'case only', 'migration', now()),
  ('Kaimana Mcguire', 'Kaimana McGuire', 'confirmed', 'case only', 'migration', now()),
  ('Tanner acor',     'Tanner Acor',     'confirmed', 'case only', 'migration', now()),
  ('Parker demski',   'Parker Demski',   'confirmed', 'case only', 'migration', now())
on conflict (lower(source_name)) do nothing;
