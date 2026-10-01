---
name: timetrack-import
description: Import a "Time Track" knocking export (the Realtime Results / SR_TimeTrack report, sourced from Bluepeak territory data, with D2DRep / Date Worked / Time Span / Doors Knocked columns) into the Grow knocking table, so rep hours, first/last knock, doors, and sold land in the dashboard. Use whenever the user uploads or references a Time Track / knocking-hours export (CSV or Excel) and wants it added to the knocking data. Triggers on phrases like "import the time track", "add this knocking report", "load the rep hours", or when a file named like Time_Track / SR_TimeTrack is provided.
---

# Import a SalesRabbit Time Track export into `knocking`

The dashboard's `knocking` table (per rep, per day: `hours`, `first_disp`,
`last_disp`, `doors`, `unique_doors`, `contacts`, `sold`) is sourced from
SalesRabbit's **Time Track** report. This skill turns that export into rows in
one step. Writes use the public anon key (the table allows anon writes), so no
secrets are needed.

## Steps

1. **Locate the file.** The user drops a Time Track export into the project (or
   names its path). It's usually `.csv`; sometimes `.xlsx`.

2. **If it's Excel (.xlsx), convert to CSV first.** Read the sheet (use the
   `xlsx` skill or any converter) and write a plain `.csv` with the same
   columns. The report's columns are:
   `System, Team, D2DRep, Date Worked, Day Value, Total Days, First Disposition,
   Last Disposition, Time Span, Doors Knocked, Unique Doors Knocked, Sold,
   Attempts of Valid Leads, Contact as % of Valid Leads, ...`

3. **Dry-run to sanity-check the parse:**
   ```
   node scripts/import-timetrack.mjs <path-to.csv> --dry
   ```
   Confirm the row count, rep count, and date range look right, and that the
   first few mapped rows have sensible `hours` / `doors` / `sold`.

4. **Run the real import:**
   ```
   node scripts/import-timetrack.mjs <path-to.csv>
   ```
   It deletes the exact rep/day cells in the file, then inserts fresh — so
   re-running the same export never duplicates.

5. **Report** what landed (rows, reps, date range) back to the user. If any rep
   names look off, mention them — the dashboard matches knocking `rep` to deal
   `rep` by exact name, so a spelling mismatch means that rep's hours won't
   attribute (fix the name in the export or flag it).

## Automated drop-folder (Tier 3)

Two macOS launch agents make this hands-off after the download (install once via
`bash scripts/install-timetrack-agents.sh`):
- **Watcher** (`com.grow.timetrack-import`) — the moment a CSV lands in
  `imports/`, it runs `node scripts/import-timetrack.mjs --scan`, imports it, and
  moves it to `imports/done/`. So the user just saves the export into `imports/`.
- **Reminder** (`com.grow.timetrack-reminder`) — a 9am Mon–Fri notification to
  pull the report.

`--scan` imports every CSV in `imports/` and moves each to `imports/done/`; run it
manually any time with `npm run import-timetrack`. Log: `imports/done/import.log`.

## Historical backfill from the report emails

Before 2026-04-02 the only copy of the Ezee / Houston Time Track report is the
daily email. To ingest a pile of those at once, with no credentials:

1. In Gmail, search the report emails (`from:… subject:"Time Track"
   before:2026/04/02`), select all, apply a label like `timetrack-backfill`.
2. Google Takeout → Mail → that label only → download the `.mbox`.
3. Harvest the attachments:
   ```
   node scripts/harvest-timetrack-mail.mjs ~/Downloads/timetrack-backfill.mbox --dry
   node scripts/harvest-timetrack-mail.mjs ~/Downloads/timetrack-backfill.mbox
   ```
   It walks every MIME part, keeps the `.csv` / `.xlsx` report attachments,
   converts xlsx → csv (`scripts/_xlsx2csv.mjs`, zero-dep, uses system `unzip`),
   and writes them to `imports/` named `YYYY-MM-DD-<file>.csv` from the email
   date. `--before=` / `--after=` bound the range (default `--before=2026-04-02`).
   Any email carrying a *download link* instead of a file is listed at the end —
   those have to be fetched by hand.
4. `npm run import-timetrack` — imports every harvested CSV and moves it to
   `imports/done/`. Idempotent, so overlapping days are safe.

The input can also be a folder of `.eml` files, if the mail gets exported that
way instead.

Before doing any of this, check whether the Realtime Results report builder will
still run Time Track over a Jan 1 → Mar 31 range. If it will, that's one CSV
straight into `imports/` and the email path is unnecessary.

## Notes

- The **CSV export uses raw report-builder field names**, not the PDF's pretty
  labels — the parser handles both. Real → knocking mapping: `D2DRep1`→rep,
  `RecordDate1`→date, `TotalTime1`→hours, `StartTime`/`EndTime`→first/last knock
  (datetimes reformatted to "1:12 PM"), `AllAttempts`→doors,
  `UniqueDispositions`→unique_doors, `Sales`→sold, `ValidAttempts`(×contact-rate)
  →contacts. Totals are extra columns (not rows) and are ignored.
- Column matching is case-insensitive and tolerant of minor header changes; it
  also carries the rep name down its group and skips any total rows.
- `contacts` is taken from a `Contacts` column if present, else derived from
  `Attempts of Valid Leads` × `Contact as % of Valid Leads`.
- Dates parse from `M/D/YYYY` to ISO. Only rows with a real rep + date import.
- The engine is `scripts/import-timetrack.mjs` — it reads the anon key from
  `index.html`, so it has no embedded credentials.
