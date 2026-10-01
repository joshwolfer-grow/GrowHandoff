#!/usr/bin/env python3
"""Turn an ISP's sector file into a lookup the reports can group by.

Some ISPs send address lists that carry a sector (i3's "Wire-Sector" column,
e.g. MRTNIL-1). Where we have that, the weekly report can break knocking down
by sector, which is how those ISPs think about their build. Where we don't, the
report falls back to city.

    python3 scripts/sector-import.py i3 ~/Downloads/SectorList-*.csv
    python3 scripts/sector-import.py Lyte ~/Downloads/"Lyte sectors.xlsx"
    python3 scripts/sector-import.py --list

Writes data/sectors/<isp>.csv with one row per address:
    street_key, zip, sector, city, state

`street_key` is the normalised street (same normalisation the dedupe and import
tools use), so a sector file and SalesRabbit agree on what "112 W Adams St" is.
Re-running with a newer file merges: newer rows win, older sectors stay unless
overwritten, so you can drop in one market at a time.
"""

import csv, glob, os, re, sys

csv.field_size_limit(10 ** 7)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'data', 'sectors')
# Every original file an ISP sends is kept here, untouched, one folder per ISP.
# Google Drive for Desktop syncs it, so the archive is in the shared drive and
# the sector map can always be rebuilt from source. Files uploaded through the
# Drive *web* UI get converted to Sheets and become unreadable to this script —
# which is why the archive is written from disk instead.
from _drive import grow_drive
DRIVE_RAW = os.path.join(grow_drive(), 'SalesRabbit Leads')


def raw_dir(isp, make=False):
    d = os.path.join(DRIVE_RAW, isp, 'Raw')
    if make and os.path.isdir(DRIVE_RAW):
        os.makedirs(d, exist_ok=True)
    return d


def archive(isp, paths):
    """Copy the originals into the ISP's Raw folder in Drive, datestamped."""
    import shutil, datetime
    d = raw_dir(isp, make=True)
    if not os.path.isdir(d):
        print('  (Drive folder not found, nothing archived)'); return []
    out = []
    for p in paths:
        base = os.path.basename(p)
        stamp = datetime.date.today().isoformat()
        dest = os.path.join(d, base if base.startswith(stamp) else f'{stamp} {base}')
        if not os.path.exists(dest):
            shutil.copy2(p, dest)
            out.append(dest)
    if out:
        print(f'  archived {len(out)} file(s) -> {d}')
    return out

SUF = {'ROAD': 'RD', 'STREET': 'ST', 'AVENUE': 'AVE', 'AV': 'AVE', 'DRIVE': 'DR', 'LANE': 'LN',
       'COURT': 'CT', 'PLACE': 'PL', 'BOULEVARD': 'BLVD', 'CIRCLE': 'CIR', 'TERRACE': 'TER',
       'PARKWAY': 'PKWY', 'HIGHWAY': 'HWY', 'TRAIL': 'TRL', 'SQUARE': 'SQ', 'EXTENSION': 'EXT',
       'NORTH': 'N', 'SOUTH': 'S', 'EAST': 'E', 'WEST': 'W', 'ROUTE': 'RTE', 'RT': 'RTE',
       'APARTMENT': 'APT', 'UNIT': 'APT', 'SUITE': 'STE', 'FLOOR': 'FL'}


def street_key(s):
    return ' '.join(SUF.get(w, w) for w in re.sub(r'[^A-Z0-9 ]', ' ', (s or '').upper()).split())


def read_any(path):
    """Rows as dicts from a csv or xlsx, whatever the ISP happened to send."""
    if path.lower().endswith(('.xlsx', '.xlsm')):
        import openpyxl
        ws = openpyxl.load_workbook(path, data_only=True).active
        rows = [[('' if v is None else str(v).strip()) for v in r] for r in ws.iter_rows(values_only=True)]
    else:
        with open(path, newline='', encoding='utf-8-sig', errors='replace') as f:
            rows = [[c.strip() for c in r] for r in csv.reader(f)]
    rows = [r for r in rows if any(r)]
    if not rows:
        return []
    hdr = rows[0]
    return [dict(zip(hdr, r)) for r in rows[1:]]


def find_col(hdr, *pats):
    for p in pats:
        for h in hdr:
            if re.search(p, h, re.I):
                return h
    return None


