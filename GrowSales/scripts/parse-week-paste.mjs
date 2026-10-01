// scripts/parse-week-paste.mjs
//
// Parse a Monday "week paste" into the authoritative override for the live week.
// The paste is blank-line-delimited team blocks; the FIRST line of each block is
// the manager, the rest are that manager's reps. This is the exact-accuracy
// source for the in-progress week (the Master pay sheet fills it only mid-week),
// and it takes precedence over everything downstream.
//
// Usage:
//   node scripts/parse-week-paste.mjs data/week-paste-<sun>.txt <YYYY-MM-DD Sunday> [--out data/team-current.json]

import fs from 'fs';
import { cleanName } from './_name-clean.mjs';

const [pastePath, week] = process.argv.slice(2);
if (!pastePath || !/^\d{4}-\d{2}-\d{2}$/.test(week || '')) {
  console.error('usage: parse-week-paste.mjs <paste.txt> <YYYY-MM-DD Sunday> [--out file]');
  process.exit(1);
}
const outIdx = process.argv.indexOf('--out');
const outPath = outIdx > -1 ? process.argv[outIdx + 1] : null;

const blocks = fs.readFileSync(pastePath, 'utf8')
  .split(/\n\s*\n/).map(b => b.split('\n').map(l => l.trim()).filter(Boolean)).filter(b => b.length);

const teams = {};
const repHome = {};   // rep -> manager (first team they landed in)
const dupes = [];
const managers = new Set();

for (const block of blocks) {
  const mgr = cleanName(block[0]);
  if (!mgr) continue;
  managers.add(mgr);
  teams[mgr] = teams[mgr] || [];
  for (const line of block.slice(1)) {
    const rep = cleanName(line);
    if (!rep) continue;
    if (repHome[rep] && repHome[rep] !== mgr) dupes.push(`${rep}: listed under both ${repHome[rep]} and ${mgr}`);
    else if (!repHome[rep]) { repHome[rep] = mgr; teams[mgr].push(rep); }
    // else: already counted on this manager (e.g. a split-up team block) — dedupe
  }
}

// a manager who also appears as someone else's rep is worth a look
const mgrAsRep = [...managers].filter(m => repHome[m] && repHome[m] !== m)
  .map(m => `${m} is a manager but also listed as a rep under ${repHome[m]}`);

const total = Object.values(teams).reduce((n, r) => n + r.length, 0);
console.log(`Week ${week}: ${Object.keys(teams).length} teams, ${total} reps\n`);
for (const [m, reps] of Object.entries(teams)) console.log(`  ${m} (${reps.length}): ${reps.join(', ')}`);
if (dupes.length) { console.log('\n--- reps listed on two teams (kept on the first) ---'); dupes.forEach(d => console.log('  ' + d)); }
if (mgrAsRep.length) { console.log('\n--- manager also listed as a rep ---'); mgrAsRep.forEach(d => console.log('  ' + d)); }

if (outPath) {
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch {}
  existing[week] = teams;
  fs.writeFileSync(outPath, JSON.stringify(existing, null, 0));
  console.log(`\nwrote ${week} -> ${outPath}`);
}
