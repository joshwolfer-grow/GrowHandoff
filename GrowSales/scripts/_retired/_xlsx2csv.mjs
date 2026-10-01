// Minimal zero-dependency .xlsx -> CSV converter (first worksheet only).
// Uses the system `unzip` (macOS ships it) to read the two XML parts we need,
// so there's no library to install just to unwrap a Time Track export.
//
//   node scripts/_xlsx2csv.mjs book.xlsx [out.csv]
//   import { xlsxToCsv } from './_xlsx2csv.mjs'

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const unzip = (file, member) => {
  try { return execFileSync('unzip', ['-p', file, member], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8'); }
  catch { return ''; }
};

const UNESC = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s) => s
  .replace(/<[^>]+>/g, '')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&(lt|gt|amp|quot|apos);/g, (_, e) => UNESC[e]);

// "BC12" -> 54 (0-based column index)
const colIndex = (ref) => {
  const m = /^([A-Z]+)/.exec(ref || '');
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

export function xlsxToRows(file) {
  // sharedStrings holds every text cell; <si> entries may be split into runs.
  const shared = [...unzip(file, 'xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((m) => decode(m[1]));

  // The workbook's first sheet isn't always sheet1.xml; fall back to it if the
  // rels lookup comes up empty.
  let sheetXml = unzip(file, 'xl/worksheets/sheet1.xml');
  if (!sheetXml) {
    const names = execFileSync('unzip', ['-Z1', file]).toString().split('\n')
      .filter((n) => /^xl\/worksheets\/.*\.xml$/.test(n)).sort();
    if (names[0]) sheetXml = unzip(file, names[0]);
  }
  if (!sheetXml) throw new Error(`could not read a worksheet out of ${file}`);

  const rows = [];
  for (const rm of sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<c([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], body = cm[2] || '';
      const type = (/\bt="([^"]+)"/.exec(attrs) || [])[1];
      const at = colIndex((/\br="([^"]+)"/.exec(attrs) || [])[1]);
      let val;
      if (type === 's') {
        const i = +decode((/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1] || '-1');
        val = shared[i] ?? '';
      } else if (type === 'inlineStr') {
        val = decode((/<is>([\s\S]*?)<\/is>/.exec(body) || [])[1] || '');
      } else {
        val = decode((/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1] || '');
      }
      if (at >= 0) { while (cells.length < at) cells.push(''); cells[at] = val; }
      else cells.push(val);
    }
    rows.push(cells);
  }
  return rows;
}

const esc = (v) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export const rowsToCsv = (rows) => rows.map((r) => r.map((c) => esc(c ?? '')).join(',')).join('\n') + '\n';
export const xlsxToCsv = (file) => rowsToCsv(xlsxToRows(file));

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , src, out] = process.argv;
  if (!src) { console.error('Usage: node scripts/_xlsx2csv.mjs book.xlsx [out.csv]'); process.exit(1); }
  const csv = xlsxToCsv(src);
  if (out) { writeFileSync(out, csv); console.log(`✓ ${out}`); } else process.stdout.write(csv);
}
