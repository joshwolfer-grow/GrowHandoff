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
# ISPs the site shows. Lyte is drawn on its own serving areas (scripts/lyte-areas.py
# rebuilds data/sectors/Lyte.csv from every drop file), doors it never listed grey.
PUBLISHED = ['i3', 'SLIC', 'Surf', 'TDS', 'Lyte']   # TDS: its own SalesRabbit company, crawled by grow-sync.mjs --tenant tds
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
  reps: (s.reps || []).slice().sort((a, b) => b[1] - a[1]), turf: s.turf || null}));
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
    TXFRSTAC001.SA02 -> TXFRSTAC001, Lake Jackson 2.01 -> Lake Jackson."""
    m = re.match(r'^(.+?) \d+\.\d+[A-Z0-9]*$', sector)
    if m:
        return m.group(1)
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


LONE_MAX = 3      # a cluster of fewer doors than this, 3 km from every other door, is a bad pin
LOOSE_MIN = 5     # loose doors in a smaller bunch than this ...
LOOSE_NEAR = 400  # ... within this many metres of an area's door join that area
STRAY_DEG = 0.3   # about 30 km: further than this from its area's middle door, a door is a bad pin
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
    # a door geocoded far from the rest of its area (a Baytown address pinned in the
    # panhandle) would stretch that area across the state: it goes loose instead
    at = collections.defaultdict(list)
    for d in doors:
        o = m.get((si.street_key(d['street']), d['zip']))
        if o:
            at[o].append(d)
    stray = set()
    for o, ds_ in at.items():
        mla, mlo = np.median([d['lat'] for d in ds_]), np.median([d['lon'] for d in ds_])
        stray |= {d['id'] for d in ds_ if abs(d['lat'] - mla) > STRAY_DEG or abs(d['lon'] - mlo) > STRAY_DEG}
    lat = np.array([d['lat'] for d in doors]); lon = np.array([d['lon'] for d in doors])
    # towns far apart are drawn separately, each in its own flat projection
    X = np.c_[lat * 111.0, lon * 111.0 * np.cos(np.radians(lat.mean()))]
    area = DBSCAN(eps=3.0, min_samples=1).fit_predict(X)
    # a pin or two 3 km from any other door is not territory, it is a bad geocode: it
    # comes off the map (and out of the door file, or build_map hangs it on the nearest area)
    size = collections.Counter(area.tolist())
    lone = {doors[i]['id'] for i in range(len(doors)) if size[int(area[i])] < LONE_MAX}
    if lone:
        json.dump([d for d in doors if d['id'] not in lone], open(os.path.join(sb.CACHE, f'{isp}-doors.json'), 'w'))
        print(f'{isp}: {len(lone)} lone pins 3 km+ from any other door left off the map')
    sectors, zones, door_sec = {}, {}, {}
    no_sector_names = collections.Counter()
    matched = inside = loose = grown = 0
    for a in sorted(set(area.tolist())):
        if size[a] < LONE_MAX:
            continue
        idx = np.where(area == a)[0]
        ds = [doors[i] for i in idx]
        P = sb.Proj(float(lat[idx].mean()), float(lon[idx].mean()))
        dx, dy = P.fwd(lat[idx], lon[idx])
        xy = np.c_[dx, dy]
        own = [None if d['id'] in stray else m.get((si.street_key(d['street']), d['zip'])) for d in ds]
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
        # loose doors sitting just off an area's edge are that area's, not a grey island of
        # their own: within LOOSE_NEAR of a door that has an area, they take its area,
        # unless enough of them sit together to be a gap worth seeing
        if rest and len(rest) < len(own):
            lab = DBSCAN(eps=LOOSE_NEAR, min_samples=1).fit_predict(xy[rest]) if len(rest) > 1 else np.zeros(1, dtype=int)
            n_lab = collections.Counter(lab.tolist())
            has = [i for i, o in enumerate(own) if o]
            near = shapely.STRtree([Point(xy[i]) for i in has])
            for i, l in zip(rest, lab.tolist()):
                if n_lab[l] < LOOSE_MIN:
                    j = has[int(near.nearest(Point(xy[i])))]
                    if np.hypot(*(xy[i] - xy[j])) <= LOOSE_NEAR:
                        own[i] = own[j]; inside += 1
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


# ---------------------------------------------------------------- SalesRabbit's own areas

SR_EXACT = {'Lyte'}
GREY_MIN = 10        # undrawn doors: only bunches this big get a grey outline   # ISPs drawn exactly as the areas in SalesRabbit, not from their files


def sr_areas(isp):
    """Every area drawn in SalesRabbit (read only), cached so a failed fetch reuses the last."""
    cache = os.path.join(sb.SECTORS, f'{isp}-sr-areas.json')
    try:
        H = json.load(open(os.path.join(ROOT, 'data', 'sr-auth.json')))['headers']
        hdr = [x for k, v in H.items() for x in ('-H', f'{k}: {v}')]
        out, off = [], 0
        while True:   # curl, not urllib: python's certificates fail on this Mac
            r = subprocess.run(['curl', '-sfg', '--max-time', '60', *hdr,
                                f'https://apis.salesrabbit.com/areas?page[limit]=500&page[offset]={off}'],
                               capture_output=True, text=True, check=True)
            d = json.loads(r.stdout).get('data') or []
            out += d
            if len(d) < 500:
                break
            off += 500
        json.dump(out, open(cache, 'w'))
        return out
    except Exception as e:
        # never print the exception whole: a curl failure carries the auth header
        print(f'{isp}: SalesRabbit areas fetch failed ({type(e).__name__}'
              f'{" " + str(e.returncode) if hasattr(e, "returncode") else ""}), using the last copy')
        return json.load(open(cache))


def lyte_namer():
    """A drawn area's title -> Lyte's name for it. Titles are bare numbers ("7.07", "2.04 A"),
    so the town comes from the doors inside, and the name is only Lyte's ("Baytown 7.07")
    when that FDH is on Lyte's tracker."""
    la = _load('lyte_areas', 'lyte-areas.py')
    code_of_city, town_of = collections.defaultdict(collections.Counter), {}
    with open(os.path.join(sb.SECTORS, 'Lyte.csv'), newline='') as f:
        for r in csv.DictReader(f):
            m = la.FDH_RE.match(r['fdh'])
            if m:
                code_of_city[r['city'].upper()][m.group(1)] += 1
                town_of[m.group(1)] = re.sub(r' \d+\.\d+\w*$', '', r['sector'])
    code_of_city = {c: n.most_common(1)[0][0] for c, n in code_of_city.items()}
    turf = json.load(open(os.path.join(sb.SECTORS, 'Lyte-turf.json')))['areas']
    known = {t['FDH'] for t in turf.values()}
    names = la.area_names(known, town_of)
    towns = {t.upper() for t in town_of.values()}
    def name(title, city):
        # only a serving area number counts, alone or after a town ("1.01", "2.04 A",
        # "Jeff 1.01"); rep areas ("Jeff 1", "Erik Juice", "Ben 10.4 7/28/26") do not
        m = re.fullmatch(r'\s*(?:([A-Za-z][A-Za-z .]*?)\s+)?(\d{1,2}\.\d{1,2}\s?[A-Za-z]?\d?)\s*', title or '')
        if not m or (m.group(1) and not any(t.startswith(m.group(1).upper().rstrip('.')) for t in towns)):
            return None
        title = m.group(2)
        sh = la.shorthand(title)
        code = code_of_city.get((city or '').upper())
        if len(sh) == 1 and code:
            f = la.resolve(code, (sh[0][0], sh[0][1], sh[0][2].replace(' ', '')), known)
            if f:
                return names[f]
            return f'{town_of.get(code, city.title())} {title.strip()}'
        return None
    return name


