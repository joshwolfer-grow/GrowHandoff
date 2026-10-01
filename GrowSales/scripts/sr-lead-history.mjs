#!/usr/bin/env node
// SalesRabbit -> every lead, with its full activity history.
//
// This is the per-lead breakdown you see when you click a lead in the UI. The
// CSV export can't give it, and Amplify can't either (it knows a door only by
// customerId, with no address). SalesRabbit's own API has both:
//
//   1. GET /loci/es_search          -> the door list, paginated (address, stage, ids)
//   2. GET /loci/<lead_id>          -> that door's activity array
//
// Step 2 is one request per lead, so a full run is ~167k requests. That takes
// tens of minutes and WILL be interrupted at some point, so everything is
// written to JSONL as it arrives and a re-run skips whatever is already done.
//
//   node scripts/sr-lead-history.mjs --login    # ONE TIME: window opens, sign in
//   node scripts/sr-lead-history.mjs --leads    # step 1 only: pull the door list
//   node scripts/sr-lead-history.mjs            # steps 1+2, resumable
//   node scripts/sr-lead-history.mjs --limit 500  # stop after N leads, for a test
//   node scripts/sr-lead-history.mjs --report   # compile the CSVs from what's on disk
//
// Output (data/):
//   sr-leads.jsonl      one line per door
//   sr-activity.jsonl   one line per door, holding its activity array
//   sr-lead-history.csv one row per door: knocks, days, reps, first/last, status
//   sr-activity.csv     one row per activity event (the long form)

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, appendFileSync, existsSync, createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROFILE = join(ROOT, '.sr-profile');
const APP = 'https://app.salesrabbit.com';
const API = 'https://apis.salesrabbit.com';
const LEADS_FILE = join(ROOT, 'data', 'sr-leads.jsonl');
const ACT_FILE = join(ROOT, 'data', 'sr-activity.jsonl');

const LOGIN = flag('--login'), LEADS_ONLY = flag('--leads'), REPORT_ONLY = flag('--report');
const LIMIT = Number(opt('--limit', '0')) || 0;
const PAGE_SIZE = Number(opt('--page-size', '100')) || 100;   // es_search rows per page
const CONCURRENCY = Number(opt('--concurrency', '20')) || 20;
const BATCH = 500;                                            // leads per evaluate() round trip

// Every field the lead detail view exposes, taken from the app's own request.
const LEAD_FIELDS = 'assignee_id,city,coordinates,country,first_activity_at,geocode_error,group_id,import_id,inserted_at,latest_activity_at,postal_code,region,stage_id,street1,street2,tenant_id,title,updated_at';

// Streamed line-by-line: the activity file runs to hundreds of MB, well past the
// ~512MB ceiling Node puts on a single string, so readFileSync is not an option.
const eachJsonl = async (f, fn) => {
  if (!existsSync(f)) return 0;
  const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    fn(o); n++;
  }
  return n;
};
// Small files only (lookups, and the --limit test paths).
const readJsonl = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);

