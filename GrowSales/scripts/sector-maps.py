#!/usr/bin/env python3
"""Sector maps for the GrowSales Maps page (More > ISP Maps).

    python3 scripts/sector-maps.py i3 Lyte          # refresh these and upload
    python3 scripts/sector-maps.py --all            # every ISP that has a map
    python3 scripts/sector-maps.py i3 --no-upload   # build locally only
    python3 scripts/sector-maps.py --no-extract ... # reuse the doors already extracted
    python3 scripts/sector-maps.py --no-extend ...  # skip the new town cut (and its road download)
    python3 scripts/sector-maps.py --no-refresh ... # skip re-reading today's import batches

Two kinds of ISP:
  sends sectors  i3, Lyte: data/sectors/<ISP>.csv (sector-import.py) names the
                 sector of each address. Those sectors are drawn around their doors
                 and rebuilt on every run, so a new sector file shows up on the next
                 refresh. A door the ISP gave no sector joins the sector whose shape
                 holds it; the rest are grouped by town as "<Town> (no sector)".
                 Surf sends areas for some towns only, so its Grow cut is kept as
                 <ISP>-grow-cut.json: a door with no ISP area takes its Grow sector
                 (BRAI 1.2) before it falls to "(no sector)", and that cut still
                 extends itself when a new town is dropped.
  no sectors     SLIC, Surf: the Grow cut frozen by sector-build.py --cut. A drop onto
                 streets already cut lands in the sector that holds it; a new town is
                 cut here by --extend, which never touches a frozen sector.

Each run: sector-build.py --extract (latest crawl), the new town cut, the map
(maps/<isp>/index.html and data.json), then the payload goes to the sector_maps
table, which the site reads. No deploy is needed to refresh a map.
Also writes maps/view.html (the page the site embeds) from scripts/sector-map.html.
"""
import collections, csv, datetime, importlib.util, json, os, re, subprocess, sys

import numpy as np
import shapely
from shapely.geometry import Point

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
SUPA_URL = 'https://cmkfohwbejcztctrpdnt.supabase.co'
SUPA_ANON = ('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNta2ZvaHdiZWpjenRjdHJwZG50Iiwicm9s'
             'ZSI6ImFub24iLCJpYXQiOjE3ODIyNDYyODgsImV4cCI6MjA5NzgyMjI4OH0.waLa5E9a6SMvJ70keY9duAz4VxK39sDNNbmPSSbcebo')
# ISPs the site shows. Lyte is held back until its leftover doors are cut into
# clusters: Lyte's own sectors cover 1,950 of its 42,844 doors.
PUBLISHED = ['i3', 'SLIC', 'Surf', 'TDS']   # TDS: its own SalesRabbit company, crawled by grow-sync.mjs --tenant tds
OSM_TIMEOUT = 1200   # seconds the nightly run gives the road download before moving on

# Talking to the page that frames this map (More > ISP Maps). The frame hands up a
# row per area, rather than the page fetching the same 2 MB a second time, and takes
# an area name back when someone clicks a row in the list beside it.
#
# The map itself handles picking an area (its own panel on the right) and tells the
# page which one is open, so the page's list can follow along.
EMBED = """
const _rows = DATA.map(s => ({name: s.name, city: s.city, zone: s.zone, total: s.total, never: s.never,
  worked: s.worked, rest30: s.rest30, rest90: s.rest90, rest: s.rest, contacts: s.contacts, sold: s.sold,
  // the group hit, not the single freshest knock: one door touched yesterday does not
  // make an area worked. lastN is its ordinal, so the list can sort what it shows.
  last: s.wave ? s.wave.to : '', lastN: s.wave ? s.wave.mid : 0, age: s.wave ? s.wave.age : null,
  from: s.wave ? s.wave.from : '', share: s.wave ? s.wave.share : null,
  passes: s.passes, first: s.first, streets: s.streets || [],
  // the freshest single knock, and how many doors were knocked in the last 4 weeks.
  // Without these, an area where a rep knocked ten doors yesterday still reads as
  // months old, because "days since knocked" is the middle door of the whole area.
  fresh: s.last, lately: (s.weeks || []).slice(-4).reduce((a, b) => a + b, 0),
  weeks: s.weeks || [], recent: s.recent || [], statuses: s.statuses || {}, poly: s.poly || [],
  reps: (s.reps || []).slice().sort((a, b) => b[1] - a[1])}));
if (window.parent !== window)
  try { parent.postMessage({type: 'growSectors', isp: META.isp, rows: _rows,
                            palette: {fresh: FRESH, rest: REST},
                            meta: {doors: META.doors, built: META.built, week0: META.week0}}, '*'); } catch (e) {}
"""


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, 'scripts', file))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


