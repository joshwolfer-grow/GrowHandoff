# GrowSales Data API

Everything the dashboard shows comes from one Postgres database (Supabase),
read over its auto-generated REST API (PostgREST). There is no separate
application API to document: the dashboard itself is a static page that queries
these tables directly, so anything the site can show, this API can return.

Base URL:

    https://cmkfohwbejcztctrpdnt.supabase.co/rest/v1

---

## 1. Auth

Every request needs two headers carrying the same key:

    apikey: <KEY>
    Authorization: Bearer <KEY>

Quick smoke test:

```bash
curl -s "https://cmkfohwbejcztctrpdnt.supabase.co/rest/v1/deals?select=rep,sale_date,status&limit=3" \
  -H "apikey: $GROW_KEY" -H "Authorization: Bearer $GROW_KEY"
```

**Which key to hand over — read this before sending anything.**

The key currently embedded in the dashboard is the Supabase *anon* key. It is
already public (it ships inside `index.html`, so anyone who opens the site has
it). But the row-level security policies grant the `public` role INSERT and
DELETE on `deals`, `knocking`, `leaderboard`, `goals`, `report_config`,
`training_cards` and others. Anyone holding that key can **delete the deals
table**, not just read it.

So: do not hand the anon key to an outside consumer. Mint a read-only key first
(section 6). The rest of this document is identical either way — only the key
changes.

---

## 2. Query syntax

PostgREST. Filters are query params, one per column.

| Want | Query string |
|---|---|
| Pick columns | `?select=rep,sale_date,status` |
| Equals | `?status=eq.Serviced` |
| Not equals | `?status=neq.Cancelled` |
| Greater / less | `?sale_date=gte.2026-01-01&sale_date=lt.2026-09-01` |
| In a list | `?status=in.(Serviced,Pending)` |
| Is null | `?cancel_date=is.null` |
| Text contains | `?city=ilike.*provo*` |
| Sort | `?order=sale_date.desc` |
| Limit | `?limit=1000` |
| Page | `?limit=1000&offset=2000` |
| Row count | header `Prefer: count=exact`, read `Content-Range` |

Combine freely; multiple params are ANDed.

```bash
# every serviced deal sold in July 2026, newest first
curl -s "$BASE/deals?select=rep,manager,isp,sale_date,install_date\
&status=eq.Serviced&sale_date=gte.2026-07-01&sale_date=lt.2026-08-01\
&order=sale_date.desc&limit=1000" \
  -H "apikey: $GROW_KEY" -H "Authorization: Bearer $GROW_KEY"
```

**Pagination matters.** The default page cap is 1000 rows. `deals` is 20k rows
and `knock_events` is 97k, so a consumer pulling full history must page with
`limit`/`offset` until a short page comes back. Requesting `limit=50000` works
against this project (the dashboard does it), but paging is the safe pattern.

Aggregation is not exposed — no GROUP BY over REST. Consumers pull rows and
aggregate on their side. If they need server-side rollups, say so and we can add
a Postgres view, which shows up as a new endpoint automatically.

---

## 3. The tables worth pulling

### `deals` — the deal feed (20,300 rows, 2026-01-01 to present)

One row per sale, synced nightly from Sequifi at 08:30 UTC. This is the table
most questions are answered from.

| Column | Type | Notes |
|---|---|---|
| `id` | bigint | primary key |
| `rep` | text | salesperson |
| `manager` | text | manager credited on the deal (see gotcha 3) |
| `status` | text | `Serviced` 11907 · `Cancelled` 4221 · `Pending` 3649 · `Clawback` 523 |
| `deal_type` | text | `Standard` 17670 · `Presale` 2630 |
| `isp` | text | carrier |
| `package` | text | plan sold |
| `adders` | text | add-ons |
| `sale_date` | date | when it was sold |
| `install_date` | date | actual install, null until installed |
| `planned_install` | date | scheduled install |
| `cancel_date` | date | null unless cancelled |
| `cancel_reason` | text | |
| `days_since_cancel` | int | |
| `past_due` | bool | |
| `week` | date | Sunday-anchored week start (gotcha 1) |
| `customer`, `phone`, `address`, `city`, `state`, `zip` | text | **customer PII** |
| `created_at` | timestamptz | row insert time, not a business date |

