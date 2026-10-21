#!/usr/bin/env node
// Ezee Fiber addresses -> ezee_knocks + ezee_addresses (Supabase).
//
//   node scripts/ezee-addresses-sync.mjs                          # yesterday..today, every Grow team
//   node scripts/ezee-addresses-sync.mjs --from 10/7/2026 --to 10/20/2026
//   node scripts/ezee-addresses-sync.mjs --csv data/_ezee-audit/*Team*.csv   # ingest CSVs already on disk, no render
//   node scripts/ezee-addresses-sync.mjs --dry                     # parse + report, write nothing
//
// Renders the Opendoor RTR "/Ezee Fiber/Activity_Detail" report once per Grow team
// via scripts/rtr-activity-detail.mjs (so it uses the .rtr-profile-backfill copy of
// the login and never fights the scheduled rtr-sync for the live profile), then:
//   1. upserts one ezee_knocks row per form_instance_id (Ezee's own submission id,
//      so re-pulling a range can never double a knock), and
//   2. rebuilds ezee_addresses for every address those knocks touched, from the
//      full knock history in the table. Old addresses are never deleted.
// The Google Sheet (scripts/ezee-addresses-sheet.gs) reads ezee_addresses.
//
// WHY: Ezee only credits a deal when our address matches THEIR spelling of it.
// This list is that spelling, for every door we have knocked, so Bria can match
// Sequifi deals against it and find the ones Ezee has not paid.
//
// Teams come from data/rtr-sources.json -> ezee.addresses.teams. Exit 3 = the
// Opendoor session expired (rtr-activity-detail passes it through).

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const DRY = flag('--dry');
const SB = 'https://cmkfohwbejcztctrpdnt.supabase.co';
const ANON = (readFileSync(join(ROOT, 'index.html'), 'utf8').match(/eyJ[A-Za-z0-9_.-]{50,}/) || [])[0];
if (!ANON) { console.error('Could not read the Supabase anon key from index.html.'); process.exit(1); }
const H = { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' };

const cfgPath = join(ROOT, 'data', 'rtr-sources.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const A = (cfg.ezee || {}).addresses || {};
const REPORT = A.reportPath || '/Ezee Fiber/Activity_Detail';
const TEAMS = opt('--team', null) ? [opt('--team')] : (A.teams || []);
const OUT_DIR = join(ROOT, 'data', '_ezee-addresses');

const mdy = (d) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
const iso = (s) => { const m = String(s).match(/^(\d+)\/(\d+)\/(\d+)/); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null; };
const today = new Date(), yday = new Date(today); yday.setDate(today.getDate() - 1);
const FROM = opt('--from', mdy(yday)), TO = opt('--to', opt('--from', null) ? opt('--from') : mdy(today));

// --- 1. collect CSVs: given, or rendered now ------------------------------
let files = [];
const csvIdx = argv.indexOf('--csv');
if (csvIdx >= 0) {
  files = argv.slice(csvIdx + 1).filter((a) => !a.startsWith('--'));
} else {
  if (!TEAMS.length) { console.error('No teams. Add ezee.addresses.teams to data/rtr-sources.json or pass --team.'); process.exit(1); }
  for (const team of TEAMS) {
    const slug = team.replace(/[^A-Za-z0-9]+/g, '_');
    const file = join(OUT_DIR, `${slug}_${iso(FROM)}_${iso(TO)}.csv`);
    console.log(`render ${team} ${FROM}..${TO}`);
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'rtr-activity-detail.mjs'), '--report', REPORT, '--team', team, '--from', FROM, '--to', TO, '--out-dir', OUT_DIR], { stdio: 'inherit' });
    if (r.status !== 0) { console.error(`render failed for ${team} (exit ${r.status})`); process.exit(r.status || 1); }
    if (!existsSync(file)) { console.error(`expected ${file} after render`); process.exit(1); }
    files.push(file);
  }
}

