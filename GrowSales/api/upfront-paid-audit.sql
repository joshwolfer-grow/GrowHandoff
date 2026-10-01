-- Payroll self-audit schema (applied 2026-08-05 via Supabase MCP; kept here so
-- the repo records every migration, same as the other api/*.sql files).
--
-- 1) Per-rep snapshot on upfront_paid. Amounts are written when a pay run
--    closes; a bare paid=true row (pre-migration) is treated by the app as
--    "assumed paid at owed". Owed stays live-computed from deal data; paid is
--    frozen here — the drift between the two is the audit signal.
alter table public.upfront_paid add column if not exists deals    integer;
alter table public.upfront_paid add column if not exists amount   integer;  -- net paid: deals*50 - clawback
alter table public.upfront_paid add column if not exists clawback integer;

-- 2) Re-enrollment periods on upfront_optin. A rep can leave upfront and come
--    back when their install rate recovers, so the sheet legitimately holds the
--    same name twice with different active/end windows. name alone can no
--    longer be the key; (name, active_date) is one enrollment period.
alter table public.upfront_optin alter column active_date set default '1970-01-01';
update public.upfront_optin set active_date = '1970-01-01' where active_date is null;
alter table public.upfront_optin alter column active_date set not null;
alter table public.upfront_optin drop constraint if exists upfront_optin_pkey;
alter table public.upfront_optin add primary key (name, active_date);

-- Room for the later manual "Pay History" sheet import (NOT created yet): a
-- future upfront_pay_history (rep, start_date, end_date, deals, amount, note)
-- would join the app's ledger on (rep, pay_week = start_date) as a third
-- reconciliation column. Nothing above depends on it.