### `bria_sales_daily` — sales and installs of record (9,763 rows, 2025-02-17 to present)

Per rep, per day. Synced from Bria nightly at 09:00 UTC. This — not `deals` — is
the source of truth for sold counts and install counts, and it reaches back a
year further.

`rep` · `sale_date` · `deals` int · `installs` int · `updated_at`

### `bria_deals` — deal-level Bria detail (32,814 rows)

`bria_id` · `rep` · `customer` · `phone` · `isp` · `product` · `sale_date` ·
`install_date` · `install_time` · `install_end_time` · `updated_at`.
**Contains customer PII.**

### `knocking` — one row per rep per day of door knocking (9,374 rows, 2025-10-27 to present)

`rep` · `date` · `doors` · `unique_doors` · `contacts` · `sold` · `hours` ·
`first_disp` · `last_disp` · `source` · `method`

**You must filter on `method` or you will double count.** Three collection
methods overlap on the same rep-days:

| `method` | rows | what it is |
|---|---|---|
| `timetrack` | 4880 | SalesRabbit Time Track export. **The only source of real clock `hours`.** |
| `sr_activity` | 3093 | SalesRabbit activity crawl. Door and contact counts, no true hours. |
| `amplify` | 222 | TDS only, distrusted for Grow numbers. |
| `sr_frozen_kc` | 38 | frozen historical slice |
| null | 1141 | pre-dates the method column |

`source` is the company: `ezee` 4880 · `grow` 4272 · `tds` 222.
For Grow door metrics: `?method=eq.sr_activity`. For hours worked:
`?method=eq.timetrack`.

### `knock_events` — raw per-door events (97,195 rows)

`lead_id` · `rep` · `rep_id` · `team_id` · `activity_id` · `activity` · `at` ·
`date` · `source`. A "knock" is a `stage_updated` mark. This is the grain
`knocking` is aggregated from — only worth pulling for door-level analysis.

### Supporting tables

| Table | Rows | What |
|---|---|---|
| `bria_reps` | 469 | rep → bria_id, photo_url |
| `rep_onboarding` | 474 | Sequifi roster: name, office, position, manager, status, onboarding state. **Contains rep emails and mobile numbers.** |
| `training_completion` | 566 | per rep per course: lessons done/total, %, quiz, complete, overdue_days |
| `leaderboard` | 71 | rep → YTD deals, sourced from Bria |
| `goals` | 65 | `scope` (rep or manager) · `metric` · `target` · `week` (null = standing goal) |
| `rep_manager_overrides` | 4 | manual rep → manager corrections, per week |
| `rep_aliases` | 23 | duplicate-name consolidation (e.g. Samantha Boyd → Sammi Boyd) |
| `week_reconciliation` | 1 | which weeks are closed/sealed |
| `pronto_deal_events` | 9,008 | deal-announcement reactions in team chat: user, local_date, local_hour, is_golden |

### Do not share these

| Table | Why |
|---|---|
| `pronto_messages` | 45,344 raw internal chat messages |
| `manager_contacts` | manager phone numbers and emails |
| `upfront_paid`, `upfront_pay_runs`, `upfront_tier`, `upfront_chargeback`, `upfront_optin` | individual pay, clawbacks, who opted into upfront pay |
| `access_codes`, `push_subscriptions` | credentials and device tokens (already blocked — RLS on, no policy) |
| `report_config` | app config keyed by magic strings; writable, easy to break the dashboard |
| `doc_chunks` | internal training/search index |

`deals.customer/phone/address` and `bria_deals.customer/phone` are customer PII.
If the consumer only needs performance numbers, have them `select=` the columns
they need and leave those out — or use the column-restricted proxy in section 6.

---

## 4. Definitions the consumer must match

These are how the dashboard computes things. A consumer that defines them
differently will produce numbers that disagree with ours, and the conversation
becomes about whose number is right instead of what it means.

1. **Weeks are Sunday-anchored.** `deals.week` is the Sunday. Do not re-derive
   with an ISO (Monday) week or every weekly total shifts.
2. **Sales come from Bria, installs from install reports.** `bria_sales_daily`
   is authoritative for sold and installed counts, not `deals`.
