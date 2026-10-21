---
name: dealcheck-import
description: Import an ISP's deal list (CSV or Excel of customers the ISP wants verified by phone) into the Deal Check call queue. Use whenever the user drops or points at a list of deals, orders or customers from an ISP (Ezee first, any ISP later) that callers should phone through to mark Clean Deal, Didn't order, No Answer or Bad Phone Number before the list goes back to the ISP. Triggers on "here is the Ezee list", "load these for the callers", "deal check list", "verify these deals". Not for cancel lists (cancel-list-import) or new-lead sector files (isp-leads).
---

# Import an ISP deal list into Deal Check

Deal Check (More > Deal Check for admin; the "Deal check" switch on a caller login)
works lists in `dealcheck_leads`. Callers see the script, dial, and mark each lead
Clean Deal, Didn't order, No Answer or Bad Phone Number. Export CSV hands the
marked list back to the ISP.

## Steps

1. **Read the file headers and a few rows.** Excel: convert to CSV first
   (`python3 -c "import pandas as pd;pd.read_excel('f.xlsx').to_csv('f.csv',index=False)"`).
   One list per import. Name the list after what the ISP called it or the date.
2. **Check the column mapping.** `scripts/dealcheck-import.mjs` guesses from
   header names (name, phones, address, order number, email, package, sale date,
   notes, rep). Read the `columns used:` line of the dry run. For a layout the guess
   gets wrong, add a `PROFILES` entry keyed by the ISP slug (first word of the ISP
   name, lowercased).
3. **Dry run, always first:**
   ```
   node scripts/dealcheck-import.mjs "<file.csv>" --isp "Ezee Fiber" --list "Oct 7 list" --dry
   ```
   Use the ISP name exactly as the deals feed spells it (`Ezee Fiber`), so Grow
   matching and the script lookup line up. Report rows, Grow matches, no phone,
   duplicates.
4. **Write it:** same command without `--dry`. Re-running the same file is safe:
   ids are `<slug>:<order number>` (or phone, or address) and rows update in place.
5. Tell the user the list is in and unassigned. The lead caller or admin hands it
   out on the Assign tab (Split evenly, or pick and assign). The script lives in
   `dealcheck_scripts`, one per ISP, edited in the app (Edit script).

## Tables

`dealcheck_leads` (this import), `dealcheck_calls` (every call), `dealcheck_assign`
(who works what), `dealcheck_scripts` (the script per ISP). SQL: `api/dealcheck.sql`.
