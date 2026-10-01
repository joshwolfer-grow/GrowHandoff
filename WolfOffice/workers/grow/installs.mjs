#!/usr/bin/env node
// Installs: tracks day-over-day movement of install dates for recent deals
// (pushed, pulled in, cancelled, newly booked, booked far out).
import { growGet } from '../../lib/growdb.mjs';
import { writeSnapshot, latestSnapshot, today } from '../../lib/db.mjs';
import { diff, statusLine } from './installs.logic.mjs';

function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('en-CA');
}

async function main() {
  const since = daysAgoISO(60);
  const day = today();

  const deals = await growGet(
    `bria_deals?select=bria_id,rep,isp,sale_date,install_date,install_time&sale_date=gte.${since}`
  );

  const curMap = {};
  for (const d of deals) {
    curMap[d.bria_id] = {
      install_date: d.install_date,
      install_time: d.install_time,
      rep: d.rep,
      isp: d.isp,
      sale_date: d.sale_date,
    };
  }

  const prev = await latestSnapshot('installs', day);
  const prevMap = prev ? (prev.data && prev.data.map ? prev.data.map : prev.data) : null;
  const result = diff(prevMap, curMap, day);
  await writeSnapshot('installs', day, { map: curMap, diff: result, first: !prev });
  console.log(statusLine(result, !prev, deals.length));
}

main().catch((err) => {
  console.log(`error: ${err.message}`);
  process.exit(1);
});