3. **Rep → manager changes week to week.** The `manager` on a deal is the
   manager at the time of sale, and it is sometimes wrong; `rep_manager_overrides`
   corrects it. Never treat rep → manager as a fixed mapping.
4. **Install Rate** = installs ÷ sold. **Completed IR** = installs ÷ (installs +
   cancels). Two different numbers, routinely confused.
5. **PRA** (per rep average) divides by days *worked* — a day with more than 10
   knocks or a sale — not by days with a sale. Dividing by sale-days inflates PRA
   by about 14%.
6. **Contact** = Not Interested, Call Back, No English, Do Not Knock, or Sold.
   Vacant and For Sale doors come out of the denominator ("knockable doors").
   The 60% contact rate is an *area* standard, not a per-rep one.
7. **Excluded everywhere:** Daxton Day and Nick Boyd (intake accounts), plus
   bursts of 10+ stage changes by one rep inside 60 seconds (bulk edits, not
   knocks).

---

## 5. Freshness

| Data | Refreshed |
|---|---|
| `deals` | daily 08:30 UTC (Sequifi sync) |
| `bria_sales_daily`, `bria_deals`, `bria_reps` | daily 09:00 UTC (Bria sync) |
| `pronto_*` | daily 08:45 UTC |
| `knocking` (`sr_activity`), `knock_events` | manual crawl, typically daily |
| `knocking` (`timetrack`) | manual import when the Time Track report lands |

A watchdog at 10:00 UTC checks the three crons ran. Anything read before ~09:15
UTC may be a day stale. `bria_sync_meta`, `sequifi_sync_meta` and
`pronto_sync_meta` each expose the last successful run if the consumer wants to
gate on freshness.

---

## 6. Minting a read-only key

Two options. Both leave the dashboard working exactly as it does now.

**Option A — read-only database role (15 min, no code).** Create a role with
SELECT on only the tables you want shared, then sign a JWT carrying that role
with the project's JWT secret. Hand over the JWT. PostgREST enforces it at the
database, so the consumer physically cannot write, and cannot see a table you
did not grant.

```sql
create role growsales_readonly nologin;
grant usage on schema public to growsales_readonly;
grant select on
  deals, bria_sales_daily, bria_deals, bria_reps, knocking, knock_events,
  leaderboard, goals, training_completion, rep_onboarding,
  rep_manager_overrides, rep_aliases, week_reconciliation, pronto_deal_events
to growsales_readonly;
grant growsales_readonly to authenticator;

-- read-only RLS policies for the new role
create policy "ro read deals" on deals for select to growsales_readonly using (true);
-- ...one per table above
```

**Option B — a proxy endpoint (about an hour).** Add `api/public-data.js` on
Vercel holding the service key server-side and accepting its own bearer token.
It whitelists tables *and columns*, so customer names and phone numbers never
leave the building, and revoking access is one env var. Worth it if the consumer
is outside the company or if this becomes more than one integration.

Say which you want and I'll build it.

---

## 7. Worked examples

```bash
BASE=https://cmkfohwbejcztctrpdnt.supabase.co/rest/v1
H1="apikey: $GROW_KEY"; H2="Authorization: Bearer $GROW_KEY"

# sold and installed by rep for a week
curl -s "$BASE/bria_sales_daily?select=rep,sale_date,deals,installs\
&sale_date=gte.2026-08-09&sale_date=lte.2026-08-15" -H "$H1" -H "$H2"

# door metrics, correct method filter, no PII
curl -s "$BASE/knocking?select=rep,date,doors,unique_doors,contacts,sold\
&method=eq.sr_activity&date=gte.2026-08-01&order=date.desc" -H "$H1" -H "$H2"

# hours worked (only timetrack carries real hours)
curl -s "$BASE/knocking?select=rep,date,hours&method=eq.timetrack\
&date=gte.2026-08-01" -H "$H1" -H "$H2"

# cancels with reasons, no customer data
curl -s "$BASE/deals?select=rep,manager,isp,sale_date,cancel_date,cancel_reason\
&status=eq.Cancelled&cancel_date=gte.2026-07-01" -H "$H1" -H "$H2"

# total row count without pulling rows
curl -sI "$BASE/deals?select=id&limit=1" -H "$H1" -H "$H2" \
  -H "Prefer: count=exact" | grep -i content-range
```
