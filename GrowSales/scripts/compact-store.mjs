#!/usr/bin/env node
// Drop the superseded lines from the append-only crawl stores.
//
//   node scripts/compact-store.mjs --dry-run   # report what it would save
//   node scripts/compact-store.mjs             # compact both files
//
// data/sr-store.jsonl and data/sr-leads.jsonl are append-only with latest-line-
// wins per lead id. That is what makes an interrupted crawl harmless, and it is
// also why they grow without bound: re-pull a lead 20 times and the file holds
// 20 copies of it, 19 of which every compile reads and throws away. As of
// 2026-08-18 the store was 68% superseded lines (627k lines, 202k leads) and the
// lead file 69%, and a compile reads ~1.3 GB to use ~650 MB of it. Reading the
// dead half is most of what pushed a scheduled tick past the 240s watchdog in
// run-grow-sync.sh.
//
// Compacting keeps the LAST line for each id and drops the rest, which is
// exactly what the compile would have kept — so the compiled CSVs and knock rows
// are byte-identical before and after. Verify that yourself if you like:
//
//   node scripts/grow-sync.mjs --skip-crawl --no-push        # before
//   cp data/sr-knocking.csv /tmp/before.csv
//   node scripts/compact-store.mjs
//   node scripts/grow-sync.mjs --skip-crawl --no-push        # after
//   diff /tmp/before.csv data/sr-knocking.csv                # must be empty
//
// Safety: writes a .compact.tmp beside the original and renames it into place,
// so a crash leaves the original untouched. The previous file is kept as
// <name>.pre-compact until you delete it — this rewrites the only copy of a
// crawl that costs 40 minutes to rebuild, so it does not delete its own undo.
//
// Do NOT run this while a sync is running: run-grow-sync.sh's pid lock does not
// cover a manual invocation, and a crawl appending to a file being rewritten
// would lose whatever it appended.

import { createReadStream, createWriteStream, statSync, renameSync, copyFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DRY = process.argv.includes('--dry-run');
const FILES = ['data/sr-store.jsonl', 'data/sr-leads.jsonl'];
const mb = (b) => (b / 1048576).toFixed(0) + ' MB';

for (const rel of FILES) {
  const f = join(ROOT, rel);
  if (!existsSync(f)) { console.log(`${rel}: missing, skipped`); continue; }

  // Pass 1: which line number is the last one for each id.
  const last = new Map();
  let n = -1;
  for await (const l of createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity })) {
    n++; const m = l.match(/^\{"id":"([^"]+)"/); if (m) last.set(m[1], n);
  }
  const lines = n + 1, before = statSync(f).size;

  if (DRY) {
    console.log(`${rel}: ${mb(before)}, ${lines.toLocaleString()} lines -> ${last.size.toLocaleString()} leads (${(100 * (1 - last.size / lines)).toFixed(0)}% superseded)`);
    continue;
  }

  // Pass 2: copy the winners through, in the order they already appear. Keeping
  // the original order (rather than Map insertion order) means the file a crawl
  // appends to next looks exactly like the one it appended to before.
  const tmp = f + '.compact.tmp';
  const out = createWriteStream(tmp);
  let n2 = -1, kept = 0;
  for await (const l of createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity })) {
    n2++;
    const m = l.match(/^\{"id":"([^"]+)"/);
    if (!m || last.get(m[1]) !== n2) continue;
    kept++;
    if (!out.write(l + '\n')) await once(out, 'drain');
  }
  out.end(); await once(out, 'finish');

  // Refuse to install a result that lost a lead. A short file here means the
  // source was being appended to underneath us, and the whole point of the
  // .pre-compact copy is that this failure costs nothing.
  if (kept !== last.size) { console.error(`${rel}: ABORT — wrote ${kept} of ${last.size} leads, leaving the original alone`); process.exitCode = 1; continue; }

  copyFileSync(f, f + '.pre-compact');
  renameSync(tmp, f);
  const after = statSync(f).size;
  console.log(`${rel}: ${mb(before)} -> ${mb(after)} (${lines.toLocaleString()} -> ${kept.toLocaleString()} lines). Previous file kept at ${rel}.pre-compact`);
}

if (!DRY) console.log('\nRecompile and compare before deleting the .pre-compact copies:\n  node scripts/grow-sync.mjs --skip-crawl --no-push');
