// TDS doors from TDS's own SalesRabbit (classic platform: web.salesrabbit.com,
// capi.salesrabbit.com/v1), for the TDS sector map.
//
//   node scripts/tds-sr-sync.mjs            # details for every lead Amplify saw Grow knock + compile
//   node scripts/tds-sr-sync.mjs --sweep    # also list every TDS lead on the map (all of TDS, not wanted by default)
//   node scripts/tds-sr-sync.mjs --compile  # rebuild the csv/jsonl from what is cached
//   node scripts/tds-sr-sync.mjs --refresh  # re-fetch every lead's detail (status/owner moved)
//
// Why not grow-sync.mjs --tenant: TDS is on the OLD SalesRabbit. apis.salesrabbit.com
// says "invalid token" to its bearer, there is no es_search. What the classic web
// map uses is POST /v1/markers {map:{zoom,sections:{k:{bounds,key}}},filters:{}}:
// clusters (point_count, bounds) at low zoom, single leads with coordinates at
// high zoom. Recursing into every cluster's bounds until nothing clusters lists
// every lead id + GPS. GET /v1/leads/<id> then gives street/city/zip/status/owner.
// Knock history is NOT here (no activity endpoint found); it comes from Amplify's
// knock_events (source=tds), which already carries every TDS disposition per lead.
//
// Token: data/sr-auth-tds.json {headers:{Authorization}}, captured from the app by
// a signed-in window (see memory tds-sector-map). Expires like any session token.
//
// Outputs (read by sector-build.py extract('TDS'), same shapes as the Grow files):
//   data/tds-leads.jsonl          {id, coordinates:{coordinates:[lon,lat]}, ...detail}
//   data/tds-doors-by-area.csv    lead_id,street,unit,city,state,zip,current_stage,ever_sold,import_id
//   data/tds-activity.csv         lead_id,datetime,event,rep,new_stage,distance (from knock_events)
import { existsSync, readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const D = (f) => join(ROOT, 'data', f);
const argv = process.argv.slice(2), flag = (n) => argv.includes(n);
const API = 'https://capi.salesrabbit.com/v1';
const SB = 'https://cmkfohwbejcztctrpdnt.supabase.co';
const LEADS = D('tds-leads.jsonl'), DOORS_CSV = D('tds-doors-by-area.csv'), ACT_CSV = D('tds-activity.csv');
const SWEEP = D('tds-markers.json');       // last sweep: id -> [lat, lon]
const TOKEN_DEAD = 3;

const auth = (() => { try { return JSON.parse(readFileSync(D('sr-auth-tds.json'), 'utf8')).headers; } catch (e) { return null; } })();
if (!auth) { console.error('No TDS token (data/sr-auth-tds.json). Sign in to TDS SalesRabbit in a recorder window first.'); process.exit(TOKEN_DEAD); }
const H = { ...auth, 'Content-Type': 'application/json', Accept: 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

async function api(path, init, tries = 4) {
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch(API + path, { headers: H, ...init });
      if (r.status === 401 || r.status === 403) { console.error(`SalesRabbit rejected the TDS token (${r.status}). Sign in again to re-capture it.`); process.exit(TOKEN_DEAD); }
      const t = await r.text();
      if (r.ok && t) return JSON.parse(t);
      if (r.status === 404) return null;
      // the markers call answers 500 with an empty body for boxes it dislikes; back off and retry
    } catch (e) {}
    await sleep(700 * (a + 1));
  }
  return null;
}

// ------------------------------------------------------------- MARKERS SWEEP
const markers = async (zoom, b) => {
  const j = await api('/markers', { method: 'POST', body: JSON.stringify({ map: { zoom, sections: { 0: { bounds: b, key: '1:1' } } }, filters: {} }) });
  return j && j.leads && j.leads[0] ? j.leads[0].features : null;
};

