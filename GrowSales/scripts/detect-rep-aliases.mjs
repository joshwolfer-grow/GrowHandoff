#!/usr/bin/env node
// Find reps whose knocking and deals sit under two different spellings, and
// write them into `rep_aliases` as PENDING candidates for review in the app.
//
//   node scripts/detect-rep-aliases.mjs --dry    # print what it would propose
//   node scripts/detect-rep-aliases.mjs          # write pending rows
//
// It never decides anything. At edit distance 1 to 2 there is no way to tell a
// typo from a different person: "Robert Bridges" and "Dyson Bridges" are close
// and are two people, and the dashboard's own fuzzy matcher already carries a
// warning that it maps "Kallia Fuller" onto "Alaina Fuller". So every match here
// lands as `pending` with its evidence attached, and only a human confirm makes
// it real.
//
// Requires api/rep-aliases.sql to have been run once.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SB = 'https://cmkfohwbejcztctrpdnt.supabase.co';
const DRY = process.argv.includes('--dry');

const ANON = (readFileSync(join(ROOT, 'index.html'), 'utf8').match(/eyJ[A-Za-z0-9_.-]{50,}/) || [])[0];
if (!ANON) { console.error('No anon key found in index.html'); process.exit(1); }
const H = { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' };

const get = async (q) => {
  const r = await fetch(`${SB}/rest/v1/${q}`, { headers: H });
  if (!r.ok) throw new Error(`${q} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
};

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z ]/g, '').trim().replace(/\s+/g, ' ');

function lev(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

// Nickname pairs the edit distance alone would miss or misjudge.
const NICK = [['josh', 'joshua'], ['mike', 'michael'], ['chris', 'christopher'], ['matt', 'matthew'],
              ['nick', 'nicholas'], ['dan', 'daniel'], ['dave', 'david'], ['tom', 'thomas'],
              ['ben', 'benjamin'], ['sam', 'samuel'], ['alex', 'alexander'], ['jake', 'jacob'],
              ['tony', 'anthony'], ['will', 'william'], ['rob', 'robert'], ['zach', 'zachary']];
const nickSame = (a, b) => a === b || NICK.some(([s, l]) => (a === s && b === l) || (a === l && b === s));

const deals = await get('deals?select=rep&limit=100000');
const knock = await get('knocking?select=rep,doors&limit=200000');

const dealCount = {}, knockDays = {};
for (const d of deals) if (d.rep) dealCount[d.rep] = (dealCount[d.rep] || 0) + 1;
for (const k of knock) if (k.rep && (k.doors || 0) > 0) knockDays[k.rep] = (knockDays[k.rep] || 0) + 1;

let existing = [];
try { existing = await get('rep_aliases?select=source_name'); }
catch (e) { console.error('Could not read rep_aliases. Has api/rep-aliases.sql been run?\n ', e.message); process.exit(2); }
const judged = new Set(existing.map((r) => norm(r.source_name)));

const dealNames = Object.keys(dealCount), knockNames = Object.keys(knockDays);
const dealNorm = new Set(dealNames.map(norm)), knockNorm = new Set(knockNames.map(norm));
const kOnly = knockNames.filter((r) => !dealNorm.has(norm(r)) && !judged.has(norm(r)));
const dOnly = dealNames.filter((r) => !knockNorm.has(norm(r)));

const cands = [];
for (const k of kOnly) {
  const a = norm(k), ap = a.split(' ');
  for (const d of dOnly) {
    const b = norm(d), bp = b.split(' ');
    if (a === b) continue;
    const dist = lev(a, b);
    const lastSame = ap[ap.length - 1] === bp[bp.length - 1];
    const firstNick = nickSame(ap[0], bp[0]);
    // Accept only when the surname matches exactly and the first name is a
    // nickname or a near-miss, OR the whole string is within a tight distance.
    // Requiring the surname is what keeps two siblings from being merged.
    const ok = (lastSame && (firstNick || lev(ap[0], bp[0]) <= 2))
            || (firstNick && lev(ap[ap.length - 1], bp[bp.length - 1]) <= 1)
            || (dist <= 1 && Math.abs(a.length - b.length) <= 1);
    if (!ok) continue;
    cands.push({
      source_name: k, canonical_name: d, status: 'pending',
      reason: lastSame && firstNick ? 'same surname, nickname first name'
            : lastSame ? 'same surname, first name within 2 edits'
            : 'whole name within 1 edit',
      edit_distance: dist, knock_days: knockDays[k] || 0, deal_count: dealCount[d] || 0,
    });
  }
}

// A knocking spelling that matches two different deal names is exactly the case
// a human must settle, so keep both rows rather than guessing.
cands.sort((x, y) => x.edit_distance - y.edit_distance || y.knock_days - x.knock_days);

console.log(`deal names ${dealNames.length} | knocking names ${knockNames.length} | already judged ${judged.size}`);
console.log(`unmatched: ${kOnly.length} knocking-only, ${dOnly.length} deals-only`);
console.log(`\n${cands.length} candidate(s):`);
for (const c of cands)
  console.log(`  d=${c.edit_distance}  "${c.source_name}" (${c.knock_days}d)  ->  "${c.canonical_name}" (${c.deal_count} deals)   ${c.reason}`);

if (!cands.length) { console.log('\nNothing new to review.'); process.exit(0); }
if (DRY) { console.log('\n--dry: nothing written.'); process.exit(0); }

const r = await fetch(`${SB}/rest/v1/rep_aliases`, {
  method: 'POST',
  headers: { ...H, Prefer: 'return=minimal,resolution=ignore-duplicates' },
  body: JSON.stringify(cands),
});
if (!r.ok) { console.error('Insert failed:', r.status, (await r.text()).slice(0, 300)); process.exit(3); }
console.log(`\nWrote ${cands.length} pending candidate(s). Review them in the app under More · Rep names.`);