// ---------------------------------------------------------------- REPORT
// Compiles whatever is on disk. Separate from the crawl so a long run can be
// turned into a report at any point, including while it's still going.
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const writeCsv = (path, rows) => {
  if (!rows.length) { console.log(`(nothing to write to ${path})`); return; }
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  writeFileSync(path, [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n');
  console.log(`${path}  (${rows.length} rows)`);
};
const compile = async () => {
  // Keep only the fields the report needs. Holding 182k full lead objects is
  // hundreds of MB for no reason.
  const leads = new Map();
  await eachJsonl(LEADS_FILE, (l) => leads.set(l.id, {
    street1: l.street1, street2: l.street2, city: l.city, region: l.region, postal_code: l.postal_code,
    stage_id: l.stage_id, assignee_id: l.assignee_id, title: l.title, coordinates: l.coordinates,
  }));
  const lk = existsSync(join(ROOT, 'data', 'sr-lookups.json'))
    ? JSON.parse(readFileSync(join(ROOT, 'data', 'sr-lookups.json'), 'utf8')) : { stages: {}, profiles: {} };
  const stageName = (id) => lk.stages[id] || id || '';
  const repName = (id) => lk.profiles[id] || id || '';
  console.log(`\n${leads.size.toLocaleString()} leads on file`);

  // Both CSVs are streamed with a fixed column list. Collecting rows in arrays
  // first would rebuild the same out-of-memory problem the JSONL read had.
  const WIDE = ['lead_id','street','unit','city','state','zip','title','current_stage','assigned_to','knocks','days_knocked','reps','first_knock','last_knock','last_knocked_by','knocked_by','notes','last_note','total_events','last_event','last_touch','coordinates'];
  const LONG = ['lead_id','street','unit','city','state','zip','datetime','event','rep','rep_email','new_stage','new_assignee','note','distance'];
  const wideOut = createWriteStream(join(ROOT, 'data', 'sr-lead-history.csv'));
  const longOut = createWriteStream(join(ROOT, 'data', 'sr-activity.csv'));
  wideOut.write(WIDE.join(',') + '\n');
  longOut.write(LONG.join(',') + '\n');
  const emit = (stream, cols, row) => stream.write(cols.map((c) => csvCell(row[c])).join(',') + '\n');
  let nWide = 0, nLong = 0;

  await eachJsonl(ACT_FILE, (a) => {
    const l = leads.get(a.id) || {};
    const evs = (a.activity || []).slice().sort((x, y) => String(x.datetime).localeCompare(String(y.datetime)));
    const addr = { street: l.street1 || '', unit: l.street2 || '', city: l.city || '', state: l.region || '', zip: l.postal_code || '' };
    // A "knock" is a disposition change. The rest of the log is bookkeeping:
    // locus_created is the import, locus_updated is usually the geocoder, and
    // assignee_updated is a reassignment. Counting those as knocks would triple
    // every number.
    const KNOCK = /stage_updated/;
    const knocks = evs.filter((e) => KNOCK.test(e.event_name || ''));
    const notes = evs.filter((e) => /note_created/.test(e.event_name || ''));
    const noteText = (e) => { try { const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; return (d && d.text) || ''; } catch { return ''; } };
    for (const e of evs) {
      let d = e.data; try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch {}
      emit(longOut, LONG, { lead_id: a.id, ...addr, datetime: e.datetime || '', event: e.event_name || '',
        rep: e.actor_name || '', rep_email: e.actor_email || '',
        new_stage: d && d.new_stage_id ? stageName(d.new_stage_id) : '',
        new_assignee: d && d.new_assignee_id ? repName(d.new_assignee_id) : '',
        note: noteText(e), distance: e.distance == null ? '' : e.distance });
      nLong++;
    }
    const kreps = [...new Set(knocks.map((e) => e.actor_name).filter(Boolean))];
    const kdays = [...new Set(knocks.map((e) => String(e.datetime).slice(0, 10)).filter(Boolean))];
    const lastK = knocks[knocks.length - 1] || {};
    const lastAny = evs[evs.length - 1] || {};
    emit(wideOut, WIDE, { lead_id: a.id, ...addr, title: l.title || '',
      current_stage: stageName(l.stage_id), assigned_to: repName(l.assignee_id),
      knocks: knocks.length, days_knocked: kdays.length, reps: kreps.length,
      first_knock: (knocks[0] || {}).datetime || '', last_knock: lastK.datetime || '',
      last_knocked_by: lastK.actor_name || '', knocked_by: kreps.join(' | '),
      notes: notes.length, last_note: notes.length ? noteText(notes[notes.length - 1]) : '',
      total_events: evs.length, last_event: lastAny.event_name || '', last_touch: lastAny.datetime || '',
      coordinates: l.coordinates && l.coordinates.coordinates ? l.coordinates.coordinates.join(' ') : '' });
    nWide++;
  });

  await new Promise((r) => wideOut.end(r));
  await new Promise((r) => longOut.end(r));
  console.log(`${join(ROOT, 'data', 'sr-lead-history.csv')}  (${nWide.toLocaleString()} doors)`);
  console.log(`${join(ROOT, 'data', 'sr-activity.csv')}  (${nLong.toLocaleString()} activity marks)`);
};
if (REPORT_ONLY) { await compile(); process.exit(0); }

// ---------------------------------------------------------------- BROWSER
// --show runs the crawl with a visible window. Useful when the headless run
// can't get a token: the app may bounce through auth0 to refresh silently, and
// seeing the page makes it obvious whether that's what's happening.
const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: !(LOGIN || flag('--show') || flag('--go')), viewport: { width: 1280, height: 900 },
});
// The API wants the app's own Bearer token and profile id. Grab them off the
// requests the app makes on load rather than hardcoding a token that expires.
await ctx.addInitScript(() => {
  window.__auth = null;
  const grab = (h) => {
    try {
      const get = (k) => (h && typeof h.get === 'function' ? h.get(k) : (h || {})[k] || (h || {})[k.toLowerCase()]);
      const a = get('Authorization') || get('authorization');
      const p = get('x-profile-id') || get('X-Profile-Id');
      if (a) window.__auth = { Authorization: a, ...(p ? { 'x-profile-id': p } : {}) };
    } catch (e) {}
  };
  const O = XMLHttpRequest.prototype.open, H = XMLHttpRequest.prototype.setRequestHeader, S = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...r) { this.__h = {}; return O.call(this, m, u, ...r); };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) { try { this.__h[k] = v; } catch (e) {} return H.call(this, k, v); };
  XMLHttpRequest.prototype.send = function (b) { grab(this.__h); return S.call(this, b); };
  const F = window.fetch;
  window.fetch = function (input, init) {
    try { grab((init && init.headers) || (input && input.headers)); } catch (e) {}
    return F.apply(this, arguments);
  };
});

