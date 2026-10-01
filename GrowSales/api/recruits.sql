-- Recruiting pipeline: people who come in from Instagram ads, the public apply
-- form, or a manual add, tracked stage by stage until they are knocking.
-- Run once in the Grow Supabase project: SQL Editor -> paste -> Run. Re-runnable.
--
-- Trust model, same as callback_leads: the anon key ships in index.html, so
-- anything readable here is readable by anyone who views source. Recruit rows
-- hold names, phones and emails of applicants, so this is the most personal
-- data in the project. The board is gated corporate-only at the router, which
-- decides what OPENS, not what is READABLE. Treat that as a known gap until
-- real auth exists; do not put anything in here you would not hand to a
-- stranger who opened devtools.
--
-- Reading code: renderRecruiting() in index.html (search "RECRUITING BOARD").
-- Writing code: api/recruit-intake.js (intake) and the board itself (stage moves).

create table if not exists public.recruits (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),  -- when the lead arrived, drives the "uncontacted for N minutes" timer
  updated_at   timestamptz not null default now(),
  name         text not null,
  phone        text,                                 -- as typed; phone10 below is the dedupe key
  phone10      text,                                 -- last 10 digits, set by the intake endpoint
  email        text,
  market       text,                                 -- which market they applied for, free text for now
  stage        text not null default 'new',
  source       text not null default 'manual',       -- instagram | form | manual | referral | other
  campaign     text,                                 -- Meta campaign name or id
  ad           text,                                 -- Meta ad name or id
  creative     text,                                 -- creative/image name, what you rank in the Creatives view
  lead_id      text,                                 -- Meta leadgen_id, the dedupe key for webhook retries
  form_id      text,
  answers      jsonb,                                -- raw question/answer pairs from the ad form
  assignee     text,                                 -- who is working this recruit
  contacted_at timestamptz,
  interview_at timestamptz,
  offer_at     timestamptz,
  hired_at     timestamptz,
  knocking_at  timestamptz,
  lost_at      timestamptz,
  lost_reason  text,
  constraint recruits_stage_chk check (stage in ('new','contacted','interview','offer','hired','knocking','lost'))
);

-- Meta retries a leadgen webhook until it gets a 200, so the same lead arrives
-- more than once. Partial unique index: real lead ids dedupe, manual rows (null)
-- are never in the way of each other.
create unique index if not exists recruits_lead_id_idx on public.recruits (lead_id) where lead_id is not null;
create index if not exists recruits_stage_idx   on public.recruits (stage);
create index if not exists recruits_created_idx on public.recruits (created_at desc);
create index if not exists recruits_phone10_idx on public.recruits (phone10) where phone10 is not null;

-- One row per touch. Kept separate from recruits so the card can show a history
-- instead of a single notes blob that whoever types last overwrites.
create table if not exists public.recruit_events (
  id         bigserial primary key,
  recruit_id uuid not null references public.recruits(id) on delete cascade,
  at         timestamptz not null default now(),
  who        text,                                   -- access-code name of whoever acted
  kind       text not null default 'note',           -- note | call | text | stage
  body       text
);
create index if not exists recruit_events_recruit_idx on public.recruit_events (recruit_id, at desc);

alter table public.recruits       enable row level security;
alter table public.recruit_events enable row level security;

-- Granular rather than "for all using(true)". No anon DELETE on recruits: the
-- board moves a dead recruit to the lost stage, it never removes the row, so a
-- misfire cannot erase someone's history. Deletes are done by hand in the SQL
-- editor on the rare occasion someone asks to be removed.
drop policy if exists "anon read recruits"   on public.recruits;
drop policy if exists "anon insert recruits" on public.recruits;
drop policy if exists "anon update recruits" on public.recruits;
create policy "anon read recruits"   on public.recruits for select using (true);
create policy "anon insert recruits" on public.recruits for insert with check (true);
create policy "anon update recruits" on public.recruits for update using (true) with check (true);

drop policy if exists "anon read recruit_events"   on public.recruit_events;
drop policy if exists "anon insert recruit_events" on public.recruit_events;
drop policy if exists "anon delete recruit_events" on public.recruit_events;
create policy "anon read recruit_events"   on public.recruit_events for select using (true);
create policy "anon insert recruit_events" on public.recruit_events for insert with check (true);
-- delete exists only for the undo on a note typed into the wrong card.
create policy "anon delete recruit_events" on public.recruit_events for delete using (true);

grant select, insert, update on public.recruits to anon;
grant select, insert, delete on public.recruit_events to anon;
grant usage, select on sequence public.recruit_events_id_seq to anon;

-- updated_at is what the board sorts a column by, so it has to move on every
-- stage change without every caller remembering to set it.
create or replace function public.recruits_touch() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;
drop trigger if exists recruits_touch_trg on public.recruits;
create trigger recruits_touch_trg before update on public.recruits
  for each row execute function public.recruits_touch();
