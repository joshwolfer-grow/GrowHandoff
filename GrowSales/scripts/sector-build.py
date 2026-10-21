#!/usr/bin/env python3
"""Cut an ISP's SalesRabbit doors into walkable sectors and draw them on a map.

    python3 scripts/sector-build.py SLIC --extract   # doors + knock history from the crawl
    python3 scripts/osm-fetch.py SLIC                # roads, rail, rivers (cached)
    python3 scripts/sector-build.py SLIC --cut       # cut the sectors ONCE and freeze them
    python3 scripts/sector-build.py SLIC --extend    # new towns only, frozen sectors untouched
    python3 scripts/sector-build.py SLIC --map       # stats + map from the frozen cut

Daily refresh after `node scripts/grow-sync.mjs`:  --extract --map  (sectors stay put).

How a sector is cut (built so someone can trace each one by hand in SalesRabbit)
  unit      the city block a door sits in: the faces the OpenStreetMap street
            network makes. Inside a town every sector edge is therefore a street
            centreline and every corner an intersection.
  borders   big roads, railways, rivers cost extra to cross (secondary roads half),
            so sectors end on them. Out in the country (blocks over 0.25 km2) roads
            are not borders and a sector takes both sides.
  grouping  smallest group first, merged into the neighbour that is closest, shares
            the most open border, and was last knocked around the same time
            (rest, weakened in rural stretches where it saws the edges), until it
            holds GROW_TO doors. Never above MAX. The same grouping then runs on
            the sectors to make zones, never mixing towns.
  outline   town: its blocks, clipped to a plain loop round its leads.
            rural: one filled straight sided shape round its leads, split from its
            neighbours by nearest house and smoothed; any house that ends up inside
            a neighbour's shape moves to that neighbour, so shape and list agree.
  names     town code, zone, sector in walking order: MASS 1.1, MASS 1.2, MASS 2.1.
            Town codes are always four capital letters (see town_code): Massena is
            MASS, Glens Falls is GLFA.

Frozen cut: data/sectors/<ISP>-cut.json (lead id -> sector, outlines). A door the
cut has never seen lands in the sector whose outline holds it.
"""
import argparse, collections, csv, datetime, heapq, json, math, os, re, sys

import numpy as np
import shapely
from shapely.geometry import LineString, MultiPoint, Point
from scipy.spatial import Delaunay

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'data', 'osm-cache')
SECTORS = os.path.join(ROOT, 'data', 'sectors')
MAPS = os.path.join(ROOT, 'maps')
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

MIN, GROW_TO, SOFT_MAX, MAX = 100, 110, 200, 500          # doors per sector
ZONE_MIN, ZONE_GROW_TO, ZONE_SOFT_MAX, ZONE_MAX = 300, 500, 800, 1200
RURAL_GROUP = 2000          # country houses further apart than this get their own shape
EXTEND_MIN = 40             # a loose pocket smaller than this joins a neighbour instead of becoming a sector   # doors per zone
SPLIT_STREET = 500          # a block holding more than this is cut into runs (its outline overlaps)
MAJOR = {'motorway', 'trunk', 'primary', 'secondary',
         'motorway_link', 'trunk_link', 'primary_link', 'secondary_link'}
EXCLUDE_REPS = {'daxton day', 'nick boyd'}
AT_DOOR_M = 1000
CONTACT = {'Not Interested', 'Call Back', 'No English', 'Do Not Knock', 'Sold',
           # TDS's own stage names (their SalesRabbit, see data/amplify-sources.json)
           'Come Back', 'No Solicitation', 'Not Interested - Fiber', 'Not Interested - Cable',
           'Not Interested - Price', "Not Interested - Won't Discuss"}
WAVE_DAYS = 14
TODAY = datetime.date.today()

SUF = {'ROAD': 'RD', 'STREET': 'ST', 'AVENUE': 'AVE', 'AV': 'AVE', 'DRIVE': 'DR', 'LANE': 'LN',
       'COURT': 'CT', 'PLACE': 'PL', 'BOULEVARD': 'BLVD', 'CIRCLE': 'CIR', 'TERRACE': 'TER',
       'PARKWAY': 'PKWY', 'HIGHWAY': 'HWY', 'TRAIL': 'TRL', 'SQUARE': 'SQ', 'EXTENSION': 'EXT',
       'NORTH': 'N', 'SOUTH': 'S', 'EAST': 'E', 'WEST': 'W', 'ROUTE': 'RTE', 'RT': 'RTE',
       'MOUNT': 'MT', 'SAINT': 'ST', 'HEIGHTS': 'HTS', 'CROSSING': 'XING', 'WAY': 'WAY'}
ROUTE_RE = re.compile(r'^(?:(?:NEW YORK|NYS|NY|US|STATE|COUNTY|CO|CR|SR|S)\s+)*'
                      r'(?:RTE|HWY|RD|ROUTE|HIGHWAY)?\s*(\d+[A-Z]?)$')


def norm(s):
    return ' '.join(SUF.get(w, w) for w in re.sub(r'[^A-Z0-9 ]', ' ', (s or '').upper()).split())


def street_keys(s):
    """Every way this street name could be spelled, for matching a door to its road."""
    s = norm(s)
    out = {s}
    m = ROUTE_RE.match(s)
    if m:
        out.add('RTE ' + m.group(1))
    w = s.split()
    if len(w) > 1 and w[-1] in SUF.values():
        out.add(' '.join(w[:-1]))
    if w and w[0] in ('N', 'S', 'E', 'W') and len(w) > 1:
        out.add(' '.join(w[1:]))
    return out


def door_street(addr):
    w = norm(addr).split()
    while w and re.match(r'^\d+[A-Z]?$|^\d+ ?1 2$', w[0]):
        w = w[1:]
    return ' '.join(w)


# ---------------------------------------------------------------- extract

# ISPs that are a whole SalesRabbit company of their own rather than a slice of
# Grow's. Their crawl comes from grow-sync.mjs --tenant <slug> (data/<slug>-*),
# and every door in it belongs to that ISP: no territory split.
TENANTS = {'TDS': 'tds'}


def extract(isp):
    """Doors for one ISP with GPS and every at-door knock date, from the crawl."""
    from isp_territory import Territory
    csv.field_size_limit(10 ** 9)
    pfx = TENANTS.get(isp, 'sr')
    doors = list(csv.DictReader(open(os.path.join(ROOT, 'data', f'{pfx}-doors-by-area.csv'))))
    if isp in TENANTS:
        sel = {d['lead_id']: d for d in doors}
    else:
        T = Territory(doors)
        sel = {d['lead_id']: d for d in doors if T.isp_of(d) == isp}
    coords, lead_imp, batch_day = {}, {}, {}
    for line in open(os.path.join(ROOT, 'data', f'{pfx}-leads.jsonl')):
        try:
            o = json.loads(line)
        except ValueError:
            continue
        if o['id'] not in sel:
            continue
        if o.get('coordinates'):
            coords[o['id']] = o['coordinates']['coordinates']
        imp = o.get('import_id')
        if imp:
            lead_imp[o['id']] = imp
            if o.get('inserted_at'):
                batch_day[imp] = min(batch_day.get(imp, '9999'), o['inserted_at'][:10])
    # the day each door was dropped: its SalesRabbit import batch (data/isp-imports.json,
    # else the batch's earliest lead). A door a rep made by hand has no batch and no drop.
    try:
        reg = json.load(open(os.path.join(ROOT, 'data', 'isp-imports.json')))
    except (OSError, ValueError):
        reg = {}
    for imp in batch_day:
        if imp in reg and reg[imp].get('date'):
            batch_day[imp] = reg[imp]['date']
    kd, contact, sold = collections.defaultdict(set), set(), set()
    marks = collections.defaultdict(dict)       # lead -> {(day, rep): last stage that day}
    with open(os.path.join(ROOT, 'data', f'{pfx}-activity.csv'), newline='') as f:
        for r in csv.DictReader(f):
            i = r['lead_id']
            if i not in sel or r['event'] != 'stage_updated' or not r['datetime']:
                continue
            if (r['rep'] or '').strip().lower() in EXCLUDE_REPS:
                continue
            try:
                if float(r['distance']) >= AT_DOOR_M:
                    continue
            except (TypeError, ValueError):
                pass
            kd[i].add(r['datetime'][:10])
            marks[i][(r['datetime'][:10], (r['rep'] or '').strip())] = r['new_stage']
            if r['new_stage'] in CONTACT:
                contact.add(i)
            if r['new_stage'] == 'Sold':
                sold.add(i)
    out = []
    for i, d in sel.items():
        if i not in coords:
            continue
        lon, lat = coords[i]
        out.append({'id': i, 'lat': round(lat, 6), 'lon': round(lon, 6), 'street': d['street'],
                    'unit': d['unit'], 'city': d['city'].strip().title(), 'state': d['state'],
                    'zip': d['zip'][:5], 'stage': d['current_stage'], 'days': sorted(kd.get(i, ())),
                    'added': batch_day.get(lead_imp.get(i)), 'contact': int(i in contact), 'sold': int(i in sold or d['ever_sold'] == '1'),
                    'marks': sorted([dy_, rep, st] for (dy_, rep), st in marks.get(i, {}).items())})
    os.makedirs(CACHE, exist_ok=True)
    json.dump(out, open(os.path.join(CACHE, f'{isp}-doors.json'), 'w'))
    print(f'{len(out)} {isp} doors, {sum(1 for o in out if o["days"])} knocked at the door'
          f' ({len(sel) - len(out)} without GPS skipped)')


