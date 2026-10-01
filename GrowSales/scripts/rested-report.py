#!/usr/bin/env python3
"""How rested is each door, area and city — off the latest SalesRabbit crawl.

    python3 scripts/rested-report.py --isp i3
    python3 scripts/rested-report.py --isp i3 --min-days 90

Rest = days since the door's last knock (a stage_updated mark at the door), as
of the crawl in data/sr-doors-by-area.csv. Areas are the ISP's own sectors when
they send a sector file (data/sectors/<isp>.csv), city otherwise.

Doors that have never been knocked are not rested — they are untouched — so
they sit on their own tab instead of at the top of the ordering.
"""
import argparse, collections, csv, datetime, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOORS = os.path.join(ROOT, 'data', 'sr-doors-by-area.csv')
ACT = os.path.join(ROOT, 'data', 'sr-activity.csv')
SECTOR_DIR = os.path.join(ROOT, 'data', 'sectors')
ISPS = os.path.join(ROOT, 'data', 'isps.json')
OUT = os.path.expanduser('~/Downloads')

EXCLUDE_REPS = {'daxton day', 'nick boyd'}   # intake accounts, not knockers
AT_DOOR_M = 1000                             # past this the mark is a desk assignment

SUF_S = {'ROAD': 'RD', 'STREET': 'ST', 'AVENUE': 'AVE', 'AV': 'AVE', 'DRIVE': 'DR', 'LANE': 'LN',
         'COURT': 'CT', 'PLACE': 'PL', 'BOULEVARD': 'BLVD', 'CIRCLE': 'CIR', 'TERRACE': 'TER',
         'PARKWAY': 'PKWY', 'HIGHWAY': 'HWY', 'TRAIL': 'TRL', 'SQUARE': 'SQ', 'EXTENSION': 'EXT',
         'NORTH': 'N', 'SOUTH': 'S', 'EAST': 'E', 'WEST': 'W', 'ROUTE': 'RTE', 'RT': 'RTE',
         'APARTMENT': 'APT', 'UNIT': 'APT', 'SUITE': 'STE', 'FLOOR': 'FL'}


def skey(s):
    return ' '.join(SUF_S.get(w, w) for w in re.sub(r'[^A-Z0-9 ]', ' ', (s or '').upper()).split())


def load_sectors(isp):
    path = os.path.join(SECTOR_DIR, f'{isp}.csv')
    if not os.path.exists(path):
        return {}
    with open(path, newline='') as f:
        return {(r['street_key'], r['zip']): r['sector'] for r in csv.DictReader(f)}


def at_door(v):
    try:
        return float(v) < AT_DOOR_M
    except (TypeError, ValueError):
        return True


def knock_days(ids):
    """lead_id -> the set of dates it was knocked on, streaming the activity file once.

    Same definition the other reports use: a stage change, at the door, not by an
    intake account.
    """
    days = collections.defaultdict(set)
    with open(ACT, newline='') as f:
        for r in csv.DictReader(f):
            if (r['lead_id'] in ids and r['event'] == 'stage_updated' and r['datetime']
                    and (r['rep'] or '').strip().lower() not in EXCLUDE_REPS
                    and at_door(r.get('distance'))):
                days[r['lead_id']].add(r['datetime'][:10])
    return days


def passes(days, gap):
    """Knock days split into passes. A new pass starts after `gap` idle days, so
    two knocks in the same week are one pass and a return a month later is two."""
    out = []
    for d in sorted(days):
        cur = datetime.date.fromisoformat(d)
        if out and (cur - datetime.date.fromisoformat(out[-1][-1])).days < gap:
            out[-1].append(d)
        else:
            out.append([d])
    return out


def city_of(d):
    return (d['city'] or '').strip().title() or '(no city)'


def load_doors(states, cities, exclude):
    out = []
    with open(DOORS, newline='') as f:
        for d in csv.DictReader(f):
            st = (d['state'] or '').strip().upper()
            if states and st not in states:
                continue
            c = city_of(d).lower()
            if cities and c not in cities:
                continue
            if c in exclude:
                continue
            out.append(d)
    return out


