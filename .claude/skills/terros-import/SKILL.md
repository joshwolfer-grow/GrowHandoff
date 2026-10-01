---
name: terros-import
description: Turn a raw address/lead file into a Terros-ready import CSV — geocode every address to rooftop coordinates via the Geocodio API, assign the leads to a rep, and emit the exact 36-column Terros schema. Use whenever the user drops an address list, lead list, or territory file (CSV or Excel) and wants it geocoded and/or prepared for Terros, especially when they name a rep to assign it to. Triggers on phrases like "geocode this file", "get this ready for Terros", "import these leads", "assign these to <rep>", or when a file named like "TERROS ... Import" is provided.
---

# Prepare a lead file for Terros

Raw address files arrive in **wildly different column layouts** — sometimes one
`address` column, sometimes street number / directional / name / suffix split
across five columns, with unpredictable header names. That variability is why
this is a human-in-the-loop workflow rather than a UI in the app: read the file,
confirm the mapping, then run a deterministic script.

The script is `scripts/geocode-file.mjs`. It handles parsing, column detection,
address assembly, geocoding, caching, and schema output.

## Steps

1. **Get the file somewhere readable.** macOS blocks `~/Downloads` for this
   process. Have the user copy it into `data/`:
   ```
   cp ~/Downloads/<file>.csv ~/Grow/GrowSales/data/
   ```
   If it's `.xlsx`, convert to CSV first (use the `xlsx` skill).

2. **Dry-run to confirm the column mapping before spending any lookups:**
   ```
   node scripts/geocode-file.mjs data/<file>.csv --terros --dry
   ```
   Check the detected mapping and the five assembled sample addresses. This is
   the whole safety net — if the samples read like real addresses, the mapping
   is right. Watch specifically for a **dropped directional** (`1101 N Highland`
   becoming `1101 Highland`), which silently mismatches.

   If detection is wrong, override per role:
   ```
   --number HouseNo --predir Dir --street StreetName --suffix St_Type \
   --unit Apt --city City --state ST --zip ZipCode
   ```
   or `--full "Property Address"` for a single-column address.

3. **Resolve the rep to a Terros user ID.** The user gives a rep *name*; the
   `owner` column needs a *U.xxx* ID. `data/terros-reps.json` is a cache of the
   live roster. Refresh it any time with:
   ```
   curl -s -X POST https://api.terros.com/user/list \
     -H "Authorization: ApiKey $TERROS_API_KEY" -H "Content-Type: application/json" -d '{}'
   ```
   (key in `~/.terros.env`). Match first+last name → `userId`.

4. **Geocode + format:**
   ```
   node scripts/geocode-file.mjs data/<file>.csv --terros \
     --rep "<Rep Name>" --out data/<name>-terros.csv
   ```
   Add any fixed column with repeated `--set col=value`.

5. **Report to the user:** match rate, **rooftop percentage**, accuracy-type
   breakdown, and — most important — **any street with clustered non-rooftop
   results** (group failures by street; one street dominating = likely bad
   input, e.g. the Monroe St/Ave case). Rooftop (`building_centroid`) = pin on
   the house; `range_interpolation` = estimated along the street, may be off.

6. **Upload to Terros:**
   ```
   node scripts/push-to-terros.mjs data/<name>-terros.csv --name "<label>"
   ```
   This POSTs `/import/add` (entity=Account, disableGeocoding=true so Terros
   trusts our pins, addMissingUsers=false, createCustomLocations=true), uploads
   the CSV to the returned S3 URL, polls status, and prints successes/errors.
   **The first live upload creates real records** — for a new setup, test with a
   1-row file first, verify in the Terros UI, then run the full file.

7. **If an import is wrong, roll it back** (removes every record it created):
   ```
   node scripts/push-to-terros.mjs --cleanup <Import.xxx>
   ```

Sidecar files from step 4: `*.audit.csv` (per-address accuracy), `*.failures.csv`
(unmatched — **excluded** from the Terros output; a blank-coordinate lead would
import as a null-island pin).