def sr_cut(isp):
    """<ISP>-cut.json from the areas drawn in SalesRabbit, exactly as drawn: same outline,
    same title, every door inside counted, so the map and SalesRabbit always agree. Doors in
    no drawn area are grouped by town and drawn grey, as on the other maps."""
    from sklearn.cluster import DBSCAN
    doors = json.load(open(os.path.join(sb.CACHE, f'{isp}-doors.json')))
    pts = shapely.points([(d['lon'], d['lat']) for d in doors])
    tree = shapely.STRtree(pts)
    namer = lyte_namer() if isp == 'Lyte' else (lambda t, c: None)
    sectors, members, primary, zones = {}, {}, {}, {}
    taken = collections.Counter()
    kept = []
    for a in sr_areas(isp):
        at = a.get('attributes') or {}
        rings = ((at.get('coordinates') or {}).get('coordinates') or [])
        if not rings or len(rings[0]) < 3:
            continue
        g = shapely.make_valid(shapely.Polygon([(p[1], p[0]) for p in rings[0]], [[(p[1], p[0]) for p in r] for r in rings[1:]]))
        hit = tree.query(g, predicate='contains')
        if not len(hit):
            continue
        ds = [doors[i] for i in hit]
        city = collections.Counter(d['city'] for d in ds).most_common(1)[0][0] or 'Unknown'
        title = (at.get('title') or '').strip()
        nm = namer(title, city)
        if isp == 'Lyte' and not nm:
            continue           # Lyte: only areas titled with a serving area number
        nm = nm or title or f'{city} untitled'
        taken[nm] += 1
        if taken[nm] > 1:
            nm = f'{nm} ({taken[nm]})'
        rp = g.representative_point()
        streets = collections.Counter(sb.door_street(d['street']).title() for d in ds)
        zone = re.sub(r' \d+\.\d+\S*( \(\d+\))?$', '', nm) if re.search(r' \d+\.\d+', nm) else city
        sectors[nm] = {'city': city, 'zone': zone, 'center': [round(rp.y, 6), round(rp.x, 6)],
                       'poly': [[[[p[0], p[1]] for p in r] for r in rings]], 'streets': [x for x, _ in streets.most_common(4)],
                       'source': 'sr', 'sr_id': a.get('id'), 'sr_title': title}
        members[nm] = [d['id'] for d in ds]
        zones.setdefault(zone, {'city': city, 'poly': [], 'center': None})
        kept.append((g.area, nm, hit))
    # a door in two drawn areas belongs, for the dots and the drop chip, to the smaller one
    for _, nm, hit in sorted(kept, key=lambda k: -k[0]):
        for i in hit:
            primary[doors[i]['id']] = nm
    # what nobody has drawn: grouped by town, then 800 m bunches, outlined grey
    rest = [i for i, d in enumerate(doors) if d['id'] not in primary]
    by_city = collections.defaultdict(list)
    for i in rest:
        by_city[doors[i]['city'] or 'Unknown'].append(i)
    for city, mem in by_city.items():
        lat = np.array([doors[i]['lat'] for i in mem]); lon = np.array([doors[i]['lon'] for i in mem])
        P = sb.Proj(float(lat.mean()), float(lon.mean()))
        xy = np.c_[P.fwd(lat, lon)]
        lab = DBSCAN(eps=800, min_samples=1).fit_predict(xy) if len(mem) > 1 else np.zeros(1, dtype=int)
        order = sorted(set(lab.tolist()), key=lambda l: -int((lab == l).sum()))
        own = [None] * len(mem)
        for k, l in enumerate(order, 1):
            nm = f'{city} (no sector)' + (f' {k}' if k > 1 else '')
            for j in np.where(lab == l)[0]:
                own[j] = nm
        n_own = collections.Counter(own)
        for nm, g in outline_groups(xy, own).items():
            js = [j for j, o in enumerate(own) if o == nm]
            if n_own[nm] < GREY_MIN:     # a stray door or three is not a gap worth drawing
                continue
            lp = label_point(g, xy[js])
            la_, lo_ = P.inv(lp.x, lp.y)
            sectors[nm] = {'city': city, 'zone': '', 'center': [round(float(la_), 6), round(float(lo_), 6)],
                           'poly': sb.to_latlon(g, P), 'streets': [], 'source': 'none'}
            members[nm] = [doors[mem[j]]['id'] for j in js]
            for j in js:
                primary[doors[mem[j]]['id']] = nm
    out = {'isp': isp, 'cut_on': datetime.date.today().isoformat(), 'source': 'salesrabbit', 'exact': True,
           'zones': zones, 'sectors': sectors, 'doors': primary, 'members': members}
    json.dump(out, open(os.path.join(sb.SECTORS, f'{isp}-cut.json'), 'w'))
    drawn = sum(1 for v in sectors.values() if v['source'] == 'sr')
    named = sum(1 for n, v in sectors.items() if v['source'] == 'sr' and re.search(r' \d+\.\d+', n))
    grey = sum(len(members[n]) for n, v in sectors.items() if v['source'] == 'none')
    print(f'{isp}: {drawn} SalesRabbit areas ({named} with a Lyte number), '
          f'{len(doors) - len(rest):,} of {len(doors):,} doors inside one, {grey:,} grey in '
          f'{len(sectors) - drawn} town groups, {len(rest) - grey:,} strays left off')


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
    import time
    for attempt in range(3):   # a busy database can time a 2 MB write out once (57014); the next try lands
        r = subprocess.run(['curl', '-s', '-w', '\n%{http_code}', '-X', 'POST',
                            f'{SUPA_URL}/rest/v1/rpc/sector_map_put',
                            '-H', f'apikey: {SUPA_ANON}', '-H', f'Authorization: Bearer {SUPA_ANON}',
                            '-H', 'Content-Type: application/json', '--data-binary', '@-'],
                           input=body, capture_output=True, text=True)
        if r.stdout.rsplit('\n', 1)[-1] in ('200', '204'):
            return
        time.sleep(15)
    if True:
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


