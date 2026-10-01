#!/usr/bin/env node
// Pull Time Track report attachments out of a pile of email and drop them in
// imports/, ready for `npm run import-timetrack`.
//
// This is the one-time backfill path for everything before 2026-04-02, when the
// only copy of the Ezee / Houston Time Track report was the daily email.
//
//   node scripts/harvest-timetrack-mail.mjs <mbox-or-dir> [--before=2026-04-02] [--dry]
//
// Accepts a Google Takeout .mbox, a folder of .eml / .mbox files, or a folder of
// saved attachments. Walks every MIME part, keeps the .csv / .xlsx attachments
// that look like a Time Track export, converts xlsx -> csv, and writes them to
// imports/ named by the email's date so re-running never collides.
//
// Zero credentials and zero dependencies: it reads files you already have on
// disk. It never touches the mailbox.

import { readFileSync, readdirSync, writeFileSync, unlinkSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, basename } from 'node:path';
import { xlsxToCsv } from './_xlsx2csv.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const IMPORTS = join(ROOT, 'imports');

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const src = args.find((a) => !a.startsWith('--'));
const before = (args.find((a) => a.startsWith('--before=')) || '--before=2026-04-02').slice(9);
const after = (args.find((a) => a.startsWith('--after=')) || '--after=').slice(8);
if (!src) {
  console.error('Usage: node scripts/harvest-timetrack-mail.mjs <mbox-or-dir> [--before=YYYY-MM-DD] [--after=YYYY-MM-DD] [--dry]');
  process.exit(1);
}

// --- header helpers -------------------------------------------------------

// Unfold RFC 5322 continuation lines, then index headers by lowercase name.
function parseHeaders(raw) {
  const h = {};
  for (const line of raw.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const m = /^([A-Za-z0-9-]+):\s*([\s\S]*)$/.exec(line);
    if (m) h[m[1].toLowerCase()] = m[2];
  }
  return h;
}

// =?UTF-8?B?...?= / =?UTF-8?Q?...?= encoded words in filenames and subjects.
function decodeWords(s) {
  return (s || '').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, txt) => {
    try {
      const buf = enc.toUpperCase() === 'B'
        ? Buffer.from(txt, 'base64')
        : Buffer.from(txt.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, x) => String.fromCharCode(parseInt(x, 16))), 'binary');
      return buf.toString(/utf-?8/i.test(cs) ? 'utf8' : 'latin1');
    } catch { return txt; }
  });
}