const page = await ctx.newPage();
await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

// --go is the one-step version: the window opens, you make sure you're logged
// in and looking at your leads, press Enter, and the crawl runs in THAT window.
// No separate login, no headless token guessing, no profile lock to trip over.
if (LOGIN || flag('--go')) {
  console.log('\nA Chrome window is open. Make sure you are logged into SalesRabbit and your leads are showing, then press Enter here.');
  process.stdin.resume();
  await new Promise((r) => process.stdin.once('data', r));
  if (LOGIN) {
    await ctx.close();
    console.log('Saved. The session lives in .sr-profile/');
    process.exit(0);
  }
  console.log('Starting the crawl in this window. Leave it open.');
}

// Wait for the app to issue an authenticated call so the token can be lifted.
// The app bounces through auth0 on load to refresh its token, so a URL match
// early on means "still booting", not "logged out". Only give up at the end,
// and say what was actually on screen when we did.
let auth = null;
for (let i = 0; i < 60 && !auth; i++) {
  auth = await page.evaluate(() => window.__auth);
  if (auth) break;
  if (i === 20) await page.goto(APP, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1000);
}
if (!auth) {
  const url = page.url();
  const title = await page.title().catch(() => '');
  console.error(`\nNo API token seen after 60s.`);
  console.error(`  landed on: ${url}`);
  console.error(`  page title: ${title || '(none)'}`);
  if (/auth0|login|signin/i.test(url)) console.error('  -> that is a login page, so the saved session expired. Re-run with --login.');
  else console.error('  -> the app loaded but made no authenticated call. Try:  --show   to watch it happen.');
  await ctx.close(); process.exit(2);
}
console.log('Session OK.');

// Stage and profile ids are UUIDs. Pull the two small lookup tables once so the
// report can say "Not Interested" and "Nick Boyd" instead of a pair of UUIDs.
const LOOKUPS = join(ROOT, 'data', 'sr-lookups.json');
{
  const lk = await page.evaluate(async ({ API, auth }) => {
    const get = async (u) => { try { const r = await fetch(u, { headers: auth }); return r.ok ? r.json() : null; } catch (e) { return null; } };
    const stages = await get(`${API}/stages?page%5Blimit%5D=200&page%5Boffset%5D=0&sort=order`);
    const profiles = await get(`${API}/profiles?page%5Blimit%5D=9999&page%5Boffset%5D=0`);
    const name = (j) => Object.fromEntries(((j && j.data) || []).map((r) => [r.id, (r.attributes || {}).name || '']));
    return { stages: name(stages), profiles: name(profiles) };
  }, { API, auth });
  writeFileSync(LOOKUPS, JSON.stringify(lk, null, 2));
  console.log(`Lookups: ${Object.keys(lk.stages).length} stages, ${Object.keys(lk.profiles).length} reps`);
}

