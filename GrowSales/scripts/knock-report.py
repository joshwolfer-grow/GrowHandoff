#!/usr/bin/env python3
"""Knock reports for any area, off the latest SalesRabbit crawl.

Everything comes from two files the crawl produces (see REFRESHING below):
    data/sr-doors-by-area.csv   one row per door, with its knock tallies
    data/sr-activity.csv        one row per activity mark

Examples
    python3 scripts/knock-report.py --list
    python3 scripts/knock-report.py --list --state NY
    python3 scripts/knock-report.py --isp i3
    python3 scripts/knock-report.py --city "glens falls"
    python3 scripts/knock-report.py --city baytown --zip 77520
    python3 scripts/knock-report.py --match "kingsbury|fort edward" --name "Kingsbury + Fort Edward"

--isp reads a named territory from data/isps.json (edit that file to define
who owns which towns). The other filters are case-insensitive substrings and
stack; --match takes a regex over "city zip state" for one-off groupings.

Output is one .xlsx built for handing to an ISP:
    Overview      knockable doors (vacants removed), contact rate vs the 60%
                  goal, penetration, and the full wave table
    Wave 1..N     the doors each push touched, with dispositions
    All Leads     every door: times knocked, by whom, current stage
    Reps          contact rate and sold per 100 for everyone who worked it
    Definitions   what every number means

REFRESHING THE DATA
    node scripts/grow-sync.mjs        # the daily command: incremental crawl,
                                      # rebuilds every file this reads, and
                                      # refreshes Supabase `knocking`
"""

import sys, os as _os; sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
import argparse, csv, collections, datetime as dt, json, os, re, sys

csv.field_size_limit(10 ** 7)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOORS = os.path.join(ROOT, 'data', 'sr-doors-by-area.csv')
ACT = os.path.join(ROOT, 'data', 'sr-activity.csv')
HIST = os.path.join(ROOT, 'data', 'sr-lead-history.csv')

# Dispositions where somebody actually came to the door.
CONTACT = {'Not Interested', 'Call Back', 'No English', 'Do Not Knock', 'Sold'}
# Not a sellable door: no one lives there. These come OUT of the denominator, so
# a street full of empty houses doesn't read as poor penetration.
VACANT = {'Vacant / For Sale'}
# Intake accounts. Leads get bulk-assigned through these, so their marks are
# admin work rather than knocking.
EXCLUDE_REPS = {'daxton day', 'nick boyd'}

# A knock is a disposition made AT the door. SalesRabbit stamps every stage
# change with the rep's distance from the address, and that separates field work
# from assignment: under 1km behaves like knocking (36% contact rate, few leads
# set to "New Lead"); past 100km it is 89% "New Lead" at a 0.7% contact rate,
# i.e. someone bulk-assigning from a desk. Marks with no distance are kept.
AT_DOOR_M = 1000
def at_door(v):
    try: return float(v) < AT_DOOR_M
    except (TypeError, ValueError): return True


def load_doors():
    if not os.path.exists(DOORS):
        sys.exit(f'Missing {DOORS}\nRun with --rebuild-doors, or re-crawl first (see the header of this file).')
    with open(DOORS, newline='') as f:
        return list(csv.DictReader(f))


def select(rows, args):
    out = []
    rx = re.compile(args.match, re.I) if args.match else None
    for r in rows:
        if args.city and args.city.lower() not in r['city'].lower():
            continue
        if args.zip and args.zip not in r['zip']:
            continue
        if args.state and r['state'].upper() != args.state.upper():
            continue
        if rx and not rx.search(f"{r['city']} {r['zip']} {r['state']}"):
            continue
        out.append(r)
    return out


def activity_for(ids):
    """Stream the activity file once, keeping only marks for these doors."""
    keep = []
    with open(ACT, newline='') as f:
        for r in csv.DictReader(f):
            if r['lead_id'] in ids:
                keep.append(r)
    return keep


def knocks_only(marks):
    return [r for r in marks
            if r['event'] == 'stage_updated'
            and (r['rep'] or '').strip().lower() not in EXCLUDE_REPS
            and at_door(r.get('distance'))
            and r['datetime']]


