#!/usr/bin/env node
// Move SalesRabbit AREAS between groups (teams) in bulk.
//
// An area's team is a plain `group_id` attribute on the area. It does NOT
// follow the reps: moving people to a new team leaves every area pointed at
// whatever team it was last set to, which is why a split has always meant
// re-picking the team on each area by hand.
//
// Auth is the token grow-sync.mjs seeds (data/sr-auth.json). If it is dead,
// run: node scripts/grow-sync.mjs --seed
//
//   --snapshot              write the current id -> group_id of every area
//   --plan <file.csv>       area_id,destination_group  (name or uuid)
//   --apply                 actually send the writes (default is a dry run)
//   --rollback <snap.json>  put every area back where the snapshot had it
//
// Nothing is sent without --apply, and --apply always snapshots first, so any
// pass can be undone with --rollback.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createInterface } from 'readline';

const API = 'https://apis.salesrabbit.com';
const D = (f) => new URL(`../data/${f}`, import.meta.url).pathname;
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i < 0 ? null : argv[i + 1]; };
const APPLY = flag('--apply');

const auth = (() => {
  if (!existsSync(D('sr-auth.json'))) die('No data/sr-auth.json. Run: node scripts/grow-sync.mjs --seed');
  const j = JSON.parse(readFileSync(D('sr-auth.json'), 'utf8'));
  if (!j.headers || !j.headers.Authorization) die('data/sr-auth.json has no token. Re-seed.');
  return j.headers;
})();
const HEAD = { ...auth, 'content-type': 'application/vnd.api+json', accept: 'application/vnd.api+json' };

function die(m) { console.error(m); process.exit(1); }

// Corporate sector areas are named by our own sector-map pipeline: a short
// all-caps code then a number, e.g. "MASS 1.1", "OLMS 1.1", "NWCHIL-2.3".
// They belong to corporate and must survive any team migration, so a plan that
// names one is refused rather than obeyed. --include-corporate overrides it for
// the rare deliberate case.
const CORP = /^[A-Z]{3,6}[-\s]?\d/;
const isCorp = (t) => CORP.test((t || '').trim());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 4) {
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch(url, { headers: auth });
      if (r.status === 401) die('SalesRabbit rejected the token (401). Run: node scripts/grow-sync.mjs --seed');
      if (r.ok) return await r.json();
    } catch (e) { /* retry */ }
    await sleep(400 * (a + 1));
  }
  return null;
}

async function groups() {
  const j = await getJson(`${API}/groups?page%5Blimit%5D=200&page%5Boffset%5D=0`);
  const byId = {}, byName = {};
  for (const r of (j && j.data) || []) {
    const n = (r.attributes || {}).name || '';
    byId[r.id] = n; byName[n.toLowerCase()] = r.id;
  }
  return { byId, byName };
}

async function areas() {
  const out = [];
  for (let off = 0; ; off += 500) {
    const j = await getJson(`${API}/areas?page%5Blimit%5D=500&page%5Boffset%5D=${off}`);
    const rows = (j && j.data) || [];
    // A page that never came back is not the end of the list. Treating it as
    // one would silently shrink the plan, so say so and stop.
    if (!j) die(`Areas page at offset ${off} kept failing. Nothing was sent.`);
    for (const r of rows) {
      const a = r.attributes || {};
      out.push({ id: r.id, title: a.title || '', group_id: a.group_id || '', homes: a.homes });
    }
    if (rows.length < 500) break;
  }
  return out;
}

function snapshot(list) {
  const f = D(`sr-areas-snapshot-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 13)}.json`);
  writeFileSync(f, JSON.stringify(list.map(({ id, title, group_id }) => ({ id, title, group_id })), null, 1));
  console.log(`snapshot: ${list.length} areas -> ${f}`);
  return f;
}

// The one write. JSON:API PATCH on the area resource.
async function setGroup(id, group_id) {
  const body = JSON.stringify({ data: { type: 'area', id, attributes: { group_id } } });
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(`${API}/areas/${id}`, { method: 'PATCH', headers: HEAD, body });
      if (r.ok) return { ok: true };
      const t = await r.text();
      if (r.status === 401) die('Token died mid-run (401). Re-seed and re-run; already-moved areas are fine.');
      if (r.status < 500) return { ok: false, status: r.status, body: t.slice(0, 200) };
    } catch (e) { /* retry */ }
    await sleep(500 * (a + 1));
  }
  return { ok: false, status: 0, body: 'gave up after 3 tries' };
}

async function confirm(n) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((r) => rl.question(`\nSend ${n} area move${n === 1 ? '' : 's'} to SalesRabbit? type yes: `, r));
  rl.close();
  if (a.trim().toLowerCase() !== 'yes') die('nothing sent.');
}

