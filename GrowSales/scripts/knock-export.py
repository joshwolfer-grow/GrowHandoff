#!/usr/bin/env python3
"""Everything that leaves the building: ISP packets, crew packets, rep levers.

All output is CSV in a dated folder, ready to drop into Drive and share.

    python3 scripts/knock-export.py --isp i3
    python3 scripts/knock-export.py --isp i3 --city "glens falls"    # narrow it
    python3 scripts/knock-export.py --crews          # one packet per manager
    python3 scripts/knock-export.py --reps           # company-wide rep levers
    python3 scripts/knock-export.py --all            # all three

Default output root is ~/Downloads/grow-export-<date>/. Override with --out.

Reads what grow-sync.mjs produces (data/sr-doors-by-area.csv,
data/sr-activity.csv) plus team-assignments.json for crew rosters. Run
`node scripts/grow-sync.mjs` first so the numbers are current.
"""

import argparse, csv, collections, datetime as dt, json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

csv.field_size_limit(10 ** 7)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOORS = os.path.join(ROOT, 'data', 'sr-doors-by-area.csv')
ACT = os.path.join(ROOT, 'data', 'sr-activity.csv')
ISPS = os.path.join(ROOT, 'data', 'isps.json')
# Google Drive for Desktop syncs this. Writing here IS uploading: the file is in
# the shared drive within seconds, no API and no drag. Subfolders already exist
# per ISP (GBN, GFiber, Glo, Lyte, SLIC, i3); a new one is created if needed.
SECTOR_DIR = os.path.join(ROOT, 'data', 'sectors')
from _drive import grow_drive
DRIVE_ISP = os.path.join(grow_drive(), 'Reporting', 'SalesRabbit Reports For ISPs')
ROSTER = os.path.join(ROOT, 'team-assignments.json')

CONTACT = {'Not Interested', 'Call Back', 'No English', 'Do Not Knock', 'Sold'}
# When a door is dispositioned more than once in a week, the Leads tab shows the
# most-progressed outcome, not the last one typed. Same rule the i3 sector sheet
# uses. Without it a door sold on Tuesday and re-tagged "Not Home" on Thursday
# vanishes from the sold count, and the summary formulas stop agreeing with the
# numbers we quote.
STAGE_RANK = ['Sold', 'Hot Lead', 'Call Back', 'Current Customer', 'Previous Customer',
              'Not Interested', 'No English', 'Do Not Knock', 'Business', 'Drop In Place',
              'Not Home 3', 'Not Home 2', 'Not Home 1', 'Vacant / For Sale', 'New Lead']
def best_stage(stages):
    for s in STAGE_RANK:
        if s in stages: return s
    return next((x for x in stages if x), '')
# NOTE: STAGE_RANK / best_stage are kept for reference but NOT used. The report
# counts each door by the LAST disposition of the week, which is what shows in
# SalesRabbit and what the ISP-side tracking reconciles against.
VACANT = {'Vacant / For Sale'}
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
GOAL = 60.0


def autosize(ws, pad=3, cap=42):
    """Widen every column to its longest cell so nothing arrives truncated.

    Formula cells are measured by their header instead of their text: nobody
    needs a column wide enough to show =SUMPRODUCT(COUNTIF(...)).
    """
    from openpyxl.utils import get_column_letter
    for col in ws.columns:
        widest = 0
        for c in col:
            v = c.value
            if v is None: continue
            t = str(v)
            if t.startswith('='):
                t = str(ws.cell(1, c.column).value or '')
            elif isinstance(v, float) and 0 < v < 1.5:
                t = '00.0%'
            elif isinstance(v, (int, float)):
                t = f'{v:,.0f}'
            widest = max(widest, len(t))
        if widest:
            ws.column_dimensions[get_column_letter(col[0].column)].width = min(widest + pad, cap)


def write_csv(path, rows, cols=None):
    if not rows:
        return None
    cols = cols or list(rows[0].keys())
    with open(path, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction='ignore')
        w.writeheader(); w.writerows(rows)
    return path


SUF_S = {'ROAD': 'RD', 'STREET': 'ST', 'AVENUE': 'AVE', 'AV': 'AVE', 'DRIVE': 'DR', 'LANE': 'LN',
         'COURT': 'CT', 'PLACE': 'PL', 'BOULEVARD': 'BLVD', 'CIRCLE': 'CIR', 'TERRACE': 'TER',
         'PARKWAY': 'PKWY', 'HIGHWAY': 'HWY', 'TRAIL': 'TRL', 'SQUARE': 'SQ', 'EXTENSION': 'EXT',
         'NORTH': 'N', 'SOUTH': 'S', 'EAST': 'E', 'WEST': 'W', 'ROUTE': 'RTE', 'RT': 'RTE',
         'APARTMENT': 'APT', 'UNIT': 'APT', 'SUITE': 'STE', 'FLOOR': 'FL'}


def _skey(s):
    return ' '.join(SUF_S.get(w, w) for w in re.sub(r'[^A-Z0-9 ]', ' ', (s or '').upper()).split())


def load_sectors(isp):
    """street+zip -> sector, from data/sectors/<isp>.csv if that ISP sends one.

    Only some ISPs give us sector data (i3 and Lyte do). Everyone else reports
    by city, which is why this returns an empty map rather than failing.
    """
    path = os.path.join(SECTOR_DIR, f'{isp}.csv')
    if not os.path.exists(path):
        return {}
    with open(path, newline='') as f:
        m = {(r['street_key'], r['zip']): r['sector'] for r in csv.DictReader(f)}
    return m


def map_sectors(isp):
    """street+zip -> area, off the ISP's map (data/sectors/<isp>-cut.json), for ISPs
    set to "sectors": "map" in data/isps.json. Surf sends areas for some towns only;
    the map fills the rest with Grow areas (BRAI 1.2), so the workbook and the map
    carry the same area for every door. A door the map has not drawn yet (it is
    rebuilt after this export) falls back to the ISP's own sector file."""
    try:
        if json.load(open(ISPS)).get(isp, {}).get('sectors') != 'map':
            return None
        cut = json.load(open(os.path.join(SECTOR_DIR, f'{isp}-cut.json')))
        doors = json.load(open(os.path.join(ROOT, 'data', 'osm-cache', f'{isp}-doors.json')))
    except (OSError, ValueError):
        return None
    m = load_sectors(isp)
    for d in doors:
        sec = cut['doors'].get(d['id'])
        if sec:
            m[(_skey(d['street']), (d['zip'] or '')[:5])] = sec
    return m