def main():
    if '--list' in sys.argv:
        if not os.path.isdir(OUT_DIR):
            print('No sector maps yet.'); return
        for f in sorted(os.listdir(OUT_DIR)):
            if not f.endswith('.csv'):
                continue
            with open(os.path.join(OUT_DIR, f), newline='') as fh:
                rows = list(csv.DictReader(fh))
            secs = {r['sector'] for r in rows}
            cities = {r['city'] for r in rows if r['city']}
            print(f'  {f[:-4]:<12}{len(rows):>8,} addresses  {len(secs):>5} sectors  '
                  f'{len(cities)} cities  e.g. {sorted(secs)[:3]}')
        return

    args = [a for a in sys.argv[1:] if not a.startswith('-')]
    if not args:
        sys.exit(__doc__)
    isp = args[0]
    patterns = args[1:]

    # --rebuild reads everything already archived for this ISP, so the map can be
    # regenerated from scratch without hunting for the original downloads.
    if '--rebuild' in sys.argv:
        d = raw_dir(isp)
        if not os.path.isdir(d):
            sys.exit(f'No archive at {d}')
        files = [os.path.join(d, f) for f in sorted(os.listdir(d))
                 if f.lower().endswith(('.xlsx', '.xlsm', '.csv'))]
        print(f'Rebuilding {isp} from {len(files)} archived file(s)')
        out_path_existing = os.path.join(OUT_DIR, f'{isp}.csv')
        if os.path.exists(out_path_existing):
            os.remove(out_path_existing)
    else:
        if not patterns:
            sys.exit(__doc__)
        files = []
        for p in patterns:
            files.extend(glob.glob(os.path.expanduser(p)))
        if not files:
            sys.exit(f'No files matched: {patterns}')
        if '--no-archive' not in sys.argv:
            archive(isp, files)

    os.makedirs(OUT_DIR, exist_ok=True)
    out_path = os.path.join(OUT_DIR, f'{isp}.csv')

    # Keep what's already mapped; a newer file overwrites the addresses it covers.
    existing = {}
    if os.path.exists(out_path):
        with open(out_path, newline='') as f:
            for r in csv.DictReader(f):
                existing[(r['street_key'], r['zip'])] = r

    added = updated = skipped = 0
    for path in files:
        rows = read_any(path)
        if not rows:
            print(f'  {os.path.basename(path)}: empty'); continue
        hdr = list(rows[0].keys())
        # Lyte calls the same thing the FDH (fiber distribution hub) — the
        # TXLKJNAC002.SA03 on every row of a Lake Jackson file is the "2.03"
        # their sheets are named after. Blitz files call it "Serving Area (Name)".
        c_sector = find_col(hdr, r'wire.?sector', r'^sector$', r'sector', r'^fdh$', r'^serving ?area')
        c_street = find_col(hdr, r'^address1?$', r'^street1?$', r'address.?label', r'^address ?1$', r'^address$',
                            r'^street ?address$')
        # Some ISPs send the house number in its own column. street_key needs both.
        c_num = find_col(hdr, r'^number$', r'^house ?(number|no)$', r'^street ?number$', r'^addr(ess)? ?number$')
        c_zip = find_col(hdr, r'^zip', r'postal')
        c_city = find_col(hdr, r'^city$')
        c_state = find_col(hdr, r'^state$', r'region')
        # Sector-level rollups (the i3 Sector Overview) have a Sector column but
        # no addresses. Skip them rather than importing 195 useless rows.
        # Surf sends one file per serving area and puts the area only in the file
        # name: MUNCIN01-SA01A1(Sheet1).csv is MUNCIN01-SA01A (the trailing 1 is
        # Google's download suffix, their areas are always two digits).
        name_sector = None
        if not c_sector:
            m = re.search(r'([A-Z]{4,8}\d{2}-SA\d{2}[A-Z]?)', os.path.basename(path))
            name_sector = m.group(1) if m else None
        if c_sector and not c_street:
            print(f'  {os.path.basename(path)}: sector column but no addresses, skipping'); continue
        if not ((c_sector or name_sector) and c_street):
            print(f'  {os.path.basename(path)}: no sector/address columns. Saw: {hdr[:10]}')
            continue
        n = 0
        for r in rows:
            sec = (r.get(c_sector) or '').strip() if c_sector else name_sector
            st = (r.get(c_street) or '').strip()
            if c_num and st and not st[:1].isdigit():
                num = (r.get(c_num) or '').strip()
                if num:
                    st = f'{num} {st}'
            if not sec or not st:
                skipped += 1; continue
            key = (street_key(st), re.sub(r'\D', '', r.get(c_zip, '') or '')[:5])
            rec = {'street_key': key[0], 'zip': key[1], 'sector': sec,
                   'city': (r.get(c_city, '') or '').strip(), 'state': (r.get(c_state, '') or '').strip()}
            if key in existing:
                if existing[key] != rec: updated += 1
            else:
                added += 1
            existing[key] = rec
            n += 1
        print(f'  {os.path.basename(path)}: {n:,} addresses, ' +
              (f'sector column "{c_sector}"' if c_sector else f'sector {name_sector} from the file name'))

    rows = sorted(existing.values(), key=lambda r: (r['sector'], r['street_key']))
    with open(out_path, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['street_key', 'zip', 'sector', 'city', 'state'])
        w.writeheader(); w.writerows(rows)

    secs = {r['sector'] for r in rows}
    print(f'\n{out_path}')
    print(f'  {len(rows):,} addresses across {len(secs)} sectors '
          f'({added:,} new, {updated:,} changed, {skipped:,} rows without a sector)')
    print(f'  set "report_by": "sector" for {isp} in data/isps.json to use it')


if __name__ == '__main__':
    main()
