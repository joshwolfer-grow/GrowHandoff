// scripts/parse-team-assignments.mjs
//
// Parse the "Master Manager Pay" sheet (CSV export) into an authoritative,
// week-scoped roster: week (Sunday ISO) -> manager -> [reps].
//
// The Master sheet is the source of truth for *completed* weeks. Its structure
// survives CSV export because teams are delimited by literal "Blitz #N" cells
// (bold is lost on export, so we can't rely on it): within each week-column,
// reading top to bottom, a "Blitz #N" cell opens a team, the next name is that
// team's MANAGER, and the names below it (until the next "Blitz #N") are the
// manager's reps. Managers change week to week (e.g. Anna Lower is a rep under
// Sammi Boyd through 7/11, then her own manager from 7/12) — this parser keeps
// that week-dated, which a flat all-time override cannot.
//
// The in-progress week is intentionally NOT trusted here (the Master sheet fills
// it mid-week); that week comes from a manual Monday paste applied downstream.
//
// Usage:
//   node scripts/parse-team-assignments.mjs "<Master CSV path>" [--out <json path>] [--push]
//
// Output: prints a validation report; writes team-assignments.json when --out
// set; upserts the whole history to report_config.__roster_weeks__ with --push.
//
// --push is what makes a re-export actually land: the dashboard reads that row
// on every load, so refreshed history takes effect without a deploy, and weeks
// stop disappearing behind the single-week __roster_current__ row.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { cleanName } from './_name-clean.mjs';

