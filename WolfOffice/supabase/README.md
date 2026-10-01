# Wolf Office database

Wolf Office keeps its own small Supabase project (separate from Grow Sales). It holds four
tables: `office_agents` (one row per worker desk), `office_events` (start/finish/heartbeat
log), `office_tasks` (the Runner's queue) and `office_snapshots` (each worker's daily JSON).

## New project

1. Create a Supabase project (any name, e.g. "Wolf Office").
2. In the SQL editor run these files, in this order:

   | order | file | what |
   |---|---|---|
   | 1 | `0001_office.sql` | the four tables, RLS on, first five desks. **Edit the policy block first** (see below) |
   | 2 | `0005_payaudit.sql` | Pay Auditor desk |
   | 3 | `0006_tasks_runner.sql` | task queue columns, Runner and Chief desks, team/lead columns |
   | 4 | `0008_mgrcards.sql` | Card sender desk |
   | 5 | `0009_grow_roster.sql` | `duty` column + the full 22 desk Grow roster (upsert, safe to re-run) |

   The gaps in numbering (0002, 0003, 0004, 0007) are files that were not Grow and were removed.

3. Project Settings > API: copy the Project URL and the `service_role` key into
   `../.env` as `OFFICE_SUPABASE_URL` and `OFFICE_SERVICE_KEY`.

### The policy placeholder in 0001

`0001_office.sql` has five `create policy` lines with `<SUCCESSOR_AUTH_UID>`. Everything in
Wolf Office uses the service key, which bypasses RLS, so you can simply **delete those five
lines**. Keep them only if you want to read the tables from a browser signed in to this
project: create your user under Authentication > Users and paste its User UID in place of
`<SUCCESSOR_AUTH_UID>`. Left unedited, those lines fail on purpose (not a valid uuid).

## If the existing project is transferred instead

The live project is `hydnqquciomyfuntavhr`. It was rebuilt on Oct 1 2026 through the
Supabase MCP, not by running these files, so treat these files as a close record rather
than an exact one. Before relying on them, compare against the live schema
(`list_tables` on hydnqquciomyfuntavhr, or Table Editor). As of Oct 1 2026 the live project
had the four tables above, a `duty` column on `office_agents`, the 22 Grow desks in
`0009_grow_roster.sql`, and **no RLS policies** (service key only).

Rotate the service key after the transfer; the old one lived on the previous owner's Mac.
