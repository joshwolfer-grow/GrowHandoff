---
name: cancel-list-import
description: Import an ISP's cancel list (CSV or Excel of cancelled installs with the ISP's cancel notes) into the Callbacks call queue. Use whenever the user drops or points at a file of cancels, cancel calls, cancelled orders or cancel reasons from an ISP (Lyte, i3, TDS, Ezee, Bluepeak, Omni, GFiber and so on) and wants callers to work it, or says "here is the cancel list for <ISP>", "load these cancels", "add these to callbacks". Not for new-lead or sector files (that is isp-leads).
---

# Import an ISP cancel list into Callbacks

The Callbacks page (More > Callbacks for admin; the whole app for cancel caller
logins) works two sources: Grow deals the sales sheet marks Cancelled, and ISP
cancel lists in the `callback_leads` table. This skill loads the second kind.

ISP lists are the truth for cancels. The first Lyte list (Sep 11 2026) had 73 Grow
sales on it, and our deals feed still called 68 of them Pending.

## Steps

1. **Read the file headers and a few rows.** Excel: convert to CSV first
   (`python3 -c "import pandas as pd;pd.read_excel('f.xlsx').to_csv('f.csv',index=False)"`).
2. **Check the column mapping.** `scripts/callback-import.mjs` has a `PROFILES`
   entry per ISP slug (first word of the ISP name, lowercased). Lyte is mapped. For
   a new layout, add a profile: `order` (a stable per-customer id, required),
   `status`, `name`, `email`, `phones` (array, best first), `address` (full
   address, "street, city, state, zip"), `area`, `notes`, `date` (cancel date).
   Without a profile the script guesses from header names; read what it prints.
3. **Dry run, always first:**
   ```
   node scripts/callback-import.mjs "<file.csv>" --isp "Lyte Fiber" --dry
   ```
   Use the ISP name exactly as the deals feed spells it (`Lyte Fiber`, `i3 Broadband`,
   `Ezee Fiber`...), so Grow matching and the ISP filter line up.
   Report to the user: rows, how many are Grow sales, what our deals feed says
   about those (Pending ones are status our sheet never caught up on), how many
   have a cancel note, no phone, DO NOT CALL.
4. **Write it:** same command without `--dry`. Re-running a newer export of the
   same list is safe: ids are `<slug>:<order number>` and rows update in place.
5. Tell the user the leads are in and unassigned. The lead caller or admin hands
   them out on the Assign tab (Split evenly, or pick and assign).

## What the script does to the data

- Strips ISP system text from notes ("Created for Object/Order ..."), pulls
  "Additional contact info" numbers into `phone2`, turns "[New Update - Aug 12 ...]"
  stamps into "Aug 12:", and drops a note repeated by its own update.
- `dnc` is set when the notes say do not call; those never enter the queue.
- Grow match: phone first, then street number + street name, rejected if both
  sides have a zip and they differ, then (profiles with a `sold` column) customer
  name + sale date within 7 days. Lyte deals carry no phones, so Lyte lists without
  addresses only match that last way. A slug can have several layouts: profiles
  named `<slug>_<variant>` (e.g. `lyte_cbi`, the "Cancel before install" sheet)
  are picked by which order column the file has. A match stores `deal_key` (same shape as the
  call log key, customer | sale date | isp lowercased), so calls on that lead also
  show on the Grow deal card.

## Tables

`callback_leads` (this import), `callback_assign` (who works what),
`cancel_callbacks` (every call). SQL: `api/callback-leads.sql`, `api/cancel-callbacks.sql`.
