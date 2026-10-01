#!/usr/bin/env python3
# Fill in the cities the install report never carries (i3: 100% blank, SLIC:
# ~half) by joining each deal's street address against the SalesRabbit crawl's
# address book (data/sr-doors-by-area.csv — street, city, state for every
# imported lead). ~98% of blank-city i3 deals match.
#
# Writes report_config.__city_overlay__ = { "STATE|STREET KEY": "CITY" } for
# exactly the keys today's blank-city deals need. The dashboard applies it at
# load time, so the deals table itself is never touched (the sheet sync would
# wipe it anyway). Re-run after big lead imports; it is idempotent.
#
#   python3 scripts/city-overlay.py           # build + write
#   python3 scripts/city-overlay.py --dry     # just report

import csv, json, re, ssl, sys, urllib.request

SB = 'https://cmkfohwbejcztctrpdnt.supabase.co'
ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNta2ZvaHdiZWpjenRjdHJwZG50Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyNDYyODgsImV4cCI6MjA5NzgyMjI4OH0.waLa5E9a6SMvJ70keY9duAz4VxK39sDNNbmPSSbcebo'
CSV = 'data/sr-doors-by-area.csv'

SUF = {'DRIVE':'DR','STREET':'ST','AVENUE':'AVE','COURT':'CT','ROAD':'RD','LANE':'LN',
       'CIRCLE':'CIR','PLACE':'PL','BOULEVARD':'BLVD','TRAIL':'TRL','TERRACE':'TER',
       'HIGHWAY':'HWY','PARKWAY':'PKWY'}
def norm(s): return re.sub(r'\s+',' ',re.sub(r'[^A-Z0-9 ]',' ',str(s or '').upper())).strip()
def key(street, state):
    toks = [SUF.get(w, w) for w in norm(street).split(' ')]
    return norm(state) + '|' + ' '.join(toks)

def http(url, body=None, prefer=None):
    hdrs = {'apikey': ANON, 'Authorization': 'Bearer ' + ANON, 'Content-Type': 'application/json'}
    if prefer: hdrs['Prefer'] = prefer
    req = urllib.request.Request(url, data=body, method='POST' if body else 'GET', headers=hdrs)
    ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
    with urllib.request.urlopen(req, context=ctx) as r: return r.read()

def main():
    dry = '--dry' in sys.argv
    lut, amb = {}, set()
    with open(CSV) as f:
        for r in csv.DictReader(f):
            st, ct, sta = (r.get('street') or '').strip(), (r.get('city') or '').strip(), (r.get('state') or '').strip()
            if not st or not ct or not sta: continue
            k, c = key(st, sta), ct.upper()
            if k in lut and lut[k] != c: amb.add(k)
            else: lut[k] = c
    for k in amb: lut.pop(k, None)
    print(f'address book: {len(lut):,} streets ({len(amb):,} ambiguous dropped)')

    # every blank-city deal with an address, all time (paginated)
    deals, off = [], 0
    while True:
        page = json.loads(http(SB + f"/rest/v1/deals?select=address,state,city&or=(city.is.null,city.eq.)&limit=10000&offset={off}"))
        deals += page
        if len(page) < 10000: break
        off += 10000
    need, overlay, miss = 0, {}, 0
    for d in deals:
        a = (d.get('address') or '').strip()
        if not a: continue
        need += 1
        k = key(a, d.get('state') or '')
        if k in lut: overlay[k] = lut[k]
        else: miss += 1
    print(f'blank-city deals with an address: {need:,} | matched streets: {len(overlay):,} | unmatched: {miss:,}')
    if dry: print('Dry run — nothing written.'); return
    body = json.dumps({'manager': '__city_overlay__', 'config': {'map': overlay}}).encode()
    http(SB + '/rest/v1/report_config?on_conflict=manager', body, 'resolution=merge-duplicates')
    print('Overlay written. The dashboard fills those cities on next load.')

if __name__ == '__main__':
    main()
