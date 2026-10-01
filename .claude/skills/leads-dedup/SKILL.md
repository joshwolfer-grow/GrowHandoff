---
name: leads-dedup
description: >
  Use this skill whenever the user uploads a leads export file (.xlsx) and wants
  to clean, deduplicate, or process it — including daily dedup runs, weekly report
  prep, or any time they mention "leads export", "same second duplicates",
  "Grow leads", "D2D leads sheet", or ask to clean/process a leads file.
  Also triggers when the user says things like "run the dedup", "process today's
  leads", "clean the sheet", or "pull the weekly report". Always use this skill
  before writing any dedup or leads-processing code.
---

# Leads Export Dedup & Weekly Report Skill

Josh uploads a daily leads export (.xlsx) from his fiber D2D sales operation.
The file has two sheets: **Sheet1** (metadata/summary) and **Leads** (the main data).

The core problem: bulk imports stamp many rows with timestamps that differ only
in microseconds but share the same second — these are duplicates that need to be
removed. Keep one row per unique second (the first occurrence by original row order).

---

## Daily Dedup Workflow

### Step 1 — Read the file

```python
import pandas as pd

df = pd.read_excel('leads_export.xlsx', sheet_name='Leads')
sheet1_df = pd.read_excel('leads_export.xlsx', sheet_name='Sheet1')
```

### Step 2 — Parse and floor timestamps

The `Updated` column contains ISO timestamps with microsecond precision (e.g.
`2026-05-06 00:35:09.460464Z`). Floor to the second to detect same-second dupes.

```python
df['_Updated_dt'] = pd.to_datetime(df['Updated'], utc=True)
df['_Updated_sec'] = df['_Updated_dt'].dt.floor('s')
```

### Step 3 — Deduplicate

Keep the first occurrence per unique second (preserves original row order).

```python
df_clean = df.drop_duplicates(subset=['_Updated_sec'], keep='first')
df_clean = df_clean.drop(columns=['_Updated_dt', '_Updated_sec'])

removed = len(df) - len(df_clean)
print(f"Removed {removed} duplicate rows ({len(df)} → {len(df_clean)})")
```

### Step 4 — Save, preserving Sheet1

```python
with pd.ExcelWriter('leads_export_cleaned.xlsx', engine='openpyxl') as writer:
    sheet1_df.to_excel(writer, sheet_name='Sheet1', index=False)
    df_clean.to_excel(writer, sheet_name='Leads', index=False)
```

Always copy the output to `/mnt/user-data/outputs/` and call `present_files`.

---

## Weekly Report Workflow

When the user asks for a weekly report, aggregate the **cleaned** Leads sheet.
Standard metrics to include:

| Metric | How to calculate |
|---|---|
| Total leads | `len(df)` |
| Leads by rep | `df.groupby('Rep Name').size()` |
| Leads by status | `df.groupby('Lead Status').size()` |
| Leads by campaign | `df.groupby('Campaign Name').size()` |
| Daily trend | `df.groupby(df['Updated_dt'].dt.date).size()` |

Report output: produce a second sheet called `Weekly Report` in the cleaned
workbook, or a separate summary .xlsx if the user prefers.

```python
# Date range for the report
df['_date'] = pd.to_datetime(df['Updated'], utc=True).dt.date
week_start = df['_date'].min()
week_end = df['_date'].max()

summary = {
    'Total Leads': len(df),
    'Week Start': week_start,
    'Week End': week_end,
    'Unique Reps': df['Rep Name'].nunique(),
    'Unique Campaigns': df['Campaign Name'].nunique(),
}
```

---

## Key Column Reference

| Column | Notes |
|---|---|
| `Rep Name` | Sales rep full name |
| `Lead Status` | Current status of the lead |
| `Updated` | ISO timestamp string with microseconds + Z suffix |
| `Campaign Name` | ISP/campaign associated with the lead |
| `Assigned To (email)` | Rep email |
| `Street1`, `City`, `State/Region`, `Postal Code` | Address fields |
| `Notes` | Free-text notes |
| `Appointment` | Appointment datetime if set |
| `Created` | Original creation timestamp |

---

## Output Naming Convention

- Daily cleaned file: `leads_export_cleaned_YYYY-MM-DD.xlsx`
  (use today's date from the `Updated` column max, not system date)
- Weekly report: `leads_weekly_report_YYYY-MM-DD.xlsx`

---

## Edge Cases

- **No duplicates found**: Report "0 duplicate rows removed" and still save the
  cleaned file so downstream steps always work from the same filename.
- **Missing `Updated` column**: Alert the user — do not proceed.
- **Additional sheets beyond Sheet1 and Leads**: Preserve them as-is.
- **Empty Leads sheet**: Save the file as-is with a warning.
