#!/usr/bin/env python3
"""Organize Drive > Grow - Corporate > SalesRabbit Leads into one layout per ISP.

    python3 scripts/drive-organize.py            # plan only: prints every move
    python3 scripts/drive-organize.py --json     # plan as JSON (for the review page)
    python3 scripts/drive-organize.py --apply    # do it (moves via the mounted Drive,
                                                 # so Sheets keep links and history)
    python3 scripts/drive-organize.py --apply --isp SLIC
    python3 scripts/drive-organize.py --undo data/drive-organize-logs/<log>.json   # put it all back


Layout per ISP:
    Raw/        what the ISP sent, date-prefixed. Lists, sector files, vendor lists.
    Imports/    every "SR ..." import we built. Lyte keeps town subfolders in here.
    Reports/    what we pulled out of SalesRabbit or built for the ISP.
    Archive/    tests, examples, duplicate gsheet/csv copies.
Nothing is deleted. Anything doubtful goes to Archive, never Raw.
"""
import argparse, json, os, re, shutil, sys

from _drive import grow_drive
BASE = os.path.join(grow_drive(), 'SalesRabbit Leads')
KEEP = {'Raw', 'Imports', 'Reports', 'Archive'}
LYTE_TOWNS = {'BAY': 'Baytown', 'BEE': 'Beeville', 'KIN': 'Kingsville', 'MAR': 'Marshall', 'MARSHALL': 'Marshall',
              'JEF': 'Jefferson', 'JEFFERSON': 'Jefferson', 'UVA': 'Uvalde', 'SIN': 'Sinton', 'PEA': 'Pearsall',
              'PITT': 'Pittsburg', 'NAV': 'Navarro', 'EAGLE': 'Eagle Pass', 'LAKE': 'Lake Jackson', 'ATLANTA': 'Atlanta'}


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGS = os.path.join(ROOT, 'data', 'drive-organize-logs')


# Short codes used in file names that the registry alone can't resolve.
CODE_TOWNS = {'KC': 'Kansas City', 'COL': 'Columbus', 'BLM': 'Bloomington', 'KINGS': 'Kingsbury', 'RYCROFT': 'Rycroft',
              'SPIRIT': 'Spirit River', 'JEFF': 'Jefferson', 'AUS': 'Austin', 'RAYTOWN': 'Raytown', 'TYL': 'Tyler',
              'MUNCIE': 'Muncie', 'CHAMP': 'Champaign', 'ROCK': 'Rockford', 'CARP': 'Carpentersville',
              'MUND': 'Mundelein', 'MUN': 'Mundelein', 'GLEN': 'Glens Falls', 'FORT': 'Fort Edward', 'BALL': 'Ballston Spa',
              'MECH': 'Mechanicville', 'ASH': 'Ashland', 'WAY': 'Waynesboro', 'HAN': 'Hanover', 'CAR': 'Carlisle', 'SHIP': 'Shippensburg'}
TITLE_FIX = {'Mchenry': 'McHenry', 'Lake In The Hills': 'Lake in the Hills'}


def _key(n):
    n = re.sub(r'\.(csv|xlsx|xlsm|gsheet)$', '', n.lower().strip())
    n = re.split(r' - (import|blitz|sheet|nick|parker)', n)[0]
    return re.sub(r'[^a-z0-9]', '', n)


_CITY = None
def city_index():
    """Batch file name -> majority city, from the registry and the crawl."""
    global _CITY
    if _CITY is not None: return _CITY
    _CITY = {'by_key': {}, 'names': set()}
    try:
        reg = json.load(open(os.path.join(ROOT, 'data', 'isp-imports.json')))
        cities = json.load(open(os.path.join(ROOT, 'data', 'sr-import-cities.json')))
        for iid, v in reg.items():
            top = cities.get(iid)
            if v.get('file') and top:
                _CITY['by_key'][_key(v['file'])] = top[0][1]
                for t in top: _CITY['names'].add(t[1])
    except Exception:
        pass
    return _CITY