# ---------------------------------------------------------------- geometry helpers

class Proj:
    def __init__(self, lat0, lon0):
        self.lat0, self.lon0 = lat0, lon0
        self.kx, self.ky = 111320 * math.cos(math.radians(lat0)), 110540

    def fwd(self, lat, lon):
        return (np.asarray(lon) - self.lon0) * self.kx, (np.asarray(lat) - self.lat0) * self.ky

    def inv(self, x, y):
        return self.lat0 + y / self.ky, self.lon0 + x / self.kx


def day_no(s):
    return datetime.date.fromisoformat(s).toordinal()


def load_osm(paths, P):
    """Road edges split at intersections, plus barrier lines, in local metres."""
    seen, els = set(), []
    for path in ([paths] if isinstance(paths, str) else paths):
        for el in json.load(open(path)).get('elements', []):
            if el['type'] == 'way' and el['id'] not in seen:
                seen.add(el['id']); els.append(el)
    data = {'elements': els}
    roads, barriers, barrier_w = [], [], []
    use = collections.Counter()
    for el in data['elements']:
        if el['type'] != 'way' or 'highway' not in el.get('tags', {}):
            continue
        for n in el['nodes']:
            use[n] += 1
    for el in data['elements']:
        if el['type'] != 'way' or not el.get('geometry'):
            continue
        t = el.get('tags', {})
        g = [(p['lat'], p['lon']) for p in el['geometry'] if p]
        if len(g) < 2:
            continue
        x, y = P.fwd([p[0] for p in g], [p[1] for p in g])
        pts = list(zip(x.tolist(), y.tolist()))
        hw = t.get('highway')
        if hw:
            major = hw in MAJOR
            keys = set()
            for k in ('name', 'alt_name', 'old_name'):
                if t.get(k):
                    keys |= street_keys(t[k])
            for r in (t.get('ref') or '').split(';'):
                if r.strip():
                    keys |= street_keys(r.strip())
            nodes = el['nodes']
            if len(nodes) != len(pts):
                nodes = [None] * len(pts)
            start = 0
            for i in range(1, len(pts)):
                if i == len(pts) - 1 or use[nodes[i]] > 1:
                    seg = pts[start:i + 1]
                    if len(seg) >= 2 and LineString(seg).length > 0.5:
                        roads.append({'line': LineString(seg), 'major': major, 'keys': keys,
                                      'a': nodes[start], 'b': nodes[i], 'name': t.get('name') or t.get('ref') or ''})
                    start = i
            if major:
                ln = LineString(pts)
                ln_w = 0.5 if hw.startswith('secondary') else 1.0
                barriers.append(ln); barrier_w.append(ln_w)
        elif t.get('railway') == 'rail' or t.get('waterway') in ('river', 'canal'):
            barriers.append(LineString(pts)); barrier_w.append(1.0)
    return roads, (barriers, barrier_w)


# ---------------------------------------------------------------- cut

