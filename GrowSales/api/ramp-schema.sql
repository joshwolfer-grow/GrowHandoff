-- Rep ramp weeks: one row per rep per Sunday-anchored week since the rep's first
-- worked day (a day with more than 10 doors after the per-day source merge).
-- Powers the Ramp strip on the rep snapshot (api/weekly-rep-email.js). Applied
-- Oct 20 2026. Rules: docs/ramp-bonus-baseline.md.
create or replace view public.rep_ramp_weeks as
with al as (select source_name, canonical_name from rep_aliases where status='confirmed'),
kd as (
  -- per rep-day: grow-side sources measure the same doors, take the max; tds adds.
  select coalesce(al.canonical_name, k.rep) rep, k.date,
         max(case when k.source='tds' then 0 else coalesce(k.doors,0) end)
       + coalesce(sum(case when k.source='tds' then k.doors end),0) doors
  from knocking k left join al on al.source_name=k.rep
  group by 1,2
),
kw as (select rep, date, doors from kd where doors>10),
b as (select coalesce(al.canonical_name,b.rep) rep, b.sale_date, b.deals, b.installs
      from bria_sales_daily b left join al on al.source_name=b.rep),
f as (select rep, min(date) first_day from kw group by rep),
cohort as (
  select f.rep, f.first_day from f
  where f.first_day >= current_date - 140
    and not exists (select 1 from b where b.rep=f.rep and b.deals>0 and b.sale_date < f.first_day - 14)
),
wk as (select c.rep, c.first_day, (kw.date - extract(dow from kw.date)::int) w0, count(*) days, sum(kw.doors) doors
       from cohort c join kw on kw.rep=c.rep group by 1,2,3),
bw as (select c.rep, (b.sale_date - extract(dow from b.sale_date)::int) w0, sum(b.deals) deals, sum(b.installs) installs
       from cohort c join b on b.rep=c.rep and b.sale_date >= c.first_day - 6 group by 1,2)
select wk.rep, wk.first_day, wk.w0, wk.days::int, wk.doors::int,
       coalesce(bw.deals,0)::int deals, coalesce(bw.installs,0)::int installs
from wk left join bw on bw.rep=wk.rep and bw.w0=wk.w0;
