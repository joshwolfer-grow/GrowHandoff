#!/usr/bin/env python3
"""One ISP lead file in, everything but the SalesRabbit click out.

    python3 scripts/isp-intake.py <file> [--isp i3] [--assign "Nick Boyd"] [--code I3-CHAMP]

What happens, in order:
  1. Which ISP. --isp wins; else the file name or its folder (an "i3" folder, a
     "Champaign" in i3's towns, a "SLIC" in the name). Unknown -> parked, you're told.
  2. Raw file archived to Drive: SalesRabbit Leads/<ISP>/Raw/<date> <original name>.
  3. lead-import.py builds the SalesRabbit import (new doors only, deduped
     against the crawl) and the dupes sheet. Needs a rep. No --assign -> the
     raw file is archived and the import waits in imports/isp/parked until
     you rerun with --assign; nothing is guessed.
  4. Import file named the way every batch on SalesRabbit is named,
     "SR <CODE>-<TOWN> (<m_d>) - <rep>.csv" (csv because SalesRabbit's
     importer refuses xlsx), copied next to the archive on Drive
     and into imports/isp/ready. That name is what isp-registry.mjs labels the
     batch by, so the ISP is fixed before the file ever reaches SalesRabbit.
  5. SalesRabbit upload: still the one manual click. SalesRabbit imports go
     through Flatfile in the browser, so this prints the path and opens the
     folder. When an API path is confirmed this is the step that changes.

Drop-folder mode (what run-isp-intake.sh calls): any file in imports/isp/ is
processed like the above and moved to imports/isp/done.
"""
import argparse, csv, datetime as dt, json, os, re, shutil, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
ISPS = os.path.join(ROOT, 'data', 'isps.json')
from _drive import grow_drive
DRIVE_LEADS = os.path.join(grow_drive(), 'SalesRabbit Leads')
INBOX = os.path.join(ROOT, 'imports', 'isp')
PY = sys.executable

# Filename / sender hints -> ISP folder. Same codes isp-registry.mjs labels by.
HINTS = [
    (r'\bi3\b|i3broadband|I3-', 'i3'), (r'\bslic\b|SLIC-', 'SLIC'), (r'\bglo\b|GLO-|\bGL-', 'Glo'),
    (r'gfiber|google\s*fiber|GFI-', 'GFiber'), (r'\bgbn\b|gigabitnow|GB-', 'GBN'),
    (r'\bsurf\b|SURF-', 'Surf'), (r'\bnlf\b|northern\s*lights|NL-', 'NLF'), (r'\blyte\b|LY-', 'Lyte'),
]


def detect_isp(path, cfg):
    names = {n.lower(): n for n in cfg if not n.startswith('_')}
    hay = path
    for rx, isp in HINTS:
        if re.search(rx, hay, re.I) and isp.lower() in names: return names[isp.lower()], 'name'
    # a city that only one ISP lists; the file's own majority city counts too
    city, _ = majority_city(path)
    low = (os.path.basename(path) + ' ' + (city or '')).lower()
    hits = {n for n, v in cfg.items() if not n.startswith('_')
            for c in v.get('cities', []) + [a.split(',')[0] for a in v.get('also', [])] if c.lower() in low}
    if len(hits) == 1: return hits.pop(), 'city'
    # a town we already knock: whichever ISP's batches own the doors there
    try:
        import csv, collections
        from isp_territory import Territory
        doors = list(csv.DictReader(open(os.path.join(ROOT, 'data', 'sr-doors-by-area.csv'))))
        terr = Territory(doors)
        by_city = collections.defaultdict(collections.Counter)
        for d in doors:
            c = d['city'].strip().lower()
            if len(c) >= 4: by_city[c][terr.isp_of(d)] += 1
        found = {}
        for c, cnt in by_city.items():
            if re.search(r'\b' + re.escape(c) + r'\b', low):
                isp, n = cnt.most_common(1)[0]
                if isp and n >= 20: found[isp] = found.get(isp, 0) + n
        if len(found) == 1: return next(iter(found)), 'crawl'
    except Exception as e:
        print(f'  (crawl lookup skipped: {e})')
    return None, None


