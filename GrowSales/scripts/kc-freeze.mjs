// One-off: freeze the KC/Raytown rep/days before those leads are deleted from
// SalesRabbit. grow-sync's push() wipes method='sr_activity' and recompiles it
// from live activity, so once the leads are gone these June days would recompile
// to nothing. Copy them to method='sr_frozen_kc', which push() never touches.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SB = 'https://cmkfohwbejcztctrpdnt.supabase.co';
const ANON = (readFileSync(join(ROOT, 'index.html'), 'utf8').match(/eyJ[A-Za-z0-9_.-]{50,}/) || [])[0];
if (!ANON) { console.error('No anon key in index.html'); process.exit(1); }
const H = { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' };

const keys = JSON.parse(readFileSync(join(ROOT, 'data/kc-frozen-repdays.json'), 'utf8'));
const dates = [...new Set(keys.map((k) => k.date))].sort();
const want = new Set(keys.map((k) => k.rep + '|' + k.date));
const DRY = process.argv.includes('--dry');

const q = `${SB}/rest/v1/knocking?method=eq.sr_activity&date=gte.${dates[0]}&date=lte.${dates.at(-1)}&select=*`;
const res = await fetch(q, { headers: H });
if (!res.ok) { console.error('Read failed:', res.status, (await res.text()).slice(0, 300)); process.exit(1); }
const all = await res.json();
const rows = all.filter((r) => want.has(r.rep + '|' + r.date));
console.log(`window ${dates[0]}..${dates.at(-1)}: ${all.length} sr_activity rows, ${rows.length} match the KC rep/days`);

const missing = [...want].filter((k) => !rows.some((r) => r.rep + '|' + r.date === k));
if (missing.length) console.log(`no knocking row for ${missing.length} rep/day(s): ${missing.slice(0, 5).join(', ')}`);

const frozen = rows.map(({ id, ...r }) => ({ ...r, method: 'sr_frozen_kc' }));
const tot = frozen.reduce((a, r) => a + (r.doors || 0), 0);
console.log(`would write ${frozen.length} rows, ${tot.toLocaleString()} doors, as method='sr_frozen_kc'`);
if (DRY) { console.log('dry run, nothing written'); process.exit(0); }

const existing = await (await fetch(`${SB}/rest/v1/knocking?method=eq.sr_frozen_kc&select=rep`, { headers: H })).json();
if (existing.length) { console.error(`refusing: ${existing.length} sr_frozen_kc rows already exist`); process.exit(1); }

let ok = 0;
for (let i = 0; i < frozen.length; i += 500) {
  const r = await fetch(`${SB}/rest/v1/knocking`, {
    method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(frozen.slice(i, i + 500)) });
  if (!r.ok) { console.error('Insert failed:', r.status, (await r.text()).slice(0, 300)); process.exit(1); }
  ok += Math.min(500, frozen.length - i);
}
console.log(`froze ${ok} rep/days as sr_frozen_kc`);