def wave_groups(knocks, gap):
    """Split active knock days into pushes separated by `gap` idle days."""
    days = sorted({k['datetime'][:10] for k in knocks})
    if not days:
        return []
    groups, cur = [], [days[0]]
    for d in days[1:]:
        a = dt.date(*map(int, cur[-1].split('-')))
        b = dt.date(*map(int, d.split('-')))
        if (b - a).days >= gap:
            groups.append(cur); cur = [d]
        else:
            cur.append(d)
    groups.append(cur)
    return groups


def build_waves(knocks, groups, knockable, vacant_ids):
    """Per-wave stats on the i3 model. Vacant doors are out of every denominator."""
    seen, waves = set(), []
    for i, g in enumerate(groups, 1):
        gs = set(g)
        e = [k for k in knocks if k['datetime'][:10] in gs and k['lead_id'] not in vacant_ids]
        uniq = {k['lead_id'] for k in e}
        new = uniq - seen
        contacts = {k['lead_id'] for k in e if k['new_stage'] in CONTACT}
        sold = {k['lead_id'] for k in e if k['new_stage'] == 'Sold'}
        seen |= uniq
        waves.append({
            'wave': i, 'start': g[0], 'end': g[-1], 'days_active': len(g),
            'reps': len({k['rep'] for k in e if k['rep']}),
            'knocks': len(e),
            'worked_doors': len(uniq),
            'new_doors': len(new), 'repeat_doors': len(uniq) - len(new),
            'pct_of_knockable': round(100 * len(uniq) / knockable, 1) if knockable else 0,
            'contacts': len(contacts),
            'contact_rate_pct': round(100 * len(contacts) / len(uniq), 1) if uniq else 0,
            'sold': len(sold),
            'penetration_pct': round(100 * len(sold) / knockable, 1) if knockable else 0,
            'close_rate_pct': round(100 * len(sold) / len(contacts), 1) if contacts else 0,
            'cumulative_worked': len(seen),
            'cumulative_pct_worked': round(100 * len(seen) / knockable, 1) if knockable else 0,
            'reps_on_this_wave': ' | '.join(sorted({k['rep'] for k in e if k['rep']})),
        })
    return waves


def build_reps(knocks):
    agg = collections.defaultdict(lambda: {'n': 0, 'c': 0, 's': 0, 'doors': set(), 'days': set()})
    for k in knocks:
        a = agg[k['rep'] or '(unknown)']
        a['n'] += 1
        a['doors'].add(k['lead_id'])
        a['days'].add(k['datetime'][:10])
        if k['new_stage'] in CONTACT: a['c'] += 1
        if k['new_stage'] == 'Sold': a['s'] += 1
    rows = [{
        'rep': r, 'knocks': v['n'], 'doors': len(v['doors']), 'days': len(v['days']),
        'knocks_per_day': round(v['n'] / len(v['days']), 1) if v['days'] else 0,
        'contacts': v['c'], 'contact_rate_pct': round(100 * v['c'] / v['n'], 1) if v['n'] else 0,
        'sold': v['s'], 'sold_per_100_knocks': round(100 * v['s'] / v['n'], 1) if v['n'] else 0,
    } for r, v in agg.items()]
    rows.sort(key=lambda r: -r['knocks'])
    return rows