function paramOf(headerValue, name) {
  if (!headerValue) return null;
  // RFC 2231 split/extended form: name*0=, name*1*=, name*=utf-8''...
  const parts = [...headerValue.matchAll(new RegExp(`${name}\\*(\\d+)\\*?\\s*=\\s*("([^"]*)"|[^;]+)`, 'gi'))]
    .sort((a, b) => +a[1] - +b[1]).map((m) => (m[3] ?? m[2]).trim());
  if (parts.length) return decodeURIComponent(parts.join('').replace(/^[^']*'[^']*'/, ''));
  const one = new RegExp(`${name}\\*?\\s*=\\s*("([^"]*)"|[^;]+)`, 'i').exec(headerValue);
  if (!one) return null;
  return decodeWords((one[2] ?? one[1]).trim().replace(/^[^']*'[^']*'/, ''));
}

function decodeBody(body, encoding) {
  const e = (encoding || '7bit').toLowerCase().trim();
  if (e === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64');
  if (e === 'quoted-printable') {
    return Buffer.from(
      body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))),
      'binary'
    );
  }
  return Buffer.from(body, 'binary');
}

// --- MIME walk ------------------------------------------------------------

// Yields { filename, data } for every attachment-ish part, recursing through
// multipart/* containers. Also collects text bodies so we can spot link-only
// reports (an email with a "download" URL and no file attached).
function walkParts(raw, out) {
  const split = raw.indexOf('\n\n') >= 0 ? raw.indexOf('\n\n') + 2 : raw.length;
  const head = parseHeaders(raw.slice(0, split));
  const body = raw.slice(split);
  const ctype = head['content-type'] || 'text/plain';

  if (/^multipart\//i.test(ctype.trim())) {
    const b = paramOf(ctype, 'boundary');
    if (!b) return;
    // Split on the boundary delimiter lines only (not the string appearing in text).
    const chunks = body.split(new RegExp(`^--${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \t]*$`, 'm'));
    for (const c of chunks.slice(1)) if (c.trim()) walkParts(c.replace(/^\r?\n/, ''), out);
    return;
  }

  const name = paramOf(head['content-disposition'], 'filename') || paramOf(ctype, 'name');
  if (name) {
    out.files.push({ filename: decodeWords(name), data: decodeBody(body, head['content-transfer-encoding']) });
  } else if (/^text\//i.test(ctype.trim())) {
    out.text += decodeBody(body, head['content-transfer-encoding']).toString('utf8');
  }
}

// --- message splitting ----------------------------------------------------

// An mbox is messages separated by lines starting "From " at column 0.
function splitMbox(raw) {
  const msgs = [];
  let cur = null;
  for (const line of raw.split(/\r?\n/)) {
    if (/^From \S+.*\d{4}$/.test(line)) { if (cur) msgs.push(cur.join('\n')); cur = []; continue; }
    if (cur) cur.push(line.replace(/^>(?=>*From )/, ''));   // undo mbox From-quoting
  }
  if (cur && cur.length) msgs.push(cur.join('\n'));
  return msgs.length ? msgs : [raw];
}

function collectSources(path) {
  const st = statSync(path);
  if (st.isFile()) return [path];
  return readdirSync(path)
    .filter((f) => /\.(mbox|eml|txt)$/i.test(f))
    .map((f) => join(path, f));
}

// --- run ------------------------------------------------------------------

const isoOf = (dateHeader) => {
  const d = new Date(decodeWords(dateHeader || ''));
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
};
const looksLikeReport = (f) => /\.(csv|xlsx)$/i.test(f) && !/^(image|logo|signature)/i.test(basename(f));

if (!existsSync(IMPORTS)) mkdirSync(IMPORTS, { recursive: true });

let scanned = 0, kept = 0, skippedDate = 0, noAttachment = 0;
const linkOnly = [], written = [], seen = new Set();

for (const file of collectSources(src)) {
  const raw = readFileSync(file, 'latin1');
  for (const msg of splitMbox(raw)) {
    const split = msg.indexOf('\n\n') >= 0 ? msg.indexOf('\n\n') + 2 : msg.length;
    const head = parseHeaders(msg.slice(0, split));
    if (!head.subject && !head.from && !head.date) continue;
    scanned++;

    const iso = isoOf(head.date) || 'undated';
    if (before && iso !== 'undated' && iso >= before) { skippedDate++; continue; }
    if (after && iso !== 'undated' && iso < after) { skippedDate++; continue; }

    const out = { files: [], text: '' };
    walkParts(msg, out);
    const reports = out.files.filter((f) => looksLikeReport(f.filename));

    if (!reports.length) {
      noAttachment++;
      const url = (out.text.match(/https?:\/\/\S*(?:report|export|download|timetrack|time_track)\S*/i) || [])[0];
      if (url) linkOnly.push({ date: iso, subject: decodeWords(head.subject || '').slice(0, 70), url });
      continue;
    }

    for (const f of reports) {
      const ext = extname(f.filename).toLowerCase();
      let data = f.data, outName = `${iso}-${basename(f.filename, ext).replace(/[^\w.-]+/g, '_')}.csv`;
      if (ext === '.xlsx') {
        if (dry) { kept++; written.push(outName + '  (xlsx, would convert)'); continue; }
        const tmp = join(IMPORTS, `.tmp-${iso}-${kept}.xlsx`);
        writeFileSync(tmp, data);
        try { data = Buffer.from(xlsxToCsv(tmp), 'utf8'); }
        catch (e) { console.error(`  ✗ ${f.filename} (${iso}): ${e.message}`); continue; }
        finally { unlinkSync(tmp); }
      }
      let n = outName, i = 2;
      while (seen.has(n)) n = outName.replace(/\.csv$/, `-${i++}.csv`);
      seen.add(n);
      kept++; written.push(n);
      if (!dry) writeFileSync(join(IMPORTS, n), data);
    }
  }
}

console.log(`Scanned ${scanned} messages`);
console.log(`  ${kept} report attachment(s) ${dry ? 'would land in' : 'written to'} imports/`);
if (skippedDate) console.log(`  ${skippedDate} skipped (outside ${after || '…'} → ${before})`);
if (noAttachment) console.log(`  ${noAttachment} in range had no csv/xlsx attachment`);
if (written.length) console.log('\n' + written.sort().map((w) => '  ' + w).join('\n'));
if (linkOnly.length) {
  console.log(`\n⚠ ${linkOnly.length} message(s) carry a download link instead of a file — these need the link followed:`);
  for (const l of linkOnly.slice(0, 10)) console.log(`  ${l.date}  ${l.subject}\n      ${l.url}`);
}
console.log(dry ? '\nDry run — nothing written. Drop --dry to write.' : '\nNext: npm run import-timetrack');