// ---------------------------------------------------------------- STEP 1
// The door list. es_search pages with limit/page and is cheap, so this is the
// fast half: ~1,700 pages at 100/page for a 167k-lead tenant.
let leads = readJsonl(LEADS_FILE);
if (!leads.length) {
  console.log(`Pulling the lead list (${PAGE_SIZE}/page)...`);
  const t = Date.now();
  // Probe page 1 alone first: it reveals the real page size the API honours and
  // whether it reports a total, which is the difference between 1,670 pages and
  // 16,700. Silent for minutes is the worst way to find that out.
  const probe1 = await page.evaluate(async ({ API, auth, LEAD_FIELDS, PAGE_SIZE }) => {
    const r = await fetch(`${API}/loci/es_search?fields=${encodeURIComponent(LEAD_FIELDS)}&sort=-latest_activity_at&limit=${PAGE_SIZE}&page=1`, { headers: auth });
    if (!r.ok) return { status: r.status };
    const j = await r.json();
    return { rows: (j.data || []).length, meta: j.meta || null };
  }, { API, auth, LEAD_FIELDS, PAGE_SIZE });
  if (probe1.status) { console.error(`Lead list request failed with HTTP ${probe1.status}.`); await ctx.close(); process.exit(4); }
  console.log(`  page size honoured: ${probe1.rows} rows/page; meta: ${probe1.meta ? JSON.stringify(probe1.meta) : 'none'}`);

  // The API reports {"page":{"total":181971}} — a LEAD count, not a page count.
  // Deriving the real page count matters: without it the crawl can only stop by
  // requesting past the end and waiting for an empty response, and this API
  // keeps returning rows for out-of-range pages, so it never stops.
  const m = probe1.meta || {};
  const count = (m.page && m.page.total) || m.total_count || m.total || 0;
  let totalPages = (m.total_pages || m.page_count) || (count ? Math.ceil(count / PAGE_SIZE) : 0);
  if (LIMIT) totalPages = Math.min(totalPages || 1, Math.ceil(LIMIT / PAGE_SIZE));
  if (!totalPages) { console.error('  no page total reported, cannot bound the crawl.'); await ctx.close(); process.exit(4); }
  console.log(`  ${count.toLocaleString()} leads across ${totalPages} pages`);

  // The search index refuses to page past 100,000 results: page 1001 onward
  // just repeats what page 1000 returned. With 181,971 leads that leaves ~82k
  // unreachable from one end. So walk it from BOTH ends — newest-first, then
  // oldest-first — which covers everything as long as the tenant is under 200k.
  // The two passes overlap in the middle; the id dedupe absorbs that.
  const REACH = Math.floor(100000 / PAGE_SIZE);
  const SORTS = totalPages > REACH ? ['-latest_activity_at', 'latest_activity_at'] : ['-latest_activity_at'];
  if (SORTS.length > 1) {
    console.log(`  index caps at 100,000 per sort, so crawling from both ends (${REACH} pages each).`);
    if (count > 2 * 100000) console.log(`  WARNING: ${count.toLocaleString()} leads exceeds what two passes can reach; some will be missed.`);
  }
  const perSort = Math.min(totalPages, REACH);

  // Pull in chunks so progress is visible and partial work survives a stop.
  const CHUNK = 100;
  const seenIds = new Set();
  leads = [];
  for (const sort of SORTS) {
  for (let start = 1; start <= perSort; start += CHUNK) {
    const pages = []; for (let p = start; p < start + CHUNK && p <= perSort; p++) pages.push(p);
    const got = await page.evaluate(async ({ API, auth, LEAD_FIELDS, PAGE_SIZE, CONCURRENCY, pages, sort }) => {
      const get = async (p) => {
        const u = `${API}/loci/es_search?fields=${encodeURIComponent(LEAD_FIELDS)}&sort=${encodeURIComponent(sort)}&limit=${PAGE_SIZE}&page=${p}`;
        for (let a = 0; a < 5; a++) {
          try {
            const r = await fetch(u, { headers: auth });
            if (r.ok) return (await r.json()).data || [];
            if (r.status === 429 || r.status >= 500) { await new Promise((x) => setTimeout(x, 1000 * (a + 1))); continue; }
            return [];
          } catch (e) { await new Promise((x) => setTimeout(x, 500 * (a + 1))); }
        }
        return [];
      };
      const out = []; let n = 0;
      const worker = async () => { while (n < pages.length) { out.push(...(await get(pages[n++]))); } };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      return out;
    }, { API, auth, LEAD_FIELDS, PAGE_SIZE, CONCURRENCY, pages, sort });

    // Sorted by latest_activity_at, so rows shift between pages as the crawl
    // runs and the same lead can land on two pages. Dedupe on id.
    const fresh = got.map((r) => ({ id: r.id, ...(r.attributes || {}) })).filter((l) => l.id && !seenIds.has(l.id) && seenIds.add(l.id));
    leads.push(...fresh);
    if (!LIMIT) appendFileSync(LEADS_FILE, fresh.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const done = Math.min(start + CHUNK - 1, perSort);
    const dir = sort.startsWith('-') ? 'newest' : 'oldest';
    console.log(`  ${dir} pages ${done}/${perSort}  ${leads.length.toLocaleString()} leads`);
  }
  }
  console.log(`  ${leads.length.toLocaleString()} leads in ${((Date.now() - t) / 60000).toFixed(1)} min${LIMIT ? ' (not cached, --limit run)' : ` -> ${LEADS_FILE}`}`);
} else {
  console.log(`${leads.length} leads already on disk (${LEADS_FILE}); delete it to re-pull.`);
}
if (LEADS_ONLY) { await ctx.close(); await compile(); process.exit(0); }

// ---------------------------------------------------------------- STEP 2
// One request per lead. Written to JSONL in batches so an interrupted run
// resumes instead of starting over.
const done = new Set(readJsonl(ACT_FILE).map((a) => a.id));
let todo = leads.map((l) => l.id).filter((id) => id && !done.has(id));
if (LIMIT) todo = todo.slice(0, LIMIT);
console.log(`Activity: ${done.size} already pulled, ${todo.length} to go.`);

const t2 = Date.now();
let ok = 0, fail = 0;
for (let i = 0; i < todo.length; i += BATCH) {
  const chunk = todo.slice(i, i + BATCH);
  const res = await page.evaluate(async ({ API, auth, ids, CONCURRENCY }) => {
    const out = []; let n = 0, unauthorized = 0;
    const one = async (id) => {
      const u = `${API}/loci/${id}?fields%5Blocus%5D=activity`;
      for (let a = 0; a < 4; a++) {
        try {
          const r = await fetch(u, { headers: auth });
          if (r.ok) {
            const j = await r.json();
            const at = (j.data && j.data.attributes) || {};
            return { id, activity: at.activity || [] };
          }
          if (r.status === 401 || r.status === 403) { unauthorized++; return null; }
          if (r.status === 429 || r.status >= 500) { await new Promise((x) => setTimeout(x, 800 * (a + 1))); continue; }
          return null;
        } catch (e) { await new Promise((x) => setTimeout(x, 400 * (a + 1))); }
      }
      return null;
    };
    const worker = async () => { while (n < ids.length) { const id = ids[n++]; const r = await one(id); if (r) out.push(r); } };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    return { out, unauthorized };
  }, { API, auth, ids: chunk, CONCURRENCY });

  if (res.unauthorized > chunk.length / 2) {
    // Token aged out mid-run. Reload the app to mint a fresh one and retry.
    console.log('  token expired, refreshing...');
    await page.goto(APP, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(4000);
    const fresh = await page.evaluate(() => window.__auth);
    if (!fresh) { console.error('Could not refresh the token. Re-run to resume where this left off.'); break; }
    auth = fresh; i -= BATCH; continue;
  }

  // A whole batch failing means the network went away, not that 500 doors are
  // broken. Stop rather than burning through the rest marking them failed;
  // nothing is lost, since a re-run retries anything not written to disk.
  if (!res.out.length) {
    console.error(`\nAll ${chunk.length} in this batch failed, so the connection is probably down.`);
    console.error('Stopping here. Re-run the same command when you are back online and it resumes.');
    break;
  }
  appendFileSync(ACT_FILE, res.out.map((r) => JSON.stringify(r)).join('\n') + '\n');
  ok += res.out.length; fail += chunk.length - res.out.length;
  const secs = (Date.now() - t2) / 1000;
  const rate = ok / Math.max(secs, 1);
  const left = todo.length - (i + chunk.length);
  console.log(`  ${i + chunk.length}/${todo.length}  ${rate.toFixed(0)} leads/sec  ~${Math.ceil(left / Math.max(rate, 0.1) / 60)} min left${fail ? `  (${fail} failed)` : ''}`);
}
await ctx.close();
console.log(`\nDone: ${ok} pulled, ${fail} failed, ${((Date.now() - t2) / 60000).toFixed(1)} min`);
await compile();