async function sweep() {
  // Start from a US-wide grid at zoom 6 (the app's own first request), then
  // descend into each cluster's reported bounds. A cluster that still will not
  // split at zoom 20 is stacked leads on one point; split its box in four anyway,
  // and at the floor take the cluster centre for every lead it hides (rare).
  const out = new Map();     // id -> [lat, lon]
  let calls = 0, stuck = 0;
  const seen = new Set();
  const walk = async (zoom, b) => {
    const key = `${zoom}:${b.north.toFixed(5)},${b.south.toFixed(5)},${b.east.toFixed(5)},${b.west.toFixed(5)}`;
    if (seen.has(key)) return; seen.add(key);
    const f = await markers(zoom, b); calls++;
    if (!f) { console.log(`  no answer at zoom ${zoom} ${JSON.stringify(b)}`); return; }
    for (const x of f) {
      const p = x.properties || {};
      if (!p.cluster) { out.set(String(x.id), x.geometry.coordinates); continue; }
      const cb = x.bounds && x.bounds.north > x.bounds.south ? x.bounds : b;
      if (zoom >= 20 || (cb.north - cb.south < 0.0002 && cb.east - cb.west < 0.0002)) {
        stuck += p.point_count; out.set(`cluster:${x.id}`, x.geometry.coordinates); continue;
      }
      // pad a hair so leads sitting exactly on the cluster's edge are not lost
      const pad = 1e-5, nb = { north: cb.north + pad, south: cb.south - pad, east: cb.east + pad, west: cb.west - pad };
      if (nb.north - nb.south > (b.north - b.south) * 0.9 && nb.east - nb.west > (b.east - b.west) * 0.9) {
        // the cluster fills the whole box: quarter it instead of re-asking the same box
        const mlat = (nb.north + nb.south) / 2, mlon = (nb.east + nb.west) / 2;
        for (const q of [{ north: nb.north, south: mlat, east: nb.east, west: mlon }, { north: nb.north, south: mlat, east: mlon, west: nb.west },
          { north: mlat, south: nb.south, east: nb.east, west: mlon }, { north: mlat, south: nb.south, east: mlon, west: nb.west }]) await walk(zoom + 1, q);
      } else await walk(Math.min(20, zoom + 2), nb);
    }
    if (calls % 50 === 0) console.log(`  ${calls} calls, ${out.size} leads so far`);
  };
  console.log('Markers sweep ...');
  for (let s = 24; s < 50; s += 5) for (let w = -125; w < -65; w += 6.25) await walk(6, { north: s + 5, south: s, east: w + 6.25, west: w });
  console.log(`  ${out.size} leads in ${calls} calls${stuck ? ` (${stuck} leads hidden in ${[...out.keys()].filter((k) => k.startsWith('cluster:')).length} unsplittable clusters)` : ''}`);
  writeFileSync(SWEEP, JSON.stringify(Object.fromEntries(out)));
  return out;
}

// ------------------------------------------------------------- LEAD DETAILS
function loadLeads() {
  const m = new Map();
  if (!existsSync(LEADS)) return m;
  for (const l of readFileSync(LEADS, 'utf8').split('\n')) { if (!l) continue; try { const o = JSON.parse(l); m.set(String(o.id), o); } catch (e) {} }
  return m;
}

async function details(ids, have) {
  const todo = ids.filter((i) => !i.startsWith('cluster:') && (flag('--refresh') || !have.has(i)));
  console.log(`Lead details: ${todo.length} to fetch (${have.size} cached)`);
  const CONC = 16; let i = 0, ok = 0, miss = 0; const buf = [];
  const flush = () => { if (buf.length) { appendFileSync(LEADS, buf.join('\n') + '\n'); buf.length = 0; } };
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (i < todo.length) {
      const id = todo[i++];
      const j = await api(`/leads/${id}`);
      if (!j || !j.data) { miss++; continue; }
      const d = j.data, c = d.position && d.position.coordinates;
      const o = { id: String(d.id), street1: d.street1 || '', street2: d.street2 || '', city: d.city || '', region: d.state || '', postal_code: d.postal_code || d.zip_code || '',
        stage_id: d.status_id, status_x_id: d.current_status_x_id, assignee_id: d.user_id, owner_id: d.current_owner_id, import_id: d.import_batch_id || '',
        campaign_id: d.campaign_id || '', status_at: d.current_status_client_inserted_at || '', updated_at: d.updated_at || d.client_updated_at || '', inserted_at: d.client_inserted_at || '',
        coordinates: c ? { type: 'Point', coordinates: [c[1], c[0]] } : null, fetched_at: new Date().toISOString() };
      have.set(o.id, o); buf.push(JSON.stringify(o)); ok++;
      if (buf.length >= 200) flush();
      if (ok % 1000 === 0) console.log(`  ${ok} fetched`);
    }
  }));
  flush();
  console.log(`  ${ok} fetched, ${miss} missing`);
}