def main():
    p = argparse.ArgumentParser(description='Rested doors, areas and cities for one ISP.')
    p.add_argument('--isp', required=True)
    p.add_argument('--min-days', type=int, default=0,
                   help='also write a second workbook holding only doors rested this long')
    p.add_argument('--gap', type=int, default=5,
                   help='idle days that end a pass (default 5, same as knock-report.py)')
    a = p.parse_args()

    cfg = json.load(open(ISPS))
    if a.isp not in cfg:
        sys.exit(f'no such ISP in data/isps.json: {a.isp}')
    conf = cfg[a.isp]
    states = {s.upper() for s in conf.get('states', [])}
    cities = {c.strip().lower() for c in conf.get('cities', [])}
    exclude = {c.strip().lower() for c in conf.get('exclude_cities', [])}

    sectors = load_sectors(a.isp)
    doors = load_doors(states, cities, exclude)
    kdays = knock_days({d['lead_id'] for d in doors})

    rows, never = [], []
    for d in doors:
        area = city_of(d)
        if sectors:
            # A door the ISP's sector file doesn't cover falls back to its city,
            # tagged so the gap is still visible. Lyte sends one sector for 304
            # of 37,178 doors, so a single "(no sector)" bucket would be the
            # whole report.
            area = sectors.get((skey(d['street']), (d['zip'] or '')[:5])) or f'{area} (no sector)'
        ps = passes(kdays.get(d['lead_id'], ()), a.gap)
        r = {
            'Area': area,
            'City': city_of(d),
            'Address': ' '.join(x for x in [d['street'], d['unit']] if x),
            'Zip': (d['zip'] or '')[:5],
            'Rested (days)': int(d['days_since_last_knock']) if d['days_since_last_knock'] else None,
            'Last knock': d['last_knock'],
            'Last outcome': d['last_disposition'],
            'Last knocked by': d['last_knocked_by'],
            'Passes': len(ps),
            'Last pass': f'{ps[-1][0]} to {ps[-1][-1]}' if ps and ps[-1][0] != ps[-1][-1]
                         else (ps[-1][0] if ps else ''),
            'Previous pass ended': ps[-2][-1] if len(ps) > 1 else '',
            'Knocks': int(d['knocks'] or 0),
            'Days knocked': int(d['days_knocked'] or 0),
            '_days': ps and set().union(*ps) or set(),
            'Current stage': d['current_stage'],
            'Ever sold': 'Yes' if d['ever_sold'] == '1' else '',
            'Lead id': d['lead_id'],
        }
        (never if r['Rested (days)'] is None else rows).append(r)

    rows.sort(key=lambda r: (-r['Rested (days)'], r['Area'], r['Address']))
    never.sort(key=lambda r: (r['Area'], r['Address']))

    stamp = datetime.date.today().strftime('%Y-%m-%d')
    made = [write(os.path.join(OUT, f'{a.isp} Rested Doors - {stamp}.xlsx'), rows, never, a.isp, None, a.gap)]
    if a.min_days:
        keep = [r for r in rows if r['Rested (days)'] >= a.min_days]
        made.append(write(os.path.join(OUT, f'{a.isp} Rested {a.min_days}+ Days - {stamp}.xlsx'),
                          keep, [], a.isp, a.min_days, a.gap))
    for m in made:
        print(m)