def build_summary(sel, knocks, waves, label, today, vacant_ids, goal):
    total = len(sel)
    knockable = total - len(vacant_ids)
    live = [d for d in sel if d['lead_id'] not in vacant_ids]
    worked = [d for d in live if int(d['knocks'] or 0) > 0]
    lastk = [d['last_knock'] for d in sel if d['last_knock']]
    firstk = [d['first_knock'] for d in sel if d['first_knock']]
    kn = [k for k in knocks if k['lead_id'] not in vacant_ids]
    contacts = {k['lead_id'] for k in kn if k['new_stage'] in CONTACT}
    sold = {k['lead_id'] for k in kn if k['new_stage'] == 'Sold'}
    rate = round(100 * len(contacts) / len(worked), 1) if worked else 0
    multi = sum(1 for d in worked if int(d['knocks'] or 0) > 1)
    return [
        ('Area', label),
        ('', ''),
        ('Total addresses', total),
        ('Vacant / for sale (removed)', len(vacant_ids)),
        ('KNOCKABLE DOORS', knockable),
        ('', ''),
        ('Worked doors', len(worked)),
        ('% of knockable worked', round(100 * len(worked) / knockable, 1) if knockable else 0),
        ('Never worked', knockable - len(worked)),
        ('Total knocks delivered', len(kn)),
        ('Knocks per worked door', round(len(kn) / len(worked), 2) if worked else 0),
        ('Doors knocked more than once', multi),
        ('% of worked doors hit again', round(100 * multi / len(worked), 1) if worked else 0),
        ('', ''),
        ('Contacts', len(contacts)),
        ('CONTACT RATE %', rate),
        ('Goal %', goal),
        ('Vs goal (points)', round(rate - goal, 1)),
        ('', ''),
        ('Sold', len(sold)),
        ('PENETRATION % (sold / knockable)', round(100 * len(sold) / knockable, 1) if knockable else 0),
        ('Close rate % (sold / contacts)', round(100 * len(sold) / len(contacts), 1) if contacts else 0),
        ('', ''),
        ('Waves worked', len(waves)),
        ('First knock', min(firstk) if firstk else ''),
        ('Last knock', max(lastk) if lastk else ''),
        ('Days since last knock', (today - dt.date(*map(int, max(lastk).split('-')))).days if lastk else ''),
        ('Reps who worked it', len({k['rep'] for k in kn if k['rep']})),
    ]


def write_xlsx(path, summary, waves, reps, doors, wave_leads, goal, label):
    import openpyxl
    from openpyxl.styles import Font, PatternFill, Alignment
    from openpyxl.utils import get_column_letter

    BOLD = Font(bold=True)
    HEAD = PatternFill('solid', fgColor='E8E8E4')
    GOOD = PatternFill('solid', fgColor='D6EBD6')   # at or above the contact goal
    BAD = PatternFill('solid', fgColor='F6DCDC')    # below it
    wb = openpyxl.Workbook()
    del wb['Sheet']

    def tab(name, rows, cols=None):
        ws = wb.create_sheet(name[:31])
        if not rows:
            ws.append(['(nothing)']); return ws
        cols = cols or list(rows[0].keys())
        ws.append(cols)
        for c in range(1, len(cols) + 1):
            ws.cell(1, c).font = BOLD; ws.cell(1, c).fill = HEAD
        for r in rows:
            ws.append([r.get(c) for c in cols])
        ws.freeze_panes = 'A2'
        ws.auto_filter.ref = ws.dimensions
        for i, h in enumerate(cols, 1):
            ws.column_dimensions[get_column_letter(i)].width = max(10, min(32, len(str(h)) + 4))
        return ws

    # --- Overview: the headline block, then every wave in one table ---------
    ws = wb.create_sheet('Overview')
    ws['A1'] = f'{label} — knock history'
    ws['A1'].font = Font(bold=True, size=14)
    r = 3
    for k, v in summary:
        if k == '':
            r += 1; continue
        ws.cell(r, 1, k); ws.cell(r, 2, v)
        if k.isupper() or k.startswith('CONTACT') or k.startswith('PENETRATION'):
            ws.cell(r, 1).font = BOLD; ws.cell(r, 2).font = BOLD
        if k == 'CONTACT RATE %':
            ws.cell(r, 2).fill = GOOD if float(v) >= goal else BAD
        r += 1
    ws.column_dimensions['A'].width = 34
    ws.column_dimensions['B'].width = 26

    wcols = ['wave', 'start', 'end', 'days_active', 'reps', 'knocks', 'worked_doors', 'new_doors',
             'repeat_doors', 'pct_of_knockable', 'contacts', 'contact_rate_pct', 'vs_goal_pts',
             'sold', 'penetration_pct', 'close_rate_pct', 'cumulative_worked', 'cumulative_pct_worked',
             'reps_on_this_wave']
    r += 1
    ws.cell(r, 1, 'WAVES').font = Font(bold=True, size=12); r += 1
    hdr = r
    for i, c in enumerate(wcols, 1):
        ws.cell(hdr, i, c).font = BOLD; ws.cell(hdr, i).fill = HEAD
    for w in waves:
        r += 1
        w = dict(w, vs_goal_pts=round(w['contact_rate_pct'] - goal, 1))
        for i, c in enumerate(wcols, 1):
            ws.cell(r, i, w.get(c))
        ws.cell(r, wcols.index('contact_rate_pct') + 1).fill = GOOD if w['contact_rate_pct'] >= goal else BAD
    for i, c in enumerate(wcols, 1):
        ws.column_dimensions[get_column_letter(i)].width = max(10, min(34, len(c) + 3))
    ws.freeze_panes = ws.cell(hdr + 1, 1)

    # --- one tab per wave, with the doors that wave touched -----------------
    for i, rows in enumerate(wave_leads, 1):
        tab(f'Wave {i}', rows)

    tab('All Leads', doors)
    tab('Reps', reps)

    ws = wb.create_sheet('Definitions')
    ws.append(['Metric', 'Definition']); ws['A1'].font = BOLD; ws['B1'].font = BOLD
    for a, b in [
        ('Total addresses', 'Every address in the selection, as it exists in SalesRabbit.'),
        ('Vacant / for sale', 'Doors dispositioned Vacant / For Sale. Nobody lives there, so they are removed from the denominators.'),
        ('Knockable doors', 'Total addresses minus vacant. The real sellable universe.'),
        ('Worked doors', 'Knockable doors with at least one disposition (a rep stood at the door).'),
        ('% of knockable worked', 'Worked doors / knockable doors.'),
        ('Knocks', 'Every disposition logged. A door worked three times counts three times.'),
        ('Wave', f'A push of knocking. A new wave starts after idle days with no activity in the area.'),
        ('Contacts', 'Doors where someone came to the door: ' + ', '.join(sorted(CONTACT)) + '.'),
        ('Contact rate', 'Contacts / worked doors.'),
        ('Goal', f'{goal}% contact rate is the internal target.'),
        ('Sold', 'Doors dispositioned Sold.'),
        ('Penetration', 'Sold / knockable doors.'),
        ('Close rate', 'Sold / contacts.'),
        ('Excluded', 'Intake accounts (' + ', '.join(sorted(EXCLUDE_REPS)) + ') and bulk edits, which are assignment activity rather than knocking.'),
        ('Source', 'SalesRabbit per-lead activity history, pulled direct from the CRM.'),
    ]:
        ws.append([a, b])
    ws.column_dimensions['A'].width = 26
    ws.column_dimensions['B'].width = 110
    for row in ws.iter_rows(min_row=2, max_col=2):
        row[1].alignment = Alignment(wrap_text=True, vertical='top')

    wb.save(path)


