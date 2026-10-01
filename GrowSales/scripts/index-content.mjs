// scripts/index-content.mjs
// Build the "Ask Grow" semantic index (doc_chunks): training decks (Canva),
// Pronto chat, and manager notes/requests -> chunk -> embed (Google
// text-embedding-004, free) -> upsert via the public anon key (same pattern as
// import-timetrack.mjs; doc_chunks allows anon writes).
//
//   node scripts/index-content.mjs --dry                 chunk + report, no embed/write
//   node scripts/index-content.mjs --only=training       one source
//   node scripts/index-content.mjs                       full rebuild of all three
//
// Env: GEMINI_API_KEY (required unless --dry). SUPABASE anon key is read from
// index.html; training text comes from imports/canva-training.json (produced in
// a Claude session via the Canva connector — that content can't be pulled from a
// headless cron).
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SB_URL = 'https://cmkfohwbejcztctrpdnt.supabase.co';
const ANON = (readFileSync(join(ROOT, 'index.html'), 'utf8').match(/eyJ[A-Za-z0-9_.-]+/) || [])[0];
if (!ANON) { console.error('Could not read the anon key from index.html'); process.exit(1); }
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const onlyArg = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];
const ONLY = onlyArg ? onlyArg.split(',').map((s) => s.trim()) : ['training', 'chat', 'note'];

const H = { apikey: ANON, Authorization: `Bearer ${ANON}` };
const H_JSON = { ...H, 'Content-Type': 'application/json' };

