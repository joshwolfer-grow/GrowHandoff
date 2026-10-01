#!/usr/bin/env node
// Which ISP owns each SalesRabbit import batch. THE source of truth for "whose
// door is this" — a door belongs to the batch it was imported in, and a batch
// is one ISP's file. Geography (data/isps.json states/cities) is only the
// fallback for the ~2% of doors reps created by hand with no batch.
//
//   node scripts/isp-registry.mjs            # pull /imports, auto-label, report
//   node scripts/isp-registry.mjs --label <import_id|prefix> <ISP>   # set by hand
//
// Writes data/isp-imports.json: { <import_id>: {isp, file, date, records, how} }.
// `how` is "rule" (matched a filename prefix below), "manual", or null when
// nobody has said. Manual labels are never overwritten by a rule.
// Exit 2 when any batch is unlabeled, so the daily runner can flag it.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REG = join(ROOT, 'data', 'isp-imports.json');
const AUTH = join(ROOT, 'data', 'sr-auth.json');

// Filename prefix -> ISP folder name (must match data/isps.json and Drive).
// Order matters: first match wins. Keep these the short codes lead-import.py
// writes ("SR <CODE>-<TOWN> (<date>) - Import.csv").
const RULES = [
  [/\bSKY-/i, 'Skynet'],
  [/\bOMNI\b/i, 'Omni'],
  [/\b(I3|13)-|_I3-|\bi3\b/i, 'i3'],
  [/\bSLIC-|\bSLIC\b/i, 'SLIC'],
  [/\bGLO-|\bGL-|\bGLO\b/i, 'Glo'],
  [/\bGFI-|\bGFI\b|\bGFIBER\b/i, 'GFiber'],
  [/\bGBN\b|\bGB-/i, 'GBN'],
  [/\bSURF-|\bSURF\b/i, 'Surf'],
  [/\bNLF-|\bNL-|SR-NL\b|SHERWOOD_PARK/i, 'NLF'],
  [/(^|[\s_])LY-|\bLYTE\b|\bLITE\b|Jeff Import|Kingsville/i, 'Lyte'],
];
export function ispForFile(name) {
  for (const [rx, isp] of RULES) if (rx.test(name || '')) return isp;
  return null;
}

const reg = existsSync(REG) ? JSON.parse(readFileSync(REG, 'utf8')) : {};
const args = process.argv.slice(2);

if (args[0] === '--label') {
  const [, key, isp] = args;
  if (!key || !isp) { console.error('usage: --label <import_id|prefix> <ISP>'); process.exit(1); }
  const ids = Object.keys(reg).filter((k) => k.startsWith(key));
  if (!ids.length) { console.error('no batch starts with ' + key); process.exit(1); }
  for (const id of ids) { reg[id].isp = isp; reg[id].how = 'manual'; }
  writeFileSync(REG, JSON.stringify(reg, null, 1));
  console.log(`labeled ${ids.length}: ${ids.map((i) => reg[i].file).join(', ')} -> ${isp}`);
  process.exit(0);
}

const H = { ...JSON.parse(readFileSync(AUTH, 'utf8')).headers, Accept: 'application/json' };
let all = [];
for (let off = 0; off < 5000; off += 30) {
  const r = await fetch(`https://apis.salesrabbit.com/imports?page[limit]=30&page[offset]=${off}`, { headers: H });
  if (!r.ok) { console.error(`imports: HTTP ${r.status}`); process.exit(r.status === 401 ? 3 : 1); }
  const d = (await r.json()).data || [];
  all = all.concat(d);
  if (d.length < 30) break;
}
let added = 0;
for (const i of all) {
  const a = i.attributes;
  const cur = reg[i.id] || {};
  const isp = cur.how === 'manual' ? cur.isp : ispForFile(a.flatfile_file_name);
  if (!reg[i.id]) added++;
  reg[i.id] = { isp, file: a.flatfile_file_name, date: a.inserted_at.slice(0, 10),
                records: a.records_processed_count, how: cur.how === 'manual' ? 'manual' : (isp ? 'rule' : null) };
}
writeFileSync(REG, JSON.stringify(reg, null, 1));
const byIsp = {};
for (const v of Object.values(reg)) { const k = v.isp || '(unlabeled)'; byIsp[k] = (byIsp[k] || 0) + 1; }
console.log(`${all.length} imports on SalesRabbit, ${added} new, by ISP:`, byIsp);
const un = Object.entries(reg).filter(([, v]) => !v.isp);
if (un.length) {
  console.log('\nUNLABELED — fix with: node scripts/isp-registry.mjs --label <id-prefix> <ISP>');
  for (const [id, v] of un) console.log(`  ${id.slice(0, 8)}  ${v.date}  ${String(v.records).padStart(6)}  ${v.file}`);
  process.exit(2);
}