def majority_city(path):
    """The city most rows in the file are in, and its share. Files often mix
    towns (a main town plus spillover); the batch is named for the bulk of it."""
    try:
        import collections
        rows = _read_rows(path)
        if not rows: return None, 0
        hdr = list(rows[0].keys())
        col = next((h for h in hdr if re.search(r'^city$', h, re.I)), None) or \
              next((h for h in hdr if re.search(r'city|town|municipal', h, re.I)), None)
        if not col: return None, 0
        c = collections.Counter(r.get(col, '').strip().title() for r in rows if r.get(col, '').strip())
        if not c: return None, 0
        city, n = c.most_common(1)[0]
        return city, n / sum(c.values())
    except Exception:
        return None, 0


def _read_rows(path):
    if path.lower().endswith(('.xlsx', '.xlsm')):
        import openpyxl
        ws = openpyxl.load_workbook(path, data_only=True, read_only=True).active
        rows = [[('' if v is None else str(v).strip()) for v in r] for r in ws.iter_rows(values_only=True)]
    else:
        import csv
        with open(path, newline='', encoding='utf-8-sig') as f:
            rows = [[c.strip() for c in r] for r in csv.reader(f)]
    rows = [r for r in rows if any(r)]
    if not rows: return []
    return [dict(zip(rows[0], r)) for r in rows[1:]]


def code_for(isp, path, cfg):
    """I3-CHAMP style code: ISP short code + the town most of the file is in
    (falls back to the town named in the file name)."""
    short = {'i3': 'I3', 'SLIC': 'SLIC', 'Glo': 'GLO', 'GFiber': 'GFI', 'GBN': 'GB', 'Surf': 'SURF', 'NLF': 'NLF', 'Lyte': 'LY'}.get(isp, isp.upper()[:4])
    city, share = majority_city(path)
    if city:
        print(f'  town      {city} ({share:.0%} of rows)')
        return f'{short}-{re.sub(r"[^A-Za-z]", "", city).upper()[:5]}'
    base = re.sub(r'\.(xlsx|xlsm|csv)$', '', os.path.basename(path), flags=re.I)
    base = re.sub(r'^\d{4}-\d{2}-\d{2}\s*', '', base)
    words = [w for w in re.findall(r'[A-Za-z]{3,}', base) if w.lower() not in
             {'grow', 'leads', 'lead', 'passings', 'import', 'export', 'file', 'sheet', 'new', 'list', 'addresses', isp.lower()}]
    town = (words[0] if words else 'LEADS').upper()[:5]
    return f'{short}-{town}'



def write_csv(xlsx, dest_csv):
    """SalesRabbit's importer takes CSV, not xlsx, so every import file gets a
    .csv twin next to it. Same rows, same header, blanks stay blank."""
    import openpyxl
    ws = openpyxl.load_workbook(xlsx, data_only=True).active
    with open(dest_csv, 'w', newline='') as f:
        w = csv.writer(f)
        for row in ws.iter_rows(values_only=True):
            w.writerow(['' if v is None else v for v in row])
    return dest_csv


# Drive folder per ISP where it differs from the isps.json name.
FOLDER = {'NLF': 'Northern Lights', 'GBN': 'GigabitNow'}


def drive_folder(isp):
    return os.path.join(DRIVE_LEADS, FOLDER.get(isp, isp))


def import_name(isp, code, rep, today, src_name=''):
    """Match the names already on Drive: "SR I3-CHAMP (9 2)" for everyone (the
    caller swaps the extension to .csv),
    "SR NLF-SEXSMITH (8_5) - Nick Boyd.xlsx" for Northern Lights."""
    if isp == 'NLF':
        return f'SR {code} ({today.month}_{today.day}) - {rep}.xlsx'
    if isp == 'Lyte':
        # Lyte files carry the sector number, "SR LY-BAY (7.7)", and their raw
        # names include it ("Lake Jackson - 2.03 - 7.30.2026"). Use it when present.
        m = re.search(r'(?<![\d.])(\d{1,2}\.\d{1,2}[A-Za-z]?)(?![\d.])', src_name or '')
        if m: return f'SR {code} ({m.group(1)}).xlsx'
    return f'SR {code} ({today.month} {today.day}).xlsx'