def cut_area(doors, roads, barriers_w, P):
    """Doors grouped by the city block they sit in (the faces the street network makes).

    Returns (unit_of_door, units, adjacency, faces, dx, dy). Adjacency counts neighbouring
    doors in different blocks: 'clean' when only a side street runs between them, 'bar'
    when a big road, railway or river does."""
    barriers, bw = barriers_w
    n = len(doors)
    dx, dy = P.fwd([d['lat'] for d in doors], [d['lon'] for d in doors])
    pts = shapely.points(dx, dy)
    env = shapely.box(dx.min() - 800, dy.min() - 800, dx.max() + 800, dy.max() + 800)
    noded = shapely.union_all([r['line'] for r in roads] + barriers + [env.exterior])
    faces = shapely.get_parts(shapely.polygonize(shapely.get_parts(noded)))
    faces = np.array([f for f in faces if f.intersects(env)], dtype=object)
    tree = shapely.STRtree(faces)
    face_of = {}
    for a_, f in zip(*tree.query(pts, predicate='within')):
        face_of.setdefault(int(a_), int(f))
    miss = [a_ for a_ in range(n) if a_ not in face_of]
    if miss:
        near = tree.query_nearest(pts[miss], all_matches=False)
        for k, f in zip(near[0].tolist(), near[1].tolist()):
            face_of[miss[k]] = f
    groups = collections.defaultdict(list)
    for a_ in range(n):
        groups[face_of[a_]].append(a_)
    units, unit_of = [], np.zeros(n, dtype=int)
    for f, mem in groups.items():
        # a block too big for one sector (rare: one estate with no through street) is
        # split into runs west to east; its outline still follows the block edge
        k = math.ceil(len(mem) / 180) if len(mem) > SPLIT_STREET else 1
        mem.sort(key=lambda a_: (dx[a_], dy[a_]))
        for c in range(k):
            chunk = mem[c * len(mem) // k:(c + 1) * len(mem) // k]
            units.append({'face': f, 'doors': chunk, 'rural': faces[f].area >= 250_000})
            for a_ in chunk:
                unit_of[a_] = len(units) - 1

    adj = collections.defaultdict(lambda: [0, 0])
    G = np.c_[dx, dy] + np.random.default_rng(0).normal(0, 0.05, (n, 2))   # split stacked apartments
    if n >= 4:
        tri = Delaunay(G)
        ind, nb = tri.vertex_neighbor_vertices
        ii, jj = [], []
        for i in range(n):
            for j in nb[ind[i]:ind[i + 1]]:
                if i < j and unit_of[i] != unit_of[j]:
                    ii.append(i); jj.append(j)
        ii, jj = np.array(ii, dtype=int), np.array(jj, dtype=int)
        crossed = np.zeros(len(ii))
        if barriers and len(ii):
            segs = shapely.linestrings(np.stack([G[ii], G[jj]], axis=1))
            hit = shapely.STRtree(barriers).query(segs, predicate='intersects')
            np.maximum.at(crossed, hit[0], np.asarray(bw)[hit[1]])
            # out in the country a road is not a border: a rural sector takes both sides
            area = shapely.area(faces)
            fa = np.array([area[units[unit_of[i]]['face']] for i in range(n)])
            crossed[(fa[ii] >= 250_000) | (fa[jj] >= 250_000)] = 0
        for i, j, c in zip(unit_of[ii].tolist(), unit_of[jj].tolist(), crossed.tolist()):
            k = (i, j) if i < j else (j, i)
            adj[k][0] += 1 - c; adj[k][1] += c
    elif len(units) > 1:
        for i in range(len(units)):
            for j in range(i + 1, len(units)):
                adj[(i, j)][0] += 1
    return unit_of, units, adj, faces, dx, dy


class Cluster:
    __slots__ = ('units', 'n', 'sx', 'sy', 'ss', 'never', 'last', 'cities', 'nb', 'alive', 'rural')


def seed(units, doors, adj, dx, dy):
    """One cluster per street run."""
    last = [day_no(d['days'][-1]) if d['days'] else None for d in doors]
    C = []
    for ui, u in enumerate(units):
        c = Cluster()
        c.units = [ui]; c.n = len(u['doors'])
        xs, ys = dx[u['doors']], dy[u['doors']]
        c.sx, c.sy, c.ss = float(xs.sum()), float(ys.sum()), float((xs ** 2 + ys ** 2).sum())
        c.never = sum(1 for a in u['doors'] if last[a] is None)
        c.last = sorted(last[a] for a in u['doors'] if last[a] is not None)
        c.cities = collections.Counter(doors[a]['city'] for a in u['doors'])
        c.rural = c.n if u.get('rural') else 0
        c.nb, c.alive = {}, True
        C.append(c)
    for (i, j), (clean, bar) in adj.items():
        if i != j:
            C[i].nb[j] = [clean, bar]; C[j].nb[i] = [clean, bar]
    return C


def lift(C):
    """Each surviving cluster becomes one unit of the next level up (sectors -> zones)."""
    alive = [i for i, c in enumerate(C) if c.alive]
    ix = {old: new for new, old in enumerate(alive)}
    Z = []
    for old in alive:
        c = C[old]
        z = Cluster()
        z.units = [ix[old]]; z.n = c.n
        z.sx, z.sy, z.ss = c.sx, c.sy, c.ss
        z.never, z.last, z.cities = c.never, list(c.last), collections.Counter(c.cities)
        z.rural = c.rural
        z.nb = {ix[k]: list(v) for k, v in c.nb.items() if k in ix}
        z.alive = True
        Z.append(z)
    snb = [[ix[k] for k in C[old].nb if k in ix] for old in alive]
    return [C[i] for i in alive], Z, snb


def city_of(c):
    return c.cities.most_common(1)[0][0]


def agglomerate(C, lo, grow_to, soft_max, cap, city_rule):
    """Smallest cluster first, merged into its cheapest neighbour, until each holds grow_to.

    city_rule 'prefer' charges for mixing towns, 'strict' never mixes them."""
    def radius(c):
        mx, my = c.sx / c.n, c.sy / c.n
        return math.sqrt(max(c.ss / c.n - mx * mx - my * my, 0)), mx, my

    def cost(a, b, cap):
        A, B = C[a], C[b]
        n = A.n + B.n
        if n > cap:
            return None
        same = city_of(A) == city_of(B)
        if city_rule == 'strict' and not same:
            return None
        ra, ax, ay = radius(A); rb, bx, by = radius(B)
        shape = math.hypot(ax - bx, ay - by) / (ra + rb + 40)
        clean, bar = A.nb[b]
        border = 2.5 * bar / (clean + bar) if clean + bar else 2.5
        rest = 1.5 * abs(A.never / A.n - B.never / B.n)
        if A.last and B.last:
            rest += min(abs(A.last[len(A.last) // 2] - B.last[len(B.last) // 2]), 150) / 40
        # out in the country clean lines matter more than rest: rest-sorting interleaved
        # houses along one road is what saws the edge between two sectors
        rest *= 1 - 0.85 * (A.rural + B.rural) / n
        size = max(0, n - soft_max) / (soft_max / 3)
        town = 0 if same else 1.2
        return shape + border + rest + size + town

    def merge(a, b):
        A, B = C[a], C[b]
        A.units += B.units; A.n += B.n
        A.sx += B.sx; A.sy += B.sy; A.ss += B.ss
        A.never += B.never
        A.last = list(heapq.merge(A.last, B.last))
        A.cities.update(B.cities)
        A.rural += B.rural
        for k, (cl, br) in B.nb.items():
            if k == a:
                continue
            cur = A.nb.setdefault(k, [0, 0])
            cur[0] += cl; cur[1] += br
            other = C[k].nb
            other.pop(b, None)
            other[a] = list(cur)
        A.nb.pop(b, None)
        B.alive = False

    def grow(limit, cap):
        heap = [(c.n, i) for i, c in enumerate(C) if c.alive and c.n < limit]
        heapq.heapify(heap)
        while heap:
            n, i = heapq.heappop(heap)
            c = C[i]
            if not c.alive or c.n != n or c.n >= limit:
                continue
            opts = [(cost(i, j, cap), j) for j in c.nb if C[j].alive]
            opts = [o for o in opts if o[0] is not None]
            if not opts:
                continue
            _, j = min(opts)
            keep, gone = (i, j) if C[i].n >= C[j].n else (j, i)
            merge(keep, gone)
            if C[keep].n < limit:
                heapq.heappush(heap, (C[keep].n, keep))

    grow(grow_to, cap)
    grow(lo, cap)
    return C


def tidy(C, units, adj, doors, dx, dy, cap):
    """Hand a block that mostly touches another sector to that sector (3 rounds), then
    rebuild the sector clusters so their neighbour lists are right for the zone step."""
    owner = {u: ci for ci, c in enumerate(C) if c.alive for u in c.units}
    nbr = collections.defaultdict(list)
    for (i, j), (cl, br) in adj.items():
        if i != j:
            w = cl + br
            nbr[i].append((j, w)); nbr[j].append((i, w))
    size = collections.Counter()
    count = collections.Counter()
    for u, ci in owner.items():
        size[ci] += len(units[u]['doors']); count[ci] += 1
    for _ in range(3):
        moved = 0
        for u in range(len(units)):
            me = owner[u]
            if count[me] <= 1:
                continue
            w = collections.Counter()
            for v, wt in nbr[u]:
                w[owner[v]] += wt
            own = w.pop(me, 0)
            if not w:
                continue
            to, tw = w.most_common(1)[0]
            n = len(units[u]['doors'])
            if tw > 2 * own and size[to] + n <= cap and size[me] - n >= MIN:
                owner[u] = to; moved += 1
                size[me] -= n; size[to] += n; count[me] -= 1; count[to] += 1
        if not moved:
            break
    groups = collections.defaultdict(list)
    for u, ci in owner.items():
        groups[ci].append(u)
    base = seed(units, doors, adj, dx, dy)
    out = []
    for ci, us in groups.items():
        c = base[us[0]]
        for u in us[1:]:
            b = base[u]
            c.units += b.units; c.n += b.n; c.sx += b.sx; c.sy += b.sy; c.ss += b.ss
            c.never += b.never; c.last = sorted(c.last + b.last); c.cities.update(b.cities); c.rural += b.rural
        out.append(c)
    idx = {u: k for k, c in enumerate(out) for u in c.units}
    for c in out:
        c.nb = {}
    for (i, j), (cl, br) in adj.items():
        a_, b_ = idx[i], idx[j]
        if a_ != b_:
            for x, y in ((a_, b_), (b_, a_)):
                cur = out[x].nb.setdefault(y, [0, 0]); cur[0] += cl; cur[1] += br
    return out


def walk(items, xy, nb):
    """Order items so each next one touches the last: start in the north west corner."""
    left = set(items)
    cur = min(left, key=lambda i: xy[i][0] - xy[i][1])
    out = [cur]; left.discard(cur)
    while left:
        near = [j for j in nb.get(cur, ()) if j in left] or list(left)
        cur = min(near, key=lambda j: (xy[j][0] - xy[cur][0]) ** 2 + (xy[j][1] - xy[cur][1]) ** 2)
        out.append(cur); left.discard(cur)
    return out


def town_code(city, taken):
    """Always four capital letters. One word: first four (MASS). Two: two of each
    (Glens Falls GLFA). Three: initial, initial, two (South Glens Falls SGFA). More:
    initials (Lake In The Hills LITH). A clash falls back to first letter plus the
    consonants (Waterford WATE, Watertown WTRT), then first three plus A to Z."""
    w = [x.upper() for x in re.sub(r'[^A-Za-z ]', ' ', city).split()] or ['X']
    if len(w) == 1:
        first = w[0][:4]
    elif len(w) == 2:
        first = w[0][:2] + w[1][:2]
    elif len(w) == 3:
        first = w[0][0] + w[1][0] + w[2][:2]
    else:
        first = ''.join(x[0] for x in w[:4])
    whole = ''.join(w)
    skel = whole[0] + ''.join(c for c in whole[1:] if c not in 'AEIOUY')
    tries = [first, skel[:4]] + [whole[:3] + c for c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ']
    for code in tries:
        code = (code + 'XXXX')[:4]
        if taken.get(code, city) == city:
            taken[code] = city
            return code
    raise ValueError(f'no free town code for {city}')


def outline(clusters, units, faces, dx, dy):
    """One traceable shape per sector.

    Town sector (houses under 60 m apart): the edges are the street centrelines between
    its blocks, so drawing it in SalesRabbit is clicking intersection to intersection,
    and the outside edge is a plain loop around the leads (concave hull + 45 m).
    Rural sector: just the plain loop around its leads, both sides of the road, since
    blocks out there are miles across. Groups of houses more than 800 m apart get their
    own loop; groups of 1 or 2 that far out are left off the outline (counted).
    Rural loops never overlap a shape already drawn."""
    from sklearn.cluster import DBSCAN
    from scipy.spatial import cKDTree
    polys, strays, drawn = {}, 0, []
    unit_by_door = {a_: ui for ui, u in enumerate(units) for a_ in u['doors']}
    order = sorted(range(len(clusters)), key=lambda s_: -clusters[s_].n)
    kinds = {}
    for s_ in order:
        c = clusters[s_]
        mem = np.array([a_ for u in c.units for a_ in units[u]['doors']])
        xy = np.c_[dx[mem], dy[mem]]
        # a town sector is one whose houses mostly sit in real city blocks (< 0.25 km2);
        # a string of houses along a county road is close together but still rural
        small = sum(1 for a_ in mem if faces[units[unit_by_door[a_]]['face']].area < 250_000)
        town = small >= 0.6 * len(mem)
        kinds[s_] = town
    # One rule everywhere: a sector is its whole blocks, clipped to one shared outline
    # of where the leads are. Town houses get a tight loop (concave hull + 45 m);
    # each rural sector's houses a filled straight-sided one (convex hull + 80 m), so a
    # rural sector is a solid shape whose edges are roads or that plain loop.
    allm = np.array([a_ for c in clusters for u in c.units for a_ in units[u]['doors']])
    is_town = np.array([kinds[s_] for s_, c in enumerate(clusters) for u in c.units for _ in units[u]['doors']])
    # Town: the sector's blocks, clipped to one shared loop round all the town houses, so
    # neighbours meet exactly on a street. Country: no blocks at all, just a simple hull
    # round the houses (few corners, few pieces), each one taking what the bigger ones
    # beside it have not already claimed.
    hulls = []
    txy = np.c_[dx[allm[is_town]], dy[allm[is_town]]]
    if len(txy):
        lab = DBSCAN(eps=300, min_samples=1).fit_predict(txy)
        for l in set(lab.tolist()):
            g = txy[lab == l]
            if len(g) >= 3:
                hulls.append(shapely.concave_hull(shapely.multipoints(g), ratio=0.3)
                             .buffer(45, join_style='mitre', mitre_limit=2.0))
    town_region = shapely.union_all(hulls) if hulls else shapely.Polygon()
    for s_, c in enumerate(clusters):
        if not kinds[s_]:
            continue
        mem = np.array([a_ for u in c.units for a_ in units[u]['doors']])
        mine = shapely.multipoints(np.c_[dx[mem], dy[mem]])
        blocks = shapely.union_all([faces[f] for f in {units[u]['face'] for u in c.units}])
        g = shapely.make_valid(blocks.intersection(town_region))
        g = shapely.union_all([p for p in shapely.get_parts(g)
                               if p.geom_type == 'Polygon' and p.area > 900 and p.intersects(mine)])
        if not g.is_empty:
            polys[s_] = g.simplify(6, preserve_topology=True)
    # Country shapes: one simple hull per sector, then where two overlap they are cut
    # apart by a straight line halfway between them, so neither swallows the other's
    # houses and both edges stay straight.
    rural = sorted((s_ for s_ in range(len(clusters)) if not kinds[s_]), key=lambda k: -clusters[k].n)
    shape, mid = {}, {}
    for s_ in rural:
        c = clusters[s_]
        mem = np.array([a_ for u in c.units for a_ in units[u]['doors']])
        xy = np.c_[dx[mem], dy[mem]]
        lab = DBSCAN(eps=RURAL_GROUP, min_samples=1).fit_predict(xy) if len(xy) > 1 else np.zeros(1, dtype=int)
        shape[s_] = shapely.union_all([shapely.convex_hull(shapely.multipoints(xy[lab == l]))
                                       .buffer(100, join_style='mitre', mitre_limit=2.0)
                                       for l in set(lab.tolist())])
        mid[s_] = xy.mean(axis=0)

    def half(a, b):
        """everything on a's side of the line halfway between a and b"""
        vx, vy = b[0] - a[0], b[1] - a[1]
        n = math.hypot(vx, vy)
        if n < 1:
            return None
        vx, vy = vx / n, vy / n
        mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
        R = 200_000
        return shapely.Polygon([(mx - vy * R, my + vx * R), (mx + vy * R, my - vx * R),
                                (mx + vy * R - vx * R, my - vx * R - vy * R),
                                (mx - vy * R - vx * R, my + vx * R - vy * R)])

    for x, i in enumerate(rural):
        for j in rural[x + 1:]:
            if not shape[i].intersects(shape[j]):
                continue
            hi, hj = half(mid[i], mid[j]), half(mid[j], mid[i])
            if hi is None:
                continue
            shape[i] = shapely.make_valid(shape[i].intersection(hi))
            shape[j] = shapely.make_valid(shape[j].intersection(hj))
    town_drawn = shapely.union_all([g.buffer(2) for g in polys.values()]) if polys else None
    for s_ in rural:
        g = shape[s_]
        if town_drawn is not None:
            g = shapely.make_valid(g.difference(town_drawn))
        mem = np.array([a_ for u in clusters[s_].units for a_ in units[u]['doors']])
        mine = shapely.multipoints(np.c_[dx[mem], dy[mem]])
        keep = [p for p in shapely.get_parts(g)
                if p.geom_type == 'Polygon' and p.area > 40_000 and p.intersects(mine)]
        if not keep:
            keep = [p for p in shapely.get_parts(g) if p.geom_type == 'Polygon' and p.intersects(mine)]
        g = shapely.union_all(keep).simplify(80, preserve_topology=True)
        if not g.is_empty:
            polys[s_] = g
    # fill holes (a pond or a lot with no leads inside a sector) unless another sector is there
    solid = {k: shapely.union_all([shapely.Polygon(p.exterior) for p in shapely.get_parts(g) if p.geom_type == 'Polygon'])
             for k, g in polys.items()}
    for k in list(polys):
        others = [polys[j] for j in polys if j != k and polys[j].intersects(solid[k])]
        g = solid[k].difference(shapely.union_all(others)) if others else solid[k]
        polys[k] = shapely.union_all([p for p in shapely.get_parts(shapely.make_valid(g)) if p.geom_type == 'Polygon' and p.area > 900])
    return polys, strays


def to_latlon(g, P):
    """shapely polygon/multipolygon in metres -> Leaflet [[[lat,lon],...ring],...poly]"""
    out = []
    for p in shapely.get_parts(g):
        if p.geom_type != 'Polygon' or p.area < 400:
            continue
        rings = []
        for ring in [p.exterior] + list(p.interiors):
            xy = np.asarray(ring.coords)
            la, lo = P.inv(xy[:, 0], xy[:, 1])
            rings.append([[round(a, 6), round(b, 6)] for a, b in zip(la.tolist(), lo.tolist())])
        out.append(rings)
    return out


def cut(isp, only=None, merge=False):
    """Cut sectors. Default: every door, from scratch.

    only   cut just these lead ids (the rest of the cut is left alone)
    merge  keep the sectors already frozen in <ISP>-cut.json and add to them. Existing
           names, shapes and door assignments are never rewritten; a new zone carries on
           numbering inside its town code, so MASS 1..4 gains MASS 5 rather than renumbering."""
    doors = json.load(open(os.path.join(CACHE, f'{isp}-doors.json')))
    byid = {d['id']: d for d in doors}
    if only is not None:
        byid = {k: v for k, v in byid.items() if k in only}
    areas = json.load(open(os.path.join(CACHE, f'{isp}-areas.json')))
    old = {}
    if merge:
        path = os.path.join(SECTORS, f'{isp}-cut.json')
        if os.path.exists(path):
            old = json.load(open(path))
    sectors, door_sec, zones, strays, reassigned = [], {}, {}, 0, 0
    for ar in areas:
        ds = [byid[i] for i in ar['doors'] if i in byid]
        if not ds:
            continue
        P = Proj(float(np.mean([d['lat'] for d in ds])), float(np.mean([d['lon'] for d in ds])))
        roads, barriers = load_osm([os.path.join(CACHE, o) for o in ar['osm']] if isinstance(ar['osm'], list) else os.path.join(CACHE, ar['osm']), P)
        if not roads:
            print(f'  area {ar["area"]}: no roads in OSM, skipped {len(ds)} doors'); continue
        unit_of, units, adj, faces, dx, dy = cut_area(ds, roads, barriers, P)
        C = agglomerate(seed(units, ds, adj, dx, dy), MIN, GROW_TO, SOFT_MAX, MAX, 'prefer')
        C = tidy(C, units, adj, ds, dx, dy, MAX)
        clusters, Z, snb = lift(C)
        agglomerate(Z, ZONE_MIN, ZONE_GROW_TO, ZONE_SOFT_MAX, ZONE_MAX, 'strict')
        zone_of = {}
        for zi, z in enumerate(Z):
            if z.alive:
                for s_ in z.units:
                    zone_of[s_] = zi
        polys, st = outline(clusters, units, faces, dx, dy)
        strays += st
        zpolys = {}
        for zi in set(zone_of.values()):
            parts = [polys[s_] for s_ in Z[zi].units if s_ in polys]
            if parts:
                zpolys[zi] = shapely.union_all(parts).buffer(1).buffer(-1).simplify(4)
        base = len(sectors)
        members = {s_: [a for u in c.units for a in units[u]['doors']] for s_, c in enumerate(clusters)}
        # the drawn shape is what counts in SalesRabbit, so a house that landed inside a
        # neighbour's shape after smoothing belongs to that neighbour
        keys = list(polys)
        ptree = shapely.STRtree([polys[k] for k in keys])
        moved = 0
        for s_, mem in list(members.items()):
            for a in list(mem):
                p_ = Point(float(dx[a]), float(dy[a]))
                if s_ in polys and polys[s_].intersects(p_):
                    continue
                hit = ptree.query(p_, predicate='intersects')
                if len(hit):
                    t = keys[hit[0]]
                    if t != s_:
                        mem.remove(a); members[t].append(a); moved += 1
        reassigned += moved
        for s_, c in enumerate(clusters):
            mem = members[s_]
            if not mem:
                continue
            la, lo = P.inv(float(dx[mem].mean()), float(dy[mem].mean()))
            streets = collections.Counter(door_street(ds[a_]['street']).title() for a_ in mem)
            sectors.append({'doors': [ds[a]['id'] for a in mem], 'city': city_of(c),
                            'center': [round(la, 6), round(lo, 6)],
                            'zone': (ar['area'], zone_of[s_]),
                            'nb': [base + k for k in snb[s_]],
                            'streets': [x for x, _ in streets.most_common(4)],
                            'poly': to_latlon(polys.get(s_, shapely.Polygon()), P)})
        for zi, g in zpolys.items():
            big = max(shapely.get_parts(g), key=lambda q: q.area)
            # label where the doors are, pulled onto the zone if the middle falls outside it
            mem = [a for s_ in Z[zi].units for u in clusters[s_].units for a in units[u]['doors']]
            m = Point(float(dx[mem].mean()), float(dy[mem].mean()))
            lp = m if g.contains(m) else big.point_on_surface()
            la, lo = P.inv(lp.x, lp.y)
            zones[(ar['area'], zi)] = {'poly': to_latlon(g, P), 'center': [round(la, 6), round(lo, 6)]}
        sizes = sorted(c.n for c in clusters)
        print(f'  area {ar["area"]:>3}: {len(ds):>6} doors  {len(units):>5} streets  '
              f'-> {len(clusters):>3} sectors in {len(zpolys):>2} zones (min {sizes[0]}, median {sizes[len(sizes) // 2]}, max {sizes[-1]})', flush=True)

    # names: town code, zone, then sector in walking order.  MASS 1.1, MASS 1.2 ... MASS 2.1
    xy = {i: (s['center'][1] * 0.72, s['center'][0]) for i, s in enumerate(sectors)}
    nb = {i: s['nb'] for i, s in enumerate(sectors)}
    by_zone = collections.defaultdict(list)
    for i, s in enumerate(sectors):
        by_zone[s['zone']].append(i)
    by_city = collections.defaultdict(list)
    for zk, mem in by_zone.items():
        by_city[collections.Counter(sectors[i]['city'] for i in mem).most_common(1)[0][0]].append(zk)
    # names already in use keep their code, and their zone numbers are never reused
    out, zout = dict(old.get('sectors', {})), dict(old.get('zones', {}))
    door_sec.update(old.get('doors', {}))
    taken, code_of, zone_top = {}, {}, collections.Counter()
    for zname, z in zout.items():
        code = zname.rsplit(' ', 1)[0]
        taken[code] = z['city']; code_of[z['city']] = code
        try:
            zone_top[code] = max(zone_top[code], int(zname.rsplit(' ', 1)[1]))
        except ValueError:
            pass
    for city in sorted(by_city, key=lambda c: -sum(len(by_zone[z]) for z in by_city[c])):
        code = code_of.get(city) or town_code(city, taken)
        code_of[city] = code
        first = zone_top[code]
        zkeys = by_city[city]
        zxy = {z: (np.mean([xy[i][0] for i in by_zone[z]]), np.mean([xy[i][1] for i in by_zone[z]])) for z in zkeys}
        znb = {z: {sectors[j]['zone'] for i in by_zone[z] for j in nb[i]} - {z} for z in zkeys}
        for zn, zk in enumerate(walk(zkeys, zxy, znb), first + 1):
            zname = f'{code} {zn}'
            zg = zones.get(zk, {'poly': [], 'center': None})
            zout[zname] = {'city': city, 'poly': zg['poly'], 'center': zg['center']}
            for sn, i in enumerate(walk(by_zone[zk], xy, nb), 1):
                s = sectors[i]
                name = f'{code} {zn}.{sn}'
                out[name] = {'city': city, 'zone': zname, 'center': s['center'], 'poly': s['poly'], 'streets': s['streets']}
                for d in s['doors']:
                    door_sec[d] = name
        zone_top[code] = first + len(zkeys)
    os.makedirs(SECTORS, exist_ok=True)
    path = os.path.join(SECTORS, f'{isp}-cut.json')
    json.dump({'isp': isp, 'cut_on': old.get('cut_on', TODAY.isoformat()), 'last_extended': TODAY.isoformat(), 'rules': {'min': MIN, 'grow_to': GROW_TO, 'max': MAX},
               'zones': zout, 'sectors': out, 'doors': door_sec}, open(path, 'w'))
    sizes = sorted(collections.Counter(door_sec.values()).values())
    print(f'{len(out)} sectors in {len(zout)} zones, {len(door_sec)} doors -> {path}')
    print(f'  {reassigned} doors moved to the sector whose drawn shape holds them')
    print(f'  {strays} lone doors (1 or 2 houses far from the rest of their sector) are left off the outlines')
    print(f'  sizes: min {sizes[0]}, p10 {sizes[len(sizes) // 10]}, median {sizes[len(sizes) // 2]}, '
          f'p90 {sizes[len(sizes) * 9 // 10]}, max {sizes[-1]}; under {MIN}: {sum(1 for x in sizes if x < MIN)}, '
          f'over {MAX}: {sum(1 for x in sizes if x > MAX)}')


def _half(a, b):
    """everything on a's side of the line halfway between a and b"""
    vx, vy = b[0] - a[0], b[1] - a[1]
    n = math.hypot(vx, vy)
    if n < 1:
        return None
    vx, vy = vx / n, vy / n
    mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
    R = 200_000
    return shapely.Polygon([(mx - vy * R, my + vx * R), (mx + vy * R, my - vx * R),
                            (mx + vy * R - vx * R, my - vx * R - vy * R), (mx - vy * R - vx * R, my + vx * R - vy * R)])


def _polys(latlon):
    """cut json poly list -> one valid lon/lat geometry"""
    ps = [shapely.Polygon([(b, a) for a, b in q[0]], [[(b, a) for a, b in r] for r in q[1:]]).buffer(0) for q in latlon]
    return shapely.union_all(ps, grid_size=1e-6) if ps else shapely.Polygon()


def _latlon(g):
    return [[[[round(y, 6), round(x, 6)] for x, y in r.coords] for r in [q.exterior] + list(q.interiors)]
            for q in shapely.get_parts(g) if q.geom_type == 'Polygon' and q.is_valid and not q.is_empty]


def reshape(isp):
    """Redraw every sector as puzzle pieces, keeping names. (Sep 14 2026)

    Town: a sector is whole street blocks, never part of one, so every border is a street
    centreline and neighbours share the exact same edge. A block goes to the sector most of
    its doors are in; the others move with it. An empty block mostly walled in by sectors
    (a park, a lot) joins the one it shares the most edge with, one pass only so it never
    creeps into empty neighbourhoods, and small holes get filled.
    Country: a big road-bounded block is taken whole when its doors fill most of it,
    otherwise trimmed to a plain loop round them. A country sector's scattered pieces are
    joined into one straight-edged shape that never covers a neighbour.
    A small cut-off piece (RESHAPE_ORPHAN doors or fewer) joins the sector beside it."""
    from sklearn.cluster import DBSCAN
    path = os.path.join(SECTORS, f'{isp}-cut.json')
    cut_ = json.load(open(path))
    doors = {d['id']: d for d in json.load(open(os.path.join(CACHE, f'{isp}-doors.json')))}
    areas = json.load(open(os.path.join(CACHE, f'{isp}-areas.json')))
    sec_of = dict(cut_['doors'])
    before = dict(sec_of)
    drawn = collections.defaultdict(list)
    TOWN, WHOLE, FILL, HOLE, ORPHAN = 250_000, 1_000_000, 200_000, 40_000, 25
    for ar in areas:
        ds = [doors[i] for i in ar['doors'] if i in doors and i in sec_of]
        if not ds:
            continue
        P = Proj(float(np.mean([d['lat'] for d in ds])), float(np.mean([d['lon'] for d in ds])))
        osm = [os.path.join(CACHE, o) for o in ar['osm']] if isinstance(ar['osm'], list) else os.path.join(CACHE, ar['osm'])
        roads, (barriers, _) = load_osm(osm, P)
        if not roads:
            continue
        dx, dy = P.fwd([d['lat'] for d in ds], [d['lon'] for d in ds])
        pts = shapely.points(dx, dy)
        sid = lambda a_: sec_of[ds[a_]['id']]
        env = shapely.box(dx.min() - 800, dy.min() - 800, dx.max() + 800, dy.max() + 800)
        noded = shapely.union_all([r['line'] for r in roads] + barriers + [env.exterior])
        faces = [f for f in shapely.get_parts(shapely.polygonize(shapely.get_parts(noded))) if f.intersects(env)]
        tree = shapely.STRtree(faces)
        face_of = {}
        for a_, f in zip(*tree.query(pts, predicate='within')):
            face_of.setdefault(int(a_), int(f))
        miss = [a_ for a_ in range(len(ds)) if a_ not in face_of]
        if miss:
            near = tree.query_nearest(pts[miss], all_matches=False)
            for k, f in zip(near[0].tolist(), near[1].tolist()):
                face_of[miss[k]] = f
        in_face = collections.defaultdict(list)
        for a_, f in face_of.items():
            in_face[f].append(a_)
        tiles, owner = collections.defaultdict(list), {}
        for f, mem in in_face.items():
            cnt = collections.Counter(sid(a_) for a_ in mem)
            fa = faces[f].area
            whole = fa < TOWN
            if not whole and fa < WHOLE:
                reach = shapely.convex_hull(shapely.multipoints(np.c_[dx[mem], dy[mem]])).buffer(150)
                whole = fa <= 1.6 * reach.intersection(faces[f]).area
            if whole:
                s = cnt.most_common(1)[0][0]
                owner[f] = s; tiles[s].append(faces[f])
                for a_ in mem:
                    sec_of[ds[a_]['id']] = s
                continue
            # a big country block: each sector a plain loop round its own houses in it,
            # cut apart halfway where two loops meet
            pieces, mids = {}, {}
            for s in cnt:
                xy = np.c_[dx[[a_ for a_ in mem if sid(a_) == s]], dy[[a_ for a_ in mem if sid(a_) == s]]]
                lab = DBSCAN(eps=700, min_samples=1).fit_predict(xy) if len(xy) > 1 else np.zeros(1, dtype=int)
                g = shapely.union_all([shapely.convex_hull(shapely.multipoints(xy[lab == l])).buffer(200, join_style='mitre', mitre_limit=2.0)
                                       for l in set(lab.tolist())]).intersection(faces[f])
                g = g.buffer(-60, join_style='mitre').buffer(60, join_style='mitre').intersection(faces[f])
                pieces[s] = shapely.make_valid(g.union(shapely.multipoints(xy).buffer(30).intersection(faces[f])))
                mids[s] = xy.mean(axis=0)
            ks = sorted(pieces, key=lambda s: -cnt[s])
            for x, i in enumerate(ks):
                for j in ks[x + 1:]:
                    if pieces[i].intersection(pieces[j]).area > 1:
                        hi, hj = _half(mids[i], mids[j]), _half(mids[j], mids[i])
                        if hi is not None:
                            pieces[i] = shapely.make_valid(pieces[i].intersection(hi))
                            pieces[j] = shapely.make_valid(pieces[j].intersection(hj))
            for s, g in pieces.items():
                tiles[s].append(g)
            pl = list(pieces)
            pt = shapely.STRtree([pieces[s] for s in pl])
            for a_ in mem:
                if not pieces[sid(a_)].intersects(pts[a_]):
                    hit = pt.query(pts[a_], predicate='intersects')
                    if len(hit):
                        sec_of[ds[a_]['id']] = pl[hit[0]]
        # empty blocks mostly walled in by sectors: one pass, judged against the door blocks only
        seeded = dict(owner)
        for f, fg in enumerate(faces):
            if f in owner or f in in_face or fg.area > FILL:
                continue
            share = collections.Counter()
            for g in tree.query(fg.buffer(1)):
                g = int(g)
                if g in seeded:
                    share[seeded[g]] += fg.boundary.intersection(faces[g].buffer(1)).length
            if share and sum(share.values()) >= 0.6 * fg.length:
                s = share.most_common(1)[0][0]
                owner[f] = s; tiles[s].append(fg)

        def parts_of(s):
            return [p for p in shapely.get_parts(shapely.make_valid(shapely.union_all(tiles[s]))) if p.geom_type == 'Polygon']
        # an empty block touching two separate pieces of one sector joins them up
        for s in list(tiles):
            parts = parts_of(s)
            if len(parts) < 2:
                continue
            ptree = shapely.STRtree(parts)
            for f in {int(x) for x in tree.query(shapely.union_all(parts).buffer(2))}:
                if f in owner or f in in_face or faces[f].area > 2 * FILL:
                    continue
                if len(ptree.query(faces[f].buffer(2), predicate='intersects')) >= 2:
                    owner[f] = s; tiles[s].append(faces[f])
        # a small cut-off piece goes to the neighbour it shares the most border with
        for _ in range(2):
            allp = {s: parts_of(s) for s in tiles}
            mine_of = collections.defaultdict(list)
            for a_ in range(len(ds)):
                mine_of[sid(a_)].append(a_)
            for s, parts in allp.items():
                if len(parts) < 2:
                    continue
                big = max(parts, key=lambda p: sum(1 for a_ in mine_of[s] if p.intersects(pts[a_])))
                for p in parts:
                    if p is big:
                        continue
                    mine = [a_ for a_ in mine_of[s] if p.buffer(1).intersects(pts[a_])]
                    if len(mine) > ORPHAN:
                        continue
                    share = collections.Counter()
                    for t, tp in allp.items():
                        if t != s:
                            for q in tp:
                                if q.distance(p) < 2:
                                    share[t] += p.boundary.intersection(q.buffer(3)).length
                    if not share:
                        continue
                    t = share.most_common(1)[0][0]
                    tiles[s] = [shapely.make_valid(g.difference(p.buffer(0.5))) for g in tiles[s]]
                    tiles[t].append(p)
                    for a_ in mine:
                        sec_of[ds[a_]['id']] = t
        keys = list(tiles)
        geoms = [shapely.union_all([p for p in shapely.get_parts(shapely.make_valid(shapely.union_all(tiles[s])))
                                    if p.geom_type == 'Polygon']) for s in keys]
        # fill small holes nobody else owns
        for k, g in enumerate(geoms):
            solid = shapely.union_all([shapely.Polygon(p.exterior, [r for r in p.interiors if shapely.Polygon(r).area > HOLE])
                                       for p in shapely.get_parts(g) if p.geom_type == 'Polygon'])
            others = [h for j, h in enumerate(geoms) if j != k and h.intersects(solid)]
            geoms[k] = shapely.make_valid(solid.difference(shapely.union_all(others)) if others else solid)
        # country sectors: scattered pieces become one straight-edged shape, never over a neighbour
        mine_of = collections.defaultdict(list)
        rural = collections.Counter()
        for a_ in range(len(ds)):
            mine_of[sid(a_)].append(a_)
            if faces[face_of[a_]].area >= TOWN:
                rural[sid(a_)] += 1
        for k in sorted(range(len(keys)), key=lambda k: -len(mine_of[keys[k]])):
            s = keys[k]
            if rural[s] < 0.5 * max(len(mine_of[s]), 1) or len(shapely.get_parts(geoms[k])) < 2:
                continue
            mp = shapely.multipoints(np.c_[dx[mine_of[s]], dy[mine_of[s]]])
            g = shapely.union_all([geoms[k], mp.buffer(40)])
            g = g.buffer(1000, join_style='mitre', mitre_limit=2.0).buffer(-1000, join_style='mitre', mitre_limit=2.0)
            g = shapely.union_all([g.simplify(300).buffer(0), mp.buffer(40, cap_style='square')])
            g = g.buffer(300, join_style='mitre').buffer(-300, join_style='mitre')
            others = [geoms[j] for j in range(len(keys)) if j != k and geoms[j].intersects(g)]
            geoms[k] = shapely.make_valid(g.difference(shapely.union_all(others)) if others else g)
        # drop any piece holding none of the sector's own doors
        for k, s in enumerate(keys):
            mp = shapely.multipoints(np.c_[dx[mine_of[s]], dy[mine_of[s]]]) if mine_of[s] else None
            keep = [p for p in shapely.get_parts(geoms[k]) if p.geom_type == 'Polygon' and mp is not None and p.intersects(mp)]
            drawn[s].append((shapely.union_all(keep).simplify(2, preserve_topology=True) if keep else shapely.Polygon(), P))
    for s, parts in drawn.items():
        g = _polys([q for geo, P in parts for q in to_latlon(geo, P)])
        cut_['sectors'][s]['poly'] = _latlon(g)
        if not g.is_empty:
            mem = [doors[i] for i, v in sec_of.items() if v == s and i in doors]
            c = Point(float(np.mean([d['lon'] for d in mem])), float(np.mean([d['lat'] for d in mem]))) if mem else g.centroid
            c = c if g.contains(c) else max(shapely.get_parts(g), key=lambda q: q.area).point_on_surface()
            cut_['sectors'][s]['center'] = [round(c.y, 6), round(c.x, 6)]
    for z, zv in cut_['zones'].items():
        g = shapely.union_all([_polys(v['poly']) for v in cut_['sectors'].values() if v.get('zone') == z], grid_size=1e-6)
        if not g.is_empty:
            zv['poly'] = _latlon(g.buffer(0.00001).buffer(-0.00001))
    cut_['doors'] = sec_of
    cut_['reshaped'] = TODAY.isoformat()
    json.dump(cut_, open(path, 'w'))
    moved = sum(1 for k, v in sec_of.items() if before.get(k) != v)
    print(f'reshaped {len(drawn)} sectors; {moved} doors moved to the sector whose block they sit in -> {path}')


def extend(isp):
    """Cut sectors for leads that no sector covers yet, leaving the frozen cut alone.

    A new town (or a drop far outside the towns already cut) becomes its own sectors,
    named by the same rules. A handful of stragglers near existing sectors are left for
    the map to attach to the sector whose shape holds them, rather than becoming a sector
    of 6 doors."""
    from sklearn.cluster import DBSCAN
    doors = json.load(open(os.path.join(CACHE, f'{isp}-doors.json')))
    path = os.path.join(SECTORS, f'{isp}-cut.json')
    if not os.path.exists(path):
        print(f'no frozen cut yet, cutting everything'); return cut(isp)
    cut_ = json.load(open(path))
    known = set(cut_['doors'])
    geoms = []
    for sname, sc in cut_['sectors'].items():
        for poly in sc['poly']:
            geoms.append(shapely.Polygon([(b, a) for a, b in poly[0]],
                                         [[(b, a) for a, b in r] for r in poly[1:]]))
    tree = shapely.STRtree(geoms) if geoms else None
    loose = []
    for d in doors:
        if d['id'] in known:
            continue
        if tree is not None and len(tree.query(Point(d['lon'], d['lat']), predicate='within')):
            continue      # inside a sector already: the map hands it that sector
        loose.append(d)
    if not loose:
        print('every lead is already in a sector, nothing to cut'); return
    lat = np.array([d['lat'] for d in loose]); lon = np.array([d['lon'] for d in loose])
    X = np.c_[lat * 111.0, lon * 111.0 * np.cos(np.radians(lat.mean()))]
    lab = DBSCAN(eps=1.5, min_samples=1).fit_predict(X)
    keep, skipped = set(), 0
    for l, n in collections.Counter(lab.tolist()).items():
        if n >= EXTEND_MIN:
            keep |= {loose[i]['id'] for i in np.where(lab == l)[0].tolist()}
        else:
            skipped += n
    towns = collections.Counter(d['city'] for d in loose if d['id'] in keep)
    print(f'{len(loose)} leads in no sector: cutting {len(keep)} in {len(towns)} places '
          f'({", ".join(f"{c} {n}" for c, n in towns.most_common(6))})')
    if skipped:
        print(f'  {skipped} stragglers left to join the sector nearest them')
    if not keep:
        return
    cut(isp, only=keep, merge=True)
    reshape(isp)      # the new town gets puzzle piece outlines like the rest


# ---------------------------------------------------------------- stats + map

def sunday(d):
    return d - datetime.timedelta(days=(d.weekday() + 1) % 7)


def passes(days, gap=5):
    out = []
    for d in sorted(days):
        if out and d - out[-1][-1] < gap:
            out[-1].append(d)
        else:
            out.append([d])
    return out


def fmt(o):
    d = datetime.date.fromordinal(o)
    return d.strftime('%b ') + str(d.day)


def assign_new(doors, cut_):
    """Doors the cut has never seen: whichever outline holds them, else the nearest centre."""
    new = [d for d in doors if d['id'] not in cut_['doors']]
    if not new:
        return {}
    geoms, names = [], []
    for name, s in cut_['sectors'].items():
        for poly in s['poly']:
            geoms.append(shapely.Polygon([(b, a) for a, b in poly[0]], [[(b, a) for a, b in r] for r in poly[1:]]))
            names.append(name)
    tree = shapely.STRtree(geoms)
    cen = [(n, s['center']) for n, s in cut_['sectors'].items()]
    out = {}
    for d in new:
        hit = tree.query(Point(d['lon'], d['lat']), predicate='within')
        if len(hit):
            out[d['id']] = names[hit[0]]
        else:
            out[d['id']] = min(cen, key=lambda c: (c[1][0] - d['lat']) ** 2 + ((c[1][1] - d['lon']) * 0.72) ** 2)[0]
    return out


SHAPE_GAP = 800     # metres: doors further apart than this are separate pieces of an area
SHAPE_PAD = 45      # metres of margin around the outer doors
SHAPE_SIMPLIFY = 35 # metres: corner points closer to a straight line than this are dropped


def clean_shapes(groups, P):
    """Simple straight-edged outlines to draw, one convex piece per cluster of doors.

    The cut's own outlines follow every street block, which out in the country means
    long ragged shapes over empty forest with hundreds of corners. For the map each
    area is drawn instead as the hull of its doors with a small margin, and where two
    areas overlap they are split by one straight line placed between their doors. The
    cut (names, door assignments, what SalesRabbit gets) is untouched."""
    from sklearn.cluster import DBSCAN
    pieces = []                         # [name, polygon, door xy]
    for name, ds in groups.items():
        if not ds:
            continue
        x, y = P.fwd(np.array([d['lat'] for d in ds]), np.array([d['lon'] for d in ds]))
        xy = np.c_[x, y]
        lab = DBSCAN(eps=SHAPE_GAP, min_samples=1).fit_predict(xy) if len(xy) > 1 else [0]
        for l in set(lab):
            pts = xy[np.asarray(lab) == l]
            hull = shapely.convex_hull(shapely.multipoints(pts)).simplify(SHAPE_SIMPLIFY)
            g = hull.buffer(SHAPE_PAD, join_style='mitre', mitre_limit=1.6)
            pieces.append([name, g.simplify(SHAPE_SIMPLIFY / 2), pts])
    tree = shapely.STRtree([p[1] for p in pieces])
    for i, j in zip(*tree.query([p[1] for p in pieces], predicate='intersects')):
        if i >= j or pieces[i][0] == pieces[j][0]:
            continue
        A, B = pieces[i], pieces[j]
        if not A[1].intersects(B[1]):
            continue                    # already cut apart by an earlier line
        ca, cb = A[2].mean(0), B[2].mean(0)
        u = cb - ca
        n = np.hypot(*u)
        if n < 1:
            continue
        u = u / n
        # the line sits between the two sets of doors where they do not interleave,
        # else halfway between their middles
        a, b = (A[2] @ u).max(), (B[2] @ u).min()
        t = (a + b) / 2 if a < b else ((ca @ u) + (cb @ u)) / 2
        m = u * t
        v = np.array([-u[1], u[0]]) * 1e6
        U = u * 1e6
        side_a = shapely.Polygon([m + v, m - v, m - v - U, m + v - U])
        side_b = shapely.Polygon([m + v, m - v, m - v + U, m + v + U])
        A[1] = A[1].intersection(side_a)
        B[1] = B[1].intersection(side_b)
    out = collections.defaultdict(list)
    for name, g, _ in pieces:
        if not g.is_empty:
            out[name].append(g)
    return {k: to_latlon(shapely.union_all(v), P) for k, v in out.items()}


DROP_MIN = 10       # doors: a batch smaller than this is not a drop worth flagging
DROP_KEEP = 8       # drops the map lets you look back through


def lead_drops(isp, doors):
    """This ISP's lead drops, newest first. Batches no more than 2 days apart are one drop."""
    c = collections.Counter(d['added'] for d in doors if d.get('added'))
    out = []
    for day in sorted(c):
        o = datetime.date.fromisoformat(day).toordinal()
        if out and o - out[-1]['hi'] <= 2:
            out[-1]['hi'] = o; out[-1]['n'] += c[day]
        else:
            out.append({'lo': o, 'hi': o, 'n': c[day]})
    out = [x for x in out if x['n'] >= DROP_MIN][::-1][:DROP_KEEP]
    try:
        reg = json.load(open(os.path.join(ROOT, 'data', 'isp-imports.json')))
    except (OSError, ValueError):
        reg = {}
    for x in out:
        x['files'] = sorted({v['file'] for v in reg.values() if v.get('isp') == isp and v.get('file')
                             and x['lo'] <= datetime.date.fromisoformat(v['date']).toordinal() <= x['hi']})
    return out


def build_map(isp):
    doors = json.load(open(os.path.join(CACHE, f'{isp}-doors.json')))
    cut_ = json.load(open(os.path.join(SECTORS, f'{isp}-cut.json')))
    extra = {} if cut_.get('exact') else assign_new(doors, cut_)   # exact: rebuilt every run, a door outside it stays off
    sec_of = dict(cut_['doors']); sec_of.update(extra)
    today = TODAY.toordinal()
    groups = collections.defaultdict(list)
    for d in doors:
        if d['id'] in sec_of:
            groups[sec_of[d['id']]].append(d)
    # an exact cut (SalesRabbit's own areas, sector-maps.py sr_cut) counts every door inside
    # an area's outline, the way SalesRabbit does, so a door in two drawn areas counts in both
    if cut_.get('members'):
        by_id = {d['id']: d for d in doors}
        groups = collections.defaultdict(list, {n: [by_id[i] for i in ids if i in by_id]
                                                for n, ids in cut_['members'].items()})
    drops = lead_drops(isp, doors)
    drop_of = {}           # door id -> index into drops
    for d in doors:
        if d.get('added'):
            o = datetime.date.fromisoformat(d['added']).toordinal()
            for j, x in enumerate(drops):
                if x['lo'] <= o <= x['hi']:
                    drop_of[d['id']] = j; break
    stages = sorted({d['stage'] for d in doors if d['stage']})
    HP = Proj(float(np.mean([d['lat'] for d in doors])), float(np.mean([d['lon'] for d in doors])))
    # exact cuts keep the drawn outline; everything else is redrawn clean around its doors
    shapes = {} if cut_.get('exact') else clean_shapes({n: groups.get(n, []) for n in cut_['sectors']}, HP)
    sidx = {s: i for i, s in enumerate(stages)}
    week0 = sunday(TODAY - datetime.timedelta(weeks=25)).toordinal()
    data = []
    for name, s in cut_['sectors'].items():
        ds = groups.get(name, [])
        if not ds:
            continue
        lasts = sorted(day_no(d['days'][-1]) for d in ds if d['days'])
        k = len(lasts)
        rest = [today - x for x in lasts]
        wave = None
        if k:
            j, best = 0, (0, 0, 0)
            for i in range(k):
                while lasts[i] - lasts[j] > WAVE_DAYS - 1:
                    j += 1
                if i - j + 1 > best[0]:
                    best = (i - j + 1, lasts[j], lasts[i])
            wave = {'from': fmt(best[1]), 'to': fmt(best[2]), 'share': round(best[0] / k, 3),
                    'mid': (best[1] + best[2]) // 2, 'age': today - best[2]}
        alldays = sorted({day_no(x) for d in ds for x in d['days']})
        ps = passes(alldays)
        per_pass = []
        for p in ps[-4:]:
            lo, hi = p[0], p[-1]
            touched = sum(1 for d in ds if any(lo <= day_no(x) <= hi for x in d['days']))
            who = collections.Counter(rep for d in ds for dy_, rep, _ in d.get('marks', [])
                                      if rep and lo <= day_no(dy_) <= hi)
            per_pass.append([fmt(lo), fmt(hi), touched, [k for k, _ in who.most_common(4)]])
        weeks = [0] * 26
        for d in ds:
            seen = set()
            for x in d['days']:
                w = (sunday(datetime.date.fromisoformat(x)).toordinal() - week0) // 7
                if 0 <= w < 26 and w not in seen:
                    weeks[w] += 1; seen.add(w)
        hot = sum(1 for x in rest if x < 14)          # doors knocked in the last 2 weeks
        lately = sum(1 for x in rest if x < 28)
        ready = len(ds) - sum(1 for x in rest if x < 30)   # never knocked, or resting 30+ days
        st = collections.Counter(d['stage'] for d in ds if d['stage'])
        # born: the drop that brought the middle of this area's dropped doors, so the area
        # first showed up on the map with it. adds: doors later drops put into it.
        got = sorted((d['added'], drop_of.get(d['id'], -1)) for d in ds if d.get('added'))
        born = got[len(got) // 2][1] if got else -1
        adds = collections.Counter(drop_of[d['id']] for d in ds if d['id'] in drop_of and drop_of[d['id']] != born)
        rp = {}
        for d in ds:
            for dy_, rep, stg in d.get('marks', []):
                if not rep:
                    continue
                r = rp.setdefault(rep, {'doors': set(), 'last': '', 'contacts': set(), 'sold': set()})
                r['doors'].add(d['id']); r['last'] = max(r['last'], dy_)
                if stg in CONTACT: r['contacts'].add(d['id'])
                if stg == 'Sold': r['sold'].add(d['id'])
        reps = [[k, len(v['doors']), fmt(day_no(v['last'])), len(v['contacts']), len(v['sold'])]
                for k, v in sorted(rp.items(), key=lambda kv: (kv[1]['last'], len(kv[1]['doors'])), reverse=True)]
        data.append({
            'name': name, 'city': s['city'], 'zone': s.get('zone', ''), 'center': s['center'], 'poly': shapes.get(name) or s['poly'],
            'streets': s['streets'],
            'cities': ', '.join(c for c, _ in collections.Counter(d['city'] for d in ds).most_common(3)),
            'total': len(ds), 'worked': k, 'never': len(ds) - k,
            'contacts': sum(d['contact'] for d in ds), 'sold': sum(d['sold'] for d in ds),
            'rest': rest[len(rest) // 2] if rest else None,
            'rest90': sum(1 for r in rest if r >= 90), 'rest60': sum(1 for r in rest if r >= 60),
            'rest30': sum(1 for r in rest if r >= 30), 'hot': hot, 'lately': lately, 'ready': ready,
            'last': fmt(lasts[-1]) if k else None, 'first': fmt(min(day_no(d['days'][0]) for d in ds if d['days'])) if k else None,
            'wave': wave, 'passes': len(ps), 'recent': per_pass[::-1], 'weeks': weeks,
            'statuses': dict(st.most_common()), 'reps': reps,
            'born': born if born >= 0 else None, 'adds': {str(j): n for j, n in sorted(adds.items())},
        })
    if cut_.get('exact'):   # drawn areas overlap: biggest first, so the small ones sit on top and take the click
        data.sort(key=lambda s: -sum(shapely.Polygon([(b, a) for a, b in p[0]]).area for p in s['poly'] if len(p[0]) > 2))
    # an ISP's own read of each area (Lyte's turf tracker, scripts/lyte-areas.py), shown
    # on the area as their sheet has it
    turf_path = os.path.join(SECTORS, f'{isp}-turf.json')
    turf = json.load(open(turf_path)) if os.path.exists(turf_path) else None
    if turf:
        for s in data:
            if s['name'] in turf['areas']:
                s['turf'] = turf['areas'][s['name']]
    # a colour per sector, never shared with a sector it touches
    geoms = []
    for s in data:
        ps = [shapely.Polygon([(b, a) for a, b in poly[0]], [[(b, a) for a, b in r] for r in poly[1:]]) for poly in s['poly']]
        geoms.append(shapely.union_all(ps).buffer(0.0004) if ps else shapely.Point(s['center'][1], s['center'][0]).buffer(0.001))
    tree = shapely.STRtree(geoms)
    touch = collections.defaultdict(set)
    for i, j in zip(*tree.query(geoms, predicate='intersects')):
        if i != j:
            touch[int(i)].add(int(j))
    for i in sorted(range(len(data)), key=lambda i: -len(touch[i])):
        used = {data[j].get('ci') for j in touch[i]}
        data[i]['ci'] = next(k for k in range(99) if k not in used)
    pts = []
    for d in doors:
        if d['id'] in sec_of:
            r = today - day_no(d['days'][-1]) if d['days'] else -1
            pts.append([d['lat'], d['lon'], r, sidx.get(d['stage'], -1), drop_of.get(d['id'], -1)])
    # a zone is drawn around its trimmed sectors, not the old sprawling outline
    zp = collections.defaultdict(list)
    for s in data:
        if s['zone'] and s['poly']:
            zp[s['zone']].append(_polys(s['poly']))
    zones = []
    for k, z in cut_.get('zones', {}).items():
        poly = z['poly']
        if zp.get(k):
            g = shapely.union_all(zp[k]).buffer(0.0004, join_style='mitre').buffer(-0.0004, join_style='mitre')
            poly = _latlon(g.simplify(0.0002, preserve_topology=True)) or poly
        zones.append({'name': k, 'city': z['city'], 'poly': poly, 'center': z.get('center')})
    meta = {'isp': isp, 'built': TODAY.isoformat(), 'cut_on': cut_['cut_on'], 'stages': stages, 'zones': zones,
            'week0': datetime.date.fromordinal(week0).isoformat(), 'doors': len(pts),
            'new_since_cut': len(extra),
            'turf': {'asof': turf['asof'], 'tab': turf['tab']} if turf else None,
            'drops': [{'date': datetime.date.fromordinal(x['lo']).isoformat(),
                       'to': datetime.date.fromordinal(x['hi']).isoformat(), 'doors': x['n'], 'files': x['files'],
                       'new': [s['name'] for s in data if s['born'] == j],
                       'grew': sorted(([s['name'], s['adds'][str(j)]] for s in data if str(j) in s['adds']),
                                      key=lambda g: -g[1])}
                      for j, x in enumerate(drops)]}
    tpl = open(os.path.join(ROOT, 'scripts', 'sector-map.html')).read()
    html = (tpl.replace('__ISP__', isp)
               .replace('/*DATA*/null', json.dumps(data, separators=(',', ':')))
               .replace('/*PTS*/null', json.dumps(pts, separators=(',', ':')))
               .replace('/*META*/null', json.dumps(meta, separators=(',', ':'))))
    out_dir = os.path.join(MAPS, isp.lower())
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, 'index.html')
    open(path, 'w').write(html)
    # the same payload on its own, for the GrowSales Maps page (scripts/sector-maps.py uploads it)
    json.dump({'meta': meta, 'data': data, 'pts': pts}, open(os.path.join(out_dir, 'data.json'), 'w'),
              separators=(',', ':'))
    # a flat sheet of the sectors too
    with open(os.path.join(out_dir, f'{isp} sectors.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['Sector', 'Zone', 'Cities', 'Main streets', 'Doors', 'Never knocked', 'Worked', 'Median rest (days)',
                    'Rested 90+', 'Last group hit', 'Share in that hit', 'Last knock', 'Passes', 'Contacts', 'Sold'])
        for s in sorted(data, key=lambda s: (-(s['rest'] if s['rest'] is not None else 9999), s['name'])):
            wv = s['wave']
            w.writerow([s['name'], s['zone'], s['cities'], ' / '.join(s['streets']), s['total'], s['never'], s['worked'],
                        s['rest'] if s['rest'] is not None else '', s['rest90'],
                        f"{wv['from']} to {wv['to']}" if wv else '', f"{wv['share']:.0%}" if wv else '',
                        s['last'] or '', s['passes'], s['contacts'], s['sold']])
    print(f'{len(data)} sectors, {len(pts)} doors ({len(extra)} new since the cut) -> {path}')
    if meta['drops']:
        x = meta['drops'][0]
        print(f"  latest drop {x['date']}: {x['doors']} doors, {len(x['new'])} new areas"
              + (f" ({', '.join(x['new'][:6])})" if x['new'] else '')
              + f", {sum(g[1] for g in x['grew'])} doors into {len(x['grew'])} existing areas")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('isp')
    ap.add_argument('--extract', action='store_true')
    ap.add_argument('--cut', action='store_true')
    ap.add_argument('--extend', action='store_true',
                    help='cut only leads no sector covers yet, keeping the frozen cut')
    ap.add_argument('--reshape', action='store_true',
                    help='redraw sector outlines as whole street blocks, keeping names')
    ap.add_argument('--map', action='store_true')
    a = ap.parse_args()
    if a.extract:
        extract(a.isp)
    if a.cut:
        cut(a.isp)
    if a.extend:
        extend(a.isp)
    if a.reshape:
        reshape(a.isp)
    if a.map:
        build_map(a.isp)


if __name__ == '__main__':
    main()