sb = _load('sector_build', 'sector-build.py')
si = _load('sector_import', 'sector-import.py')


# ---------------------------------------------------------------- ISP sectors

def zone_name(sector):
    """The market an ISP sector belongs to: CHMPIL 166 -> CHMPIL, MRTNIL-1 -> MRTNIL,
    TXFRSTAC001.SA02 -> TXFRSTAC001."""
    return re.split(r'[ \-.]', sector, 1)[0]


def outline_groups(xy, owner, eps=250, pad=40):
    """One shape per group of doors that never overlaps another group's shape.

    Each group gets a loose outline around its doors (concave hull + pad, one per
    cluster of doors eps apart), then the space is split by nearest door so two
    groups meet halfway between their houses."""
    from sklearn.cluster import DBSCAN
    by = collections.defaultdict(list)
    for i, o in enumerate(owner):
        by[o].append(i)
    region = {}
    for o, idx in by.items():
        g = xy[idx]
        lab = DBSCAN(eps=eps, min_samples=1).fit_predict(g) if len(g) > 1 else np.zeros(1, dtype=int)
        parts = []
        for l in set(lab.tolist()):
            p = g[lab == l]
            hull = shapely.concave_hull(shapely.multipoints(p), ratio=0.3) if len(p) >= 3 else shapely.multipoints(p)
            parts.append(hull.buffer(pad, join_style='mitre', mitre_limit=2.0))
        region[o] = shapely.union_all(parts)
    uxy, keep = np.unique(np.round(xy, 1), axis=0, return_index=True)
    own = [owner[k] for k in keep.tolist()]
    if len(uxy) >= 3:
        env = shapely.box(*(uxy.min(0) - 3000), *(uxy.max(0) + 3000))
        cells = shapely.get_parts(shapely.voronoi_polygons(shapely.multipoints(uxy), extend_to=env, ordered=True))
    else:
        cells = [shapely.box(*(uxy.min(0) - 3000), *(uxy.max(0) + 3000))] * len(uxy)
    cell_by = collections.defaultdict(list)
    for c, o in zip(cells, own):
        cell_by[o].append(c)
    out = {}
    for o in by:
        if o not in cell_by:
            continue
        g = shapely.make_valid(shapely.union_all(cell_by[o]).intersection(region[o]))
        g = shapely.union_all([p for p in shapely.get_parts(g) if p.geom_type == 'Polygon' and p.area > 200])
        out[o] = g.simplify(4, preserve_topology=True)
    return out


def label_point(g, xy):
    m = Point(float(xy[:, 0].mean()), float(xy[:, 1].mean()))
    if g.is_empty or g.contains(m):
        return m
    return max(shapely.get_parts(g), key=lambda q: q.area).point_on_surface()


GROW_MIN = 20   # fewer doors than this left in a Grow sector: fold them into their neighbours


