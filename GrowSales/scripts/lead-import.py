#!/usr/bin/env python3
"""Turn an ISP address file into a SalesRabbit import, deduped against the crawl.

    python3 scripts/lead-import.py ~/Downloads/"Kingsbury & Fort Edward.xlsx" --assign "Nick Boyd"
    python3 scripts/lead-import.py file.xlsx --assign "Nick Boyd" --notes "Kingsbury July 28"

Reads the source workbook (or CSV), finds the address columns by name, drops
in-file duplicates, then checks every address against data/sr-doors-by-area.csv
— the full crawl of SalesRabbit, not an export — and writes two files next to
the source:

    SR <name> - <assignee>.xlsx    only the NEW addresses, in the import template
    <name> - dupes.xlsx            everything already in SalesRabbit, with its
                                   current stage, knock count and last knock

Run scripts/grow-sync.mjs first so the dedupe is against today's SalesRabbit.
Assignee emails come from data/rep-emails.json (grow-sync maintains it).
"""

import argparse, collections, csv, json, os, re, sys, datetime as dt

csv.field_size_limit(10 ** 7)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOORS = os.path.join(ROOT, 'data', 'sr-doors-by-area.csv')
EMAILS = os.path.join(ROOT, 'data', 'rep-emails.json')

SUF = {'ROAD': 'RD', 'STREET': 'ST', 'AVENUE': 'AVE', 'AV': 'AVE', 'DRIVE': 'DR', 'LANE': 'LN', 'COURT': 'CT',
       'PLACE': 'PL', 'BOULEVARD': 'BLVD', 'CIRCLE': 'CIR', 'TERRACE': 'TER', 'PARKWAY': 'PKWY', 'HIGHWAY': 'HWY',
       'TRAIL': 'TRL', 'SQUARE': 'SQ', 'EXTENSION': 'EXT', 'NORTH': 'N', 'SOUTH': 'S', 'EAST': 'E', 'WEST': 'W',
       'ROUTE': 'RTE', 'RT': 'RTE', 'COUNTY': 'CO', 'APARTMENT': 'APT', 'UNIT': 'APT', 'SUITE': 'STE', 'FLOOR': 'FL'}


def norm(s):
    return ' '.join(SUF.get(w, w) for w in re.sub(r'[^A-Z0-9 ]', ' ', (s or '').upper()).split())


def base(street):
    return re.sub(r'\s+(APT|STE|FL)\s+\S+$', '', norm(street))


UNIT_TAIL = re.compile(r'\s+((?:apartment|apt\.?|unit|suite|ste\.?|fl\.?|#)\s*[A-Za-z0-9-]{1,6})$', re.I)


def split_unit(street):
    """Pull a trailing 'Apartment 2' off a street that carries its own unit.

    ISP files often ship one address column with the unit glued on. The dedupe
    key never cared, but SalesRabbit wants the unit in its own column.
    """
    m = UNIT_TAIL.search(street)
    return (street[:m.start()].strip(), m.group(1).strip()) if m else (street, '')


def unit_of(street, unit):
    u = norm(unit)
    if not u:
        m = re.search(r'\s(APT|STE|FL)\s+\S+$', norm(street))
        if m:
            u = m.group(0).strip()
    return re.sub(r'^(APT|STE|FL)\s+', '', u)


def read_source(path):
    """Rows as dicts, whether the source is xlsx or csv."""
    if path.lower().endswith(('.xlsx', '.xlsm')):
        import openpyxl
        ws = openpyxl.load_workbook(path, data_only=True).active
        rows = [[('' if v is None else str(v).strip()) for v in r] for r in ws.iter_rows(values_only=True)]
    else:
        with open(path, newline='', encoding='utf-8-sig') as f:
            rows = [[c.strip() for c in r] for r in csv.reader(f)]
    rows = [r for r in rows if any(r)]
    hdr = rows[0]
    return [dict(zip(hdr, r)) for r in rows[1:]]


def find_col(hdr, *pats):
    for p in pats:
        for h in hdr:
            if re.search(p, h, re.I):
                return h
    return None