def rebuild_doors(today):
    """Regenerate data/sr-doors-by-area.csv from the crawl's compiled CSVs."""
    meta = {}
    with open(HIST, newline='') as f:
        for r in csv.DictReader(f):
            meta[r['lead_id']] = {'street': r['street'], 'unit': r['unit'], 'city': r['city'].strip(),
                                  'state': r['state'].strip(), 'zip': r['zip'].strip(),
                                  'current_stage': r['current_stage']}
    acc = collections.defaultdict(lambda: {'ks': [], 'reps': set(), 'days': set(), 'sold': 0})
    with open(ACT, newline='') as f:
        for r in csv.DictReader(f):
            if r['event'] != 'stage_updated':
                continue
            who = (r['rep'] or '').strip()
            if who.lower() in EXCLUDE_REPS:
                continue
            d = acc[r['lead_id']]
            d['ks'].append((r['datetime'], who, r['new_stage']))
            if who: d['reps'].add(who)
            if r['datetime']: d['days'].add(r['datetime'][:10])
            if r['new_stage'] == 'Sold': d['sold'] = 1
    rows = []
    for lid, m in meta.items():
        d = acc.get(lid)
        ks = sorted(d['ks']) if d else []
        last = ks[-1] if ks else ('', '', '')
        days = ''
        if last[0]:
            try:
                days = (today - dt.date(int(last[0][:4]), int(last[0][5:7]), int(last[0][8:10]))).days
            except ValueError:
                pass
        rows.append({**m, 'lead_id': lid, 'knocks': len(ks),
                     'days_knocked': len(d['days']) if d else 0,
                     'reps': len(d['reps']) if d else 0,
                     'first_knock': ks[0][0][:10] if ks else '',
                     'last_knock': last[0][:10], 'days_since_last_knock': days,
                     'last_knocked_by': last[1], 'last_disposition': last[2],
                     'ever_sold': d['sold'] if d else 0,
                     'knocked_by': ' | '.join(sorted(d['reps'])) if d else ''})
    rows.sort(key=lambda r: (r['state'], r['city'].upper(), r['zip'], r['street']))
    cols = ['lead_id', 'street', 'unit', 'city', 'state', 'zip', 'current_stage', 'knocks',
            'days_knocked', 'reps', 'first_knock', 'last_knock', 'days_since_last_knock',
            'last_knocked_by', 'last_disposition', 'ever_sold', 'knocked_by']
    with open(DOORS, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction='ignore')
        w.writeheader(); w.writerows(rows)
    print(f'rebuilt {DOORS}  ({len(rows):,} doors)')