def grow_fallback(isp):
    """Door id -> Grow sector, and sector -> zone, from <ISP>-grow-cut.json, for the
    towns an ISP sent no sectors for. Doors the cut never listed take the sector whose
    shape holds them, as they would on a Grow map."""
    path = os.path.join(sb.SECTORS, f'{isp}-grow-cut.json')
    if not os.path.exists(path):
        return {}, {}
    g = json.load(open(path))
    of = dict(g['doors'])
    names, geoms = [], []
    for n, sc in g['sectors'].items():
        for poly in sc['poly']:
            names.append(n)
            geoms.append(shapely.Polygon([(b, a) for a, b in poly[0]], [[(b, a) for a, b in r] for r in poly[1:]]))
    tree = shapely.STRtree(geoms) if geoms else None
    for d in json.load(open(os.path.join(sb.CACHE, f'{isp}-doors.json'))):
        if d['id'] not in of and tree is not None:
            hit = tree.query(Point(d['lon'], d['lat']), predicate='within')
            if len(hit):
                of[d['id']] = names[hit[0]]
    return of, {n: sc['zone'] for n, sc in g['sectors'].items()}


def isp_cut(isp):
    """Build <ISP>-cut.json from the ISP's own sector file (not frozen: rebuilt every run)."""
    from sklearn.cluster import DBSCAN
    path = os.path.join(sb.SECTORS, f'{isp}.csv')
    with open(path, newline='') as f:
        m = {(r['street_key'], r['zip']): r['sector'] for r in csv.DictReader(f)}
    doors = json.load(open(os.path.join(sb.CACHE, f'{isp}-doors.json')))
    grow_of, grow_zone = grow_fallback(isp)
    lat = np.array([d['lat'] for d in doors]); lon = np.array([d['lon'] for d in doors])
    # towns far apart are drawn separately, each in its own flat projection
    X = np.c_[lat * 111.0, lon * 111.0 * np.cos(np.radians(lat.mean()))]
    area = DBSCAN(eps=3.0, min_samples=1).fit_predict(X)
    sectors, zones, door_sec = {}, {}, {}
    no_sector_names = collections.Counter()
    matched = inside = loose = grown = 0
    for a in sorted(set(area.tolist())):
        idx = np.where(area == a)[0]
        ds = [doors[i] for i in idx]
        P = sb.Proj(float(lat[idx].mean()), float(lon[idx].mean()))
        dx, dy = P.fwd(lat[idx], lon[idx])
        xy = np.c_[dx, dy]
        own = [m.get((si.street_key(d['street']), d['zip'])) for d in ds]
        have = [i for i, o in enumerate(own) if o]
        matched += len(have)
        if have:
            shapes = outline_groups(xy[have], [own[i] for i in have])
            names = list(shapes)
            tree = shapely.STRtree([shapes[n] for n in names])
            for i, o in enumerate(own):
                if o:
                    continue
                hit = tree.query(Point(xy[i]), predicate='within')
                if len(hit):
                    own[i] = names[hit[0]]; inside += 1
        for i, o in enumerate(own):
            if not o and ds[i]['id'] in grow_of:
                own[i] = grow_of[ds[i]['id']]; grown += 1
        # a Grow sector the ISP's areas swallowed leaves a door or two behind (a house
        # the ISP left off its list). Those join the nearest neighbour's area instead.
        n_own = collections.Counter(own)
        crumbs = [i for i, o in enumerate(own) if o in grow_zone and n_own[o] < GROW_MIN]
        solid = [i for i, o in enumerate(own) if o and i not in set(crumbs)]
        if crumbs and solid:
            near = shapely.STRtree([Point(xy[i]) for i in solid])
            for i in crumbs:
                own[i] = own[solid[int(near.nearest(Point(xy[i])))]]
        # what is still loose is grouped by town, then by clusters of houses 800 m apart
        rest = [i for i, o in enumerate(own) if not o]
        loose += len(rest)
        by_city = collections.defaultdict(list)
        for i in rest:
            by_city[ds[i]['city'] or 'Unknown'].append(i)
        for city, mem in by_city.items():
            lab = DBSCAN(eps=800, min_samples=1).fit_predict(xy[mem]) if len(mem) > 1 else [0]
            for l in sorted(set(lab), key=lambda l: -list(lab).count(l)):
                no_sector_names[city] += 1
                k = no_sector_names[city]
                name = f'{city} (no sector)' + (f' {k}' if k > 1 else '')
                for i, ll in zip(mem, lab):
                    if ll == l:
                        own[i] = name
        # final shapes over everything in this area, so nothing overlaps
        shapes = outline_groups(xy, own)
        for o, g in shapes.items():
            mem = [i for i, x in enumerate(own) if x == o]
            lp = label_point(g, xy[mem])
            la, lo = P.inv(lp.x, lp.y)
            streets = collections.Counter(sb.door_street(ds[i]['street']).title() for i in mem)
            city = collections.Counter(ds[i]['city'] for i in mem).most_common(1)[0][0]
            src = 'grow' if o in grow_zone else 'none' if ' (no sector)' in o or o.endswith(')') else 'isp'
            sectors[o] = {'city': city, 'zone': zone_name(o) if src == 'isp' else grow_zone.get(o, ''),
                          'center': [round(float(la), 6), round(float(lo), 6)],
                          'poly': sb.to_latlon(g, P), 'streets': [x for x, _ in streets.most_common(4)],
                          'source': src}
            for i in mem:
                door_sec[ds[i]['id']] = o
        # zones: the ISP's markets, outlined around their sectors
        zg = collections.defaultdict(list)
        for o, g in shapes.items():
            if sectors[o]['source'] != 'none' and sectors[o]['zone']:
                zg[sectors[o]['zone']].append((o, g))
        for z, parts in zg.items():
            g = shapely.union_all([p for _, p in parts]).buffer(1).buffer(-1).simplify(4)
            mem = [i for i, x in enumerate(own) if x and sectors.get(x, {}).get('zone') == z]
            lp = label_point(g, xy[mem])
            la, lo = P.inv(lp.x, lp.y)
            cur = zones.get(z)
            poly = sb.to_latlon(g, P)
            if cur:   # a market split across two areas: keep both outlines, first label
                cur['poly'] += poly
            else:
                zones[z] = {'city': collections.Counter(sectors[o]['city'] for o, _ in parts).most_common(1)[0][0],
                            'poly': poly, 'center': [round(float(la), 6), round(float(lo), 6)]}
    cut_on = datetime.date.fromtimestamp(os.path.getmtime(path)).isoformat()
    out = {'isp': isp, 'cut_on': cut_on, 'source': 'isp', 'zones': zones, 'sectors': sectors, 'doors': door_sec}
    json.dump(out, open(os.path.join(sb.SECTORS, f'{isp}-cut.json'), 'w'))
    n_isp = sum(1 for s in sectors.values() if s['source'] == 'isp')
    n_grow = sum(1 for s in sectors.values() if s['source'] == 'grow')
    print(f'{isp}: {n_isp} ISP sectors, {n_grow} Grow sectors, {len(zones)} zones; {matched:,} doors from the '
          f'sector file, {inside:,} more inside a sector shape, {grown:,} in a Grow sector, {loose:,} with no '
          f'sector in {len(sectors) - n_isp - n_grow} town groups')