def drop_strays(isp):
    """A few doors in a state the ISP does not serve (data/isps.json states) are bad pins
    or rep typos, and one of them zooms the whole map out to the country: off the map."""
    try:
        states = set(json.load(open(os.path.join(ROOT, 'data', 'isps.json'))).get(isp, {}).get('states') or [])
    except (OSError, ValueError):
        return
    if not states:
        return
    path = os.path.join(sb.CACHE, f'{isp}-doors.json')
    doors = json.load(open(path))
    # only a handful: i3 really works 4,690 Missouri doors outside its listed IL
    n = collections.Counter((d.get('state') or '').upper() for d in doors)
    keep = [d for d in doors if not d.get('state') or d['state'].upper() in states or n[d['state'].upper()] >= 20]
    if len(keep) < len(doors):
        json.dump(keep, open(path, 'w'))
        print(f'{isp}: {len(doors) - len(keep)} doors outside {", ".join(sorted(states))} left off the map')


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
    live = []
    for isp in isps:
        if not has_map(isp):
            print(f'{isp}: no sector file and no cut yet, skipped'); continue
        if '--no-extract' not in sys.argv:
            sb.extract(isp)
        drop_strays(isp)
        source = 'grow'
        if isp == 'Lyte' and os.path.exists(os.path.join(sb.SECTORS, 'Lyte-turf.json')):
            # Lyte's areas come from its drop files: re-read them so a new drop lands in its area
            subprocess.run([sys.executable, os.path.join(ROOT, 'scripts', 'lyte-areas.py')], cwd=ROOT,
                           stdout=subprocess.DEVNULL)
        if os.path.exists(os.path.join(sb.SECTORS, f'{isp}.csv')):
            if '--no-extend' not in sys.argv and os.path.exists(os.path.join(sb.SECTORS, f'{isp}-grow-cut.json')):
                extend_grow_cut(isp)       # towns the ISP sent no sectors for
            if isp in SR_EXACT:
                sr_cut(isp); source = 'salesrabbit'   # exactly the areas drawn in SalesRabbit
            else:
                isp_cut(isp); source = 'isp'   # their sectors, rebuilt from their file
        elif '--no-extend' not in sys.argv:
            extend_cut(isp)
        sb.build_map(isp)
        if '--no-upload' in sys.argv:
            continue
        payload = json.load(open(os.path.join(sb.MAPS, isp.lower(), 'data.json')))
        upload(isp, payload, payload['meta'], source)
        print(f'  {isp} is live on the Maps page')
        live.append(isp)
    if live:
        # last line on purpose: the Wolf Office Mapper card shows it as its status
        print(f'{len(live)} maps live: {", ".join(live)}')


if __name__ == '__main__':
    main()
