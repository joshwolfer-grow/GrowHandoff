#!/usr/bin/env node
// data/sr-activity.jsonl -> rows in the shape of the `knocking` table.
//
// The crawl gives one row per activity mark; `knocking` is one row per rep per
// day. This rolls the first into the second so the dashboard can read it, and
// so the Amplify-derived rows can be replaced with something trustworthy.
//
//   node scripts/sr-activity-to-knocking.mjs              # writes data/sr-knocking.csv
//   node scripts/sr-activity-to-knocking.mjs --compare    # also diff against what's in Supabase
//
// Definitions match the existing Amplify sync so the numbers stay comparable:
//   doors        every stage change (a disposition tapped at a door)
//   unique_doors distinct leads touched that day
//   contacts     distinct leads set to Not Interested, Call Back or Sold
//   sold         distinct leads set to Sold
//   hours        last disposition minus first, same as the Amplify sync computed
//
// Nothing here writes to Supabase. It only produces a CSV to look at first.

import { readFileSync, writeFileSync, existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
const { canonicalDisplayName } = createRequire(import.meta.url)('../api/_name-aliases.js');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ACT = join(ROOT, 'data', 'sr-activity.jsonl');
const LEADS = join(ROOT, 'data', 'sr-leads.jsonl');
const LOOKUPS = join(ROOT, 'data', 'sr-lookups.json');
const OUT = join(ROOT, 'data', 'sr-knocking.csv');

const CONTACT = new Set(['Not Interested', 'Call Back', 'Sold']);
const SOLD = 'Sold';

// Intake accounts, not door reps. Leads get bulk-assigned and bulk-dispositioned
// through these, so their rows are admin work rather than knocking. The burst
// filter catches most of it, but whatever leaks through still isn't a rep's day.
const EXCLUDE_REPS = new Set(['daxton day', 'nick boyd'].map((s) => s.toLowerCase()));

// A knock happens where the door is, so the day it belongs to is the day in the
// LEAD's timezone, not the account's or the viewer's. Same table the Amplify
// sync uses, keyed off each lead's own state rather than the rep's recent deals.
const STATE_TZ = {
  UT: 'America/Denver', CO: 'America/Denver', NM: 'America/Denver', WY: 'America/Denver', MT: 'America/Denver',
  ID: 'America/Boise', AZ: 'America/Phoenix',
  IL: 'America/Chicago', TX: 'America/Chicago', OK: 'America/Chicago', KS: 'America/Chicago', MO: 'America/Chicago',
  WI: 'America/Chicago', MN: 'America/Chicago', IA: 'America/Chicago', NE: 'America/Chicago', SD: 'America/Chicago',
  ND: 'America/Chicago', AR: 'America/Chicago', LA: 'America/Chicago', MS: 'America/Chicago', AL: 'America/Chicago',
  TN: 'America/Chicago', AB: 'America/Edmonton', SK: 'America/Regina', MB: 'America/Winnipeg',
  IN: 'America/Indiana/Indianapolis', MI: 'America/Detroit',
  OH: 'America/New_York', KY: 'America/New_York', GA: 'America/New_York', FL: 'America/New_York',
  SC: 'America/New_York', NC: 'America/New_York', VA: 'America/New_York', WV: 'America/New_York',
  PA: 'America/New_York', NY: 'America/New_York', NJ: 'America/New_York', MD: 'America/New_York',
  DE: 'America/New_York', CT: 'America/New_York', RI: 'America/New_York', MA: 'America/New_York',
  VT: 'America/New_York', NH: 'America/New_York', ME: 'America/New_York', DC: 'America/New_York',
  ON: 'America/Toronto', QC: 'America/Toronto',
  CA: 'America/Los_Angeles', OR: 'America/Los_Angeles', WA: 'America/Los_Angeles', NV: 'America/Los_Angeles', BC: 'America/Vancouver',
};
const DEFAULT_TZ = 'America/Chicago';

const fmtCache = new Map();
const localParts = (iso, tz) => {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true });
    fmtCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(iso)).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${Number(p.hour)}:${p.minute} ${p.dayPeriod}`, ms: Date.parse(iso) };
};

const eachJsonl = async (f, fn) => {
  const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) { if (!line) continue; try { fn(JSON.parse(line)); } catch {} }
};

// Lead state, so each event can be bucketed in the right timezone.
const stateOf = new Map();
await eachJsonl(LEADS, (l) => stateOf.set(l.id, (l.region || '').trim().toUpperCase()));
const lk = existsSync(LOOKUPS) ? JSON.parse(readFileSync(LOOKUPS, 'utf8')) : { stages: {} };
const stageName = (id) => lk.stages[id] || '';

// Pass 1: collect every stage change, so bursts can be spotted before tallying.
// A rep flipping 40 doors inside a minute is a bulk edit in the web app, not
// someone walking a street, and those runs are big enough to swamp real totals
// (12% of all doors, almost all of it on the intake accounts).
const BURST_N = Number(opt('--burst-count', '10')) || 10;      // events...
const BURST_SEC = Number(opt('--burst-seconds', '60')) || 60;  // ...within this many seconds
const NO_FILTER = flag('--keep-bulk');

const byRep = new Map();
let events = 0, skipped = 0, excluded = 0;
await eachJsonl(ACT, (a) => {
  const tz = STATE_TZ[stateOf.get(a.id)] || DEFAULT_TZ;
  for (const e of a.activity || []) {
    if (e.event_name !== 'stage_updated') continue;
    const rep = canonicalDisplayName((e.actor_name || '').replace(/\s+/g, ' ').trim());
    if (!rep || !e.datetime) { skipped++; continue; }
    if (EXCLUDE_REPS.has(rep.toLowerCase())) { excluded++; continue; }
    let d = e.data; try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch {}
    if (!byRep.has(rep)) byRep.set(rep, []);
    byRep.get(rep).push({ lead: a.id, tz, stage: stageName(d && d.new_stage_id), iso: e.datetime, ms: Date.parse(e.datetime) });
    events++;
  }
});

// Mark bursts: any window of BURST_N events by one rep spanning < BURST_SEC.
let dropped = 0;
for (const list of byRep.values()) {
  list.sort((x, y) => x.ms - y.ms);
  for (let i = 0; i + BURST_N - 1 < list.length; i++) {
    const j = i + BURST_N - 1;
    if (list[j].ms - list[i].ms < BURST_SEC * 1000) for (let k = i; k <= j; k++) list[k].bulk = true;
  }
  for (const x of list) if (x.bulk) dropped++;
}

const agg = new Map();   // rep|date -> tallies
for (const [rep, list] of byRep) {
  for (const x of list) {
    if (x.bulk && !NO_FILTER) continue;
    const { date, time, ms } = localParts(x.iso, x.tz);
    const stage = x.stage, a = { id: x.lead };
    const k = rep + '|' + date;
    let g = agg.get(k);
    if (!g) { g = { rep, date, doors: 0, leads: new Set(), contacts: new Set(), sold: new Set(), minMs: ms, maxMs: ms, first: time, last: time }; agg.set(k, g); }
    g.doors++;
    g.leads.add(a.id);
    if (CONTACT.has(stage)) g.contacts.add(a.id);
    if (stage === SOLD) g.sold.add(a.id);
    if (ms < g.minMs) { g.minMs = ms; g.first = time; }
    if (ms > g.maxMs) { g.maxMs = ms; g.last = time; }
  }
}

const rows = [...agg.values()].map((g) => ({
  rep: g.rep, date: g.date, doors: g.doors, unique_doors: g.leads.size,
  contacts: g.contacts.size, sold: g.sold.size,
  first_disp: g.first, last_disp: g.last,
  hours: Math.round(((g.maxMs - g.minMs) / 3600000) * 100) / 100,
  source: 'grow', method: 'sr_activity',
})).sort((a, b) => a.date.localeCompare(b.date) || a.rep.localeCompare(b.rep));

const cell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const cols = Object.keys(rows[0] || {});
writeFileSync(OUT, [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n');

const dates = rows.map((r) => r.date).sort();
console.log(`${events.toLocaleString()} stage changes seen`);
console.log(`${excluded.toLocaleString()} skipped from intake accounts (${[...EXCLUDE_REPS].join(', ')})`);
console.log(`${dropped.toLocaleString()} dropped as bulk edits (${BURST_N}+ within ${BURST_SEC}s)${NO_FILTER ? ' — KEPT, --keep-bulk' : ''}`);
console.log(`${(events - (NO_FILTER ? 0 : dropped)).toLocaleString()} knocks -> ${rows.length.toLocaleString()} rep/day rows`);
console.log(`covering ${dates[0]} .. ${dates[dates.length - 1]}, ${new Set(rows.map((r) => r.rep)).size} reps`);
if (skipped) console.log(`${skipped} events skipped (no actor or no timestamp)`);
console.log(`-> ${OUT}`);