// ---------- Supabase helpers (raw PostgREST, anon) ----------
async function sbSelect(table, query) {
  const rows = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const r = await fetch(`${SB_URL}/rest/v1/${table}?${query}`, {
      headers: { ...H, 'Range-Unit': 'items', Range: `${offset}-${offset + PAGE - 1}` },
    });
    if (r.status !== 200 && r.status !== 206) throw new Error(`select ${table}: ${r.status} ${(await r.text()).slice(0, 160)}`);
    const batch = await r.json();
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}
async function sbDelete(table, filter) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, { method: 'DELETE', headers: { ...H_JSON, Prefer: 'return=minimal' } });
  if (!r.ok && r.status !== 404) throw new Error(`delete ${table}: ${r.status} ${(await r.text()).slice(0, 160)}`);
}
async function sbInsert(rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const r = await fetch(`${SB_URL}/rest/v1/doc_chunks`, { method: 'POST', headers: { ...H_JSON, Prefer: 'return=minimal' }, body: JSON.stringify(chunk) });
    if (!r.ok) throw new Error(`insert doc_chunks: ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
}

// ---------- Gemini embeddings (free text-embedding-004, 768-dim) ----------
async function embedAll(texts) {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY not set (needed to embed). Use --dry to skip.');
  const out = [];
  const BATCH = 20;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const body = { requests: slice.map((t) => ({ model: 'models/gemini-embedding-001', content: { parts: [{ text: t }] }, taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: 768 })) };
    let j = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents?key=${GEMINI_KEY}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        if (r.ok) { j = await r.json(); break; }
        const txt = (await r.text()).slice(0, 200);
        if (r.status === 429) { process.stdout.write(`  429, backing off ${Math.min(attempt+1,5)*30}s\n`); await sleep(Math.min(attempt + 1, 5) * 30000); continue; }
        throw new Error(`embed batch ${i}: ${r.status} ${txt}`);
      } catch (e) {
        if (String(e).includes('embed batch')) throw e;
        process.stdout.write(`  network hiccup (${String(e.cause || e.message).slice(0,60)}), retry in ${Math.min(attempt+1,6)*20}s\n`);
        await sleep(Math.min(attempt + 1, 6) * 20000);
      }
    }
    if (!j) throw new Error(`embed batch ${i}: gave up after retries`);
    out.push(...j.embeddings.map((e) => e.values));
    process.stdout.write(`  embedded ${Math.min(i + BATCH, texts.length)}/${texts.length}\r`);
    await sleep(7000);
  }
  process.stdout.write('\n');
  return out;
}

// ---------- Chunking ----------
// Pack paragraphs greedily into ~targetChars windows, carrying one paragraph of
// overlap so a thought split across a boundary is still retrievable.
function chunkText(text, targetChars = 1200, minChars = 200) {
  const paras = String(text).split(/\n{2,}|\r\n\r\n/).map((p) => p.replace(/\s+\n/g, '\n').trim()).filter(Boolean);
  const chunks = [];
  let buf = '';
  for (const p of paras) {
    if (buf && (buf.length + p.length + 2) > targetChars) {
      chunks.push(buf.trim());
      const tail = buf.split(/\n{2,}/).slice(-1)[0] || '';
      buf = (tail.length < targetChars / 2 ? tail + '\n\n' : '');
    }
    buf += (buf ? '\n\n' : '') + p;
  }
  if (buf.trim().length >= minChars || (chunks.length === 0 && buf.trim())) chunks.push(buf.trim());
  return chunks;
}

const hasWords = (s) => /[a-zA-Z]{2,}/.test(s || '');

// ---------- Source builders ----------
function buildTraining() {
  const dir = join(ROOT, 'imports', 'canva');
  if (!existsSync(dir)) { console.warn('  (no imports/canva/ — skipping training; extract decks there via the Canva connector)'); return []; }
  // One .txt per deck (filename = deck title). Optional manifest.json maps
  // "<title>" -> { url } to attach a clickable citation.
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.txt'));
  let manifest = {};
  const mPath = join(dir, 'manifest.json');
  if (existsSync(mPath)) { try { manifest = JSON.parse(readFileSync(mPath, 'utf8')); } catch { /* ignore */ } }
  const rows = [];
  for (const f of files) {
    const title = f.replace(/\.txt$/i, '');
    const text = readFileSync(join(dir, f), 'utf8');
    const url = (manifest[title] && manifest[title].url) || null;
    chunkText(text).forEach((content, ix) => {
      rows.push({ source: 'training', source_id: title, chunk_ix: ix, title, ref: title, url, content });
    });
  }
  return rows;
}

async function buildChat() {
  const metas = await sbSelect('pronto_sync_meta', 'select=bubble_id,market').catch(() => []);
  const marketById = {}; for (const m of metas) marketById[m.bubble_id] = m.market || '';
  const msgs = await sbSelect('pronto_messages', 'select=id,bubble_id,fullname,message,created_at_utc&order=bubble_id.asc,created_at_utc.asc');
  // Group into ~1500-char windows per bubble+day; drop emoji-only tally messages.
  const rows = [];
  const groups = new Map();
  for (const m of msgs) {
    if (!hasWords(m.message)) continue;
    const day = (m.created_at_utc || '').slice(0, 10);
    const key = `${m.bubble_id}|${day}`;
    (groups.get(key) || groups.set(key, []).get(key)).push(m);
  }
  for (const [key, list] of groups) {
    const [bubble_id, day] = key.split('|');
    const market = marketById[bubble_id] || bubble_id;
    let buf = [], len = 0, win = 0;
    const flush = () => {
      if (!buf.length) return;
      rows.push({ source: 'chat', source_id: `${bubble_id}:${day}:${win}`, chunk_ix: win, title: `Pronto ${market}`.trim(), ref: `Pronto ${market} ${day}`.trim(), url: null, content: buf.join('\n') });
      win++; buf = []; len = 0;
    };
    for (const m of list) {
      const line = `${m.fullname || 'someone'}: ${m.message.trim()}`;
      if (len + line.length > 1500) flush();
      buf.push(line); len += line.length + 1;
    }
    flush();
  }
  return rows;
}

async function buildNotes() {
  const rows = [];
  // (table, content column, author column, date column, citation label)
  const specs = [
    ['manager_notes', 'notes', 'manager', 'updated_at', 'Manager note'],
    ['manager_requests', 'message', 'manager', 'created_at', 'Manager request'],
  ];
  for (const [table, col, authorCol, dateCol, label] of specs) {
    let data = [];
    try { data = await sbSelect(table, 'select=*'); }
    catch (e) { console.warn(`  (${table} not readable: ${String(e.message).slice(0, 80)})`); continue; }
    for (const row of data) {
      const body = (row[col] || '').trim();
      if (!hasWords(body)) continue;
      const author = row[authorCol] ? `${row[authorCol]}: ` : '';
      const day = (row[dateCol] || '').slice(0, 10);
      const id = row.id != null ? String(row.id) : String(rows.length);
      rows.push({ source: 'note', source_id: `${table}:${id}`, chunk_ix: 0, title: label, ref: `${label}${day ? ' ' + day : ''}`, url: null, content: author + body });
    }
  }
  return rows;
}

// ---------- Main ----------
const builders = { training: buildTraining, chat: buildChat, note: buildNotes };
let all = [];
for (const src of ['training', 'chat', 'note']) {
  if (!ONLY.includes(src)) continue;
  const rows = await builders[src]();
  const chars = rows.reduce((a, r) => a + r.content.length, 0);
  console.log(`${src}: ${rows.length} chunks, ${(chars / 1000).toFixed(0)}k chars`);
  all = all.concat(rows);
}

if (!all.length) { console.log('Nothing to index.'); process.exit(0); }

if (DRY) {
  console.log(`\n[dry] ${all.length} chunks total. Sample:`);
  for (const r of all.slice(0, 3)) console.log(`  [${r.source}] ${r.ref}\n    ${r.content.slice(0, 140).replace(/\n/g, ' ')}...`);
  console.log('\n[dry] no embeddings, no writes. Set GEMINI_API_KEY and drop --dry to build the index.');
  process.exit(0);
}

console.log(`\nEmbedding ${all.length} chunks...`);
const vectors = await embedAll(all.map((r) => r.content));
all.forEach((r, i) => { r.embedding = vectors[i]; });

console.log('Writing to doc_chunks...');
for (const src of ONLY) await sbDelete('doc_chunks', `source=eq.${src}`);
await sbInsert(all);
console.log(`Done. Indexed ${all.length} chunks for [${ONLY.join(', ')}].`);
