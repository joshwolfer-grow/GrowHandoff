#!/usr/bin/env node
// Install-time desk for one ISP: earliest install date and open windows per market.
// GrowSales' scripts/install-slots.mjs does the walking (a real door per market, up to
// the install calendar, never submitted or booked); this desk runs it for its ISP and
// keeps the read as the day's findings.
//   node workers/grow/slots.mjs tds
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeSnapshot, today } from '../../lib/db.mjs';
import { NAME, summarize, statusLine } from './slots.logic.mjs';

const GROW = process.env.GROW_DIR || path.join(os.homedir(), 'Grow', 'GrowSales');
const LIMIT_MS = 15 * 60 * 1000;

async function main() {
  const isp = String(process.argv[2] || '').toLowerCase();
  if (!NAME[isp]) { console.log(`error: usage slots.mjs <${Object.keys(NAME).join('|')}>`); return 2; }
  const started = new Date().toISOString();

  // The walker's own per-market lines go straight to the log; our summary prints last.
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, ['scripts/install-slots.mjs', '--isp', isp], { cwd: GROW, stdio: ['ignore', 'inherit', 'inherit'] });
    const kill = setTimeout(() => p.kill('SIGTERM'), LIMIT_MS);
    p.on('error', () => { clearTimeout(kill); resolve(127); });
    p.on('close', (c) => { clearTimeout(kill); resolve(c ?? 143); });
  });

  const file = path.join(GROW, 'data', 'install-slots.jsonl');
  const rows = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.isp === isp && String(r.checked_at) >= started) : [];
  if (!rows.length) { console.log(`error: install-slots.mjs exited ${code} without reading any market`); return code || 1; }

  const s = summarize(isp, rows);
  await writeSnapshot(`slots-${isp}`, today(), { ...s, ranAt: started });
  console.log(statusLine(s));
  return code;
}

main().then((c) => process.exit(c)).catch((err) => { console.log(`error: ${err.message}`); process.exit(1); });
