"""Whose door is this. One answer for knock-export.py and knock-report.py.

Order of evidence, strongest first:
  1. batch    the door's SalesRabbit import_id, looked up in data/isp-imports.json
              (node scripts/isp-registry.mjs keeps that current). A batch is one
              ISP's file, so this can never put a door on two reports.
  2. zip      rep-created doors have no batch. They take the ISP that owns the
              rest of their zip, judged from the batch-labeled doors in it.
  3. map      data/isps.json states/cities, the old rule, for a zip nobody has
              imported into yet.
  4. None     unassigned: a batch nobody has labeled, or a zip nobody claims.
              These are reported, never silently folded into a state.
"""
import collections, json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REG = os.path.join(ROOT, 'data', 'isp-imports.json')
ISPS = os.path.join(ROOT, 'data', 'isps.json')


def _map_isp(d, cfg):
    """data/isps.json rules (states, cities, exclude_cities, also, zips)."""
    city = d['city'].strip().lower(); st = d['state'].strip().upper(); z = d['zip'][:5]
    for name, v in cfg.items():
        if name.startswith('_') or not isinstance(v, dict): continue
        if any(a.split(',')[0].strip().lower() == city and a.split(',')[1].strip().upper() == st
               for a in v.get('also', [])):
            return name
        cities = {c.lower() for c in v.get('cities', [])}
        states = {s.upper() for s in v.get('states', [])}
        zips = set(v.get('zips', []))
        excl = {c.lower() for c in v.get('exclude_cities', [])}
        if ((not cities or city in cities) and city not in excl
                and (not states or st in states) and (not zips or z in zips)):
            return name
    return None


class Territory:
    def __init__(self, doors):
        self.reg = json.load(open(REG)) if os.path.exists(REG) else {}
        self.cfg = json.load(open(ISPS))
        self.batch = {k: v.get('isp') for k, v in self.reg.items()}
        # zip -> ISP that imported most doors there
        zc = collections.defaultdict(collections.Counter)
        for d in doors:
            isp = self.batch.get(d.get('import_id') or '')
            if isp: zc[d['zip'][:5]][isp] += 1
        self.zip_isp = {z: c.most_common(1)[0][0] for z, c in zc.items()}
        self.how = collections.Counter()
        self.unlabeled_batches = collections.Counter()

    def isp_of(self, d):
        b = d.get('import_id') or ''
        if b:
            if b in self.batch:
                if self.batch[b]:
                    self.how['batch'] += 1; return self.batch[b]
                self.unlabeled_batches[b] += 1; self.how['unassigned'] += 1; return None
            # batch the registry has never seen (new import since last sync)
            self.unlabeled_batches[b] += 1; self.how['unassigned'] += 1; return None
        isp = self.zip_isp.get(d['zip'][:5])
        if isp: self.how['zip'] += 1; return isp
        isp = _map_isp(d, self.cfg)
        if isp: self.how['map'] += 1; return isp
        self.how['unassigned'] += 1; return None

    def select(self, doors, isp):
        want = isp.lower()
        return [d for d in doors if (self.isp_of(d) or '').lower() == want]

    def unassigned(self, doors):
        return [d for d in doors if self.isp_of(d) is None]


def isp_names(cfg=None):
    cfg = cfg or json.load(open(ISPS))
    return [k for k, v in cfg.items() if not k.startswith('_') and isinstance(v, dict)]