def town_folder(isp, kind, path, code):
    """<ISP>/<Raw|Imports>/<Town>/ once the folder has been organized that way
    (scripts/drive-organize.py); before that, the ISP root (Lyte: its town folder).
    Town = the city most of the file's rows are in."""
    root = drive_folder(isp)
    city, share = majority_city(path)
    town = city if (city and share >= 0.5) else None
    if os.path.isdir(os.path.join(root, 'Imports')):
        return os.path.join(root, kind)     # flat: the file name carries the town
    if kind == 'Raw' and os.path.isdir(os.path.join(root, 'Raw')):
        return os.path.join(root, 'Raw')
    if os.path.isdir(root) and kind == 'Imports':
        low = (os.path.basename(path) + ' ' + code + ' ' + (town or '')).lower()
        for sub in os.listdir(root):
            if os.path.isdir(os.path.join(root, sub)) and sub.lower() not in ('raw', 'rested leads') and sub.lower() in low:
                return os.path.join(root, sub)
    return root


def place_for(isp, path, code):
    return town_folder(isp, 'Imports', path, code)


def notify(msg, title='Grow · ISP leads'):
    m = msg.replace('\\', '').replace('"', "'")   # AppleScript string: no inner double quotes
    subprocess.run(['/usr/bin/osascript', '-e', f'display notification "{m}" with title "{title}"'], check=False)


