#!/usr/bin/env python3
"""Pull the OpenStreetMap roads, railways and rivers around an ISP's doors.

    python3 scripts/osm-fetch.py SLIC

Reads data/osm-cache/<ISP>-doors.json (written by sector-build.py --extract),
fetches every ~5 km tile that holds a door from Overpass once (cached as
data/osm-cache/tile-<i>_<j>.json, shared by every ISP), and groups the doors into
areas 1.5 km apart in data/osm-cache/<ISP>-areas.json.
"""
import collections, json, math, os, subprocess, sys, time
import numpy as np
from sklearn.cluster import DBSCAN

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'data', 'osm-cache')
HOSTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter']
ROADS = ('motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|road|'
         'motorway_link|trunk_link|primary_link|secondary_link|tertiary_link')


def areas(doors):
    lat = np.array([d['lat'] for d in doors]); lon = np.array([d['lon'] for d in doors])
    X = np.c_[lat * 111.0, lon * 111.0 * np.cos(np.radians(lat.mean()))]
    return DBSCAN(eps=1.5, min_samples=1).fit_predict(X)


def fetch(bbox, first=0):
    s, w, n, e = bbox
    b = f'{s},{w},{n},{e}'
    q = (f'[out:json][timeout:300];('
         f'way["highway"~"^({ROADS})$"]({b});'
         f'way["railway"="rail"]({b});'
         f'way["waterway"~"^(river|canal)$"]({b});'
         f');out geom;')
    for attempt in range(6):
        host = HOSTS[(first + attempt) % len(HOSTS)]
        r = subprocess.run(['curl', '-s', '-m', '360', '--data-urlencode', f'data={q}', host],
                           capture_output=True, text=True)
        try:
            return json.loads(r.stdout)
        except Exception:
            print(f'    retry {attempt + 1} on {host}', flush=True); time.sleep(5 * (attempt + 1))
    sys.exit('Overpass kept failing')


TILE_LAT, TILE_LON = 0.05, 0.07          # about 5.5 km square in upstate NY
BLOCK = 3                                # tiles per side in one request


def main():
    isp = sys.argv[1]
    doors = json.load(open(os.path.join(CACHE, f'{isp}-doors.json')))
    lab = areas(doors)
    groups = collections.defaultdict(list)
    for d, l in zip(doors, lab):
        groups[int(l)].append(d)
    # only the tiles that hold doors (plus a 600 m apron), so rural areas stay small
    need = set()
    for d in doors:
        for dl in (-0.006, 0, 0.006):
            for dn in (-0.008, 0, 0.008):
                need.add((math.floor((d['lat'] + dl) / TILE_LAT), math.floor((d['lon'] + dn) / TILE_LON)))
    print(f'{len(need)} tiles', flush=True)
    todo = [(i, j) for i, j in sorted(need) if not os.path.exists(os.path.join(CACHE, f'tile-{i}_{j}.json'))]
    # The public servers queue every request for seconds to minutes whatever its size,
    # so ask for 3x3 blocks of tiles at once and split each answer back into tiles.
    blocks = collections.defaultdict(set)
    for i, j in todo:
        blocks[(i // BLOCK, j // BLOCK)].add((i, j))
    done = [0]

    def one(k_b):
        k, ((bi, bj), tiles) = k_b
        lo_i, lo_j = min(i for i, _ in tiles), min(j for _, j in tiles)
        hi_i, hi_j = max(i for i, _ in tiles), max(j for _, j in tiles)
        bbox = (round(lo_i * TILE_LAT, 4), round(lo_j * TILE_LON, 4),
                round((hi_i + 1) * TILE_LAT, 4), round((hi_j + 1) * TILE_LON, 4))
        t = time.time()
        data = fetch(bbox, k % len(HOSTS))   # alternate servers, each has its own per-IP limit
        per = collections.defaultdict(list)
        for el in data.get('elements', []):
            g = [p for p in el.get('geometry') or [] if p]
            if not g:
                continue
            touched = {(math.floor(p['lat'] / TILE_LAT), math.floor(p['lon'] / TILE_LON)) for p in g}
            for tl in touched & tiles:
                per[tl].append(el)
        for i, j in tiles:
            path = os.path.join(CACHE, f'tile-{i}_{j}.json')
            json.dump({'elements': per.get((i, j), [])}, open(path + '.part', 'w'))
            os.replace(path + '.part', path)
        done[0] += 1
        print(f'  {done[0]}/{len(blocks)} block {bi}_{bj} ({len(tiles)} tiles): '
              f'{len(data.get("elements", []))} ways, {time.time() - t:.0f}s', flush=True)

    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(2) as ex:
        list(ex.map(one, enumerate(sorted(blocks.items()))))
    index = []
    for l, ds in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        tiles = sorted({(math.floor(d['lat'] / TILE_LAT), math.floor(d['lon'] / TILE_LON)) for d in ds}
                       | {t for d in ds for t in [(math.floor((d['lat'] + a) / TILE_LAT), math.floor((d['lon'] + b) / TILE_LON))
                                                  for a in (-0.006, 0.006) for b in (-0.008, 0.008)]})
        index.append({'area': l, 'doors': [d['id'] for d in ds], 'osm': [f'tile-{i}_{j}.json' for i, j in tiles]})
    json.dump(index, open(os.path.join(CACHE, f'{isp}-areas.json'), 'w'))
    print(f'{len(index)} areas cached')


if __name__ == '__main__':
    main()
