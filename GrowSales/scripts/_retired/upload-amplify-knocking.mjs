#!/usr/bin/env node
// SUPERSEDED (2026-07-20): use `node scripts/amplify-knocking-sync.mjs --from X --to Y`
// instead — it pulls live from Amplify, counts sold/contacts as DISTINCT doors
// (this script's CSV counts double-tapped dispositions), and also fills
// knock_events. Keep only as a last-resort fallback if the sync is unavailable.
//
// One-time historical upload of the Amplify Lead Status export into the Grow
// `knocking` table. Reads amplify_knocking_jun_jul_2026.csv (per-rep/day status
// breakdown pulled from SalesRabbit Amplify) and maps it to the knocking schema:
//   rep, date, doors, unique_doors, contacts, sold, first_disp, last_disp, hours
// contacts = Not Interested + Call Back + Sold (dispositions that mean a
// conversation happened). doors = TotalDoors, unique_doors = UniqueLeads.
//
// Idempotent: deletes the exact rep/date rows before inserting, like the Time
// Track importer, so re-running never duplicates. Writes via the PUBLIC anon
// key (knocking allows anon writes) read from index.html — no secrets embedded.
//
//   node scripts/upload-amplify-knocking.mjs --dry   # parse only
//   node scripts/upload-amplify-knocking.mjs         # upload

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SB_URL = 'https://cmkfohwbejcztctrpdnt.supabase.co';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CSV = join(ROOT, 'amplify_knocking_jun_jul_2026.csv');
const ANON = (readFileSync(join(ROOT, 'index.html'), 'utf8').match(/eyJ[A-Za-z0-9_.-]{50,}/) || [])[0];
if (!ANON) { console.error('Could not read anon key from index.html'); process.exit(1); }
const dry = process.argv.includes('--dry');

// --- tiny CSV parser (handles quoted fields) ---
function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\r') {}
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows;
}

const num = (s) => { const n = parseFloat(String(s || '').replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; };

const rows = parseCSV(readFileSync(CSV, 'utf8')).filter((r) => r.length > 5 && r[0]);
const H = rows[0];
const ix = (name) => H.indexOf(name);
const c = {
  date: ix('Date'), rep: ix('Rep'), ni: ix('Not Interested'), cb: ix('Call Back'), sold: ix('Sold'),
  doors: ix('TotalDoors'), uniq: ix('UniqueLeads'), first: ix('FirstKnock'), last: ix('LastKnock'), hours: ix('Hours'),
};

const recs = [];
const rawPairs = [];   // (originalSpelling, date) to also clear, so double-space variants don't linger
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  let rep = (r[c.rep] || '').trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(rep)) rep = 'Unknown Rep';   // the one unresolved (deactivated) user
  // Amplify returns some names with doubled spaces ("Douglas  Evans"); collapse so we
  // match the existing roster spelling instead of creating a duplicate rep.
  const rawRep = rep;
  rep = rep.replace(/\s+/g, ' ');
  const date = (r[c.date] || '').trim();
  if (!rep || !date) continue;
  if (rawRep !== rep) rawPairs.push({ rep: rawRep, date });
  recs.push({
    rep, date,
    doors: num(r[c.doors]),
    unique_doors: num(r[c.uniq]),
    contacts: num(r[c.ni]) + num(r[c.cb]) + num(r[c.sold]),
    sold: num(r[c.sold]),
    first_disp: (r[c.first] || '').trim() || null,
    last_disp: (r[c.last] || '').trim() || null,
    hours: num(r[c.hours]),
  });
}

// Bulk-intake accounts (leads get mass-assigned here then distributed) — their
// events are imports/admin, not door knocking. Clear their rows, insert nothing.
const EXCLUDED_REPS = new Set(['Nick Boyd']);
const excludedPairs = recs.filter((r) => EXCLUDED_REPS.has(r.rep)).map((r) => ({ rep: r.rep, date: r.date }));
const keptRecs = recs.filter((r) => !EXCLUDED_REPS.has(r.rep));

const reps = [...new Set(keptRecs.map((r) => r.rep))];
const dates = [...new Set(recs.map((r) => r.date))].sort();
console.log(`Parsed ${recs.length} rep/day rows · ${reps.length} reps · ${dates[0]} → ${dates[dates.length - 1]}`);
console.log('First 3 knocking rows:', JSON.stringify(recs.slice(0, 3), null, 2));
if (dry) { console.log('DRY RUN — no writes.'); process.exit(0); }

const H_JSON = { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' };
async function del(rep, date) {
  const u = `${SB_URL}/rest/v1/knocking?rep=eq.${encodeURIComponent(rep)}&date=eq.${date}`;
  const r = await fetch(u, { method: 'DELETE', headers: { ...H_JSON, Prefer: 'return=minimal' } });
  if (!r.ok && r.status !== 204) throw new Error(`delete ${rep} ${date}: ${r.status} ${(await r.text()).slice(0, 120)}`);
}
async function insert(chunk) {
  const r = await fetch(`${SB_URL}/rest/v1/knocking`, { method: 'POST', headers: { ...H_JSON, Prefer: 'return=minimal' }, body: JSON.stringify(chunk) });
  if (!r.ok) throw new Error(`insert: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

const t0 = Date.now();
// clear both the clean spelling and any stale double-space spelling for each rep/day,
// plus excluded intake accounts' rows (deleted, never re-inserted)
const pairs = [...keptRecs.map((r) => ({ rep: r.rep, date: r.date })), ...rawPairs, ...excludedPairs];
for (let i = 0; i < pairs.length; i += 25) await Promise.all(pairs.slice(i, i + 25).map((p) => del(p.rep, p.date)));
for (let i = 0; i < keptRecs.length; i += 500) await insert(keptRecs.slice(i, i + 500));
console.log(`✓ Uploaded ${keptRecs.length} rows (${excludedPairs.length} intake-account rows cleared) in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