# ---------------------------------------------------------------- viewer + upload

def write_viewer():
    """maps/view.html: the sector-map template, loading its data from sector_maps by ?isp=."""
    tpl = open(os.path.join(ROOT, 'scripts', 'sector-map.html')).read()
    # the title holds __ISP__ too, and markup in there renders as literal text in the
    # browser tab, so blank it before the placeholder becomes a span
    tpl = re.sub(r'<title>.*?</title>', '<title>Grow · Area Map</title>', tpl, count=1, flags=re.S)
    tpl = tpl.replace('__ISP__', '<span class="ispn"></span>')
    loader = (
        "const ISP = new URLSearchParams(location.search).get('isp') || 'i3';\n"
        "const SRC = new URLSearchParams(location.search).get('src') ||   // ?src= is for local testing\n"
        f"  '{SUPA_URL}/rest/v1/sector_maps?select=payload&isp=eq.' + encodeURIComponent(ISP);\n"
        f"const _res = await fetch(SRC, {{cache: 'no-cache', headers: {{apikey: '{SUPA_ANON}'}}}});\n"
        "const _j = _res.ok ? await _res.json() : null;\n"
        "const _map = Array.isArray(_j) ? (_j[0] || {}).payload : _j;\n"
        "if (!_map) { document.body.innerHTML = '<p style=\"padding:24px;font:14px system-ui\">No map for ' + ISP + ' yet.</p>'; throw new Error('no map'); }\n"
        "const {data: DATA, pts: PTS, meta: META} = _map;\n"
        "document.querySelectorAll('.ispn').forEach(e => e.textContent = META.isp);\n"
        "document.title = 'Grow · ' + META.isp + ' Areas';\n")
    for k in ('DATA', 'PTS', 'META'):
        tpl = re.sub(r'const %s = /\*%s\*/null;\n' % (k, k), '', tpl)
    tpl = tpl.replace('<script>\n', '<script type="module">\n' + loader, 1)
    # doors with no ISP sector: dashed grey edge so they read as a gap, not a sector
    tpl = tpl.replace('render();\n</script>',
                      "for (const [p, s] of polys) if (/\\(no sector\\)/.test(s.name)) p.setStyle({dashArray: '5 5', color: '#666'});\n"
                      "render();\n" + EMBED + "</script>")
    # the site loads this in a frame that can still be hidden (zero size): fitting then
    # zooms to the whole world, so wait until the map has a size
    tpl = tpl.replace('map.fitBounds(bounds.pad(0.02));\n',
                      "const _fit = () => { map.invalidateSize(); map.fitBounds(bounds.pad(0.02)); };\n"
                      "if (document.getElementById('map').clientWidth) _fit();\n"
                      "else { const _ro = new ResizeObserver(() => { if (document.getElementById('map').clientWidth) { _ro.disconnect(); _fit(); } });\n"
                      "  _ro.observe(document.getElementById('map')); }\n", 1)
    assert 'const {data: DATA' in tpl and 'dashArray' in tpl and '_ro.observe' in tpl, \
        'sector-map.html changed shape, update write_viewer()'
    path = os.path.join(sb.MAPS, 'view.html')
    open(path, 'w').write(tpl)
    return path