def city_of(isp, rel, target):
    """Which town a file belongs to: the batch it became (by name), a town named
    in the file, the xlsx's own majority city, or the Lyte folder it sat in."""
    name = os.path.basename(rel); idx = city_index()
    k = _key(name)
    for bk, city in idx['by_key'].items():
        if k and (bk.startswith(k) or k.startswith(bk)) and min(len(k), len(bk)) >= 8:
            return city
    m = re.search(r'\b(?:ly|i3|slic|glo?|gfi|gbn?|nlf?|surf|sky)-?\s*([a-z]+)', name.lower())
    code = (m.group(1).upper() if m else '')
    t = (LYTE_TOWNS if isp == 'Lyte' else {}).get(code) or CODE_TOWNS.get(code)
    if t: return t
    low = name.lower()
    for code, town in CODE_TOWNS.items():
        if len(code) >= 3 and re.search(r'(?<![a-z])' + code.lower() + r'(?![a-z])', low): return town
    hits = [c for c in idx['names'] if len(c) >= 4 and re.search(r'\b' + re.escape(c.lower()) + r'\b', low)]
    if len(hits) == 1: return hits[0]
    if name.lower().endswith(('.xlsx', '.xlsm', '.csv')):
        try:
            import runpy
            g = runpy.run_path(os.path.join(ROOT, 'scripts', 'isp-intake.py'), run_name='x')
            c, share = g['majority_city'](os.path.join(BASE, isp, rel))
            if c and share >= 0.5: return c
        except Exception:
            pass
    top = rel.split('/')[0] if '/' in rel else ''
    if top and top not in KEEP and top not in ('Rested Leads', 'Lead Reports'): return top
    return None


def classify(isp, rel):
    """(target subfolder, reason). rel is the path inside the ISP folder."""
    name = os.path.basename(rel)
    low = name.lower()
    stem = re.sub(r'\.(gsheet|csv|xlsx|xlsm)$', '', low).strip()
    parts = rel.split('/')
    top = parts[0] if len(parts) > 1 else ''

    if top in ('Raw', 'Imports') and len(parts) > 2:
        return top, 'out of its town folder'
    if top in KEEP:
        return None, 'already placed'
    if top == 'Rested Leads':
        return 'Reports/Rested Leads', 'rested-doors report'
    # Imports first: "SR I3-WAUCANDA (7 2) - Same as Terros File" is a real batch.
    is_import = (re.search(r'^\s*_?sr[ _-]|^sr-nl|\bimport\b', low)
                 or re.search(r'^\s*_?(i3|slic|glo?|gfi|gbn?|ly|nlf?|surf|sky)-', low))
    if not is_import and re.search(r'terros|example|sample|test\b', low):
        return 'Archive', 'test or example file'
    if is_import and not re.search(r'sales rabbit data|leads? import example', low):
        return 'Imports', 'SalesRabbit import file'
    if re.search(r'leads?_export|sales rabbit data|lead analysis|total leads|rested|deal tracker|sales for review|'
                 r'unknocked|knocked frankfort|all frankfort|lead reports|for review', low) or top == 'Lead Reports':
        return 'Reports', 'pulled from SalesRabbit or built for the ISP'
    return 'Raw', 'ISP source file'


