#!/usr/bin/env node
// Rep GPS trail: SalesRabbit profile_locations -> Supabase rep_gps.
//
// Kept small on purpose: only pings between NOON and 10PM in the rep's own
// timezone (guessed from the ping's longitude), and only the last 31 days
// (prune_rep_gps() runs at the end of every sync). Overnight pings are mostly a
// rep's home, which the map has no business showing.
//
//   node scripts/rep-locations-sync.mjs                  # incremental (what the tick runs)
//   node scripts/rep-locations-sync.mjs --since 2026-09-07   # backfill (31 days max)
//
// The SalesRabbit app pings each signed-in rep's phone about every 5 minutes
// (GET /profile_locations, found 2026-10-07). The endpoint ignores limit/page and
// returns EVERY row matching the filter, so the only safe way to read it is a
// narrow filter[inserted_at][gte]. Points are immutable, so the insert ignores
// duplicates and re-reading an overlap costs nothing.
//
// Uses the same token as grow-sync.mjs (data/sr-auth.json). A dead token exits 3,
// same as grow-sync, so the wrapper reports it the same way.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const D = (f) => join(ROOT, 'data', f);
const SR = 'https://apis.salesrabbit.com';
const SB = 'https://cmkfohwbejcztctrpdnt.supabase.co';
const STATE = D('rep-loc-state.json');
const NAMES = D('sr-profile-names.json');
// re-read this far behind the watermark: a phone that was offline uploads its
// pings late, with their original inserted_at
const OVERLAP_MS = 2 * 3600e3;

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };

const auth = JSON.parse(readFileSync(D('sr-auth.json'), 'utf8'));
const SRH = { ...(auth.headers || auth), Accept: 'application/json' };
const ANON = (readFileSync(join(ROOT, 'index.html'), 'utf8').match(/eyJ[A-Za-z0-9_.-]{50,}/) || [])[0];
if (!ANON) { console.error('No anon key in index.html'); process.exit(1); }
const SBH = { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' };

async function sr(path) {
  const r = await fetch(SR + path, { headers: SRH });
  if (r.status === 401 || r.status === 403) { console.error('SalesRabbit rejected the token. Run: node scripts/grow-sync.mjs --seed'); process.exit(3); }
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const names = existsSync(NAMES) ? JSON.parse(readFileSync(NAMES, 'utf8')) : {};

let since = arg('--since');
if (!since) since = state.last ? new Date(new Date(state.last) - OVERLAP_MS).toISOString() : new Date(Date.now() - 2 * 86400e3).toISOString();

const j = await sr(`/profile_locations?filter[inserted_at][gte]=${encodeURIComponent(since)}`);
const pts = (j.data || []).filter((x) => x.attributes?.coordinates?.coordinates?.length === 2);

// names: one GET per profile we have never seen, cached forever (ids are stable)
for (const id of new Set(pts.map((x) => x.attributes.profile_id))) {
  if (names[id]) continue;
  try {
    const p = await sr(`/profiles/${id}?fields[profile]=name,email`);
    names[id] = { name: (p.data?.attributes?.name || '').replace(/\s+/g, ' ').trim(), email: (p.data?.attributes?.email || '').toLowerCase() };
  } catch (e) { names[id] = { name: '', email: '' }; }
}
writeFileSync(NAMES, JSON.stringify(names, null, 1));

// Rough US/Canada zone bands by longitude. Chicago sits at -87.6, so the
// Eastern line is -87.5; Alberta and Utah both land in Mountain.
const zoneOf = (lng) => lng > -87.5 ? 'America/New_York' : lng > -102 ? 'America/Chicago' : lng > -114.5 ? 'America/Denver' : 'America/Los_Angeles';
const fmt = {};
const localHour = (iso, lng) => {
  const z = zoneOf(lng);
  fmt[z] ||= new Intl.DateTimeFormat('en-US', { timeZone: z, hour: 'numeric', hourCycle: 'h23' });
  return +fmt[z].format(new Date(iso));
};
const H_FROM = 12, H_TO = 22;   // noon to 10pm local
const cutoff = new Date(Date.now() - 31 * 86400e3).toISOString();

const rows = pts.map((x) => {
  const a = x.attributes, n = names[a.profile_id] || {};
  return { id: x.id, profile_id: a.profile_id, rep: n.name || null, ts: a.inserted_at, lat: a.coordinates.coordinates[1], lng: a.coordinates.coordinates[0] };
}).filter((r) => { const h = localHour(r.ts, r.lng); return r.ts > cutoff && h >= H_FROM && h < H_TO; });

let ok = 0;
for (let i = 0; i < rows.length; i += 1000) {
  const chunk = rows.slice(i, i + 1000);
  const r = await fetch(`${SB}/rest/v1/rep_gps?on_conflict=id`, {
    method: 'POST', headers: { ...SBH, Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(chunk),
  });
  if (!r.ok) { console.error('Insert failed:', r.status, (await r.text()).slice(0, 300)); process.exit(5); }
  ok += chunk.length;
}

const pr = await fetch(`${SB}/rest/v1/rpc/prune_rep_gps`, { method: 'POST', headers: SBH, body: '{}' });
const pruned = pr.ok ? await pr.json() : `failed ${pr.status}`;

// watermark on everything read, not just what was kept, or a quiet night would
// re-read the same overnight pings forever
const newest = pts.reduce((m, x) => (x.attributes.inserted_at > m ? x.attributes.inserted_at : m), state.last || '');
writeFileSync(STATE, JSON.stringify({ last: newest, ran: new Date().toISOString() }));
console.log(`rep-gps: kept ${ok} of ${pts.length} pings since ${since.slice(0, 16)}, ${new Set(rows.map((r) => r.profile_id)).size} reps, pruned ${pruned}, newest ${newest.slice(0, 16)}`);