// ---- CSV ----------------------------------------------------------------
function parseCSV(t) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c === '\r') { /* skip */ }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// ---- week header -> Sunday ISO ------------------------------------------
// Headers look like "6/7/2026-6/13/2026", "7/12/2026 - 7/18/2026", or bare
// "12/28-1/03" (year implied). We only key off the start date -> Sunday ISO.
function headerParts(h) {
  const s = String(h || '').replace(/\([^)]*\)/g, '').trim();
  const m = s.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (!m) return null;
  const [, mo, da, yr] = m;
  return { mo: +mo, da: +da, yr: yr ? +(yr.length === 2 ? '20' + yr : yr) : null };
}
function toSunday(yr, mo, da) {
  const iso = `${yr}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
  const d = new Date(iso + 'T12:00:00Z');
  if (isNaN(d)) return null;
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());          // weeks are Sunday-anchored
  return d.toISOString().slice(0, 10);
}
// The sheet only started writing the year in the header around 03/29/2026; the
// 15 columns before it are bare "12/28-1/03" style. Skipping them (what this
// did before) silently dropped every week of roster history prior to 3/29 —
// the app then fell back to deal-derived managers for all of them. Columns run
// left to right in date order, so the year is recoverable: walk right to left
// from the first dated column and roll the year back whenever a date would
// otherwise land after the column to its right (that's a December -> January
// boundary).
function resolveWeeks(header) {
  const parts = header.map((h, i) => ({ p: headerParts(h), col: i })).filter(c => c.p);
  const out = [];
  let nextYr = null, nextMo = null, nextDa = null;
  for (let i = parts.length - 1; i >= 0; i--) {
    const { p, col } = parts[i];
    let yr = p.yr;
    if (!yr) {
      if (nextYr == null) continue;                       // no dated column to anchor from
      yr = nextYr;
      if (p.mo > nextMo || (p.mo === nextMo && p.da > nextDa)) yr--;   // rolled back over New Year
    }
    const week = toSunday(yr, p.mo, p.da);
    if (!week) continue;
    out.push({ week, col, inferredYear: !p.yr });
    nextYr = yr; nextMo = p.mo; nextDa = p.da;
  }
  return out.reverse();
}

const BLITZ = /blitz\s*#?\s*\d+/i;

// ---- parse --------------------------------------------------------------
const csvPath = process.argv[2];
if (!csvPath) { console.error('usage: parse-team-assignments.mjs <csv> [--out file] [--push]'); process.exit(1); }
const outIdx = process.argv.indexOf('--out');
const outPath = outIdx > -1 ? process.argv[outIdx + 1] : null;

const rows = parseCSV(fs.readFileSync(csvPath, 'utf8'));
const header = rows[0] || [];
const cols = resolveWeeks(header);

const assignments = {};   // week -> manager -> [reps]
const anomalies = [];
const nameFreq = {};

// Within each week-column, "Blitz #N" delimits a team: the next name is the
// MANAGER, the names below (until the next "Blitz #N") are the manager's reps.
// We deliberately do NOT try to auto-split when a divider is missing: the
// manager-vs-rep direction isn't machine-determinable, and guessing wrongly
// pulls people onto the wrong team (and across weeks). Missing-divider weeks
// instead surface as oversized teams in the report for a human to resolve —
// or get overridden entirely by the manual Monday paste for the live week.
for (const { week, col } of cols) {
  let mgr = null, expect = false;
  const teams = {};             // manager -> [reps] for this week
  const repSeen = {};           // rep -> manager (dup detection)
  for (let r = 1; r < rows.length; r++) {
    const cell = String((rows[r] || [])[col] || '').trim();
    if (!cell) continue;
    if (BLITZ.test(cell)) { mgr = null; expect = true; continue; }
    const nm = cleanName(cell);
    if (!nm) continue;
    nameFreq[nm] = (nameFreq[nm] || 0) + 1;
    if (expect) { mgr = nm; expect = false; teams[mgr] = teams[mgr] || []; }
    else if (mgr) {
      if (repSeen[nm] && repSeen[nm] !== mgr) {
        anomalies.push(`${week}: ${nm} appears under both ${repSeen[nm]} and ${mgr}`);
      }
      repSeen[nm] = mgr;
      teams[mgr].push(nm);
    }
  }
  if (Object.keys(teams).length) assignments[week] = teams;
}

// ---- validation report --------------------------------------------------
const weeks = Object.keys(assignments).sort();
console.log(`Parsed ${weeks.length} weeks: ${weeks[0]} .. ${weeks[weeks.length - 1]}\n`);

// recent weeks in full so they can be eyeballed against the manager texts
for (const w of weeks.slice(-4)) {
  console.log(`===== ${w} =====`);
  for (const [m, reps] of Object.entries(assignments[w])) {
    console.log(`  ${m} (${reps.length}): ${reps.join(', ')}`);
  }
  console.log('');
}

// managers with suspiciously large teams (possible missed Blitz delimiter)
console.log('--- teams >18 reps (check for a missed delimiter) ---');
for (const w of weeks) for (const [m, reps] of Object.entries(assignments[w]))
  if (reps.length > 18) console.log(`  ${w}  ${m}: ${reps.length}`);

// rare names = likely typos worth adding to SPELLING
console.log('\n--- names seen only once (likely typos to review) ---');
console.log(Object.entries(nameFreq).filter(([, n]) => n === 1).map(([n]) => n).sort().join('\n'));

if (anomalies.length) { console.log('\n--- anomalies ---'); anomalies.forEach(a => console.log('  ' + a)); }

// Coverage: a header column that parsed to a week but produced no teams means
// the export was taken before that week was filled in — the single most common
// reason a week goes missing in the app.
const empty = cols.filter(c => !assignments[c.week]).map(c => c.week);
if (empty.length) console.log(`\n--- dated columns with no teams (export taken too early?) ---\n  ${empty.join(', ')}`);
const inferred = cols.filter(c => c.inferredYear && assignments[c.week]).map(c => c.week);
if (inferred.length) console.log(`\n--- weeks whose year was inferred (undated header) ---\n  ${inferred.join(', ')}`);

// Gaps inside the covered range: a Sunday with no roster leaves the app carrying
// a rep's last-known manager forward, which is how attribution silently drifts.
const gaps = [];
for (let d = new Date(weeks[0] + 'T12:00:00Z'); d.toISOString().slice(0, 10) < weeks[weeks.length - 1]; d.setUTCDate(d.getUTCDate() + 7)) {
  const iso = d.toISOString().slice(0, 10);
  if (!assignments[iso]) gaps.push(iso);
}
console.log(`\nCoverage: ${weeks.length} weeks, ${gaps.length ? 'GAPS: ' + gaps.join(', ') : 'no gaps'}`);

if (outPath) { fs.writeFileSync(outPath, JSON.stringify(assignments, null, 0)); console.log(`\nwrote ${outPath}`); }

if (process.argv.includes('--push')) {
  const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const ANON = (fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').match(/eyJ[A-Za-z0-9_.-]{50,}/) || [])[0];
  if (!ANON) { console.error('No anon key found in index.html; cannot push.'); process.exit(1); }
  const res = await fetch('https://cmkfohwbejcztctrpdnt.supabase.co/rest/v1/report_config?on_conflict=manager', {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      manager: '__roster_weeks__',
      config: { weeks: assignments, saved_at: new Date().toISOString(), source: 'parse-team-assignments.mjs' }
    })
  });
  console.log(res.ok ? `\nPushed ${weeks.length} weeks to __roster_weeks__ (${res.status}). Live on next dashboard load.`
                     : `\nPush failed: ${res.status} ${await res.text()}`);
}