def plan(isp_filter=None):
    moves, keep = [], []
    for isp in sorted(os.listdir(BASE)):
        d = os.path.join(BASE, isp)
        if not os.path.isdir(d) or isp == 'Archive' or (isp_filter and isp.lower() != isp_filter.lower()): continue
        for root, dirs, files in os.walk(d):
            dirs[:] = [x for x in dirs if not x.startswith('.')]
            for f in files:
                if f.startswith('.') or f.startswith('~$'): continue
                rel = os.path.relpath(os.path.join(root, f), d)
                target, why = classify(isp, rel)
                # Town subfolders were tried (Sep 8 2026) and dropped: most held one
                # file, and the file names already carry the town code.
                if target and target.split('/')[0] in ('Raw', 'Imports'):
                    target = target.split('/')[0]
                if target is None or os.path.dirname(rel) == target:
                    keep.append({'isp': isp, 'path': rel}); continue
                moves.append({'isp': isp, 'from': rel, 'to': f'{target}/{f}', 'why': why})
    # duplicate gsheet + csv/xlsx of the same stem: keep the Sheet, archive the file copy
    seen = {}
    for m in moves:
        stem = re.sub(r'\.(gsheet|csv|xlsx)$', '', m['to'].lower()); stem = re.sub(r'\s*\(\d\)$', '', stem)
        seen.setdefault((m['isp'], stem), []).append(m)
    for (isp, stem), ms in seen.items():
        if len(ms) > 1 and any(x['from'].endswith('.gsheet') for x in ms):
            for x in ms:
                if not x['from'].endswith('.gsheet'):
                    x['to'] = 'Archive/' + os.path.basename(x['from']); x['why'] = 'file copy of a Google Sheet with the same name'
    # loose files at the root of SalesRabbit Leads
    for f in sorted(os.listdir(BASE)):
        p = os.path.join(BASE, f)
        if os.path.isfile(p) and not f.startswith('.'):
            moves.append({'isp': '(root)', 'from': f, 'to': 'Archive/' + f, 'why': 'not tied to an ISP'})
    return moves, keep


def apply(moves):
    """Every move is written to data/drive-organize-logs/<timestamp>.json as it
    happens, so --undo <log> can put every file back exactly where it was."""
    import datetime as dt
    os.makedirs(LOGS, exist_ok=True)
    log = os.path.join(LOGS, dt.datetime.now().strftime('%Y%m%d-%H%M%S') + '.json')
    done = []
    for m in moves:
        base = BASE if m['isp'] == '(root)' else os.path.join(BASE, m['isp'])
        src, dst = os.path.join(base, m['from']), os.path.join(base, m['to'])
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.exists(dst):
            stem, ext = os.path.splitext(dst); dst = f'{stem} (dup){ext}'
        shutil.move(src, dst)
        done.append({'from': src, 'to': dst})
        json.dump(done, open(log, 'w'), indent=1)
        print(f'  {m["isp"]:16} {m["from"]}  ->  {os.path.relpath(dst, base)}')
    print(f'\nlogged {len(done)} moves to {log}\nundo with: python3 scripts/drive-organize.py --undo "{log}"')


def undo(log):
    moves = json.load(open(log))
    for m in reversed(moves):
        if not os.path.exists(m['to']): print(f'  missing, skipped: {m["to"]}'); continue
        os.makedirs(os.path.dirname(m['from']), exist_ok=True)
        shutil.move(m['to'], m['from']); print(f'  restored {os.path.relpath(m["from"], BASE)}')
    for root, dirs, files in os.walk(BASE, topdown=False):
        if root != BASE and not os.listdir(root): os.rmdir(root)
    print(f'undid {len(moves)} moves')
    # drop folders left empty
    for isp in os.listdir(BASE):
        d = os.path.join(BASE, isp)
        if not os.path.isdir(d): continue
        for root, dirs, files in os.walk(d, topdown=False):
            if root != d and not os.listdir(root): os.rmdir(root); print(f'  removed empty {os.path.relpath(root, BASE)}')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--apply', action='store_true'); p.add_argument('--json', action='store_true'); p.add_argument('--isp')
    p.add_argument('--undo', help='path of a log in data/drive-organize-logs to reverse')
    a = p.parse_args()
    if a.undo: undo(a.undo); return
    moves, keep = plan(a.isp)
    if a.json:
        print(json.dumps({'moves': moves, 'keep': keep})); return
    cur = None
    for m in moves:
        if m['isp'] != cur: cur = m['isp']; print(f'\n== {cur}')
        print(f'  {m["from"]}\n      -> {m["to"]}   ({m["why"]})')
    print(f'\n{len(moves)} moves, {len(keep)} already in place')
    if a.apply:
        print('\nApplying...'); apply(moves)


if __name__ == '__main__':
    main()
