#!/usr/bin/env node
// Dry test for the resumable crawl in grow-sync.mjs. No SalesRabbit, no
// Supabase, nothing under data/ is touched: a mock API serves synthetic leads
// and every run works in its own temp directory via --data-dir / --api.
//
//   node scripts/test-grow-sync-resume.mjs
//
// What it proves:
//   1. A backlog that one capped run cannot cover (--max-pages) is drained by a
//      few consecutive capped runs, each saving where it got to, and the final
//      watermark + store equal what ONE uncapped run produces — even when the
//      list shifts under the scan between ticks (new activity on top, a lead
//      deleted).
//   2. A small delta under --scheduled (one page) behaves as before: watermark
//      advances, no partial marker is written.
//
// Exit 0 when every check passes, 1 otherwise.

import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SYNC = join(ROOT, 'scripts', 'grow-sync.mjs');
const T0 = Date.parse('2026-10-16T12:00:00.000Z');          // the stored watermark
const iso = (ms) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');

// ---- synthetic SalesRabbit: id -> { latest, activity[] }
const leads = new Map();
const addLead = (id, latestMs, region = 'TX') => {
  const activity = [{ datetime: iso(latestMs), event_name: 'stage_updated', actor_name: `Rep ${(latestMs / 1000) % 20 | 0}`, actor_email: 'rep@example.com',
                      data: JSON.stringify({ new_stage_id: 's1' }), distance: 12 }];
  leads.set(id, { latest: iso(latestMs), region, activity });
};
// 300 leads safely BELOW the cutoff (older than watermark - 30 min): never pulled.
for (let i = 0; i < 300; i++) addLead(`old-${i}`, T0 - 3 * 3600e3 - i * 60e3);
// 1,250 leads in the window: 12.5 pages, so a 5-page cap needs three ticks.
for (let i = 0; i < 1250; i++) addLead(`new-${i}`, T0 - 20 * 60e3 + i * 12e3);
const sorted = () => [...leads.entries()].sort((a, b) => (a[1].latest < b[1].latest ? 1 : a[1].latest > b[1].latest ? -1 : 0));

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  if (u.pathname === '/stages') return send({ data: [{ id: 's1', attributes: { name: 'Not Interested' } }] });
  if (u.pathname === '/profiles') return send({ data: [] });
  if (u.pathname === '/loci/es_search') {
    const p = Number(u.searchParams.get('page') || 1), lim = Number(u.searchParams.get('limit') || 100);
    const rows = sorted().slice((p - 1) * lim, p * lim).map(([id, l]) => ({ id, attributes: { latest_activity_at: l.latest, region: l.region, city: 'Austin', postal_code: '78701', street1: `${id} Main St`, import_id: '' } }));
    return send({ data: rows });
  }
  const m = u.pathname.match(/^\/loci\/([^/]+)$/);
  if (m) {
    const l = leads.get(m[1]);
    if (!l) { res.statusCode = 404; return res.end('{}'); }
    return send({ data: { attributes: { activity: l.activity } } });
  }
  res.statusCode = 404; res.end('{}');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const API = `http://127.0.0.1:${server.address().port}`;

