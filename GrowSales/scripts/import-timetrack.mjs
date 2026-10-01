#!/usr/bin/env node
// Import a "Time Track" knocking export (Realtime Results / Bluepeak) into the
// Grow `knocking` table.
//
//   node scripts/import-timetrack.mjs path/to/TimeTrack.csv   # one file
//   node scripts/import-timetrack.mjs --scan                  # import every csv in imports/
//   node scripts/import-timetrack.mjs <file> --dry            # parse only, no writes
//
// Maps the report columns -> knocking (rep, date, hours, first_disp, last_disp,
// doors, unique_doors, contacts, sold), keyed on rep+date. Idempotent: it
// deletes the exact rep/date rows in the file before inserting, so re-running
// the same export never duplicates. Writes go through the PUBLIC anon key
// (the knocking table allows anon writes) — no secrets needed.
//
// --scan is what the folder-watch launch agent runs: it imports each CSV
// dropped in imports/, then moves it to imports/done/.

import { readFileSync, readdirSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const SB_URL = 'https://cmkfohwbejcztctrpdnt.supabase.co';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const IMPORTS = join(ROOT, 'imports');
// Same alias map the crawl and rtr-sync apply, so one person never lands under
// two spellings (Allison/Alli Lauriano was doubling 25 days before this).
const { canonicalDisplayName } = createRequire(import.meta.url)(join(ROOT, 'api/_name-aliases.js'));
const DONE = join(IMPORTS, 'done');
// The anon key is public (it ships in the dashboard bundle); read it from there
// so this script has no embedded credentials to drift.
const ANON = (readFileSync(join(ROOT, 'index.html'), 'utf8').match(/eyJ[A-Za-z0-9_.-]+/) || [])[0];
if (!ANON) { console.error('Could not read the anon key from index.html'); process.exit(1); }

const dryRun = process.argv.includes('--dry');
const scan = process.argv.includes('--scan');

// --- tiny CSV parser (handles quoted fields with commas/newlines) ---
function parseCSV(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
function findCol(headers, ...needles) {
  for (let i = 0; i < headers.length; i++) {
    const h = norm(headers[i]);
    if (needles.some((n) => (typeof n === 'function' ? n(h) : h.includes(n)))) return i;
  }
  return -1;
}
function toISO(d) {
  const m = (d || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
}
const numOf = (s) => { const n = parseFloat(String(s == null ? '' : s).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };
const pctOf = (s) => { const n = numOf(s); return n == null ? null : (String(s).includes('%') ? n / 100 : (n > 1 ? n / 100 : n)); };
const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
// StartTime/EndTime arrive as "07/16/2026 13:12:13" (or already "1:12 PM");
// normalize to the "1:12 PM" style the knocking table / Deal Clock expects.
function fmtTime(s) {
  s = (s || '').trim(); if (!s) return null;
  const ap = s.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (ap) return `${+ap[1]}:${ap[2]} ${ap[3].toUpperCase()}`;
  const t = s.match(/(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (t) { let h = +t[1]; const p = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${t[2]} ${p}`; }
  return s || null;
}

const H_JSON = { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' };
async function del(rep, date) {
  // Scoped to source=grow so a Time Track import can never delete another
  // company's rows for a rep who shares a name (see amplify-company-sync.mjs,
  // which tags every row with its own source).
  const u = `${SB_URL}/rest/v1/knocking?source=eq.grow&rep=eq.${encodeURIComponent(rep)}&date=eq.${date}`;
  const r = await fetch(u, { method: 'DELETE', headers: { ...H_JSON, Prefer: 'return=minimal' } });
  if (!r.ok && r.status !== 204) throw new Error(`delete ${rep} ${date}: ${r.status} ${(await r.text()).slice(0, 120)}`);
}
async function insert(chunk) {
  const r = await fetch(`${SB_URL}/rest/v1/knocking`, { method: 'POST', headers: { ...H_JSON, Prefer: 'return=minimal' }, body: JSON.stringify(chunk) });
  if (!r.ok) throw new Error(`insert: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

function parseFile(path) {
  const rows = parseCSV(readFileSync(path, 'utf8')).filter((r) => r.some((c) => c && c.trim()));
  // Header row = whichever has a rep column (D2DRep / D2DRep1) and a date column.
  const repNeedles = ['d2drep', (h) => h === 'rep'];
  const dateNeedles = ['recorddate', 'date worked', (h) => h === 'date'];
  let hi = rows.findIndex((r) => findCol(r, ...repNeedles) >= 0 && findCol(r, ...dateNeedles) >= 0);
  if (hi < 0) hi = 0;
  const H = rows[hi];
  const col = {
    rep: findCol(H, ...repNeedles),
    date: findCol(H, ...dateNeedles),
    hours: findCol(H, 'totaltime', 'time span', 'total hours', (h) => h === 'hours'),
    first: findCol(H, 'starttime', 'start time', 'first disposition', 'first disp'),
    last: findCol(H, 'endtime', 'end time', 'last disposition', 'last disp'),
    // Doors knocked = AllAttempts (raw) or the "Doors Knocked" label.
    doors: findCol(H, (h) => h === 'allattempts' || h === 'doors knocked' || (h.includes('doors') && !h.includes('unique'))),
    uniq: findCol(H, (h) => h.includes('unique')),
    sold: findCol(H, (h) => h === 'sold' || h === 'sales'),
    contacts: findCol(H, (h) => h === 'contacts'),
    attempts: findCol(H, 'validattempts', 'valid attempts', 'attempts of valid leads'),
    contactPct: findCol(H, 'contact as %', 'contact %'),
  };
  // Raw report puts contact-rate in the unlabeled column right after valid attempts.
  if (col.contactPct < 0 && col.attempts >= 0) col.contactPct = col.attempts + 1;
  if (col.rep < 0 || col.date < 0) throw new Error('Could not find rep / date columns. Headers seen: ' + H.join(' | '));
  const recs = []; let lastRep = '';
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    let rep = canonicalDisplayName((r[col.rep] || '').replace(/\s+/g, ' ').trim());
    if (/^total$/i.test(rep)) { lastRep = ''; continue; }
    if (rep) lastRep = rep; else rep = lastRep;
    const date = toISO(r[col.date]);
    if (!rep || !date) continue;
    const doors = col.doors >= 0 ? numOf(r[col.doors]) : null;
    const attempts = col.attempts >= 0 ? numOf(r[col.attempts]) : null;
    let cpct = col.contactPct >= 0 ? pctOf(r[col.contactPct]) : null;
    if (cpct != null && (cpct < 0 || cpct > 1)) cpct = null;   // guard the positional guess
    let contacts = col.contacts >= 0 ? numOf(r[col.contacts]) : null;
    if (contacts == null && attempts != null && cpct != null) contacts = Math.round(attempts * cpct);
    recs.push({ rep, date, hours: col.hours >= 0 ? round2(numOf(r[col.hours])) : null,
      first_disp: col.first >= 0 ? fmtTime(r[col.first]) : null, last_disp: col.last >= 0 ? fmtTime(r[col.last]) : null,
      doors: doors == null ? 0 : doors, unique_doors: col.uniq >= 0 ? (numOf(r[col.uniq]) || 0) : 0,
      contacts: contacts == null ? 0 : contacts, sold: col.sold >= 0 ? (numOf(r[col.sold]) || 0) : 0 });
  }
  return recs;
}

async function importFile(path) {
  const recs = parseFile(path);
  if (!recs.length) throw new Error('No rep/day rows parsed — check the file format.');
  const dates = [...new Set(recs.map((r) => r.date))].sort();
  const reps = [...new Set(recs.map((r) => r.rep))];
  console.log(`Parsed ${recs.length} rep/day rows · ${reps.length} reps · ${dates[0]} → ${dates[dates.length - 1]}`);
  if (dryRun) { console.log('DRY RUN — first 3 rows:', JSON.stringify(recs.slice(0, 3), null, 2)); return; }
  const t0 = Date.now();
  // Delete the exact rep/day cells, run in parallel batches so a big export
  // still lands in a couple seconds instead of one-request-at-a-time.
  const pm = new Map(); recs.forEach((r) => pm.set(r.rep + '|' + r.date, { rep: r.rep, date: r.date }));
  const pairs = [...pm.values()];
  for (let i = 0; i < pairs.length; i += 25) await Promise.all(pairs.slice(i, i + 25).map((p) => del(p.rep, p.date)));
  for (let i = 0; i < recs.length; i += 500) await insert(recs.slice(i, i + 500));
  console.log(`✓ Imported ${recs.length} rows (${pairs.length} rep/day cells) in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
}

// --- entry ---
if (scan) {
  // Import every CSV dropped in imports/, then move it to imports/done/.
  if (!existsSync(IMPORTS)) { console.log('No imports/ folder — nothing to scan.'); process.exit(0); }
  const files = readdirSync(IMPORTS).filter((f) => /\.csv$/i.test(f));
  if (!files.length) { console.log('imports/ is empty — nothing to import.'); process.exit(0); }
  if (!existsSync(DONE)) mkdirSync(DONE, { recursive: true });
  for (const f of files) {
    const p = join(IMPORTS, f);
    try { console.log(`\n— ${f} —`); await importFile(p); if (!dryRun) renameSync(p, join(DONE, Date.now() + '-' + f)); }
    catch (e) { console.error(`✗ ${f}: ${e.message}`); }
  }
} else {
  const file = process.argv[2];
  if (!file || file.startsWith('--')) { console.error('Usage: node scripts/import-timetrack.mjs <TimeTrack.csv>   (or --scan)'); process.exit(1); }
  await importFile(file);
}