def main():
    p = argparse.ArgumentParser(description='Knock reports by area, from the latest SalesRabbit crawl.')
    p.add_argument('--city'); p.add_argument('--zip'); p.add_argument('--state')
    p.add_argument('--match', help='regex over "city zip state", for grouping towns')
    p.add_argument('--isp', help='named territory from data/isps.json (cities+states+zips)')
    p.add_argument('--name', help='label for the report (defaults to the filters)')
    p.add_argument('--gap', type=int, default=5, help='idle days that start a new wave (default 5)')
    p.add_argument('--goal', type=float, default=60.0, help='contact-rate target in percent (default 60)')
    p.add_argument('--out', help='output .xlsx path')
    p.add_argument('--list', action='store_true', help='list areas instead of reporting')
    p.add_argument('--rebuild-doors', action='store_true', help='regenerate sr-doors-by-area.csv from the crawl')
    p.add_argument('--today', help='anchor date for "days since" (YYYY-MM-DD, defaults to today)')
    args = p.parse_args()

    today = dt.date(*map(int, args.today.split('-'))) if args.today else dt.date.today()

    if args.rebuild_doors:
        rebuild_doors(today); return

    doors = load_doors()

    # --isp resolves to a city/state/zip set from data/isps.json, so "pull the
    # i3 report" is one flag instead of a hand-built regex.
    isp_def = None
    if args.isp:
        path = os.path.join(ROOT, 'data', 'isps.json')
        m = {k.lower(): v for k, v in json.load(open(path)).items() if not k.startswith('_')}
        isp_def = m.get(args.isp.lower())
        if not isp_def:
            sys.exit(f'No ISP "{args.isp}" in {path}. Known: ' + ', '.join(sorted(m)))
        from isp_territory import Territory
        doors = Territory(doors).select(doors, args.isp)
        if not args.name:
            args.name = args.isp

    if args.list:
        sel = select(doors, args)
        area = collections.defaultdict(list)
        for d in sel:
            area[(d['state'], d['city'], d['zip'])].append(d)
        rows = []
        for (st, city, z), ds in area.items():
            k = [x for x in ds if int(x['knocks'] or 0) > 0]
            lk = [x['last_knock'] for x in ds if x['last_knock']]
            rows.append((len(ds), st, city, z, len(k), round(100 * len(k) / len(ds)), max(lk) if lk else '-'))
        rows.sort(reverse=True)
        print(f"{'doors':>7}  {'st':<3}{'city':<24}{'zip':<8}{'knocked':>8}{'pct':>5}  last knock")
        for n, st, city, z, k, pct, last in rows:
            print(f'{n:>7}  {st:<3}{city[:23]:<24}{z:<8}{k:>8}{pct:>4}%  {last}')
        print(f'\n{len(rows)} areas, {sum(r[0] for r in rows):,} doors')
        return

    if not any([args.city, args.zip, args.state, args.match, args.isp]):
        p.error('give me something to filter on: --city, --zip, --state or --match (or use --list)')

    sel = select(doors, args)
    if not sel:
        sys.exit('Nothing matched. Try --list to see what is there.')

    label = args.name or ', '.join(x for x in [args.city, args.zip, args.state, args.match] if x)
    ids = {d['lead_id'] for d in sel}
    marks = activity_for(ids)
    knocks = knocks_only(marks)

    # A door counts as vacant if it was ever dispositioned that way, or sits
    # there now. Those come out of every denominator.
    vacant_ids = {d['lead_id'] for d in sel if d['current_stage'] in VACANT}
    vacant_ids |= {k['lead_id'] for k in knocks if k['new_stage'] in VACANT}
    knockable = len(sel) - len(vacant_ids)

    groups = wave_groups(knocks, args.gap)
    waves = build_waves(knocks, groups, knockable, vacant_ids)
    reps = build_reps(knocks)
    summary = build_summary(sel, knocks, waves, label, today, vacant_ids, args.goal)

    # Per-wave door lists: what each push actually touched, and what it got.
    by_id = {d['lead_id']: d for d in sel}
    wave_leads, seen = [], set()
    for g in groups:
        gs = set(g)
        e = [k for k in knocks if k['datetime'][:10] in gs]
        per = collections.defaultdict(list)
        for k in e:
            per[k['lead_id']].append(k)
        rows = []
        for lid, ks in per.items():
            d = by_id.get(lid, {})
            ks.sort(key=lambda x: x['datetime'])
            stages = [k['new_stage'] for k in ks if k['new_stage']]
            rows.append({
                'street': d.get('street', ''), 'unit': d.get('unit', ''), 'city': d.get('city', ''),
                'zip': d.get('zip', ''), 'first_seen_this_wave': ks[0]['datetime'][:16].replace('T', ' '),
                'last_seen_this_wave': ks[-1]['datetime'][:16].replace('T', ' '),
                'times_hit_this_wave': len(ks),
                'dispositions_this_wave': ' > '.join(stages),
                'ended_wave_as': stages[-1] if stages else '',
                'contacted': 'yes' if any(s in CONTACT for s in stages) else '',
                'sold': 'yes' if 'Sold' in stages else '',
                'first_time_ever_hit': 'yes' if lid not in seen else '',
                'rep': ' | '.join(sorted({k['rep'] for k in ks if k['rep']})),
                'current_stage': d.get('current_stage', ''),
                'total_knocks_all_time': d.get('knocks', ''),
                'lead_id': lid,
            })
        seen |= set(per)
        rows.sort(key=lambda r: (r['city'], r['street']))
        wave_leads.append(rows)

    # All Leads: every door, with how many times it has been hit and by whom.
    hist = collections.defaultdict(list)
    for k in knocks:
        hist[k['lead_id']].append(k)
    for d in sel:
        ks = sorted(hist.get(d['lead_id'], []), key=lambda x: x['datetime'])
        d['all_dispositions'] = ' > '.join(k['new_stage'] for k in ks if k['new_stage'])
        d['vacant'] = 'yes' if d['lead_id'] in vacant_ids else ''
        d['knockable'] = '' if d['lead_id'] in vacant_ids else 'yes'
        d['ever_contacted'] = 'yes' if any(k['new_stage'] in CONTACT for k in ks) else ''
    doors_cols = ['street', 'unit', 'city', 'state', 'zip', 'knockable', 'vacant', 'knocks',
                  'days_knocked', 'reps', 'first_knock', 'last_knock', 'days_since_last_knock',
                  'ever_contacted', 'ever_sold', 'current_stage', 'all_dispositions',
                  'last_knocked_by', 'knocked_by', 'lead_id']
    sel_out = [{c: d.get(c, '') for c in doors_cols} for d in sel]

    out = args.out or os.path.join(os.path.expanduser('~'), 'Downloads',
                                   f"knock report - {re.sub(r'[^A-Za-z0-9 +-]', '', label)[:60]}.xlsx")
    write_xlsx(out, summary, waves, reps, sel_out, wave_leads, args.goal, label)

    for k, v in summary:
        print(f'  {k:<36}{v}')
    print(f'\n{len(waves)} waves, {len(reps)} reps, {len(sel):,} doors, {len(marks):,} activity marks')
    print(f'-> {out}')


if __name__ == '__main__':
    main()