def sectors_for(isp, sel, min_cover=0.5):
    """Sector map if it covers at least min_cover of this selection, else {}.

    Lyte's file is 372 Lake Jackson addresses against 31,000 knocked doors
    statewide; blocking the whole report by sector then puts 99% of it under
    "(no sector)", which reads as a broken report, not a data gap. Below the
    threshold the ISP is reported by city like everyone else.
    """
    m = map_sectors(isp)
    if m:
        return m
    m = load_sectors(isp)
    if not m or not sel:
        return m
    hit = sum(1 for d in sel if (_skey(d['street']), d['zip'][:5]) in m)
    if hit / len(sel) < min_cover:
        print(f'  {isp}: sector file covers {hit:,} of {len(sel):,} doors, reporting by city instead')
        return {}
    return m


def group_key(d, sectors):
    """How this ISP's report is broken down: sector when we have one for the
    address, city otherwise. Addresses in a sector-mapped ISP that aren't in the
    file land in "(no sector)" so a gap in their data is visible rather than
    quietly folded into a city."""
    if sectors:
        return sectors.get((_skey(d['street']), d['zip'][:5]), '(no sector)')
    return f"{d['city']}, {d['state']} {d['zip']}"


def load_doors():
    if not os.path.exists(DOORS):
        sys.exit(f'Missing {DOORS}. Run: node scripts/grow-sync.mjs')
    with open(DOORS, newline='') as f:
        return list(csv.DictReader(f))


def load_knocks(ids=None):
    """Every stage change, intake accounts dropped. ids=None means all."""
    out = []
    with open(ACT, newline='') as f:
        for r in csv.DictReader(f):
            if r['event'] != 'stage_updated' or not r['datetime']:
                continue
            if (r['rep'] or '').strip().lower() in EXCLUDE_REPS:
                continue
            if not at_door(r.get('distance')):
                continue
            if ids is not None and r['lead_id'] not in ids:
                continue
            out.append(r)
    return out


# How many weeks get their own tab. Older weeks stay on the Summary; the tab
# strip is capped so a workbook stays navigable after a year of Mondays.
KEEP_TABS = 13
MON = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']


def lock_sheet(ws):
    """Lock every cell on a tab, leaving selection, sorting and filtering alone.

    This stops an ISP nudging a number or clobbering a formula by accident. It
    is NOT security: anyone can click Unprotect. Real access control is the
    Drive sharing on the file. Set ISP_SHEET_PASSWORD in the environment to put
    a password on it — deliberately not stored in the repo.
    """
    ws.protection.sheet = True
    ws.protection.sort = False          # False here means "allowed"
    ws.protection.autoFilter = False
    ws.protection.selectLockedCells = False
    pw = os.environ.get('ISP_SHEET_PASSWORD')
    if pw:
        ws.protection.password = pw


def week_sunday(iso):
    """The Sunday that owns this date. Weeks are Sunday-anchored everywhere here."""
    d = dt.date(*map(int, iso.split('-')))
    return (d - dt.timedelta(days=(d.weekday() + 1) % 7)).isoformat()


def week_label(sun):
    """'Aug 16-22', or 'Aug 30-Sep 5' when the week straddles a month."""
    a = dt.date(*map(int, sun.split('-'))); b = a + dt.timedelta(days=6)
    return (f'{MON[a.month]} {a.day}-{b.day}' if a.month == b.month
            else f'{MON[a.month]} {a.day}-{MON[b.month]} {b.day}')


def week_tabname(sun, used):
    """Same label, made unique. Two kept weeks can only collide across years, so
    that is the only case that needs the suffix."""
    n = week_label(sun)
    if n in used:
        n = f"{n} '{dt.date(*map(int, sun.split('-'))).strftime('%y')}"
    used.add(n)
    return n


def unit_sort(u):
    """Alphabetical, with the sector-data gap pinned to the bottom: it is a hole
    in the ISP's own file, not a place, and it should not head the list."""
    return (u == '(no sector)', u)


def wave_split(knocks, gap=5):
    days = sorted({k['datetime'][:10] for k in knocks})
    if not days:
        return []
    groups, cur = [], [days[0]]
    for d in days[1:]:
        if (dt.date(*map(int, d.split('-'))) - dt.date(*map(int, cur[-1].split('-')))).days >= gap:
            groups.append(cur); cur = [d]
        else:
            cur.append(d)
    groups.append(cur)
    return groups


