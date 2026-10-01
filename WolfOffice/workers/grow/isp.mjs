#!/usr/bin/env node
// ISP sales analyst: node workers/grow/isp.mjs <i3|slic|lyte|surf|tds|ezee|omni|all>
// One desk per ISP, same script. Reads Grow's deals and knocking, writes a
// per-ISP snapshot with flags (anything out of the ordinary) and wins (things
// worth sharing). `all` is the Sales lead: rolls up every ISP's latest snapshot.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { growGet } from '../../lib/growdb.mjs';
import { writeSnapshot, latestSnapshot, today } from '../../lib/db.mjs';
import { ISPS, analyze, statusLine, rollup, rollupLine, repIspByWeek, shiftDays, weekOf } from './isp.logic.mjs';

const arg = process.argv[2];
const G = path.join(os.homedir(), 'Grow', 'GrowSales');

function exportStampAge() {
  try { const st = fs.statSync(path.join(G, 'imports', 'done', 'isp-export-last-run')); return (Date.now() - st.mtimeMs) / 36e5; } catch { return null; }
}
function parkedFor(code) {
  try { return fs.readdirSync(path.join(G, 'imports', 'isp', 'parked')).filter(f => !f.startsWith('.') && f.toLowerCase().includes(code)); } catch { return []; }
}

async function analyzeOne(key) {
  const I = ISPS[key];
  const day = today();
  const since = shiftDays(weekOf(day), -7 * 17);
  const inList = (arr) => `in.(${arr.map(s => `"${s}"`).join(',')})`;
  const [deals, bria, allDeals, knocking] = await Promise.all([
    growGet(`deals?select=rep,status,isp,sale_date,install_date,cancel_date,cancel_reason,planned_install,past_due,deal_type,customer,phone&isp=${inList(I.deals)}&sale_date=gte.${since}&limit=20000`),
    // Sales come from Bria (synced nightly into bria_deals); the report stays the source for installs and cancels.
    growGet(`bria_deals?select=rep,customer,phone,sale_date,install_date,isp&isp=${inList(I.bria)}&sale_date=gte.${since}&limit=20000`),
    growGet(`deals?select=rep,isp,sale_date&sale_date=gte.${since}&limit=50000`),
    growGet(`knocking?select=rep,date,doors,sold,source,method&date=gte.${since}&method=in.(sr_activity,timetrack,amplify)&limit=50000`),
  ]);
  // Attribute knocking: rows tagged with this ISP's source count directly; SalesRabbit
  // rows (source grow) go to whichever ISP the rep sold for that week.
  const map = repIspByWeek(allDeals);
  const mine = knocking.filter(k => {
    if (I.source && k.source === I.source) return true;
    if (k.source && k.source !== 'grow') return false;
    const isp = k.rep && (map[k.rep] ? (map[k.rep][weekOf(k.date)] || null) : null);
    return isp ? I.deals.includes(isp) : false;
  });
  const s = analyze({ ispKey: key, deals, bria, knocking: mine, today: day, exportStampAge: exportStampAge(), parkedFiles: parkedFor(I.code) });
  await writeSnapshot(`isp-${key}`, day, s);
  return s;
}

async function main() {
  if (arg === 'all') {
    const day = today();
    const sums = [];
    for (const key of Object.keys(ISPS)) { const snap = await latestSnapshot(`isp-${key}`, shiftDays(day, 1)); if (snap && snap.data && snap.day >= shiftDays(day, -1)) sums.push(snap.data); }
    if (!sums.length) { console.log('error: no ISP desks have reported yet today'); process.exit(1); }
    const r = rollup(sums);
    await writeSnapshot('sales-lead', day, r);
    console.log(rollupLine(r));
    return;
  }
  if (!ISPS[arg]) { console.log(`usage: isp.mjs <${Object.keys(ISPS).join('|')}|all>`); process.exit(2); }
  const s = await analyzeOne(arg);
  console.log(statusLine(s));
}
main().catch((err) => { console.log(`error: ${err.message}`); process.exit(1); });