def env():
    out = {}
    for f in ('.env.local', '.env.prod'):
        p = os.path.join(ROOT, f)
        if os.path.exists(p):
            for line in open(p):
                k, _, v = line.strip().partition('=')
                if k and v and k not in out:
                    out[k] = v.strip().strip('"')
    return out


def upload(isp, payload, meta, source):
    """Put one map in the sector_maps table through the sector_map_put function.

    The write key is data/.sector-map-key on this Mac (never in the repo, never in
    scripts/, which build.sh publishes). Without it the table is read only.
    """
    key_path = os.path.join(ROOT, 'data', '.sector-map-key')
    if not os.path.exists(key_path):
        sys.exit(f'no write key at {key_path} (see the sector_map_put function in Supabase)')
    body = json.dumps({'p_key': open(key_path).read().strip(), 'p_isp': isp, 'p_built': meta['built'],
                       'p_doors': meta['doors'], 'p_source': source, 'p_payload': payload})
    r = subprocess.run(['curl', '-s', '-w', '\n%{http_code}', '-X', 'POST',
                        f'{SUPA_URL}/rest/v1/rpc/sector_map_put',
                        '-H', f'apikey: {SUPA_ANON}', '-H', f'Authorization: Bearer {SUPA_ANON}',
                        '-H', 'Content-Type: application/json', '--data-binary', '@-'],
                       input=body, capture_output=True, text=True)
    if r.stdout.rsplit('\n', 1)[-1] not in ('200', '204'):
        sys.exit(f'upload {isp} failed: {r.stdout[:300]}')