def process(path, isp=None, assign=None, code=None, quiet=False, archive_only=False, extra=()):
    cfg = json.load(open(ISPS))
    path = os.path.abspath(path)
    today = dt.date.today()
    if not isp:
        isp, how = detect_isp(path, cfg)
    if not isp:
        dest = os.path.join(INBOX, 'parked', os.path.basename(path))
        shutil.move(path, dest)
        msg = f'could not tell which ISP sent {os.path.basename(path)}. Parked; rerun with --isp'
        print('  ' + msg); notify(msg); return {'ok': False, 'why': 'no isp', 'parked': dest}
    print(f'  ISP       {isp}')

    # 2. archive raw
    drive = os.path.isdir(DRIVE_LEADS)
    raw_dir = town_folder(isp, 'Raw', path, code or '') if drive else os.path.join(INBOX, 'done')
    if drive: os.makedirs(raw_dir, exist_ok=True)
    raw_name = os.path.basename(path)
    if not re.match(r'^\d{4}-\d{2}-\d{2} ', raw_name): raw_name = f'{today.isoformat()} {raw_name}'
    raw_dest = os.path.join(raw_dir if drive else os.path.join(INBOX, 'done'), raw_name)
    if os.path.abspath(path) != os.path.abspath(raw_dest):
        shutil.copy2(path, raw_dest)
    print(f'  archived  {raw_dest}' + ('' if drive else '  (Drive not mounted, kept locally)'))

    # 3. build import
    code = code or code_for(isp, path, cfg)
    label = f'{code} ({today.month}_{today.day})'
    if archive_only:
        dest = os.path.join(INBOX, 'parked', os.path.basename(path))
        if os.path.abspath(path) != dest: shutil.move(path, dest)
        msg = f'{isp} file archived to Drive, waiting for review. Hand it to Claude to build the import'
        print('  ' + msg); notify(msg); return {'ok': True, 'why': 'archive only', 'isp': isp, 'parked': dest}
    if not assign:
        dest = os.path.join(INBOX, 'parked', os.path.basename(path))
        if os.path.abspath(path) != dest: shutil.move(path, dest)
        msg = f'{isp} file archived. Needs a rep: python3 scripts/isp-intake.py "{dest}" --assign "<rep>"'
        print('  ' + msg); notify(msg); return {'ok': False, 'why': 'no rep', 'isp': isp, 'parked': dest}
    work = os.path.join(INBOX, 'work'); os.makedirs(work, exist_ok=True)
    src = os.path.join(work, os.path.basename(path)); shutil.copy2(path, src)
    r = subprocess.run([PY, os.path.join(ROOT, 'scripts', 'lead-import.py'), src, '--assign', assign, '--name', label, *extra],
                       capture_output=True, text=True)
    sys.stdout.write(''.join('  | ' + l + '\n' for l in (r.stdout + r.stderr).strip().splitlines()))
    imp = os.path.join(work, f'SR {label} - {assign}.xlsx')
    if r.returncode != 0 or not os.path.exists(imp):
        msg = f'{isp}: lead-import failed for {os.path.basename(path)}'
        notify(msg); return {'ok': False, 'why': 'lead-import failed', 'isp': isp}
    m = re.search(r'NEW\s+([\d,]+)', r.stdout)
    new_n = int(m.group(1).replace(',', '')) if m else None

    # 4. place the import file. Nothing new = no import file anywhere: an empty
    # template sitting in "ready" is exactly what gets uploaded by mistake.
    ready = None
    dup = os.path.join(work, f'{label} - dupes.xlsx')
    if drive and os.path.exists(dup): shutil.copy2(dup, os.path.join(raw_dir, os.path.basename(dup)))
    if new_n:
        final = import_name(isp, code, assign, today, os.path.basename(path))
        # csv only: SalesRabbit's importer refuses xlsx, and nothing downstream
        # reads the import file (isp-registry.mjs labels batches from the names
        # SalesRabbit itself reports, not from disk).
        ready = os.path.join(INBOX, 'ready', os.path.splitext(final)[0] + '.csv')
        write_csv(imp, ready)
        if drive:
            dest = os.path.join(place_for(isp, path, code), os.path.basename(ready))
            shutil.copy2(ready, dest)
            print(f'  drive     {dest}')
        print(f'  import    {ready}')
    if os.path.dirname(path) == INBOX:
        shutil.move(path, os.path.join(INBOX, 'done', os.path.basename(path)))
    shutil.rmtree(work, ignore_errors=True)

    # 5. SalesRabbit: manual click for now
    if new_n == 0:
        msg = f'{isp} {code}: nothing new, every address is already in SalesRabbit. No import needed'
    else:
        msg = f'{isp} {code}: {new_n if new_n is not None else "?"} new doors ready for SalesRabbit → {assign}. File is in imports/isp/ready'
    print('  ' + msg)
    if not quiet:
        notify(msg)
        if ready: subprocess.run(['open', os.path.dirname(ready)], check=False)
    return {'ok': True, 'isp': isp, 'code': code, 'new': new_n, 'ready': ready}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('source', nargs='?')
    p.add_argument('--isp'); p.add_argument('--assign'); p.add_argument('--code')
    p.add_argument('--inbox', action='store_true', help='process every file waiting in imports/isp/')
    p.add_argument('--quiet', action='store_true')
    p.add_argument('--archive-only', action='store_true', help='detect ISP + archive to Drive, then park for review (what the watcher does)')
    # Passed straight through to lead-import.py (the Lead desk in Wolf Office sets these).
    p.add_argument('--notes-from'); p.add_argument('--status-from')
    p.add_argument('--fill-zip-from-city', action='store_true')
    a = p.parse_args()
    extra = [x for k, v in (('--notes-from', a.notes_from), ('--status-from', a.status_from)) if v for x in (k, v)]
    if a.fill_zip_from_city: extra.append('--fill-zip-from-city')
    if a.inbox:
        files = [os.path.join(INBOX, f) for f in sorted(os.listdir(INBOX))
                 if f.lower().endswith(('.xlsx', '.xlsm', '.csv')) and not f.startswith('~$')]
        if not files: return
        for f in files:
            print(os.path.basename(f)); process(f, a.isp, a.assign, None, a.quiet, a.archive_only, extra)
        return
    if not a.source: p.error('give a file, or --inbox')
    print(os.path.basename(a.source)); process(a.source, a.isp, a.assign, a.code, a.quiet, a.archive_only, extra)


if __name__ == '__main__':
    main()