// ------------------------------------------------------------- COMPILE
async function compile(have, sweepPts) {
  const st = await api('/settings/lead-statuses');
  const stName = Object.fromEntries(((st && st.data) || []).map((s) => [s.id, s.name]));
  const users = await api('/users');
  const userName = Object.fromEntries(((users && users.data) || []).map((u) => [u.id, `${u.first_name || ''} ${u.last_name || ''}`.trim()]));
  const src = JSON.parse(readFileSync(D('amplify-sources.json'), 'utf8')).tds;
  const dispName = src._dispositionNames || {};
  // Knock history from Amplify: every TDS disposition, per lead. The Grow files get
  // this from SalesRabbit's activity feed; the classic API showed no such route.
  const ANON = (readFileSync(join(ROOT, 'index.html'), 'utf8').match(/eyJ[A-Za-z0-9_.-]{50,}/) || [])[0];
  const SH = { apikey: ANON, Authorization: `Bearer ${ANON}` };
  const ev = [];
  for (let off = 0; ; off += 5000) {
    const r = await fetch(`${SB}/rest/v1/knock_events?select=lead_id,rep,activity_id,activity,at&source=eq.tds&order=id&offset=${off}&limit=5000`, { headers: SH });
    const rows = await r.json(); if (!Array.isArray(rows) || !rows.length) break; ev.push(...rows); if (rows.length < 5000) break;
  }
  const act = [['lead_id', 'street', 'unit', 'city', 'state', 'zip', 'datetime', 'event', 'rep', 'rep_email', 'new_stage', 'new_assignee', 'note', 'distance']];
  const knocked = new Set();
  for (const e of ev) {
    if (!e.lead_id || !e.at) continue;
    const l = have.get(String(e.lead_id)) || {};
    const stage = dispName[String(e.activity_id)] || e.activity || '';
    act.push([e.lead_id, l.street1 || '', l.street2 || '', l.city || '', l.region || '', l.postal_code || '', e.at, 'stage_updated', e.rep || '', '', stage, '', '', '']);
    knocked.add(String(e.lead_id));
  }
  writeFileSync(ACT_CSV, act.map((r) => r.map(csvCell).join(',')).join('\n') + '\n');
  const doors = [['lead_id', 'street', 'unit', 'city', 'state', 'zip', 'current_stage', 'assigned_to', 'ever_sold', 'import_id']];
  let n = 0;
  for (const [id, l] of have) {
    if (!l.coordinates) continue;
    const stage = stName[l.stage_id] || '';
    doors.push([id, l.street1, l.street2, l.city, l.region, l.postal_code, stage, userName[l.assignee_id] || '', stage === 'Sold' || stage === 'Customer' ? '1' : '0', l.import_id]); n++;
  }
  writeFileSync(DOORS_CSV, doors.map((r) => r.map(csvCell).join(',')).join('\n') + '\n');
  const missing = [...knocked].filter((i) => !have.has(i)).length;
  console.log(`Compiled: ${n} doors, ${ev.length} Amplify knocks on ${knocked.size} leads (${missing} knocked leads not in the SalesRabbit sweep)`);
}

// ------------------------------------------------------------- MAIN
const have = loadLeads();
if (!flag('--compile')) {
  // Default: only the doors Grow reps have knocked (Amplify's lead ids), which is
  // what the user asked for ("just the leads I have, only around Madison"). The
  // whole-company sweep (--sweep) lists all ~32k TDS leads around Madison, most of
  // them assigned to TDS's own people, and is not wanted on the map.
  const pts = flag('--sweep') ? await sweep() : new Map();
  // Leads Amplify knocked that the sweep did not list (deleted from the map, or
  // sitting under a stuck cluster) are still fetched by id so their history has a door.
  const ANON = (readFileSync(join(ROOT, 'index.html'), 'utf8').match(/eyJ[A-Za-z0-9_.-]{50,}/) || [])[0];
  const r = await fetch(`${SB}/rest/v1/knock_events?select=lead_id&source=eq.tds&limit=100000`, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } });
  const extra = new Set((await r.json()).map((x) => String(x.lead_id)).filter(Boolean));
  const ids = [...new Set([...pts.keys(), ...extra])];
  await details(ids, have);
}
await compile(have);
console.log('Done.');