def extend_cut(isp):
    """Cut whatever new ground the latest lead drops put on the map.

    A drop onto streets already cut needs nothing: those doors land in the sector
    whose shape holds them. A new town has no shape to land in, so it is cut here,
    leaving every frozen sector untouched (sector-build.py --extend).

    The road download has to come first, since a new town has no tiles cached, and
    it is the slow part: public Overpass, minutes per block when busy. It is capped
    so a big new market cannot hold the nightly run open; a fetch that runs out of
    time has still cached what it got and carries on the next night.
    """
    try:
        subprocess.run([sys.executable, os.path.join(ROOT, 'scripts', 'osm-fetch.py'), isp],
                       timeout=OSM_TIMEOUT)
    except subprocess.TimeoutExpired:
        print(f'{isp}: road download stopped at {OSM_TIMEOUT // 60} min, carrying on with the tiles it has')
    sb.extend(isp)


def extend_grow_cut(isp):
    """extend_cut on <ISP>-grow-cut.json. sector-build only knows <ISP>-cut.json, which
    isp_cut rewrites, so the Grow cut is swapped in for the extend and always put back."""
    grow, live = (os.path.join(sb.SECTORS, f'{isp}{x}.json') for x in ('-grow-cut', '-cut'))
    keep = live + '.isp'
    if os.path.exists(live):
        os.replace(live, keep)
    os.replace(grow, live)
    try:
        extend_cut(isp)
    finally:
        os.replace(live, grow)
        if os.path.exists(keep):
            os.replace(keep, live)


def refresh_inputs():
    """The batch list and the door file are otherwise only rebuilt by the 7am run, so a
    lead drop imported after that would be missing from the map until tomorrow."""
    node = os.path.expanduser('~/.nvm/versions/node/v20.20.2/bin/node')
    node = node if os.path.exists(node) else 'node'
    subprocess.run([node, os.path.join(ROOT, 'scripts', 'isp-registry.mjs')], cwd=ROOT,
                   stdout=subprocess.DEVNULL)   # exits 2 on an unlabeled batch; the 7am run reports that
    r = subprocess.run([node, os.path.join(ROOT, 'scripts', 'grow-sync.mjs'), '--skip-crawl', '--full-csv', '--no-push'],
                       cwd=ROOT, capture_output=True, text=True)
    if r.returncode:
        print('door file refresh failed, using the last one:', (r.stderr or r.stdout)[-300:])


def has_map(isp):
    return (os.path.exists(os.path.join(sb.SECTORS, f'{isp}.csv'))
            or os.path.exists(os.path.join(sb.SECTORS, f'{isp}-cut.json')))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    isps = args or ([i for i in PUBLISHED if has_map(i)] if '--all' in sys.argv else [])
    if not isps:
        sys.exit(__doc__)
    write_viewer()
    if '--no-extract' not in sys.argv and '--no-refresh' not in sys.argv:
        refresh_inputs()
    for isp in isps:
        if not has_map(isp):
            print(f'{isp}: no sector file and no cut yet, skipped'); continue
        if '--no-extract' not in sys.argv:
            sb.extract(isp)
        source = 'grow'
        if os.path.exists(os.path.join(sb.SECTORS, f'{isp}.csv')):
            if '--no-extend' not in sys.argv and os.path.exists(os.path.join(sb.SECTORS, f'{isp}-grow-cut.json')):
                extend_grow_cut(isp)       # towns the ISP sent no sectors for
            isp_cut(isp); source = 'isp'   # their sectors, rebuilt from their file
        elif '--no-extend' not in sys.argv:
            extend_cut(isp)
        sb.build_map(isp)
        if '--no-upload' in sys.argv:
            continue
        payload = json.load(open(os.path.join(sb.MAPS, isp.lower(), 'data.json')))
        upload(isp, payload, payload['meta'], source)
        print(f'  {isp} is live on the Maps page')


if __name__ == '__main__':
    main()