## Bad pins are usually bad input, not a bad geocoder

Measured on 377 real Wauconda addresses (2026-07-23), Geocodio returned 88.9%
rooftop vs Smarty's 76.4%, and where both said rooftop they agreed to a median
of **0.7 m** — same underlying data. Smarty put 52 addresses on a ZIP centroid
that Geocodio placed correctly, and rescued only 3 of Geocodio's 42 misses.
**Switching vendors is not the fix.** Don't re-litigate this without new data.

The real culprit was the source file: every `MONROE ST` row was wrong, since
Wauconda has a Monroe **Ave** and no Monroe St. Rewriting the suffix lifted
rooftop coverage to 92.0%.

So when pins land off the house, **check the input before blaming the API**:
group the non-rooftop rows by street. If one street dominates, its name or
suffix is probably wrong in the source. Geocodio's normalized
`formatted_address` shows what it thinks the address really is; a mismatch with
the input is the tell.

## Terros import API — hard-won specifics

- **`workflowId` is mandatory in practice.** Without it the import still reports
  success, but the accounts are orphaned — invisible in the Accounts list, the
  map, and every filter. Resolve it from `POST /workflow/list` (currently one:
  "Grow Marketing" `WF._POU8GKSNuUi6HSvtMjDN`, whose stages are the valid
  `status` values). `push-to-terros.mjs` now does this automatically and aborts
  if no workflow is found. **If leads "don't show up" after a successful import,
  this is the first thing to check.**
- **Required header `status`.** The Account import fails wholesale with
  `Missing required header: status` if absent. Its value must be a valid **stage**:
  Start, Lead, Unique Knock, Contact, Sold, Call Back, Current Customer, Do Not
  Knock, No English, Not Home 1/2/3, Not Interested, Vacant Home. These imports
  always use `Lead`. "New Lead" (common in source files) is **invalid** and makes
  every row error. The script hardcodes `status=Lead` and `stage=Lead`.
- **Empty street = rejected row.** Terros rejects any row with no `street`.
  Geocodio "place"-level matches resolve to an area with no street, so the script
  now routes empty-street rows to failures (marked `NO_STREET`) instead of the
  import. Expect a few of these on rural files.
- **Cleanup needs `{entity, importId, fullRun:true}`** — not just importId, or it
  returns `NotAuthorized ... permission to undefined`. `push-to-terros.mjs
  --cleanup <id>` sends the right shape and fully removes an import's records.
- **`/import/errors` returns `[]` even when rows errored** — the per-row reason is
  not reliably exposed. Diagnose failures from the data instead (empty street,
  invalid status, duplicate coords).
- **A whole-file rejection** (status `Failed`, 0 successes/0 errors) puts the
  reason in the import log's `reason` field (via `/import/get` or `/import/list`).

## Notes

- **Costs money.** Geocodio is $1 per 1,000 lookups with a 2,500/day free tier
  that the user often spends on other work. The script prints an estimate before
  starting and dedupes identical addresses. Results cache to
  `~/.geocodio-cache.json`, so re-runs and overlapping territory are free.
- **A 403 saying "exceeded the free tier" usually means the daily 2,500 is
  spent**, not that anything is misconfigured. It resets at midnight.
- **API key** lives in `~/.geocodio.env` as `GEOCODIO_API_KEY`. Geocoding
  permissions only (GET + POST `/v2/geocode`); no reverse, no field appends —
  appends multiply cost, since `lookups = addresses x (1 + fields)`.
- **Geocodio normalizes addresses**, correcting things like `Monroe St` to
  `Monroe Ave`. The Terros output uses Geocodio's corrected components, not the
  raw input.
- **The assignment column is `owner`** — it holds the Terros rep ID for whoever
  the leads go to. A known-good import populates only these eight fields:
  `street, city, state, zip, latitude, longitude, owner, stage` (stage=`Lead`).
  Everything else, including `sourceId` and `team`, is blank unless asked for.
- Schema lives in `data/terros-schema.csv`. If Terros changes its import format,
  update that file and everything follows.