// --- 2. parse ---------------------------------------------------------------
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const hdr = rows.shift() || [];
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(hdr.map((h, i) => [h.trim(), (r[i] || '').trim()])));
}
const NEED = ['form_instance_id', 'Customer_Nbr', 'House', 'Street', 'CalcCity', 'CalcState', 'CalcZip', 'Date_Submitted', 'Agent', 'Disposition', 'Sale'];
const norm = (s) => s.toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const knocks = new Map();
for (const f of files) {
  const recs = parseCsv(readFileSync(f, 'utf8'));
  const missing = NEED.filter((c) => recs.length && !(c in recs[0]));
  if (missing.length) { console.error(`${f}: missing columns ${missing.join(', ')} (report redesigned?)`); process.exit(2); }
  for (const r of recs) {
    if (!r.form_instance_id) continue;
    const house = r.House, street = r.Street, unit = r.CalcAddress2 || '';
    const addr = [house, street].filter(Boolean).join(' ');
    if (!addr) continue;
    const id = r.Customer_Nbr || `addr:${norm([addr, unit, r.CalcCity, r.CalcState, (r.CalcZip || '').slice(0, 5)].join(' '))}`;
    const sub = r.Date_Submitted.match(/^(\d+)\/(\d+)\/(\d+)\s+(\d+:\d+:\d+)/);
    const date = iso(r.Date_Submitted); if (!date) continue;
    const dist = r.Distance && r.Distance !== 'NULL' ? Number(r.Distance) : null;
    knocks.set(r.form_instance_id, {
      knock: { form_instance_id: r.form_instance_id, address_id: id, agent: r.Agent, team: r.BU_Level_3 || null, disposition: r.Disposition,
        submitted: sub ? `${date}T${sub[4]}` : null, date, sale: r.Sale === '1', customer_name: (r.CalcCustomerName || '').replace(/^[|\[\]\s]+/, '') || null, distance_ft: Number.isFinite(dist) ? dist : null },
      addr: { id, customer_nbr: r.Customer_Nbr || null, house, street, unit: unit || null, city: r.CalcCity, state: r.CalcState, zip: (r.CalcZip || '').slice(0, 5) || null,
        address: addr, team: r.BU_Level_3 || null, segment: r.Segment || null, property_type: r.cust_misc1 || null, area: r.Cust_Misc8 || null },
    });
  }
}
const addrs = new Map();
for (const { addr } of knocks.values()) addrs.set(addr.id, addr);
console.log(`${files.length} file(s): ${knocks.size} knocks, ${addrs.size} addresses`);
if (DRY) { for (const a of [...addrs.values()].slice(0, 5)) console.log(' ', a.id, a.address, a.city, a.zip); process.exit(0); }
if (!knocks.size) { console.log('nothing to write'); process.exit(0); }

// --- 3. write ---------------------------------------------------------------
const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };
async function post(table, rows, conflict) {
  for (const c of chunk(rows, 500)) {
    const res = await fetch(`${SB}/rest/v1/${table}?on_conflict=${conflict}`, { method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(c) });
    if (!res.ok) { console.error(`${table} upsert ${res.status}: ${(await res.text()).slice(0, 300)}`); process.exit(1); }
  }
}
async function getAll(path) {
  const out = [];
  for (let off = 0; ; off += 1000) {
    const res = await fetch(`${SB}/rest/v1/${path}&limit=1000&offset=${off}`, { headers: H });
    if (!res.ok) { console.error(`read ${res.status}: ${(await res.text()).slice(0, 300)}`); process.exit(1); }
    const page = await res.json(); out.push(...page); if (page.length < 1000) break;
  }
  return out;
}
const ids = [...addrs.keys()];
const before = new Set((await Promise.all(chunk(ids, 100).map((c) => getAll(`ezee_addresses?select=id&id=in.(${c.map(encodeURIComponent).join(',')})`)))).flat().map((r) => r.id));

await post('ezee_knocks', [...knocks.values()].map((k) => k.knock), 'form_instance_id');

// Rebuild each touched address from its whole knock history, not just this run.
const hist = (await Promise.all(chunk(ids, 100).map((c) => getAll(`ezee_knocks?select=address_id,agent,disposition,submitted,date,sale,customer_name&address_id=in.(${c.map(encodeURIComponent).join(',')})&order=submitted.asc`)))).flat();
const byAddr = new Map();
for (const k of hist) { if (!byAddr.has(k.address_id)) byAddr.set(k.address_id, []); byAddr.get(k.address_id).push(k); }
const rows = [];
for (const [id, a] of addrs) {
  const ks = byAddr.get(id) || [];
  const last = ks[ks.length - 1] || {};
  const sale = ks.find((k) => k.sale);
  const name = [...ks].reverse().find((k) => k.customer_name && !/^resident$/i.test(k.customer_name));
  rows.push({ ...a, first_seen: ks[0]?.date || null, last_seen: last.date || null, knocks: ks.length, last_disposition: last.disposition || null, last_rep: last.agent || null,
    sold: !!sale, sold_date: sale?.date || null, sold_rep: sale?.agent || null, customer_name: name?.customer_name || null, updated_at: new Date().toISOString() });
}
await post('ezee_addresses', rows, 'id');
const added = ids.filter((i) => !before.has(i)).length;
console.log(`✓ ${knocks.size} knocks upserted, ${rows.length} addresses rebuilt, ${added} new`);
