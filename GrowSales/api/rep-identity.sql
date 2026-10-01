-- Rep identity keyed on email (Sep 29 2026).
-- One row per person from the Sequifi user export; every name a feed has ever
-- used for them lives in rep_identity_alias. A trigger stamps rep_email on each
-- knocking / knock_events row at insert, so every feed (SR crawl, Amplify,
-- Time Track, Ezee, Bluepeak, Omni) joins on email without sync changes.
-- Names with no alias (mostly subs) stay rep_email = null.
-- Adding an alias later: insert it, then `select restamp_rep_email();`.

create table if not exists rep_identity (
  email          text primary key,            -- Sequifi login email, lowercased
  employee_id    text unique,                 -- grow000xxx
  first_name     text,
  last_name      text,
  preferred_name text,
  display_name   text,
  alt_emails     text[] not null default '{}', -- other addresses seen for them (SalesRabbit)
  position       text,
  office         text,
  state          text,
  user_status    text,
  updated_at     timestamptz not null default now()
);

create table if not exists rep_identity_alias (
  name_key text primary key,                  -- rep_name_key(name)
  email    text not null references rep_identity(email) on update cascade on delete cascade,
  name     text,                              -- the spelling as first seen
  how      text                               -- sequifi | sr_email | name | confirmed
);
create index if not exists rep_identity_alias_email_idx on rep_identity_alias (email);

create or replace function rep_name_key(n text) returns text
language sql immutable as $$ select nullif(lower(regexp_replace(trim(coalesce(n, '')), '\s+', ' ', 'g')), '') $$;

alter table knocking     add column if not exists rep_email text;
alter table knock_events add column if not exists rep_email text;
create index if not exists knocking_rep_email_idx     on knocking (rep_email);
create index if not exists knock_events_rep_email_idx on knock_events (rep_email);

create or replace function stamp_rep_email() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.rep_email := (select email from rep_identity_alias where name_key = rep_name_key(new.rep));
  return new;
end $$;

drop trigger if exists knocking_stamp_rep_email on knocking;
create trigger knocking_stamp_rep_email before insert or update of rep on knocking
  for each row execute function stamp_rep_email();
drop trigger if exists knock_events_stamp_rep_email on knock_events;
create trigger knock_events_stamp_rep_email before insert or update of rep on knock_events
  for each row execute function stamp_rep_email();

-- Re-run after changing aliases; returns rows changed per table.
create or replace function restamp_rep_email() returns table (tbl text, changed bigint)
language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  update knocking k set rep_email = a.email from (select k2.id, ra.email from knocking k2
    left join rep_identity_alias ra on ra.name_key = rep_name_key(k2.rep)) a
    where a.id = k.id and k.rep_email is distinct from a.email;
  get diagnostics n = row_count; tbl := 'knocking'; changed := n; return next;
  update knock_events k set rep_email = a.email from (select k2.id, ra.email from knock_events k2
    left join rep_identity_alias ra on ra.name_key = rep_name_key(k2.rep)) a
    where a.id = k.id and k.rep_email is distinct from a.email;
  get diagnostics n = row_count; tbl := 'knock_events'; changed := n; return next;
end $$;

-- Read-only to the app; edits go through the SQL editor / service role.
alter table rep_identity       enable row level security;
alter table rep_identity_alias enable row level security;
drop policy if exists "anon read rep_identity" on rep_identity;
create policy "anon read rep_identity" on rep_identity for select using (true);
drop policy if exists "anon read rep_identity_alias" on rep_identity_alias;
create policy "anon read rep_identity_alias" on rep_identity_alias for select using (true);