# ------------------------------------------------------------------ ISP
def isp_packet(outdir, label, sel, gap):
    """Files an ISP can read without us in the room.

    Broken down by sector for the ISPs that send sector data (i3 only, as of
    Jul 2026) and by city for everyone else. That is decided by whether
    data/sectors/<isp>.csv exists, so adding an ISP's sector file is all it
    takes to switch them over.
    """
    sectors = sectors_for(label, sel)
    ids = {d['lead_id'] for d in sel}
    knocks = load_knocks(ids)
    vacant = {d['lead_id'] for d in sel if d['current_stage'] in VACANT}
    vacant |= {k['lead_id'] for k in knocks if k['new_stage'] in VACANT}
    knockable = len(sel) - len(vacant)
    live = [k for k in knocks if k['lead_id'] not in vacant]
    worked = {k['lead_id'] for k in live}
    contacts = {k['lead_id'] for k in live if k['new_stage'] in CONTACT}
    sold = {k['lead_id'] for k in live if k['new_stage'] == 'Sold'}
    lastk = [d['last_knock'] for d in sel if d['last_knock']]

    # Duplicate addresses in their own file: knocks we spent twice on one house.
    SUF = {'ROAD': 'RD', 'STREET': 'ST', 'AVENUE': 'AVE', 'DRIVE': 'DR', 'LANE': 'LN', 'COURT': 'CT',
           'PLACE': 'PL', 'BOULEVARD': 'BLVD', 'CIRCLE': 'CIR', 'TERRACE': 'TER', 'NORTH': 'N',
           'SOUTH': 'S', 'EAST': 'E', 'WEST': 'W', 'APARTMENT': 'APT', 'UNIT': 'APT', 'SUITE': 'STE'}
    nrm = lambda s: ' '.join(SUF.get(w, w) for w in re.sub(r'[^A-Z0-9 ]', ' ', (s or '').upper()).split())
    g = collections.defaultdict(list)
    for d in sel:
        g[(nrm(d['street']), nrm(d['unit']), d['zip'])].append(d)
    dupe_groups = {k: v for k, v in g.items() if len(v) > 1}
    dupe_rows = sum(len(v) for v in dupe_groups.values())
    wasted = sum(sum(int(x['knocks'] or 0) for x in sorted(v, key=lambda y: -int(y['knocks'] or 0))[1:])
                 for v in dupe_groups.values())

    summary = [
        ('Area', label),
        ('Report date', dt.date.today().isoformat()),
        ('Total addresses in SalesRabbit', len(sel)),
        ('Vacant / for sale', len(vacant)),
        ('Knockable doors', knockable),
        ('Doors worked', len(worked)),
        ('% of knockable worked', round(100 * len(worked) / knockable, 1) if knockable else 0),
        ('Doors never worked', knockable - len(worked)),
        ('Total knocks delivered', len(live)),
        ('Knocks per worked door', round(len(live) / len(worked), 2) if worked else 0),
        ('Doors worked more than once', sum(1 for d in sel if int(d['knocks'] or 0) > 1)),
        ('Contacts', len(contacts)),
        ('Contact rate %', round(100 * len(contacts) / len(worked), 1) if worked else 0),
        ('Contact rate goal %', GOAL),
        ('Sold', len(sold)),
        ('Penetration % (sold / knockable)', round(100 * len(sold) / knockable, 1) if knockable else 0),
        ('Close rate % (sold / contacts)', round(100 * len(sold) / len(contacts), 1) if contacts else 0),
        ('Duplicate addresses in the lead file', len(dupe_groups)),
        ('Extra rows those duplicates created', dupe_rows - len(dupe_groups)),
        ('Knocks spent re-working a duplicate', wasted),
        ('First knock', min(d['first_knock'] for d in sel if d['first_knock']) if lastk else ''),
        ('Last knock', max(lastk) if lastk else ''),
        ('Reps who worked it', len({k['rep'] for k in live if k['rep']})),
    ]
    write_csv(os.path.join(outdir, f'{label} - summary.csv'),
              [{'metric': k, 'value': v} for k, v in summary])

    groups = wave_split(live, gap)
    seen, waves = set(), []
    for i, wdays in enumerate(groups, 1):
        ws = set(wdays)
        e = [k for k in live if k['datetime'][:10] in ws]
        uniq = {k['lead_id'] for k in e}
        new = uniq - seen
        c = {k['lead_id'] for k in e if k['new_stage'] in CONTACT}
        s = {k['lead_id'] for k in e if k['new_stage'] == 'Sold'}
        seen |= uniq
        waves.append({'wave': i, 'start': wdays[0], 'end': wdays[-1], 'days_active': len(wdays),
                      'reps': len({k['rep'] for k in e if k['rep']}), 'knocks': len(e),
                      'doors_worked': len(uniq), 'new_doors': len(new), 'repeat_doors': len(uniq) - len(new),
                      'contacts': len(c), 'contact_rate_pct': round(100 * len(c) / len(uniq), 1) if uniq else 0,
                      'vs_goal_pts': round((100 * len(c) / len(uniq) if uniq else 0) - GOAL, 1),
                      'sold': len(s), 'close_rate_pct': round(100 * len(s) / len(c), 1) if c else 0,
                      'cumulative_doors_worked': len(seen),
                      'cumulative_pct_of_knockable': round(100 * len(seen) / knockable, 1) if knockable else 0})
    write_csv(os.path.join(outdir, f'{label} - waves.csv'), waves)

    hist = collections.defaultdict(list)
    for k in knocks:
        hist[k['lead_id']].append(k)
    door_rows = []
    for d in sel:
        ks = sorted(hist.get(d['lead_id'], []), key=lambda x: x['datetime'])
        door_rows.append({'street': d['street'], 'unit': d['unit'], 'city': d['city'], 'state': d['state'],
                          'zip': d['zip'], 'knockable': '' if d['lead_id'] in vacant else 'yes',
                          'times_knocked': d['knocks'], 'days_knocked': d['days_knocked'],
                          'first_knock': d['first_knock'], 'last_knock': d['last_knock'],
                          'current_status': d['current_stage'],
                          'every_disposition': ' > '.join(k['new_stage'] for k in ks if k['new_stage']),
                          'contacted': 'yes' if any(k['new_stage'] in CONTACT for k in ks) else '',
                          'sold': 'yes' if str(d['ever_sold']) == '1' else ''})
    door_rows.sort(key=lambda r: (r['city'].upper(), r['zip'], r['street']))
    write_csv(os.path.join(outdir, f'{label} - every door.csv'), door_rows)

    # The breakdown the ISP actually reads: their sectors, or cities if they
    # don't send sector data.
    unit = 'sector' if sectors else 'area'
    by = collections.defaultdict(list)
    for d in sel: by[group_key(d, sectors)].append(d)
    kn_by = collections.defaultdict(list)
    idx = {d['lead_id']: group_key(d, sectors) for d in sel}
    for k in live: kn_by[idx[k['lead_id']]].append(k)
    area_rows = []
    for key, ds in by.items():
        vac = sum(1 for d in ds if d['lead_id'] in vacant)
        kn = len(ds) - vac
        e = kn_by.get(key, [])
        worked = {x['lead_id'] for x in e}
        con = {x['lead_id'] for x in e if x['new_stage'] in CONTACT}
        sld = {x['lead_id'] for x in e if x['new_stage'] == 'Sold'}
        lastk = [d['last_knock'] for d in ds if d['last_knock']]
        area_rows.append({
            unit: key, 'total_addresses': len(ds), 'vacant': vac, 'knockable_doors': kn,
            'doors_worked': len(worked), 'pct_worked': round(100 * len(worked) / max(kn, 1), 1),
            'contacts': len(con), 'contact_rate_pct': round(100 * len(con) / max(len(worked), 1), 1),
            'sold': len(sld), 'penetration_lift_pct': round(100 * len(sld) / max(len(worked), 1), 1),
            'never_worked': kn - len(worked), 'last_knocked': max(lastk) if lastk else ''})
    area_rows.sort(key=lambda r: -r['total_addresses'])
    write_csv(os.path.join(outdir, f'{label} - by {unit}.csv'), area_rows)
    print(f'  {label}: {len(sel):,} addresses, {knockable:,} knockable, '
          f'{summary[6][1]}% worked, {summary[12][1]}% contact, {len(sold)} sold')