// ---- a fresh data dir seeded with the same starting store and watermark
const seedDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'grow-sync-test-'));
  writeFileSync(join(d, 'sr-store.jsonl'), [...leads.keys()].filter((k) => k.startsWith('old-')).map((id) => JSON.stringify({ id, a: [{ t: leads.get(id).latest, ev: 'stage_updated', rep: 'Rep 1', em: 'rep@example.com', st: '', na: '', no: '', di: '12' }] })).join('\n') + '\n');
  writeFileSync(join(d, 'sr-leads.jsonl'), '');
  writeFileSync(join(d, 'sr-sync-state.json'), JSON.stringify({ lastActivityAt: iso(T0) }));
  writeFileSync(join(d, 'sr-auth.json'), JSON.stringify({ headers: { Authorization: 'Bearer test' } }));
  return d;
};
// Async on purpose: the mock server lives in THIS process, so a spawnSync here
// would block the event loop and the child would wait on it forever.
const run = async (dir, extra) => {
  const r = await new Promise((resolve) => {
    const c = spawn(process.execPath, [SYNC, '--data-dir', dir, '--api', API, '--no-push', '--lean', ...extra]);
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  const out = (r.stdout + r.stderr).replace(/\r[^\n]*\r/g, '\r');
  console.log(out.split('\n').filter((l) => /Crawl|NOTE|leads changed|re-pulled|watermark|resum|progress/.test(l)).map((l) => '    ' + l.trim().replace(/\s+/g, ' ')).join('\n'));
  if (r.status !== 0) { console.log(out); throw new Error(`grow-sync exited ${r.status}`); }
  return out;
};
const state = (dir) => JSON.parse(readFileSync(join(dir, 'sr-sync-state.json'), 'utf8'));
// latest line wins, same rule the compile uses
const storeView = (dir) => {
  const m = new Map();
  for (const l of readFileSync(join(dir, 'sr-store.jsonl'), 'utf8').split('\n')) if (l) { const o = JSON.parse(l); m.set(o.id, JSON.stringify(o.a)); }
  return m;
};

let fails = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails++; };

// ---- 1. capped ticks vs one uncapped run, with the list moving between ticks
console.log('\n1. Backlog of 1,250 changed leads, cap of 5 pages per tick');
const A = seedDir();
console.log('  tick 1');
await run(A, ['--max-pages', '5']);
let s = state(A);
check(s.lastActivityAt === iso(T0) && s.partial && s.partial.pages === 5, 'tick 1: watermark unchanged, partial marker saved at page 5');
// The world moves: 120 leads from the UNSCANNED part get new activity (they
// jump above everything), and one scanned lead is deleted (everything below it
// shifts up a row). Both are what the resume probe has to survive.
for (let i = 0; i < 120; i++) addLead(`new-${i}`, T0 + 6 * 3600e3 + i * 1000);
leads.delete('new-1240');
console.log('  tick 2 (120 leads moved to the top, one deleted)');
await run(A, ['--max-pages', '5']);
s = state(A);
check(s.lastActivityAt === iso(T0) && s.partial && s.partial.pages > 5, 'tick 2: still partial, further along');
console.log('  tick 3');
await run(A, ['--max-pages', '5']);
s = state(A);
check(!s.partial, 'tick 3: window covered, partial marker cleared');
const topOfWindow = s.lastActivityAt;
console.log('  tick 4 (normal tick after the backlog, picks up the 120 that moved up)');
await run(A, ['--max-pages', '5']);
s = state(A);

// One uncapped run over the same final world.
console.log('  one uncapped run on a fresh copy of the same starting state');
const B = seedDir();
await run(B, []);
const sB = state(B);
check(s.lastActivityAt === sB.lastActivityAt, `final watermark equal (${s.lastActivityAt})`);
check(topOfWindow && topOfWindow < sB.lastActivityAt, 'the capped series advanced the watermark only after covering the whole window');
const vA = storeView(A), vB = storeView(B);
const missing = [...vB.keys()].filter((k) => !vA.has(k)), extra = [...vA.keys()].filter((k) => !vB.has(k));
const differ = [...vB.keys()].filter((k) => vA.has(k) && vA.get(k) !== vB.get(k));
// The one allowed difference: the capped series pulled new-1240 in tick 1,
// before the test deleted it, and the store never forgets a lead (see the
// crawl-keeps-deleted-leads note). The uncapped run started after the deletion.
check(!missing.length && !differ.length && extra.join() === 'new-1240', `store identical lead for lead (${vA.size} leads; missing ${missing.length}, differ ${differ.length}, extra ${extra.join() || 'none'})`);
check(vA.has('new-0') && vA.has('new-1249') && vA.has('new-1239') && vA.has('new-1241'), 'leads on both sides of the deletion and both ends of the window present');

// ---- 2. a small delta under --scheduled is unchanged
console.log('\n2. Small delta under --scheduled');
const C = seedDir();
for (const [id] of [...leads].filter(([k]) => k.startsWith('new-'))) leads.delete(id);
for (let i = 0; i < 40; i++) addLead(`tiny-${i}`, T0 + 60e3 + i * 1000);
await run(C, ['--scheduled']);
const sC = state(C);
check(sC.lastActivityAt === iso(T0 + 60e3 + 39 * 1000) && !('partial' in sC), 'watermark advanced to the newest lead, no partial key written');
check(storeView(C).size === 340, 'store holds the 300 old + 40 new leads');

server.close();
console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll checks passed.');
process.exit(fails ? 1 : 0);