def roll(rows, key, gap):
    """One line per area or city: how rested it is, and how much of it is rested."""
    g = collections.defaultdict(list)
    for r in rows:
        g[r[key]].append(r)
    out = []
    for k, rs in g.items():
        rest = sorted(r['Rested (days)'] for r in rs)
        n = len(rest)
        area_days = set().union(*(r['_days'] for r in rs)) if rs else set()
        aps = passes(area_days, gap)
        row = {key: k}
        if key == 'Area':
            row['City'] = ', '.join(sorted({r['City'] for r in rs}))
        row.update({
            'Doors': n,
            'Median rest (days)': rest[n // 2],
            'Newest knock': max(r['Last knock'] for r in rs),
            'Oldest knock': min(r['Last knock'] for r in rs),
            'Doors rested 90+': sum(1 for x in rest if x >= 90),
            'Passes over the area': len(aps),
            'Last pass': f'{aps[-1][0]} to {aps[-1][-1]}' if aps and aps[-1][0] != aps[-1][-1]
                         else (aps[-1][0] if aps else ''),
            'Avg passes per door': round(sum(r['Passes'] for r in rs) / n, 2),
            'Doors hit once': sum(1 for r in rs if r['Passes'] == 1),
            'Knocks': sum(r['Knocks'] for r in rs),
            'Sold': sum(1 for r in rs if r['Ever sold']),
        })
        out.append(row)
    out.sort(key=lambda r: -r['Median rest (days)'])
    return out


def write(path, rows, never, isp, min_days, gap):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    head = Font(bold=True, color='FFFFFF')
    fill = PatternFill('solid', fgColor='334155')

    def sheet(ws, data, cols):
        ws.append(cols)
        for c in range(1, len(cols) + 1):
            ws.cell(1, c).font = head
            ws.cell(1, c).fill = fill
            ws.cell(1, c).alignment = Alignment(horizontal='left')
        for r in data:
            ws.append([r.get(c) for c in cols])
        ws.freeze_panes = 'A2'
        if data:
            ws.auto_filter.ref = f'A1:{get_column_letter(len(cols))}{len(data) + 1}'
        for i, c in enumerate(cols, 1):
            w = max(len(str(c)), *(len(str(r.get(c) or '')) for r in data[:2000])) if data else len(str(c))
            ws.column_dimensions[get_column_letter(i)].width = min(max(w + 2, 9), 42)

    ws = wb.active
    ws.title = 'Areas'
    sheet(ws, roll(rows, 'Area', gap),
          ['Area', 'City', 'Doors', 'Median rest (days)', 'Oldest knock', 'Newest knock',
           'Doors rested 90+', 'Passes over the area', 'Last pass', 'Avg passes per door',
           'Doors hit once', 'Knocks', 'Sold'])
    sheet(wb.create_sheet('Cities'), roll(rows, 'City', gap),
          ['City', 'Doors', 'Median rest (days)', 'Oldest knock', 'Newest knock',
           'Doors rested 90+', 'Passes over the area', 'Last pass', 'Avg passes per door',
           'Doors hit once', 'Knocks', 'Sold'])
    sheet(wb.create_sheet('Leads'), rows,
          ['Area', 'City', 'Address', 'Zip', 'Rested (days)', 'Last knock', 'Passes',
           'Last pass', 'Previous pass ended', 'Last outcome', 'Last knocked by', 'Knocks',
           'Days knocked', 'Current stage', 'Ever sold', 'Lead id'])
    if never:
        sheet(wb.create_sheet('Never Knocked'), never,
              ['Area', 'City', 'Address', 'Zip', 'Current stage', 'Lead id'])

    d = wb.create_sheet('Definitions')
    scope = f'doors rested {min_days}+ days' if min_days else 'every knocked door'
    for line in [
        (f'{isp} rest report', ''),
        ('Built', datetime.date.today().strftime('%B %-d, %Y') + ' from the SalesRabbit crawl'),
        ('Scope', scope),
        ('Rested (days)', 'Days since the door was last knocked. Higher means it has sat longer.'),
        ('Knock', 'A stage change made at the door, so an assignment from the office is not one.'),
        ('Area', 'The ISP sector the address falls in. Doors their sector file does not cover '
                 'fall back to the city, marked (no sector).'),
        ('Median rest (days)', 'Half the doors in the area have rested longer than this, half less.'),
        ('Doors rested 90+', 'Doors in the area untouched for three months or more.'),
        ('Passes', f'How many separate times we have worked the door. Knocks less than {gap} days '
                   'apart are the same pass; a return after that is a new one.'),
        ('Last pass', 'The dates of the most recent pass. Rested counts from the day it ended.'),
        ('Passes over the area', 'Passes counted across the area as a whole, so a pass where we '
                                 'worked half the doors still counts once.'),
        ('Avg passes per door', 'Average passes on the doors in the area. Near 1 means we have '
                                'barely gone back.'),
        ('Never Knocked', 'Imported but never worked, so not rested — new territory, not old.'),
    ] + ([('Area totals', 'Counted over the doors on this file only, so an area that also holds '
           'recently worked doors shows an older last pass here than it has on the full report.')]
         if min_days else []):
        d.append(list(line))
    d.column_dimensions['A'].width = 22
    d.column_dimensions['B'].width = 86
    for r in range(1, d.max_row + 1):
        d.cell(r, 1).font = Font(bold=True)
        d.cell(r, 2).alignment = Alignment(wrap_text=True)

    wb.save(path)
    return path


if __name__ == '__main__':
    main()