(async () => {
  const g = await groups();
  const list = await areas();
  const gname = (id) => g.byId[id] || id || '(none)';

  if (flag('--snapshot')) { snapshot(list); return; }

  let moves = [];

  if (val('--rollback')) {
    const f = JSON.parse(readFileSync(val('--rollback'), 'utf8'));
    const now = Object.fromEntries(list.map((a) => [a.id, a.group_id]));
    const isRun = Array.isArray(f) && f.length && f[0] && 'to' in f[0];
    if (isRun) {
      // A run log knows what THIS pass did, so it undoes only that. An area
      // someone re-picked in the app since then is no longer where the run left
      // it, and reverting that would stomp a deliberate change — skip those and
      // name them instead.
      const drifted = [];
      for (const m of f) {
        if (!now[m.id]) continue;                         // area deleted since
        if (now[m.id] !== m.to) { drifted.push(m); continue; }
        if (m.from === m.to) continue;
        moves.push({ id: m.id, title: m.title, from: m.to, to: m.from });
      }
      if (drifted.length) {
        console.log(`  ${drifted.length} area${drifted.length === 1 ? '' : 's'} changed again after that run — left alone:`);
        for (const d of drifted.slice(0, 10))
          console.log(`    ${d.id} ${JSON.stringify(d.title)} now on ${gname(now[d.id])}, the run left it on ${gname(d.to)}`);
      }
    } else {
      // A full snapshot restores the whole board to how it looked then, which
      // also undoes hand edits made since. Say so out loud before the confirm.
      moves = f.filter((s) => now[s.id] && now[s.id] !== s.group_id)
               .map((s) => ({ id: s.id, title: s.title, from: now[s.id], to: s.group_id }));
      console.log('  NOTE: that is a full snapshot — it restores EVERY area to how it looked then,');
      console.log('  including any you re-picked by hand since. A run log (sr-areas-run-*.json) undoes only that run.');
    }
  } else if (val('--plan')) {
    const byId = Object.fromEntries(list.map((a) => [a.id, a]));
    var corpSkipped = [];
    const lines = readFileSync(val('--plan'), 'utf8').trim().split(/\r?\n/);
    if (/area_id/i.test(lines[0])) lines.shift();
    for (const [i, ln] of lines.entries()) {
      const [id, dest] = ln.split(',').map((s) => (s || '').trim());
      if (!id) continue;
      const a = byId[id];
      if (!a) { console.log(`  row ${i + 1}: no area with id ${id} — skipped`); continue; }
      const to = g.byId[dest] ? dest : g.byName[(dest || '').toLowerCase()];
      if (!to) { console.log(`  row ${i + 1}: no group named "${dest}" — skipped`); continue; }
      if (a.group_id === to) continue;                    // already there
      if (isCorp(a.title) && !flag('--include-corporate')) { corpSkipped.push(a); continue; }
      moves.push({ id, title: a.title, from: a.group_id, to });
    }
  } else {
    console.log('Areas by group:');
    const c = {};
    for (const a of list) { const k = gname(a.group_id); c[k] = (c[k] || 0) + 1; }
    for (const [k, v] of Object.entries(c).sort((x, y) => y[1] - x[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);
    console.log('\nGroups:');
    for (const [id, n] of Object.entries(g.byId)) console.log(`  ${id}  ${n}`);
    console.log('\nPass --plan <csv> (area_id,destination_group) to move them, or --snapshot first.');
    return;
  }

  if (typeof corpSkipped !== 'undefined' && corpSkipped.length) {
    console.log(`\n${corpSkipped.length} corporate sector area${corpSkipped.length === 1 ? '' : 's'} named in the plan — NOT moving (pass --include-corporate to override):`);
    for (const a of corpSkipped.slice(0, 10)) console.log(`    ${JSON.stringify(a.title)}  on ${gname(a.group_id)}`);
    if (corpSkipped.length > 10) console.log(`    ... and ${corpSkipped.length - 10} more`);
  }

  if (!moves.length) { console.log('Nothing to move — every area is already where the plan wants it.'); return; }

  console.log(`\n${moves.length} area${moves.length === 1 ? '' : 's'} would move:`);
  const pairs = {};
  for (const m of moves) { const k = `${gname(m.from)} -> ${gname(m.to)}`; pairs[k] = (pairs[k] || 0) + 1; }
  for (const [k, v] of Object.entries(pairs).sort((x, y) => y[1] - x[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);
  for (const m of moves.slice(0, 15)) console.log(`    ${m.id}  ${JSON.stringify(m.title).padEnd(20)} ${gname(m.from)} -> ${gname(m.to)}`);
  if (moves.length > 15) console.log(`    ... and ${moves.length - 15} more`);

  if (!APPLY) { console.log('\nDRY RUN — nothing sent. Re-run with --apply to do it.'); return; }

  const snapFile = snapshot(list);
  await confirm(moves.length);

  const done = []; const bad = [];
  // Written as we go, not at the end. A run that dies halfway — dead token,
  // closed laptop — still leaves a log of exactly what already moved, which is
  // the only thing that can undo a partial pass.
  const runFile = D(`sr-areas-run-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 13)}.json`);
  for (const [i, m] of moves.entries()) {
    const r = await setGroup(m.id, m.to);
    if (r.ok) { done.push({ id: m.id, title: m.title, from: m.from, to: m.to }); }
    else bad.push({ ...m, ...r });
    writeFileSync(runFile, JSON.stringify(done, null, 1));
    process.stdout.write(`\r  ${i + 1}/${moves.length} sent, ${done.length} ok, ${bad.length} failed   `);
    await sleep(120);                                     // stay polite
  }
  process.stdout.write('\r' + ' '.repeat(60) + '\r');
  console.log(`done: ${done.length} moved, ${bad.length} failed`);
  for (const b of bad.slice(0, 10)) console.log(`  FAILED ${b.id} ${JSON.stringify(b.title)} HTTP ${b.status} ${b.body}`);
  console.log(`\nrun log:  ${runFile}`);
  console.log(`undo just this run:   node scripts/sr-area-group.mjs --rollback ${runFile} --apply`);
  console.log(`restore the whole board: node scripts/sr-area-group.mjs --rollback ${snapFile} --apply`);
})();
