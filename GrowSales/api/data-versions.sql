-- data_versions: one row per big table, stamped by a statement trigger on
-- every insert/update/delete/truncate. The dashboard keeps its last download
-- of each table in IndexedDB and only re-downloads a table whose stamp moved,
-- instead of pulling ~17 MB on every page load (Supabase egress quota, Sep 2026).
-- Applied Sep 30 2026.

create table if not exists public.data_versions (
  tbl text primary key,
  v   timestamptz not null default now()
);
alter table public.data_versions enable row level security;
drop policy if exists data_versions_read on public.data_versions;
create policy data_versions_read on public.data_versions for select using (true);
grant select on public.data_versions to anon, authenticated;

-- security definer: the syncs write as anon, which has no write grant here.
create or replace function public.bump_data_version() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.data_versions (tbl, v) values (tg_table_name, clock_timestamp())
  on conflict (tbl) do update set v = excluded.v;
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['deals','bria_deals','bria_sales_daily','knocking','knocking_isp'] loop
    execute format('drop trigger if exists %I on public.%I', 'bump_version_' || t, t);
    execute format('create trigger %I after insert or update or delete or truncate on public.%I
                    for each statement execute function public.bump_data_version()', 'bump_version_' || t, t);
    insert into public.data_versions (tbl) values (t) on conflict do nothing;
  end loop;
end $$;