def main():
    p = argparse.ArgumentParser()
    p.add_argument('source')
    p.add_argument('--assign', required=True, help='rep display name, e.g. "Nick Boyd"')
    p.add_argument('--email', help='override the rep email if the lookup lacks it')
    p.add_argument('--notes', default='', help='Notes column value for every row')
    p.add_argument('--notes-from', help='source column to copy into Notes per row, e.g. Sector. '
                                        'Combined with --notes as "<notes> <value>".')
    p.add_argument('--name', help='label for the output files (default: source filename)')
    p.add_argument('--country', default='United States', help='Country column value for every row')
    p.add_argument('--fill-zip-from-city', action='store_true',
                   help="fill a blank zip from the zip other rows in the same city carry. ISPs ship "
                        "files with the zip column half empty; without a zip a row is dropped, so a "
                        "whole town can vanish silently. Only fills when that city has exactly one zip "
                        "in the file; anything ambiguous stays blank and is reported.")
    p.add_argument('--status-from', help='source column holding the SalesRabbit stage per row. '
                                         'Rows with a blank value fall back to New Lead.')
    args = p.parse_args()

    rep = args.assign.strip()
    email = args.email
    if not email:
        emails = json.load(open(EMAILS)) if os.path.exists(EMAILS) else {}
        email = emails.get(rep) or next((v for k, v in emails.items() if k.lower() == rep.lower()), None)
    if not email:
        sys.exit(f'No email on file for "{rep}". Pass --email, or run grow-sync to refresh data/rep-emails.json.')

    src = read_source(args.source)
    hdr = list(src[0].keys())
    c_street = find_col(hdr, r'^address_label$', r'^street1?$', r'^address1?$')
    # Some ISPs ship the house number in its own column. Without this the street
    # name alone becomes the dedupe key and every door on a street collapses to one.
    c_streetnum = find_col(hdr, r'^street\s*(number|num|no|#)$', r'^house\s*(number|num|no|#)$',
                           r'^(addr(ess)?\s*)?(number|num)$')
    c_unit = find_col(hdr, r'apt|suite|unit|street2', r'^address2$')
    c_city = find_col(hdr, r'^city$')
    c_state = find_col(hdr, r'^state$|state/region|state/province|^province$|^region$')
    c_zip = find_col(hdr, r'zip|postal')
    c_lat = find_col(hdr, r'^lat')
    c_lng = find_col(hdr, r'^lon|^lng')
    if not (c_street and c_zip):
        sys.exit(f'Could not find address columns. Headers: {hdr}')
    c_status = None
    if args.status_from:
        c_status = find_col(hdr, rf'^{re.escape(args.status_from)}$') or args.status_from
        if c_status not in hdr:
            sys.exit(f'--status-from "{args.status_from}" is not a column. Headers: {hdr}')
    # A yes/no customer flag (SLIC ships one as "Customer") means those doors go in
    # the SAME import as Current Customer, never split into a second file or left
    # out. Sep 2026: 1,632 Washington County customer doors were split off and the
    # second file never got uploaded. --status-from still wins when given.
    c_cust = None if c_status else find_col(hdr, r'^(existing|current)?\s*cust(omer)?\s*(\?|flag|y/n)?$',
                                              r'^is[_ ]?customer$', r'^subscriber$')
    c_note = None
    if args.notes_from:
        c_note = find_col(hdr, rf'^{re.escape(args.notes_from)}$') or args.notes_from
        if c_note not in hdr:
            sys.exit(f'--notes-from "{args.notes_from}" is not a column. Headers: {hdr}')

    # Index of everything already in SalesRabbit, by normalised street+unit+zip.
    if not os.path.exists(DOORS):
        sys.exit(f'Missing {DOORS}. Run grow-sync first.')
    existing = {}
    with open(DOORS, newline='') as f:
        for r in csv.DictReader(f):
            existing.setdefault((base(r['street']), unit_of(r['street'], r['unit']), r['zip'][:5]), r)

    # A blank zip drops the row (no dedupe key without one), and ISP files often
    # ship a town's worth of blanks. Learn each city's zip from the rows that do
    # carry one so those doors can be recovered instead of disappearing.
    city_zip = {}
    if args.fill_zip_from_city and c_city:
        z_by_city = collections.defaultdict(collections.Counter)
        for r in src:
            z = re.sub(r'\.0$', '', (r.get(c_zip) or '').strip())[:5]
            city = (r.get(c_city) or '').strip().title()
            if city and re.match(r'^\d{5}$', z):
                z_by_city[city][z] += 1
        for city, cnt in z_by_city.items():
            if len(cnt) == 1:
                city_zip[city] = next(iter(cnt))
            else:
                top, n = cnt.most_common(1)[0]
                # one stray typo among hundreds is not a second real zip
                if n / sum(cnt.values()) >= 0.9:
                    city_zip[city] = top

    new, dupes, seen, infile = [], [], set(), 0
    skipped = collections.Counter()
    filled = collections.Counter()
    for r in src:
        street = r.get(c_street, '').strip()
        if c_streetnum:
            num = re.sub(r'\.0$', '', r.get(c_streetnum, '').strip())
            if num and not street.upper().startswith(num.upper() + ' '):
                street = f'{num} {street}'.strip()
        unit = r.get(c_unit, '').strip() if c_unit else ''
        # only a unit that stands on its own ("MAIN ST 4", "MAIN ST #4"); a bare
        # endswith turned "COUNTY RD 3331" unit 1 into "COUNTY RD 333"
        m = unit and re.search(r'(?:\s|#)\s*' + re.escape(unit) + r'$', street, re.I)
        if m:
            street = street[:m.start()].strip()
        if not unit:
            street, unit = split_unit(street)
        postal = re.sub(r'\.0$', '', r.get(c_zip, '').strip())
        if re.match(r'^\d{5}', postal):
            postal = postal[:5]      # US, drop any ZIP+4
        zip5 = postal[:5]            # key only — Canadian postals are 6 chars and must reach the output whole
        row_city = (r.get(c_city) or '').strip().title() if c_city else ''
        if not zip5 and row_city in city_zip:
            postal = zip5 = city_zip[row_city]
            filled[row_city] += 1
        if not street or not zip5:
            skipped[(row_city or '(no city)', 'no street' if not street else 'no zip')] += 1
            continue
        k = (base(street), unit_of(street, unit), zip5)
        if k in seen:
            infile += 1
            continue
        seen.add(k)
        row = {'street': street, 'unit': unit, 'city': r.get(c_city, '').strip() if c_city else '',
               'state': r.get(c_state, '').strip() if c_state else '', 'zip': postal,
               'status': ((r.get(c_status, '') or '').strip() if c_status else '')
                         or ('Current Customer' if c_cust and (r.get(c_cust, '') or '').strip().lower()
                             in ('yes', 'y', 'true', 'x', '1', 'customer', 'current') else '')
                         or 'New Lead',
               'lat': r.get(c_lat, '').strip() if c_lat else '', 'lng': r.get(c_lng, '').strip() if c_lng else '',
               'note': ' '.join(x for x in (args.notes, (r.get(c_note, '') or '').strip() if c_note else '') if x)}
        hit = existing.get(k)
        if hit:
            dupes.append({**row, 'existing_stage': hit['current_stage'], 'knocks': hit['knocks'],
                          'last_knock': hit['last_knock'], 'last_knocked_by': hit['last_knocked_by'],
                          'ever_sold': hit['ever_sold'], 'sr_city': hit['city']})
        else:
            new.append(row)

    import openpyxl
    label = args.name or re.sub(r'\.(xlsx|xlsm|csv)$', '', os.path.basename(args.source), flags=re.I)
    outdir = os.path.dirname(os.path.abspath(args.source))

    HDR = ['Assigned to (email)', 'Assigned to (name)', 'Status', 'Address', 'Apt/Suite', 'City', 'State/Region',
           'Postal Code', 'Country', 'Latitude', 'Longitude', 'Notes', 'Appointment', 'Date Created']
    wb = openpyxl.Workbook(); ws = wb.active
    ws.append(HDR)
    for r in new:
        ws.append([email, rep, r['status'], r['street'], r['unit'], r['city'], r['state'], r['zip'],
                   args.country, r['lat'], r['lng'], r['note'], '', ''])
    imp = os.path.join(outdir, f'SR {label} - {rep}.xlsx')
    wb.save(imp)

    dup_path = ''
    if dupes:
        wb2 = openpyxl.Workbook(); ws2 = wb2.active
        cols = list(dupes[0].keys())
        ws2.append(cols)
        for r in dupes:
            ws2.append([r[c] for c in cols])
        ws2.freeze_panes = 'A2'; ws2.auto_filter.ref = ws2.dimensions
        dup_path = os.path.join(outdir, f'{label} - dupes.xlsx')
        wb2.save(dup_path)

    sold = sum(1 for d in dupes if str(d['ever_sold']) == '1')
    print(f'source rows        {len(src):,}')
    if filled:
        print(f'zip filled by city {sum(filled.values()):,}   ' +
              ', '.join(f'{c} {n:,}' for c, n in filled.most_common()))
    if skipped:
        # Loud on purpose: a silent skip once lost two whole towns out of a file.
        print(f'DROPPED            {sum(skipped.values()):,}  rows with no street or no zip, NOT in the import')
        for (city, why), n in skipped.most_common():
            print(f'  {city:<20} {why:<10} {n:,}')
        if any(why == 'no zip' for (_, why) in skipped):
            print('  -> rerun with --fill-zip-from-city if these towns should be knocked')
    print(f'in-file duplicates {infile:,}')
    print(f'already in SR      {len(dupes):,}' + (f'   (of which {sold} Sold — leave those alone)' if sold else ''))
    print(f'NEW                {len(new):,}')
    if c_cust:
        print(f'Customer flag column "{c_cust}": customer doors are in this file as Current Customer')
    if c_status or c_cust:
        for stage, n in sorted(collections.Counter(r['status'] for r in new).items(), key=lambda x: -x[1]):
            print(f'  {stage:<18} {n:,}')
    print(f'\nimport file: {imp}')
    if dup_path:
        print(f'dupes report: {dup_path}')


if __name__ == '__main__':
    main()