# ------------------------------------------------------------------ CREW
def crew_packets(outdir, doors, gap):
    """One file per manager: their crew's knocking, plus each rep's levers."""
    if not os.path.exists(ROSTER):
        print('  (no team-assignments.json, skipping crews)'); return
    roster = json.load(open(ROSTER))
    latest = sorted(roster)[-1]
    crews = roster[latest]
    knocks = load_knocks()
    by_rep = collections.defaultdict(list)
    for k in knocks:
        by_rep[k['rep'].strip()].append(k)
    team = rep_rows(by_rep)
    med_contact = sorted(r['contact_rate_pct'] for r in team if r['knocks'] >= 200)
    med = med_contact[len(med_contact) // 2] if med_contact else 0

    made = 0
    for mgr, reps in crews.items():
        rows = [r for r in team if r['rep'] in set(reps)]
        if not rows:
            continue
        rows.sort(key=lambda r: -r['knocks'])
        tot_k = sum(r['knocks'] for r in rows)
        tot_c = sum(r['contacts'] for r in rows)
        tot_s = sum(r['sold'] for r in rows)
        rows.append({'rep': f'— {mgr} CREW TOTAL —', 'knocks': tot_k, 'doors': sum(r['doors'] for r in rows),
                     'days': '', 'knocks_per_day': '', 'contacts': tot_c,
                     'contact_rate_pct': round(100 * tot_c / tot_k, 1) if tot_k else 0,
                     'sold': tot_s, 'sold_per_100_knocks': round(100 * tot_s / tot_k, 1) if tot_k else 0,
                     'close_rate_pct': round(100 * tot_s / tot_c, 1) if tot_c else 0,
                     'vs_team_median_pts': '', 'biggest_lever': ''})
        safe = re.sub(r'[^A-Za-z0-9 ]', '', mgr)
        write_csv(os.path.join(outdir, f'crew - {safe}.csv'), rows)
        made += 1
    print(f'  {made} crew files (roster week {latest}), team median contact rate {med}%')


# ------------------------------------------------------------------ REPS
def rep_rows(by_rep):
    rows = []
    for rep, ks in by_rep.items():
        if not rep:
            continue
        n = len(ks)
        doors = {k['lead_id'] for k in ks}
        days = {k['datetime'][:10] for k in ks}
        c = sum(1 for k in ks if k['new_stage'] in CONTACT)
        s = sum(1 for k in ks if k['new_stage'] == 'Sold')
        rows.append({'rep': rep, 'knocks': n, 'doors': len(doors), 'days': len(days),
                     'knocks_per_day': round(n / len(days), 1) if days else 0,
                     'contacts': c, 'contact_rate_pct': round(100 * c / n, 1) if n else 0,
                     'sold': s, 'sold_per_100_knocks': round(100 * s / n, 1) if n else 0,
                     'close_rate_pct': round(100 * s / c, 1) if c else 0})
    return rows


def rep_levers(outdir):
    """Every rep, with the one number most worth fixing.

    Reps are compared to the TEAM, not to the 60% goal. That 60% is an area
    standard — how saturated a market is once we're done with it — and a single
    rep's per-knock rate swings too much with the streets they were given to
    hold against it. The three levers, in the order they matter: are they
    knocking enough, are they getting people to the door, are they closing the
    ones who answer.
    """
    knocks = load_knocks()
    by_rep = collections.defaultdict(list)
    for k in knocks:
        by_rep[k['rep'].strip()].append(k)
    rows = rep_rows(by_rep)
    active = [r for r in rows if r['knocks'] >= 200]
    if not active:
        print('  (no reps with 200+ knocks)'); return
    mid = lambda key: sorted(r[key] for r in active)[len(active) // 2]
    m_kpd, m_contact, m_close = mid('knocks_per_day'), mid('contact_rate_pct'), mid('close_rate_pct')

    for r in rows:
        r['vs_team_median_pts'] = round(r['contact_rate_pct'] - m_contact, 1)
        gaps = []
        if r['knocks_per_day'] < m_kpd * 0.8:
            gaps.append(((m_kpd - r['knocks_per_day']) / max(m_kpd, 1),
                         f"volume: {r['knocks_per_day']}/day vs team {m_kpd}"))
        if r['contact_rate_pct'] < m_contact * 0.85:
            gaps.append(((m_contact - r['contact_rate_pct']) / max(m_contact, 1),
                         f"contact rate: {r['contact_rate_pct']}% vs team {m_contact}%"))
        if r['close_rate_pct'] < m_close * 0.8 and r['contacts'] >= 30:
            gaps.append(((m_close - r['close_rate_pct']) / max(m_close, 1),
                         f"closing: {r['close_rate_pct']}% of contacts vs team {m_close}%"))
        gaps.sort(reverse=True)
        r['biggest_lever'] = gaps[0][1] if gaps else 'on standard'
    rows.sort(key=lambda r: -r['knocks'])
    p = write_csv(os.path.join(outdir, 'rep levers.csv'), rows)
    print(f'  {len(rows)} reps ({len(active)} with 200+ knocks), compared against team medians.')
    print(f'  team medians: {m_kpd} knocks/day, {m_contact}% contact, {m_close}% close')
    return p


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--isp'); p.add_argument('--city'); p.add_argument('--zip'); p.add_argument('--state')
    p.add_argument('--match'); p.add_argument('--name')
    p.add_argument('--crews', action='store_true'); p.add_argument('--reps', action='store_true')
    p.add_argument('--all', action='store_true')
    p.add_argument('--gap', type=int, default=5)
    p.add_argument('--week', help='Sunday of the report week (YYYY-MM-DD); makes the dated weekly ISP '
                                  'report AND rebuilds the continuous workbook. '
                                  'Omit the date to use last week automatically.', nargs='?', const='last')
    p.add_argument('--out')
    args = p.parse_args()
    if not any([args.isp, args.city, args.zip, args.state, args.match, args.crews, args.reps, args.all]):
        p.error('pick something: --isp / --city / --crews / --reps / --all')

    outdir = args.out or os.path.join(os.path.expanduser('~'), 'Downloads',
                                      f'grow-export-{dt.date.today().isoformat()}')
    os.makedirs(outdir, exist_ok=True)

    # "all" is the Monday job: every ISP we run on SalesRabbit knocking, one go.
    if (args.isp or '').lower() == 'all':
        cfg = json.load(open(ISPS))
        # _skip lets an ISP sit out the bulk run without deleting its territory.
        names = [k for k, v in cfg.items()
                 if not k.startswith('_') and not (isinstance(v, dict) and v.get('_skip'))]
        skipped = [k for k, v in cfg.items()
                   if not k.startswith('_') and isinstance(v, dict) and v.get('_skip')]
        if skipped:
            print(f'  (skipping {", ".join(skipped)} — run --isp <name> to build anyway)')
        for name in names:
            sub = sys.argv[1:]
            os.execv(sys.executable, [sys.executable, os.path.abspath(__file__)]
                     + [('--isp' if a == '--isp' else a) for a in sub]) if False else None
        import subprocess
        for name in names:
            cmd = [sys.executable, os.path.abspath(__file__), '--isp', name]
            if args.week: cmd += ['--week'] + ([args.week] if args.week != 'last' else [])
            if args.out: cmd += ['--out', args.out]
            subprocess.run(cmd)
        return

    doors = load_doors()

    if args.isp or args.city or args.zip or args.state or args.match:
        sel = doors
        label = args.name
        if args.isp:
            # Ownership comes from the import batch (data/isp-imports.json), not
            # from geography. See scripts/isp_territory.py for the fallbacks.
            from isp_territory import Territory, isp_names
            known = {n.lower(): n for n in isp_names()}
            if args.isp.lower() not in known:
                sys.exit(f'No ISP "{args.isp}". Known: all, ' + ', '.join(sorted(known.values())))
            terr = Territory(doors)
            sel = terr.select(sel, args.isp)
            if terr.unlabeled_batches:
                print(f'  {args.isp}: {sum(terr.unlabeled_batches.values()):,} doors sit in '
                      f'{len(terr.unlabeled_batches)} unlabeled import batch(es) and are on NO report. '
                      f'Run: node scripts/isp-registry.mjs')
            label = label or args.isp
        if args.city:
            sel = [x for x in sel if args.city.lower() in x['city'].lower()]
        if args.zip:
            sel = [x for x in sel if args.zip in x['zip']]
        if args.state:
            sel = [x for x in sel if x['state'].upper() == args.state.upper()]
        if args.match:
            rx = re.compile(args.match, re.I)
            sel = [x for x in sel if rx.search(f"{x['city']} {x['zip']} {x['state']}")]
        if not sel:
            sys.exit('Nothing matched.')
        label = re.sub(r'[^A-Za-z0-9 +&-]', '', label or args.city or args.state or 'selection')
        if args.week:
            # One deliverable now. The workbook carries every week as its own
            # tab, so the dated per-week file it used to sit beside was the same
            # numbers twice; a date passed here no longer selects anything.
            if args.week != 'last':
                print(f'  note: --week {args.week} — the workbook covers every week, '
                      f'so the date is ignored')
            weekly_isp(outdir, label, sel)
        else:
            isp_packet(outdir, label, sel, args.gap)

    if args.crews or args.all:
        crew_packets(outdir, doors, args.gap)
    if args.reps or args.all:
        rep_levers(outdir)

    print(f'\n-> {outdir}')



# ---------------------------------------------------------------- ISP WORKBOOK
def _d(iso):
    """Real date, not text. MIN/MAX in the Summary silently return 0 over
    date-shaped strings, which is why first/last knock came out blank."""
    try: return dt.date(int(iso[:4]), int(iso[5:7]), int(iso[8:10]))
    except (ValueError, TypeError): return None


def isp_dest(outdir, label):
    """The ISP's folder on the shared Drive when it is mounted, else outdir."""
    if os.path.isdir(DRIVE_ISP):
        match = next((d for d in os.listdir(DRIVE_ISP)
                      if os.path.isdir(os.path.join(DRIVE_ISP, d)) and d.lower() == label.lower()), None)
        dest = os.path.join(DRIVE_ISP, match or label)
        os.makedirs(dest, exist_ok=True)
        return dest
    return outdir


DRIVE_IDS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'isp-drive-ids.json')


def _drive_id(path):
    import subprocess
    r = subprocess.run(['xattr', '-p', 'com.google.drivefs.item-id#S', path],
                       capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def shared_file_ok(path, label):
    """The ISP holds a link to ONE Drive file. Sep 14 2026 two runs a minute apart
    wrote while Drive was still uploading, Drive split every workbook into
    "<name>.xlsx" (new, unshared) and "<name> 2.xlsx" (the shared original, frozen),
    and the ISPs silently stopped getting updates. data/isp-drive-ids.json pins the
    shared file's Drive id; writing to any other file is refused so the run goes red."""
    if DRIVE_ISP not in path:
        return True
    try: pinned = json.load(open(DRIVE_IDS)).get(label)
    except FileNotFoundError: pinned = None
    base, ext = os.path.splitext(path)
    twin = f'{base} 2{ext}'
    if os.path.exists(twin):
        print(f'  SPLIT     {label}: Drive made a second copy ({os.path.basename(twin)}). '
              f'The ISP is on one of the two. Merge before writing, nothing saved.')
        return False
    if pinned and os.path.exists(path) and _drive_id(path) != pinned:
        print(f'  SPLIT     {label}: {os.path.basename(path)} is Drive file {_drive_id(path)}, '
              f'the shared one is {pinned}. Nothing saved.')
        return False
    return True


def _saved(path):
    # Reveal in Finder only when someone is at the keyboard. The launchd runner
    # (run-isp-export.sh) has no terminal, and seven Finder windows every
    # morning is not a status report.
    try:
        import subprocess
        if sys.stdout.isatty():
            subprocess.run(['open', '-R', path], check=False)
    except Exception:
        pass
    print(f'  saved     {path}')
    print( '  Drive     ' + ('syncing now' if DRIVE_ISP in path else 'NOT synced, local only'))


def weekly_packet(outdir, label, sel, sun, sat):
    """NO LONGER CALLED. The week-tab workbook (weekly_isp) carries each week as
    its own tab, so this file was the same numbers a second time. Kept because
    the dated files it wrote are still on Drive and this is what built them.

    The week's report on its own: only the doors knocked between sun and sat.

    One dated file per week (Grow_<ISP> Knocking Data - (6_21-6_27).xlsx) that
    never gets touched again, next to the continuous workbook that does. Summary
    is all formulas over the Leads tab, same as the continuous file, so the ISP
    can check any number by filtering.
    """
    import openpyxl
    from openpyxl.styles import Font, PatternFill, Border, Side
    from openpyxl.utils import get_column_letter

    ARIAL = Font(name='Arial')
    BOLD = Font(name='Arial', bold=True)
    HEAD_FILL = PatternFill('solid', fgColor='9FC5E8')
    thin = Side(style='thin', color='999999')
    BOX = Border(left=thin, right=thin, top=thin, bottom=thin)

    ids = {d['lead_id'] for d in sel}
    allk = load_knocks(ids)
    vacant = {k['lead_id'] for k in allk if k['new_stage'] in VACANT}
    vacant |= {d['lead_id'] for d in sel if d['current_stage'] in VACANT}
    live = [k for k in allk if k['lead_id'] not in vacant]
    week = [k for k in live if sun <= k['datetime'][:10] <= sat]
    if not week:
        print(f'  {label}: nothing knocked {sun}..{sat}, no weekly file'); return None

    city_of = {d['lead_id']: (d['city'].strip().title() or 'Unknown') for d in sel}
    street_of = {d['lead_id']: d['street'] for d in sel}
    zip_of = {d['lead_id']: d['zip'] for d in sel}
    sectors = sectors_for(label, sel)
    sector_of = {}
    if sectors:
        for d in sel:
            sector_of[d['lead_id']] = sectors.get((_skey(d['street']), d['zip'][:5]), '(no sector)')

    wb = openpyxl.Workbook(); del wb['Sheet']
    log = wb.create_sheet('Summary')
    lead_ws = wb.create_sheet('Leads')

    lead_cols = (['Knocked By', 'City'] + (['Sector'] if sectors else [])
                 + ['Address', 'Zip', 'Outcome', 'Knocked On'])
    LC = {v: get_column_letter(i) for i, v in enumerate(lead_cols, 1)}
    for i, v in enumerate(lead_cols, 1):
        c = lead_ws.cell(1, i, v); c.font = BOLD; c.fill = HEAD_FILL; c.border = BOX

    # One row per door: the LAST disposition of the week, which is what shows in
    # SalesRabbit and what the ISP-side tracking reconciles against.
    per = collections.defaultdict(list)
    for k in week:
        per[k['lead_id']].append((k['datetime'], k['new_stage']))
    for lid, v in sorted(per.items(), key=lambda x: (city_of.get(x[0], ''), street_of.get(x[0], ''))):
        last = sorted(v)[-1]
        row = (['Grow', city_of.get(lid, 'Unknown')]
               + ([sector_of.get(lid, '(no sector)')] if sectors else [])
               + [street_of.get(lid, ''), zip_of.get(lid, ''),
                  last[1], _d(last[0][:10])])
        lead_ws.append(row)
        for c in lead_ws[lead_ws.max_row]: c.font = ARIAL
    date_col = lead_cols.index('Knocked On') + 1
    for r in range(2, lead_ws.max_row + 1):
        lead_ws.cell(r, date_col).number_format = 'yyyy-mm-dd'
    lead_ws.freeze_panes = 'A2'
    autosize(lead_ws)

    lead_col = lambda name: f'Leads!${LC[name]}:${LC[name]}'
    P_CITY, P_OUT = lead_col('City'), lead_col('Outcome')
    P_SEC = lead_col('Sector') if sectors else None
    CLIST = '","'.join(sorted(CONTACT))

    def metric_row(r, c0, f):
        L = lambda n: get_column_letter(c0 + n)
        log.cell(r, c0 + 0, f'=COUNTIFS({f})')
        log.cell(r, c0 + 1, f'=SUMPRODUCT(COUNTIFS({f},{P_OUT},{{"{CLIST}"}}))')
        log.cell(r, c0 + 2, f'=IFERROR({L(1)}{r}/{L(0)}{r},0)')
        log.cell(r, c0 + 3, f'=COUNTIFS({f},{P_OUT},"Sold")')
        log.cell(r, c0 + 4, f'=IFERROR({L(3)}{r}/{L(1)}{r},0)')
        for i in (2, 4):
            log.cell(r, c0 + i).number_format = '0.0%'

    c = log.cell(1, 2, f'{label} week of {sun} to {sat}')
    c.font = Font(name='Arial', bold=True, size=12)
    heads = ['City', 'Doors Knocked', 'People Contacted', 'Contact Rate',
             'People Sold', 'Close Rate']
    for i, v in enumerate(heads, 2):
        c = log.cell(3, i, v); c.font = BOLD; c.fill = HEAD_FILL; c.border = BOX
    for city in sorted({city_of.get(lid, 'Unknown') for lid in per},
                       key=lambda ct: -sum(1 for lid in per if city_of.get(lid, 'Unknown') == ct)):
        r = log.max_row + 1
        log.cell(r, 2, city)
        metric_row(r, 3, f'{P_CITY},"{city}"')
        for c in log[r]:
            c.font = ARIAL
            if c.column > 1: c.border = BOX
    first_city_r, last_city_r = 4, log.max_row
    r = log.max_row + 1
    log.cell(r, 2, 'TOTAL')
    for col in (3, 4, 6):
        L = get_column_letter(col)
        log.cell(r, col, f'=SUM({L}{first_city_r}:{L}{last_city_r})')
    log.cell(r, 5, f'=IFERROR(D{r}/C{r},0)').number_format = '0.0%'
    log.cell(r, 7, f'=IFERROR(F{r}/D{r},0)').number_format = '0.0%'
    for c in log[r]:
        c.font = BOLD
        if c.column > 1: c.border = BOX

    if sectors:
        pairs = sorted({(city_of.get(lid, 'Unknown'), sector_of.get(lid, '(no sector)')) for lid in per})
        at = log.max_row + 3
        for i, v in enumerate(['Sector', 'City'] + heads[1:], 2):
            c = log.cell(at, i, v); c.font = BOLD; c.fill = HEAD_FILL; c.border = BOX
        for city, sec in pairs:
            r = log.max_row + 1
            log.cell(r, 2, sec)
            log.cell(r, 3, city)
            metric_row(r, 4, f'{P_SEC},"{sec}",{P_CITY},"{city}"')
            for c in log[r]:
                c.font = ARIAL
                if c.column > 1: c.border = BOX
    log.freeze_panes = 'B4'
    autosize(log)

    d0, d1 = _d(sun), _d(sat)
    fname = f'Grow_{label} Knocking Data - ({d0.month}_{d0.day}-{d1.month}_{d1.day}).xlsx'
    path = os.path.join(isp_dest(outdir, label), fname)
    if not shared_file_ok(path, label):
        return
    wb.save(path)
    sold_wk = sum(1 for v in per.values() if sorted(v)[-1][1] == 'Sold')
    print(f'  {label}: weekly {sun}..{sat} — {len(per):,} doors, {sold_wk} sold')
    _saved(path)
    return path


def weekly_isp(outdir, label, sel):
    """One permanent workbook per ISP, built around WEEKS.

        Summary    a row per week worked, then the all-time table for the unit
                   this ISP builds in (its sectors, or its towns) with a TOTAL
        <week>     one tab per week, newest first, the most recent KEEP_TABS:
                   that week's unit block and TOTAL, then that week's doors

    A door appears once per week, carrying that week's LAST disposition — the
    same rule weekly_packet uses, so the dated file and this workbook agree door
    for door. That was not true of the old per-PASS layout: a push that straddled
    a Sunday counted into one pass here and two weeks there.

    Each week tab's block is COUNTIFS over the door rows on its OWN sheet, so a
    week still recalculates when the ISP filters or edits it. The Summary spans
    weeks that no longer have a tab, so it carries computed values.

    Rebuilt from scratch every run rather than appended to, so a late-arriving
    disposition corrects the history instead of leaving a stale row behind.
    """
    import openpyxl
    from openpyxl.styles import Font, PatternFill, Border, Side
    from openpyxl.utils import get_column_letter

    ARIAL = Font(name='Arial'); BOLD = Font(name='Arial', bold=True)
    HEAD_FILL = PatternFill('solid', fgColor='9FC5E8')
    TOT_FILL = PatternFill('solid', fgColor='CFE2F3')
    thin = Side(style='thin', color='999999')
    BOX = Border(left=thin, right=thin, top=thin, bottom=thin)

    ids = {d['lead_id'] for d in sel}
    allk = load_knocks(ids)
    if not allk:
        print(f'  {label}: no knocking on record'); return None

    vacant = {k['lead_id'] for k in allk if k['new_stage'] in VACANT}
    vacant |= {d['lead_id'] for d in sel if d['current_stage'] in VACANT}
    live = [k for k in allk if k['lead_id'] not in vacant]

    city_of = {d['lead_id']: (d['city'].strip().title() or 'Unknown') for d in sel}
    street_of = {d['lead_id']: d['street'] for d in sel}
    zip_of = {d['lead_id']: d['zip'] for d in sel}

    sectors = sectors_for(label, sel)
    sector_of = {}
    if sectors:
        for d in sel:
            sector_of[d['lead_id']] = sectors.get((_skey(d['street']), d['zip'][:5]), '(no sector)')
    UNIT = 'Sector' if sectors else 'City'
    unit_of = ((lambda lid: sector_of.get(lid, '(no sector)')) if sectors
               else (lambda lid: city_of.get(lid, 'Unknown')))

    by_week = collections.defaultdict(lambda: collections.defaultdict(list))
    for k in live:
        by_week[week_sunday(k['datetime'][:10])][k['lead_id']].append((k['datetime'], k['new_stage']))
    weeks = sorted(by_week)
    CLIST = '","'.join(sorted(CONTACT))

    week_rows, wmeta, seen = {}, [], set()
    for sun in weeks:
        per = by_week[sun]
        rows = []
        for lid, v in sorted(per.items(), key=lambda x: (city_of.get(x[0], ''), street_of.get(x[0], ''))):
            last = sorted(v)[-1]
            rows.append({'_lid': lid, '_unit': unit_of(lid), 'Address': street_of.get(lid, ''),
                         'City': city_of.get(lid, 'Unknown'), 'Sector': sector_of.get(lid, '(no sector)'),
                         'Zip': zip_of.get(lid, ''), 'Outcome': last[1], 'Knocked On': _d(last[0][:10])})
        week_rows[sun] = rows
        new_n = len(set(per) - seen); seen |= set(per)
        wmeta.append({'sun': sun, 'doors': len(rows), 'new': new_n,
                      'contact': sum(1 for r in rows if r['Outcome'] in CONTACT),
                      'sold': sum(1 for r in rows if r['Outcome'] == 'Sold')})

    wb = openpyxl.Workbook(); del wb['Sheet']
    log = wb.create_sheet('Summary')
    used = set()
    week_tabs = {sun: wb.create_sheet(week_tabname(sun, used)) for sun in reversed(weeks[-KEEP_TABS:])}

    def pct(ws, r, cols):
        for c in cols: ws.cell(r, c).number_format = '0.0%'

    def style(ws, r, fill=None):
        for c in ws[r]:
            c.font = BOLD if fill else ARIAL
            if c.column > 1: c.border = BOX
            if fill: c.fill = fill

    # ---- Summary: a row per week. No TOTAL line: summing Doors Knocked down
    # the weeks counts a door once per week it was worked, which is not a door
    # count anyone would want to read as one.
    heads = ['Week Of', 'From', 'To', 'Doors Knocked', 'New Doors', 'Repeat Doors',
             'People Contacted', 'Contact Rate', 'People Sold', 'Close Rate', 'Penetration Lift']
    for i, v in enumerate(heads, 2):
        c = log.cell(1, i, v); c.font = BOLD; c.fill = HEAD_FILL; c.border = BOX
    for m in wmeta:
        r = log.max_row + 1
        a = dt.date(*map(int, m['sun'].split('-')))
        log.cell(r, 2, week_label(m['sun']))
        log.cell(r, 3, a).number_format = 'yyyy-mm-dd'
        log.cell(r, 4, a + dt.timedelta(days=6)).number_format = 'yyyy-mm-dd'
        log.cell(r, 5, m['doors']); log.cell(r, 6, m['new']); log.cell(r, 7, m['doors'] - m['new'])
        log.cell(r, 8, m['contact'])
        log.cell(r, 9, f'=IFERROR(H{r}/E{r},0)')
        log.cell(r, 10, m['sold'])
        log.cell(r, 11, f'=IFERROR(J{r}/H{r},0)')
        log.cell(r, 12, f'=IFERROR(J{r}/E{r},0)')
        style(log, r); pct(log, r, (9, 11, 12))

    # ---- Summary: the all-time table for the unit this ISP builds in. Doors
    # dedupe to unique addresses; contacts and sales are door-weeks, so a town
    # worked repeatedly can read above 100% contact rate. Same as it always has.
    u_doors = collections.defaultdict(set); u_weeks = collections.defaultdict(set)
    u_contact = collections.Counter(); u_sold = collections.Counter()
    u_first, u_last = {}, {}
    for sun in weeks:
        for row in week_rows[sun]:
            u = row['_unit']
            u_doors[u].add(row['_lid']); u_weeks[u].add(sun)
            if row['Outcome'] in CONTACT: u_contact[u] += 1
            if row['Outcome'] == 'Sold': u_sold[u] += 1
            d = row['Knocked On']
            if d:
                u_first[u] = min(u_first.get(u, d), d); u_last[u] = max(u_last.get(u, d), d)
    # Total Doors is opt-in per ISP ("total_doors": true in data/isps.json):
    # every non-vacant door we hold for that unit, knocked or not, so the ISP
    # can read how much of each area has been worked.
    try: show_total = bool(json.load(open(ISPS)).get(label, {}).get('total_doors'))
    except Exception: show_total = False
    u_total = collections.Counter(unit_of(d['lead_id']) for d in sel if d['lead_id'] not in vacant)
    at = log.max_row + 3
    heads = ([UNIT] + (['Total Doors'] if show_total else []) + ['Doors Knocked']
             + (['Doors Knocked Rate'] if show_total else [])
             + ['People Contacted', 'Contact Rate', 'People Sold', 'Close Rate', 'Penetration Lift',
                'Weeks Worked', 'First Knock', 'Last Knock'])
    col = {h: i for i, h in enumerate(heads, 2)}
    L = {h: get_column_letter(i) for h, i in col.items()}
    for h, i in col.items():
        c = log.cell(at, i, h); c.font = BOLD; c.fill = HEAD_FILL; c.border = BOX
    rates = [h for h in heads if h.endswith('Rate') or h == 'Penetration Lift']

    def rate_cells(r):
        K, C, S = L['Doors Knocked'], L['People Contacted'], L['People Sold']
        if show_total:
            log.cell(r, col['Doors Knocked Rate'], f"=IFERROR({K}{r}/{L['Total Doors']}{r},0)")
        log.cell(r, col['Contact Rate'], f'=IFERROR({C}{r}/{K}{r},0)')
        log.cell(r, col['Close Rate'], f'=IFERROR({S}{r}/{C}{r},0)')
        log.cell(r, col['Penetration Lift'], f'=IFERROR({S}{r}/{K}{r},0)')

    ufirst = log.max_row + 1
    for u in sorted(u_doors, key=lambda x: (x == '(no sector)', -len(u_doors[x]))):
        r = log.max_row + 1
        log.cell(r, col[UNIT], u)
        if show_total: log.cell(r, col['Total Doors'], max(u_total[u], len(u_doors[u])))
        log.cell(r, col['Doors Knocked'], len(u_doors[u]))
        log.cell(r, col['People Contacted'], u_contact[u])
        log.cell(r, col['People Sold'], u_sold[u])
        log.cell(r, col['Weeks Worked'], len(u_weeks[u]))
        log.cell(r, col['First Knock'], u_first.get(u)).number_format = 'yyyy-mm-dd'
        log.cell(r, col['Last Knock'], u_last.get(u)).number_format = 'yyyy-mm-dd'
        rate_cells(r)
        style(log, r); pct(log, r, [col[h] for h in rates])
    r = log.max_row + 1
    ulast = r - 1
    log.cell(r, col[UNIT], 'TOTAL')
    for h in ['Doors Knocked', 'People Contacted', 'People Sold'] + (['Total Doors'] if show_total else []):
        log.cell(r, col[h], f'=SUM({L[h]}{ufirst}:{L[h]}{ulast})')
    rate_cells(r)
    log.cell(r, col['Weeks Worked'], len(weeks))
    style(log, r, TOT_FILL); pct(log, r, [col[h] for h in rates])
    log.freeze_panes = 'B2'; autosize(log); lock_sheet(log)

    # ---- One tab per week.
    door_cols = ['Address', 'City'] + (['Sector'] if sectors else []) + ['Zip', 'Outcome', 'Knocked On']
    UCOL = get_column_letter(door_cols.index(UNIT) + 1)
    OCOL = get_column_letter(door_cols.index('Outcome') + 1)

    for sun, ws in week_tabs.items():
        rows = week_rows[sun]
        units = sorted({r['_unit'] for r in rows}, key=unit_sort)
        n = len(units)
        # Laid out before anything is written, so the block above can address the
        # doors below on this same sheet.
        total_r = 2 + n
        dhdr = total_r + 3
        dfirst, dlast = dhdr + 1, dhdr + len(rows)
        UR = f'${UCOL}${dfirst}:${UCOL}${dlast}'
        OR_ = f'${OCOL}${dfirst}:${OCOL}${dlast}'

        for i, v in enumerate([UNIT, 'Doors Knocked', 'People Contacted', 'Contact Rate',
                               'People Sold', 'Close Rate', 'Penetration Lift'], 1):
            c = ws.cell(1, i, v); c.font = BOLD; c.fill = HEAD_FILL; c.border = BOX
        for j, u in enumerate(units):
            r = 2 + j; U = f'"{u}"'
            ws.cell(r, 1, u)
            ws.cell(r, 2, f'=COUNTIFS({UR},{U})')
            ws.cell(r, 3, f'=SUMPRODUCT(COUNTIFS({UR},{U},{OR_},{{"{CLIST}"}}))')
            ws.cell(r, 4, f'=IFERROR(C{r}/B{r},0)')
            ws.cell(r, 5, f'=COUNTIFS({UR},{U},{OR_},"Sold")')
            ws.cell(r, 6, f'=IFERROR(E{r}/C{r},0)')
            ws.cell(r, 7, f'=IFERROR(E{r}/B{r},0)')
            style(ws, r); pct(ws, r, (4, 6, 7))
        ws.cell(total_r, 1, 'TOTAL')
        for col in (2, 3, 5):
            L = get_column_letter(col)
            ws.cell(total_r, col, f'=SUM({L}2:{L}{total_r - 1})')
        ws.cell(total_r, 4, f'=IFERROR(C{total_r}/B{total_r},0)')
        ws.cell(total_r, 6, f'=IFERROR(E{total_r}/C{total_r},0)')
        ws.cell(total_r, 7, f'=IFERROR(E{total_r}/B{total_r},0)')
        style(ws, total_r, TOT_FILL); pct(ws, total_r, (4, 6, 7))

        for i, v in enumerate(door_cols, 1):
            c = ws.cell(dhdr, i, v); c.font = BOLD; c.fill = HEAD_FILL; c.border = BOX
        for j, lr in enumerate(sorted(rows, key=lambda x: (x['City'], x['Address']))):
            rr = dfirst + j
            for i, v in enumerate(door_cols, 1):
                cc = ws.cell(rr, i, lr[v]); cc.font = ARIAL
            ws.cell(rr, door_cols.index('Knocked On') + 1).number_format = 'yyyy-mm-dd'
        ws.freeze_panes = 'A2'; autosize(ws); lock_sheet(ws)

    # Tabs cannot be added, renamed or deleted either, so the week series stays
    # the week series.
    from openpyxl.workbook.protection import WorkbookProtection
    _pw = os.environ.get('ISP_SHEET_PASSWORD')
    wb.security = WorkbookProtection(lockStructure=True,
                                     **({'workbookPassword': _pw} if _pw else {}))

    fname = f'Grow & {label} Knocking Data.xlsx'
    path = os.path.join(isp_dest(outdir, label), fname)
    if not shared_file_ok(path, label):
        return
    wb.save(path)

    sold_all = len({r['_lid'] for s in weeks for r in week_rows[s] if r['Outcome'] == 'Sold'})
    print(f'  {label}: {len(weeks)} weeks ({len(week_tabs)} as tabs), {len(seen):,} doors worked '
          f'all time, {sold_all:,} sold')
    if sectors:
        gap_n = sum(1 for lid in seen if sector_of.get(lid) == '(no sector)')
        if gap_n:
            print(f'  {label}: {gap_n:,} knocked doors have no sector in their files '
                  f'("(no sector)" at the bottom of each block)')
    _saved(path)
    return path



if __name__ == '__main__':
    main()
