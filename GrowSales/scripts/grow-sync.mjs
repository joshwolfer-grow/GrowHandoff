#!/usr/bin/env node
// The one daily command: pull what changed in SalesRabbit, rebuild every file
// the reporting reads, refresh Supabase.
//
//   node scripts/grow-sync.mjs                # normal daily run
//   node scripts/grow-sync.mjs --skip-crawl   # recompile + push from what's on disk
//   node scripts/grow-sync.mjs --no-push      # everything except Supabase
//   node scripts/grow-sync.mjs --concurrency 50   # leads in flight during the re-pull
//   node scripts/grow-sync.mjs --seed         # open a window, mint a token, stop
//   node scripts/grow-sync.mjs --scheduled --push-days 7   # what the agent runs
//   node scripts/grow-sync.mjs --lean         # skip the big CSVs (knock rows only)
//   node scripts/grow-sync.mjs --scheduled --full-csv   # scheduled, CSVs anyway
//
// INTRADAY: the crawl is watermark-driven, so running it every 10 minutes costs
// 10 minutes of leads, not a day's. scripts/run-grow-sync.sh + the launchd agent
// com.grow.sr-sync run it all day.
//
// The reason this works at all is that NO BROWSER is involved in a sync. Chrome
// only ever runs under --seed, to mint a token; the syncs are plain HTTP against
// apis.salesrabbit.com. Headless Chrome is not an option here — Cloudflare bot
// management bounces it to the auth0 login page every time, live session or not,
// and spoofing the UA and navigator.webdriver does not help. A visible window
// every 10 minutes obviously isn't one either. Hence: mint once, use for hours.
//
// Where the time goes: it used to be the crawl, back when a compile was ~9
// seconds. It is not anymore — the store has grown to ~450 MB and the lead file
// to ~500 MB, so a full compile reads ~950 MB and writes ~350 MB of CSV and
// takes over three minutes, while an intraday crawl is still seconds. That is
// why --scheduled now implies --lean (see LEAN below): the CSVs nothing reads
// on a tick are skipped, and a scheduled compile is back to ~20s. If a MANUAL
// run feels slow it is the CSVs, and that is the work you asked for; if a crawl
// feels slow it is the per-lead activity re-pull, and --concurrency is the knob.
//
// What a run does:
//   1. INCREMENTAL CRAWL  walks es_search newest-first only until it reaches
//      leads older than the last run's watermark, then re-fetches activity for
//      just those leads. Minutes, not the 40 of a full crawl — seconds, on a
//      10-minute delta.
//   --tenant tds: same crawl against the TDS SalesRabbit company (own profile,
//      own data/tds-* files, never pushes). Seed once: --tenant tds --seed
//   2. COMPILE            rebuilds data/sr-activity.csv, sr-lead-history.csv,
//      sr-doors-by-area.csv, sr-knocking.csv and rep-emails.json from the store.
//      Under --lean (which --scheduled implies) only sr-knocking.csv and
//      rep-emails.json are written; the other three are left as the last full
//      run made them.
//   3. PUSH               replaces the method='sr_activity' rows in `knocking`.
//      Whole table by default; --push-days N restricts both the delete and the
//      insert to the last N days, which is what makes an hourly push safe.
//
// Storage is append-only JSONL with latest-wins per lead id, so an interrupted
// run never corrupts anything and a re-run just continues:
//   data/sr-store.jsonl       {"id","a":[{t,ev,rep,em,st,na,no,di}]} per lead
//   data/sr-leads.jsonl       lead meta (address, stage, assignee), same rule
//   data/sr-sync-state.json   the watermark
//
// First run bootstraps sr-store.jsonl from sr-activity.csv (the full crawl's
// output), so the 40-minute pull never has to happen again. A full re-crawl is
// still available via scripts/sr-lead-history.mjs if the store is ever lost.

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, appendFileSync, existsSync, lstatSync, createReadStream, createWriteStream, renameSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { snapshotKnock, stampFresh } from './_rep-fresh.mjs';
const { canonicalDisplayName } = createRequire(import.meta.url)('../api/_name-aliases.js');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const SKIP_CRAWL = flag('--skip-crawl'), NO_PUSH = flag('--no-push');
const ISP_ONLY = flag('--isp-only');   // push knocking_isp only, leave `knocking` alone
// --seed is the only mode that opens a browser: it mints a token and stops.
const SEED = flag('--seed');
// --scheduled says nobody is watching, so never open a window — a missing or
// dead token exits 3 and the wrapper turns that into a notification instead of
// Chrome appearing on screen while you're mid-sentence or mid-drive.
const SCHEDULED = flag('--scheduled');
// Days of knocking the push rewrites. null = the whole method='sr_activity'
// set, which is right for a once-a-day run and wrong for a 10-minute one.
const PUSH_DAYS = arg('--push-days') ? Math.max(1, Number(arg('--push-days'))) : null;
// The three big CSVs (sr-activity, sr-lead-history, sr-doors-by-area) are read
// by knock-report.py / knock-export.py / city-overlay.py, all of which you run
// by hand. Nothing reads them on a 5-minute tick — but rebuilding them was the
// whole cost of a compile: 350 MB written per run, ~150s of the ~200s, against
// 48s for every read the knock rows actually need. Once the store passed ~450 MB
// that pushed a scheduled run past run-grow-sync.sh's 240s watchdog, so ticks
// started dying at exit 137 mid-compile — intermittently, since the run sat
// right at the line (observed 2026-08-18, several kills an hour).
// So: scheduled runs compile only what the push needs. Any manual run still
// rebuilds every CSV, which is when the reporting scripts want them fresh.
// --lean / --full-csv force it either way.
const LEAN = flag('--lean') || (SCHEDULED && !flag('--full-csv'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const D = (f) => join(ROOT, 'data', f);
// --tenant tds crawls a SECOND SalesRabbit company (TDS has its own tenant, own
// login, own leads). Everything it touches is kept apart: its own Chrome profile
// and token, and data files prefixed with the tenant slug instead of "sr-". It
// never pushes knocking rows: TDS knocking already comes from its Amplify crawl
// (scripts/amplify-company-sync.mjs --source tds). What the tenant crawl is for
// is doors with GPS, so sector-build.py can draw the TDS map like any ISP.
const TENANT = (arg('--tenant') || '').toLowerCase();
const PFX = TENANT ? `${TENANT}-` : 'sr-';
const STORE = D(`${PFX}store.jsonl`), LEADS = D(`${PFX}leads.jsonl`), STATE = D(`${PFX}sync-state.json`);
const ACT_CSV = D(`${PFX}activity.csv`), HIST_CSV = D(`${PFX}lead-history.csv`);
const DOORS_CSV = D(`${PFX}doors-by-area.csv`), KNOCK_CSV = D(`${PFX}knocking.csv`);
const LOOKUPS = D(`${PFX}lookups.json`), EMAILS = D(TENANT ? `rep-emails-${TENANT}.json` : 'rep-emails.json');
const APP = 'https://app.salesrabbit.com', API = 'https://apis.salesrabbit.com';
const PROFILE = join(ROOT, TENANT ? `.sr-profile-${TENANT}` : '.sr-profile');
const SB = 'https://cmkfohwbejcztctrpdnt.supabase.co';

// Same rules the reports use. Keep these in sync with knock-report.py and
// knock-export.py.
const EXCLUDE_REPS = new Set(['daxton day', 'nick boyd']);
const CONTACT = new Set(['Not Interested', 'Call Back', 'No English', 'Do Not Knock', 'Sold']);   // same set as knock-report.py / knock-export.py
const BURST_N = 10, BURST_SEC = 60;                                  // bulk-edit detector
// A knock is a disposition made AT the door. SalesRabbit stamps every stage
// change with how far the rep was from the address, and that number separates
// field work from assignment cleanly: under 1km it behaves like knocking (36%
// contact, 1-17% of marks setting a lead to "New Lead"); past 100km it is 89%
// "New Lead" with a 0.7% contact rate, i.e. someone bulk-assigning from a desk.
// This is what stops an intake batch from reading as a 3,500-door day.
const AT_DOOR_M = 1000;
const atDoor = (d) => { const v = parseFloat(d); return !isFinite(v) || v < AT_DOOR_M; };

// ---- Whose door is this. Same order of evidence as scripts/isp_territory.py,
// which knock-report.py and knock-export.py use, so the board and the ISP
// workbooks can never disagree:
//   1. batch  the door's SalesRabbit import_id, looked up in isp-imports.json
//   2. zip    rep-created doors take the ISP that owns the rest of their zip
//   3. map    data/isps.json states/cities, for a zip nobody has imported into
//   4. null   unassigned, reported as its own row and never folded into an ISP
function ispResolver() {
  const reg = existsSync(D('isp-imports.json')) ? JSON.parse(readFileSync(D('isp-imports.json'), 'utf8')) : {};
  const cfg = existsSync(D('isps.json')) ? JSON.parse(readFileSync(D('isps.json'), 'utf8')) : {};
  const batch = {};
  for (const [k, v] of Object.entries(reg)) if (v && v.isp) batch[k] = v.isp;
  const mapIsp = (city, state, zip) => {
    const c = String(city || '').trim().toLowerCase(), st = String(state || '').trim().toUpperCase(), z = String(zip || '').slice(0, 5);
    for (const [name, v] of Object.entries(cfg)) {
      if (name.startsWith('_') || !v || typeof v !== 'object') continue;
      if ((v.also || []).some((a) => {
        const p = String(a).split(',');
        return p.length > 1 && p[0].trim().toLowerCase() === c && p[1].trim().toUpperCase() === st;
      })) return name;
      const cities = new Set((v.cities || []).map((x) => x.toLowerCase()));
      const states = new Set((v.states || []).map((x) => x.toUpperCase()));
      const zips = new Set(v.zips || []);
      const excl = new Set((v.exclude_cities || []).map((x) => x.toLowerCase()));
      if ((!cities.size || cities.has(c)) && !excl.has(c) && (!states.size || states.has(st)) && (!zips.size || zips.has(z))) return name;
    }
    return null;
  };
  return {
    // zip -> the ISP that imported the most doors into it. Built from the
    // batch-labeled doors themselves, so it follows the imports rather than a
    // hand-kept list.
    learn(seen) {
      const zc = new Map();
      for (const d of seen) {
        const isp = batch[d.import_id || ''];
        if (!isp || !d.zip) continue;
        const z = d.zip.slice(0, 5);
        if (!zc.has(z)) zc.set(z, new Map());
        const c = zc.get(z);
        c.set(isp, (c.get(isp) || 0) + 1);
      }
      this.zipIsp = new Map([...zc].map(([z, c]) => [z, [...c].sort((a, b) => b[1] - a[1])[0][0]]));
    },
    of(d) {
      const b = batch[d.import_id || ''];
      if (b) return { isp: b, how: 'batch' };
      const z = String(d.zip || '').slice(0, 5);
      const zi = this.zipIsp && this.zipIsp.get(z);
      if (zi) return { isp: zi, how: 'zip' };
      const m = mapIsp(d.city, d.state, d.zip);
      return m ? { isp: m, how: 'map' } : { isp: null, how: null };
    },
  };
}

const STATE_TZ = {
  UT: 'America/Denver', CO: 'America/Denver', NM: 'America/Denver', WY: 'America/Denver', MT: 'America/Denver',
  ID: 'America/Boise', AZ: 'America/Phoenix',
  IL: 'America/Chicago', TX: 'America/Chicago', OK: 'America/Chicago', KS: 'America/Chicago', MO: 'America/Chicago',
  WI: 'America/Chicago', MN: 'America/Chicago', IA: 'America/Chicago', NE: 'America/Chicago', SD: 'America/Chicago',
  ND: 'America/Chicago', AR: 'America/Chicago', LA: 'America/Chicago', MS: 'America/Chicago', AL: 'America/Chicago',
  TN: 'America/Chicago', AB: 'America/Edmonton', SK: 'America/Regina', MB: 'America/Winnipeg',
  IN: 'America/Indiana/Indianapolis', MI: 'America/Detroit',
  OH: 'America/New_York', KY: 'America/New_York', GA: 'America/New_York', FL: 'America/New_York',
  SC: 'America/New_York', NC: 'America/New_York', VA: 'America/New_York', WV: 'America/New_York',
  PA: 'America/New_York', NY: 'America/New_York', NJ: 'America/New_York', MD: 'America/New_York',
  DE: 'America/New_York', CT: 'America/New_York', RI: 'America/New_York', MA: 'America/New_York',
  VT: 'America/New_York', NH: 'America/New_York', ME: 'America/New_York', DC: 'America/New_York',
  ON: 'America/Toronto', QC: 'America/Toronto',
  CA: 'America/Los_Angeles', OR: 'America/Los_Angeles', WA: 'America/Los_Angeles', NV: 'America/Los_Angeles', BC: 'America/Vancouver',
};
const DEFAULT_TZ = 'America/Chicago';
const fmtCache = new Map();
const localParts = (iso, tz) => {
  let f = fmtCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true }); fmtCache.set(tz, f); }
  const p = Object.fromEntries(f.formatToParts(new Date(iso)).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${Number(p.hour)}:${p.minute} ${p.dayPeriod}` };
};

const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
// The activity file runs to millions of rows, and at that size an await per row
// costs more than the writing does. Rows land in a ~1MB buffer instead, and
// row() only returns a promise on the flush that actually needs backpressure —
// callers await it when it's there and pay nothing when it isn't.
const ROW_BUF = 1 << 20;
const rowWriter = (stream) => {
  let buf = '';
  return {
    row(vals) {
      buf += vals.map(csvCell).join(',') + '\n';
      if (buf.length < ROW_BUF) return null;
      const b = buf; buf = '';
      return stream.write(b) ? null : once(stream, 'drain');
    },
    async end() {
      if (buf) { const b = buf; buf = ''; if (!stream.write(b)) await once(stream, 'drain'); }
      await new Promise((r) => stream.end(r));
    },
  };
};

// Streaming CSV reader that survives quoted commas and embedded newlines (the
// activity file has both, courtesy of note text).
async function* csvRecords(path) {
  const rs = createReadStream(path, { encoding: 'utf8' });
  // `pending` carries the "just closed a quote" state across chunk boundaries,
  // so an escaped "" split between two chunks still parses as a literal quote.
  let cell = '', row = [], q = false, pending = false;
  for await (const chunk of rs) {
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (pending) {
        pending = false;
        if (c === '"') { cell += '"'; q = true; continue; }
      }
      if (q) {
        if (c === '"') { q = false; pending = true; } else cell += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); yield row; row = []; cell = ''; }
      else if (c !== '\r') cell += c;
    }
  }
  if (cell !== '' || row.length) { row.push(cell); yield row; }
}

const eachLine = async (path, fn) => {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) { if (line) { fn(line, n); n++; } }
  return n;
};

// ------------------------------------------------------------- BOOTSTRAP
// Build the per-lead store from the full crawl's activity CSV, once. Rows for a
// lead are contiguous in that file (its writer emitted one lead at a time).
async function bootstrapStore() {
  if (existsSync(STORE)) return;
  if (TENANT && !existsSync(ACT_CSV)) {
    // A new tenant has no full crawl behind it. An empty store means an empty
    // watermark, so the first crawl walks every lead and pulls its whole history.
    writeFileSync(STORE, '');
    console.log(`First run for tenant ${TENANT}: empty store, the crawl will pull everything.`);
    return;
  }
  if (!existsSync(ACT_CSV)) { console.error(`No ${STORE} and no ${ACT_CSV} to build it from. Run scripts/sr-lead-history.mjs first.`); process.exit(1); }
  console.log('First run: building the store from sr-activity.csv ...');
  const out = createWriteStream(STORE + '.tmp');
  const seen = new Set();
  let hdr = null, cur = null, events = [], leads = 0, marks = 0, maxT = '';
  const emit = async () => {
    if (!cur) return;
    if (seen.has(cur)) { console.error(`Lead ${cur} appears in two places in ${ACT_CSV}; the store can't be built from it. Re-run the full crawl.`); process.exit(1); }
    seen.add(cur);
    if (!out.write(JSON.stringify({ id: cur, a: events }) + '\n')) await once(out, 'drain');
    leads++;
  };
  for await (const rec of csvRecords(ACT_CSV)) {
    if (!hdr) { hdr = rec; continue; }
    const r = Object.fromEntries(hdr.map((h, i) => [h, rec[i] ?? '']));
    if (r.lead_id !== cur) { await emit(); cur = r.lead_id; events = []; }
    events.push({ t: r.datetime, ev: r.event, rep: r.rep, em: r.rep_email, st: r.new_stage, na: r.new_assignee, no: r.note, di: r.distance });
    if (r.datetime > maxT) maxT = r.datetime;
    marks++;
  }
  await emit();
  await new Promise((res) => out.end(res));
  renameSync(STORE + '.tmp', STORE);
  if (!existsSync(STATE)) writeFileSync(STATE, JSON.stringify({ lastActivityAt: maxT }, null, 2));
  console.log(`  ${leads.toLocaleString()} leads, ${marks.toLocaleString()} marks -> sr-store.jsonl (watermark ${maxT.slice(0, 16)})`);
}

// ------------------------------------------------------------- AUTH
// Cloudflare is why this is shaped the way it is. Headless Chrome gets bounced
// to the auth0 login page every single time, live session or not, and masking
// the UA and navigator.webdriver doesn't change it — the __cf_bm cookie in the
// profile is bot management, and it is not fooled. But the token the app mints
// works fine from plain node fetch with no browser in the picture at all.
//
// So the browser's whole job is minting a token. --seed opens a real window,
// captures it, and saves it here; every run after that is silent HTTP. That is
// what makes a 10-minute cadence possible: a window every 10 minutes would be
// unusable, and headless is not on the table.
const AUTH_FILE = D(TENANT ? `sr-auth-${TENANT}.json` : 'sr-auth.json');

function loadAuth() {
  if (!existsSync(AUTH_FILE)) return null;
  try {
    const j = JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
    return j && j.headers && j.headers.Authorization ? j : null;
  } catch (e) { return null; }
}

// Opens a window. Only ever called by --seed, or by a hand-run sync that finds
// no usable token — never by the scheduled runs, which exit 3 instead so the
// wrapper can tell you rather than popping Chrome up while you're driving.
async function seedAuth() {
  // A previous run's Chrome can outlive its script and keep the profile locked;
  // Playwright's own error for that is a wall of flags. Clear a lock whose owner
  // is gone, and say something useful if the browser is genuinely still up.
  // The lock is a symlink to "<host>-<pid>", a target that never exists, so it
  // has to be probed with lstat — existsSync follows the link and always says no.
  const lock = join(PROFILE, 'SingletonLock');
  let locked = true;
  try { lstatSync(lock); } catch (e) { locked = false; }
  if (locked) {
    const { execSync } = await import('node:child_process');
    let running = '';
    try { running = execSync(`pgrep -f "user-data-dir=${PROFILE}" || true`, { encoding: 'utf8' }).trim(); } catch (e) {}
    if (running) {
      console.error('\nA Chrome window is already using this profile. Close it (or run:');
      console.error(`  pkill -f "user-data-dir=${PROFILE}"`);
      console.error('), then run the sync again.');
      process.exit(1);
    }
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try { (await import('node:fs')).rmSync(join(PROFILE, f), { force: true }); } catch (e) {}
    }
    console.log('(cleared a stale profile lock from an earlier run)');
  }
  // --fresh throws the saved session away. Worth trying if the login itself
  // starts failing: the profile accumulates state and can end up in a bad way.
  if (flag('--fresh') && existsSync(PROFILE)) {
    (await import('node:fs')).rmSync(PROFILE, { recursive: true, force: true });
    console.log('(cleared the saved SalesRabbit session; you will be asked to log in)');
  }

  console.log('Opening SalesRabbit in a window to mint a token (sign in if asked) ...');
  const ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chrome', headless: false, viewport: { width: 1100, height: 750 } });
  await ctx.addInitScript(() => {
    window.__auth = null;
    const grab = (h) => { try {
      const get = (k) => (h && typeof h.get === 'function' ? h.get(k) : (h || {})[k] || (h || {})[k.toLowerCase()]);
      const a = get('Authorization') || get('authorization');
      const p = get('x-profile-id') || get('X-Profile-Id');
      // Only a request that carries x-profile-id is the app talking to its API.
      // Earlier bearers (auth0, the profile picker) look the same and are rejected
      // with "invalid token", which is what a fresh tenant seed produced on 2026-09-15.
      if (a && p) window.__auth = { Authorization: a, 'x-profile-id': p };
    } catch (e) {} };
    const O = XMLHttpRequest.prototype.open, H = XMLHttpRequest.prototype.setRequestHeader, S = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u, ...r) { this.__h = {}; return O.call(this, m, u, ...r); };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) { try { this.__h[k] = v; } catch (e) {} return H.call(this, k, v); };
    XMLHttpRequest.prototype.send = function (b) { grab(this.__h); return S.call(this, b); };
    const F = window.fetch;
    window.fetch = function (input, init) { try { grab((init && init.headers) || (input && input.headers)); } catch (e) {} return F.apply(this, arguments); };
  });
  let page = await ctx.newPage();
  await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  // Logging in navigates: auth0 redirect, then the app boots. Every navigation
  // destroys the page's execution context, so an unguarded page.evaluate in this
  // loop throws "Execution context was destroyed" the moment you sign in —
  // exactly when it is least welcome. Swallow it and poll again; the init script
  // re-installs the header hook on every document, so the token still arrives.
  // SalesRabbit's login throws errors of its own often enough that a fixed
  // deadline here just means logging in twice, so wait as long as it takes.
  const loginCap = Number(arg('--login-timeout') || 0);   // 0 = wait forever
  let auth = null;
  for (let i = 0; !auth; i++) {
    if (loginCap && i >= loginCap) break;
    if (page.isClosed()) {
      page = await ctx.newPage();
      await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    }
    try {
      auth = await page.evaluate(() => window.__auth);
    } catch (e) {
      if (!/destroyed|navigation|Target closed|detached|closed/i.test(String(e && e.message))) throw e;
      auth = null;                                   // mid-navigation, try again
    }
    if (i === 15) console.log('  (waiting for the app; if you see a login page, sign in — this continues on its own)');
    if (!auth && i > 15 && i % 120 === 0) {
      console.log(`  (still waiting for sign-in, ${Math.round(i / 60)}m in — Ctrl+C to stop; retrying the app URL)`);
      await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    }
    if (!auth) await page.waitForTimeout(1000).catch(() => {});
  }
  await ctx.close();
  if (!auth) { console.error('Never saw an API token. Sign in in the window and re-run.'); process.exit(2); }
  writeFileSync(AUTH_FILE, JSON.stringify({ headers: auth, at: new Date().toISOString() }, null, 2));
  console.log(`Token saved to ${AUTH_FILE.replace(ROOT + '/', '')}`);
  return auth;
}

// Exit 3 is "the token is dead and I can't fix it without a window" — the one
// state the wrapper turns into a notification. Distinct from 2 (login failed at
// the window) so the message can actually tell you which it was.
const TOKEN_DEAD = 3;
async function getAuth() {
  const saved = loadAuth();
  if (saved) return saved.headers;
  if (SCHEDULED) {
    console.error(`No token in ${AUTH_FILE.replace(ROOT + '/', '')}. Run: node scripts/grow-sync.mjs${TENANT ? ` --tenant ${TENANT}` : ''} --seed`);
    process.exit(TOKEN_DEAD);
  }
  return seedAuth();
}

// ------------------------------------------------------------- CRAWL
async function crawl() {
  const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
  let watermark = state.lastActivityAt || '';
  if (!watermark) {
    await eachLine(STORE, (l) => { const m = l.match(/"t":"([^"]+)"/g); if (m) for (const x of m) { const t = x.slice(5, -1); if (t > watermark) watermark = t; } });
  }
  // Overlap so nothing near the boundary is missed; latest-wins absorbs repeats.
  const cutoff = new Date(Date.parse(watermark || '2020-01-01') - 30 * 60000).toISOString();
  console.log(`Crawl: everything active since ${cutoff.slice(0, 16)} ...`);

  // Everything below is plain HTTP. No browser: the token from --seed is all the
  // API needs, and skipping Chrome is what makes a 10-minute cadence viable.
  const auth = await getAuth();

  // One place where a dead token is recognised, so every call site gets the same
  // behaviour. A 401 mid-crawl is not a network blip to retry — the token is
  // gone and every subsequent request will fail the same way, so stop now and
  // let the wrapper say so rather than grinding through a thousand retries.
  let tokenDead = false;
  const srFetch = async (url, tries = 4) => {
    for (let a = 0; a < tries; a++) {
      try {
        const r = await fetch(url, { headers: auth });
        if (r.status === 401 || r.status === 403) { tokenDead = true; return null; }
        if (r.ok) return r;
        if (r.status === 429 || r.status >= 500) { await sleep(800 * (a + 1)); continue; }
        return null;
      } catch (e) { await sleep(400 * (a + 1)); }
    }
    return null;
  };
  const srJson = async (url, tries = 4) => {
    const r = await srFetch(url, tries);
    if (!r) return null;
    try { return await r.json(); } catch (e) { return null; }
  };
  const dieIfTokenDead = () => {
    if (!tokenDead) return;
    console.error('SalesRabbit rejected the token (401). It has expired.');
    console.error(`Run: node scripts/grow-sync.mjs${TENANT ? ` --tenant ${TENANT}` : ''} --seed   (a window opens; sign in once)`);
    process.exit(TOKEN_DEAD);
  };

  const name = (j) => Object.fromEntries(((j && j.data) || []).map((r) => [r.id, (r.attributes || {}).name || '']));
  const lk = {
    stages: name(await srJson(`${API}/stages?page%5Blimit%5D=200&page%5Boffset%5D=0&sort=order`)),
    profiles: name(await srJson(`${API}/profiles?page%5Blimit%5D=9999&page%5Boffset%5D=0`)),
  };
  dieIfTokenDead();
  if (Object.keys(lk.stages).length) writeFileSync(LOOKUPS, JSON.stringify(lk, null, 2));
  const stageName = (id) => lk.stages[id] || '';

  // Newest-first until we're past the cutoff. The 100k index ceiling is fine
  // here: a daily delta is a handful of pages, and if it ever isn't, say so.
  const FIELDS = 'assignee_id,city,coordinates,country,first_activity_at,geocode_error,group_id,import_id,inserted_at,latest_activity_at,postal_code,region,stage_id,street1,street2,tenant_id,title,updated_at';
  // Report each page and how far back we've walked, so the timestamp marching
  // toward the cutoff is visible proof it's still moving.
  const found = await (async () => {
    const out = []; let newest = '', sample = null, body = '';
    for (let p = 1; p <= 1000; p++) {
      const r = await srFetch(`${API}/loci/es_search?fields=${encodeURIComponent(FIELDS)}&sort=-latest_activity_at&limit=100&page=${p}`);
      if (tokenDead) return { rows: out, newest, pages: p, capped: false, tokenDead: true };
      let j = null;
      if (r) { try { j = await r.json(); } catch (e) { j = null; } }
      // A page that never came back is not the same as reaching the end of the
      // list, and treating it as one silently truncates the delta. Say so.
      if (!j) return { rows: out, newest, pages: p, capped: false, failedAt: p, status: r ? r.status : 0, body };
      const rows = (j && j.data) || [];
      if (!rows.length) break;
      // Keep the first row we ever see. If the scan comes back empty, this is
      // what says whether the shape changed underneath us vs. genuinely nothing
      // new — the two look identical from a zero count alone.
      if (!sample) sample = { id: rows[0].id, keys: Object.keys(rows[0].attributes || {}), attrs: rows[0].attributes || {} };
      let oldest = '';
      for (const row of rows) {
        const at = (row.attributes || {}).latest_activity_at || '';
        if (at > newest) newest = at;
        oldest = at;
        if (at >= cutoff) out.push({ id: row.id, ...(row.attributes || {}) });
      }
      // No usable timestamp means the loop can never reach the cutoff and will
      // burn all 1000 pages to find nothing. Stop and report instead.
      if (!oldest) return { rows: out, newest, pages: p, capped: false, noTimestamp: true, sample };
      process.stdout.write(`\r  page ${p} — back to ${String(oldest).slice(0, 16)}, ${out.length} kept   `);
      if (oldest && oldest < cutoff) return { rows: out, newest, pages: p, capped: false, sample };
    }
    return { rows: out, newest, pages: 1000, capped: true, sample };
  })();
  dieIfTokenDead();
  process.stdout.write('\r' + ' '.repeat(60) + '\r');
  if (found.failedAt) {
    console.log(`  NOTE: page ${found.failedAt} kept failing (HTTP ${found.status || '?'}) — this delta is INCOMPLETE. Re-run to pick up the rest.`);
    if (found.body) console.log(`  response: ${found.body}`);
  }
  if (found.noTimestamp) console.log('  NOTE: rows came back with no latest_activity_at — the API shape changed, so the cutoff can never be reached.');
  if (found.capped) console.log('  NOTE: hit the 100k page ceiling — the delta is unusually big. Consider a full re-crawl.');
  console.log(`  ${found.rows.length.toLocaleString()} leads changed (${found.pages} page${found.pages === 1 ? '' : 's'} scanned)`);
  // A zero-row scan is the case worth explaining, because it is indistinguishable
  // from a quiet weekend unless you can see what the API actually returned.
  if (!found.rows.length) {
    if (found.sample) {
      console.log(`  sample row ${found.sample.id} fields: ${found.sample.keys.join(', ') || '(none)'}`);
      console.log(`  sample latest_activity_at: ${JSON.stringify(found.sample.attrs.latest_activity_at)}  (cutoff ${cutoff.slice(0, 16)})`);
      writeFileSync(D('sr-scan-sample.json'), JSON.stringify(found.sample, null, 2));
      console.log('  full sample written to data/sr-scan-sample.json');
    } else console.log('  the API returned no rows at all on page 1.');
  }

  let repullFailed = 0;
  if (found.rows.length) {
    appendFileSync(LEADS, found.rows.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const ids = found.rows.map((r) => r.id);
    // This used to run in 400-lead chunks with a hard barrier between them: every
    // chunk waited on its slowest straggler before the next one started, and on a
    // big delta that idle time is most of the wall clock. Now the workers stream
    // results back through a binding as each one lands, so a lead only ever waits
    // on its own request. --concurrency tunes the in-flight count; 429s and 5xx
    // already back off and retry below, so the ceiling is SalesRabbit's patience,
    // not correctness.
    const CONC = Math.max(1, Number(arg('--concurrency') || 50));
    let done = 0;
    const writeBatch = (batch) => {
      const lines = batch.map((r) => {
        const evs = (r.activity || []).map((e) => {
          let d = e.data; if (typeof d === 'string') { try { d = JSON.parse(d); } catch { d = {}; } }
          return { t: e.datetime || '', ev: e.event_name || '', rep: e.actor_name || '', em: e.actor_email || '',
                   st: d && d.new_stage_id ? stageName(d.new_stage_id) : '',
                   na: d && d.new_assignee_id ? (lk.profiles[d.new_assignee_id] || '') : '',
                   no: d && d.text ? d.text : '', di: e.distance == null ? '' : String(e.distance) };
        }).sort((x, y) => x.t.localeCompare(y.t));
        return JSON.stringify({ id: r.id, a: evs });
      });
      if (lines.length) appendFileSync(STORE, lines.join('\n') + '\n');
      done += batch.length;
      process.stdout.write(`\r  activity ${done.toLocaleString()}/${ids.length.toLocaleString()}   `);
    };
    repullFailed = await (async () => {
      let n = 0, fails = 0, buf = [];
      const BATCH = 25;
      // Hand the buffer off before awaiting, so two workers flushing at once
      // can't ship the same lead twice.
      const flush = () => { if (!buf.length) return; const b = buf; buf = []; writeBatch(b); };
      const one = async (id) => {
        const j = await srJson(`${API}/loci/${id}?fields%5Blocus%5D=activity`);
        if (!j) return null;
        return { id, activity: ((j.data || {}).attributes || {}).activity || [] };
      };
      const worker = async () => {
        while (n < ids.length && !tokenDead) {
          const r = await one(ids[n++]);
          if (r) { buf.push(r); if (buf.length >= BATCH) flush(); } else fails++;
        }
      };
      await Promise.all(Array.from({ length: CONC }, worker));
      flush();
      return fails;
    })();
    dieIfTokenDead();
    process.stdout.write('\r' + ' '.repeat(60) + '\r');
    console.log(`  ${done.toLocaleString()} leads re-pulled${CONC === 50 ? '' : ` (${CONC} at a time)`}`);
    // A lead whose activity never came back is a hole in the store that the
    // watermark would otherwise hide forever. Same reasoning as the scan below.
    if (repullFailed) console.log(`  NOTE: ${repullFailed.toLocaleString()} lead${repullFailed === 1 ? '' : 's'} never returned activity — re-run to pick them up.`);
  }
  // Only advance the watermark on a complete scan. Moving it after a partial one
  // makes the leads we missed invisible to every future run, since they're older
  // than the new cutoff — a silent, permanent hole in the data.
  // A lead whose activity never came back is the same kind of hole as a failed
  // scan page: advancing past it puts it permanently out of reach, since it is
  // older than every future cutoff. Re-pulling is latest-wins, so re-scanning
  // the window costs time and nothing else.
  if (found.newest && !found.failedAt && !repullFailed) writeFileSync(STATE, JSON.stringify({ lastActivityAt: found.newest, lastRun: new Date().toISOString() }, null, 2));
  else if (found.failedAt || repullFailed) console.log('  (watermark left where it was, so the next run re-scans this window)');

  // Record the CRAWL, not the push. The Ops banner used to read the knocking
  // table's created_at, which a --skip-crawl recompile also bumps — so it would
  // claim "synced" when nothing had been pulled from SalesRabbit. This row is
  // only written when leads were actually fetched.
  //
  // UPSERT, not DELETE-then-POST. anon has no DELETE privilege on report_config
  // ("permission denied for table report_config", 401), so the delete was a
  // no-op and the insert that followed it hit the unique index on manager and
  // 409'd. Both statuses were unchecked and the whole block is inside a catch
  // that treats the marker as cosmetic, so it failed in total silence: the row
  // froze at whatever value it held when it was last created, and the dashboard
  // read a crawl that was running fine every 10 minutes as "ran 1h ago"
  // (observed 2026-08-07). Same on_conflict upsert scripts/sync-marker.sh uses,
  // which is why __sr_health__ stayed current through all of it.
  try {
    const ANON2 = (readFileSync(join(ROOT, 'index.html'), 'utf8').match(/eyJ[A-Za-z0-9_.-]{50,}/) || [])[0];
    if (ANON2) {
      const H2 = { apikey: ANON2, Authorization: `Bearer ${ANON2}`, 'Content-Type': 'application/json' };
      const mk = await fetch(`${SB}/rest/v1/report_config?on_conflict=manager`, {
        method: 'POST', headers: { ...H2, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{ manager: '__knock_sync__', config: {
          crawled_at: new Date().toISOString(),
          watermark: found.newest || null,
          leads_changed: found.rows.length,
        } }]),
      });
      // Say so rather than swallowing it. A stale marker is indistinguishable
      // from a stale crawl on the board, and that is the expensive kind of lie.
      if (!mk.ok) console.log(`  (freshness marker not written: ${mk.status} ${(await mk.text()).slice(0, 120)})`);
    }
  } catch (e) { /* the sync itself succeeded; the marker is cosmetic */ }
}

// ------------------------------------------------------------- COMPILE
async function compile() {
  console.log(LEAN ? 'Compile (lean: knock rows only) ...' : 'Compile ...');
  // Lead meta, latest line wins. Addresses exist for the CSVs; the knock rows
  // need exactly one field off this file — region, to pick the rep's timezone —
  // so a lean run pulls that with a regex instead of JSON.parsing 500 MB, which
  // is 30s of a compile down to about 8.
  const meta = new Map();
  if (LEAN) {
    await eachLine(LEADS, (l) => {
      const i = l.match(/^\{"id":"([^"]+)"/); if (!i) return;
      // import_id / zip / city too: the ISP split needs them. Without them every
      // lean tick fell through to the state-level map, so Surf's Braidwood IL
      // doors were written to knocking_isp as i3 (Sep 29 2026).
      const g = (k) => ((l.match(new RegExp('"' + k + '":"([^"]*)"')) || [])[1] || '').trim();
      meta.set(i[1], { state: g('region'), import_id: g('import_id'), zip: g('postal_code'), city: g('city') });
    });
  } else await eachLine(LEADS, (l) => {
    let o; try { o = JSON.parse(l); } catch { return; }
    meta.set(o.id, { street: o.street1 || '', unit: o.street2 || '', city: (o.city || '').trim(), state: (o.region || '').trim(),
      zip: (o.postal_code || '').trim(), stage_id: o.stage_id || '', assignee_id: o.assignee_id || '',
      title: o.title || '', coords: o.coordinates && o.coordinates.coordinates ? o.coordinates.coordinates.join(' ') : '',
      import_id: o.import_id || '' });
  });
  const lk = existsSync(LOOKUPS) ? JSON.parse(readFileSync(LOOKUPS, 'utf8')) : { stages: {}, profiles: {} };
  const stageName = (id) => lk.stages[id] || id || '';
  const repName = (id) => lk.profiles[id] || id || '';

  // Pass 1 over the store: which line is the latest for each lead.
  const last = new Map();
  const total = await eachLine(STORE, (l, n) => { const m = l.match(/^\{"id":"([^"]+)"/); if (m) last.set(m[1], n); });

  // Say when the store has gone mostly stale. Every superseded line is read and
  // discarded by both passes below, so this ratio IS the compile's wasted work —
  // at 68% it had grown the compile past run-grow-sync.sh's 240s watchdog and
  // ticks were being killed mid-compile (2026-08-18). scripts/compact-store.mjs
  // drops those lines; it took that run from 166s back to 11s. Nothing here
  // compacts on its own: it rewrites the only copy of a crawl that costs 40
  // minutes to rebuild, so it stays a command you choose to run.
  const stale = total ? 1 - last.size / total : 0;
  if (stale > 0.5) console.log(`  ${(stale * 100).toFixed(0)}% of the store is superseded lines — run: node scripts/compact-store.mjs`);

  // Pass 2: everything in one sweep.
  const actW = LEAN ? null : rowWriter(createWriteStream(ACT_CSV + '.tmp'));
  const histW = LEAN ? null : rowWriter(createWriteStream(HIST_CSV + '.tmp'));
  const ACT_COLS = ['lead_id', 'street', 'unit', 'city', 'state', 'zip', 'datetime', 'event', 'rep', 'rep_email', 'new_stage', 'new_assignee', 'note', 'distance'];
  const HIST_COLS = ['lead_id', 'street', 'unit', 'city', 'state', 'zip', 'title', 'current_stage', 'assigned_to', 'knocks', 'days_knocked', 'reps', 'first_knock', 'last_knock', 'last_knocked_by', 'knocked_by', 'notes', 'last_note', 'total_events', 'last_event', 'last_touch', 'coordinates'];
  if (!LEAN) { actW.row(ACT_COLS); histW.row(HIST_COLS); }
  const doors = [];                       // -> sr-doors-by-area.csv
  const knockEv = [];                     // -> burst filter -> sr-knocking.csv
  const assignMs = new Map();             // actor -> [ms of their lead reassignments]
  const emails = new Map();               // rep -> {email: count}
  let leads = 0, marks = 0;

  const rl = createInterface({ input: createReadStream(STORE, { encoding: 'utf8' }), crlfDelay: Infinity });
  let n = -1;
  for await (const line of rl) {
    if (!line) continue;
    n++;
    const m = line.match(/^\{"id":"([^"]+)"/);
    if (!m || last.get(m[1]) !== n) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const l = meta.get(o.id) || { street: '', unit: '', city: '', state: '', zip: '', stage_id: '', assignee_id: '', title: '', coords: '' };
    const evs = o.a || [];
    leads++;
    for (const e of evs) {
      marks++;
      if (!LEAN) { const bp = actW.row([o.id, l.street, l.unit, l.city, l.state, l.zip, e.t, e.ev, e.rep, e.em, e.st, e.na, e.no, e.di]); if (bp) await bp; }
      if (e.rep && e.em) { let c = emails.get(e.rep); if (!c) { c = new Map(); emails.set(e.rep, c); } c.set(e.em, (c.get(e.em) || 0) + 1); }
    }
    const stages = evs.filter((e) => e.ev === 'stage_updated');
    const notes = evs.filter((e) => e.ev === 'locus_note_created');
    const lastAny = evs[evs.length - 1] || {};
    const kAll = stages, lastK = kAll[kAll.length - 1] || {};
    const hbp = LEAN ? null : histW.row([o.id, l.street, l.unit, l.city, l.state, l.zip, l.title, stageName(l.stage_id), repName(l.assignee_id),
      kAll.length, new Set(kAll.map((e) => e.t.slice(0, 10))).size, new Set(kAll.map((e) => e.rep).filter(Boolean)).size,
      (kAll[0] || {}).t ? kAll[0].t.slice(0, 10) : '', lastK.t ? lastK.t.slice(0, 10) : '', lastK.rep || '',
      [...new Set(kAll.map((e) => e.rep).filter(Boolean))].sort().join(' | '),
      notes.length, notes.length ? notes[notes.length - 1].no : '', evs.length, lastAny.ev || '', lastAny.t || '', l.coords]);
    if (hbp) await hbp;

    // Doors rollup: intake accounts excluded, like the reports expect.
    const ks = stages.filter((e) => e.rep && !EXCLUDE_REPS.has(e.rep.trim().toLowerCase()) && atDoor(e.di));
    const dLast = ks[ks.length - 1] || {};
    // import_id: the batch this door was loaded in, which is how the ISP
    // reports decide whose door it is (data/isp-imports.json). Blank = rep-created.
    if (!LEAN) doors.push({ lead_id: o.id, street: l.street, unit: l.unit, city: l.city, state: l.state, zip: l.zip, import_id: l.import_id || '',
      current_stage: stageName(l.stage_id), knocks: ks.length,
      days_knocked: new Set(ks.map((e) => e.t.slice(0, 10))).size,
      reps: new Set(ks.map((e) => e.rep)).size,
      first_knock: ks.length ? ks[0].t.slice(0, 10) : '', last_knock: dLast.t ? dLast.t.slice(0, 10) : '',
      days_since_last_knock: dLast.t ? Math.floor((Date.now() - Date.parse(dLast.t)) / 86400000) : '',
      last_knocked_by: dLast.rep || '', last_disposition: dLast.st || '',
      ever_sold: ks.some((e) => e.st === 'Sold') ? 1 : 0,
      knocked_by: [...new Set(ks.map((e) => e.rep))].sort().join(' | ') });
    const tz = STATE_TZ[l.state.toUpperCase()] || DEFAULT_TZ;
    for (const e of ks) knockEv.push({ rep: canonicalDisplayName(e.rep.replace(/\s+/g, ' ').trim()), ms: Date.parse(e.t), iso: e.t, tz, st: e.st, lead: o.id,
      import_id: l.import_id || '', zip: l.zip || '', city: l.city || '', state: l.state || '' });
    // Track when each actor reassigns leads: managers bulk-distribute areas
    // (Sammi Boyd runs 50k+ of these) and their stage edits in those sessions
    // are office cleanup, not doors.
    for (const e of evs) if (e.ev === 'assignee_updated' && e.rep) {
      const rn = canonicalDisplayName(e.rep.replace(/\s+/g, ' ').trim());
      if (!assignMs.has(rn)) assignMs.set(rn, []);
      assignMs.get(rn).push(Date.parse(e.t));
    }
  }
  if (!LEAN) {
    await actW.end(); await histW.end();
    renameSync(ACT_CSV + '.tmp', ACT_CSV); renameSync(HIST_CSV + '.tmp', HIST_CSV);

    doors.sort((a, b) => a.state.localeCompare(b.state) || a.city.toUpperCase().localeCompare(b.city.toUpperCase()) || a.zip.localeCompare(b.zip) || a.street.localeCompare(b.street));
    const DOOR_COLS = Object.keys(doors[0]);
    const dW = rowWriter(createWriteStream(DOORS_CSV + '.tmp'));
    dW.row(DOOR_COLS);
    for (const d of doors) { const bp = dW.row(DOOR_COLS.map((c) => d[c])); if (bp) await bp; }
    await dW.end(); renameSync(DOORS_CSV + '.tmp', DOORS_CSV);
  }

  writeFileSync(EMAILS, JSON.stringify(Object.fromEntries([...emails].map(([r, c]) => [r, [...c].sort((a, b) => b[1] - a[1])[0][0]])), null, 2));

  // Burst filter, then rep/day aggregation, exactly as before.
  const byRep = new Map();
  for (const e of knockEv) { if (!byRep.has(e.rep)) byRep.set(e.rep, []); byRep.get(e.rep).push(e); }
  let dropped = 0;
  for (const list of byRep.values()) {
    list.sort((a, b) => a.ms - b.ms);
    for (let i = 0; i + BURST_N - 1 < list.length; i++) if (list[i + BURST_N - 1].ms - list[i].ms < BURST_SEC * 1000) for (let k = i; k < i + BURST_N; k++) list[k].bulk = true;
    for (const x of list) if (x.bulk) dropped++;
  }
  // A stage change within 2 minutes of the same actor's own lead
  // reassignments is part of a distribution session, not a knock.
  const ASSIGN_WIN_MS = 120000;
  let droppedAssign = 0;
  for (const t of assignMs.values()) t.sort((a, b) => a - b);
  const nearAssign = (rep, ms) => {
    const t = assignMs.get(rep); if (!t || !t.length) return false;
    let lo = 0, hi = t.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (t[mid] < ms) lo = mid + 1; else hi = mid; }
    for (const i of [lo - 1, lo]) if (i >= 0 && i < t.length && Math.abs(t[i] - ms) <= ASSIGN_WIN_MS) return true;
    return false;
  };
  // ISP split of the SAME knocks the rep/day rows are built from: same burst
  // and assign-window drops, so the two can never disagree on what a knock is.
  const ISP = ispResolver();
  ISP.learn(knockEv);
  const aggIsp = new Map();
  const agg = new Map();
  for (const [rep, list] of byRep) for (const x of list) {
    if (x.bulk) continue;
    if (nearAssign(rep, x.ms)) { droppedAssign++; continue; }
    const { date, time } = localParts(x.iso, x.tz);
    const r = ISP.of(x);
    const ik = rep + '|' + date + '|' + (r.isp || 'Unassigned');
    let ig = aggIsp.get(ik);
    if (!ig) { ig = { rep, date, isp: r.isp || 'Unassigned', how: r.how, doors: 0, leads: new Set(), contacts: new Set(), sold: new Set(), minMs: x.ms, maxMs: x.ms }; aggIsp.set(ik, ig); }
    ig.doors++; ig.leads.add(x.lead);
    if (CONTACT.has(x.st)) ig.contacts.add(x.lead);
    if (x.st === 'Sold') ig.sold.add(x.lead);
    if (x.ms < ig.minMs) ig.minMs = x.ms;
    if (x.ms > ig.maxMs) ig.maxMs = x.ms;
    const k = rep + '|' + date;
    let g = agg.get(k);
    if (!g) { g = { rep, date, doors: 0, leads: new Set(), contacts: new Set(), sold: new Set(), minMs: x.ms, maxMs: x.ms, first: time, last: time }; agg.set(k, g); }
    g.doors++; g.leads.add(x.lead);
    if (CONTACT.has(x.st)) g.contacts.add(x.lead);
    if (x.st === 'Sold') g.sold.add(x.lead);
    if (x.ms < g.minMs) { g.minMs = x.ms; g.first = time; }
    if (x.ms > g.maxMs) { g.maxMs = x.ms; g.last = time; }
  }
  const rows = [...agg.values()].map((g) => ({ rep: g.rep, date: g.date, doors: g.doors, unique_doors: g.leads.size,
    contacts: g.contacts.size, sold: g.sold.size, first_disp: g.first, last_disp: g.last,
    hours: Math.round(((g.maxMs - g.minMs) / 3600000) * 100) / 100, source: 'grow', method: 'sr_activity' }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.rep.localeCompare(b.rep));
  const cols = Object.keys(rows[0]);
  writeFileSync(KNOCK_CSV, [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n');
  // Hours are the rep's span INSIDE that ISP. They sum to more than the day's
  // hours when a rep works two ISPs with a gap between them, which is why the
  // board reads hours off the rep/day rows and never off these.
  const ispRows = [...aggIsp.values()].map((g) => ({ rep: g.rep, date: g.date, isp: g.isp, doors: g.doors,
    unique_doors: g.leads.size, contacts: g.contacts.size, sold: g.sold.size,
    hours: Math.round(((g.maxMs - g.minMs) / 3600000) * 100) / 100, how: g.how, source: 'grow', method: 'sr_activity' }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.rep.localeCompare(b.rep) || a.isp.localeCompare(b.isp));
  const ispCount = {};
  for (const r of ispRows) ispCount[r.isp] = (ispCount[r.isp] || 0) + r.doors;
  console.log('  ISP doors: ' + Object.entries(ispCount).sort((a, b) => b[1] - a[1])
    .map(([i, d]) => `${i} ${d.toLocaleString()}`).join(' | '));

  console.log(`  ${leads.toLocaleString()} leads | ${marks.toLocaleString()} marks | ${knockEv.length.toLocaleString()} knocks (${dropped.toLocaleString()} bulk-dropped, ${droppedAssign.toLocaleString()} assign-window) | ${rows.length.toLocaleString()} rep/days${LEAN ? ' (lean: sr-activity/lead-history/doors-by-area left from the last full run)' : ''}`);
  return { rows, ispRows };
}

// ------------------------------------------------------------- PUSH
async function push(rows) {
  const ANON = (readFileSync(join(ROOT, 'index.html'), 'utf8').match(/eyJ[A-Za-z0-9_.-]{50,}/) || [])[0];
  if (!ANON) { console.error('No anon key in index.html; skipping push.'); return; }
  const H = { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' };
  // Delete-then-insert leaves a window where the table has no sr_activity rows.
  // Once a day at 7am nobody is looking. Every hour from noon someone eventually
  // loads the dashboard mid-write and sees knocking at zero. --push-days narrows
  // both halves to the recent days, so the gap covers a week instead of all of
  // history and there are far fewer rows to reinsert. Older days are untouched;
  // they recompile identically anyway, since the store behind them never changed.
  let scope = '';
  if (PUSH_DAYS) {
    const cut = new Date(Date.now() - PUSH_DAYS * 86400000).toISOString().slice(0, 10);
    scope = `&date=gte.${cut}`;
    rows = rows.filter((r) => r.date >= cut);
  }
  // The KC/Raytown GFiber leads were deleted out of SalesRabbit on 2026-08-11, so
  // their June activity no longer exists to recompile. Those rep/days live on as
  // method='sr_frozen_kc' (see scripts/kc-freeze.mjs), which this delete does not
  // touch. Skip recompiling them here or the mixed days would count twice.
  const frozen = new Set(JSON.parse(readFileSync(join(ROOT, 'data/kc-frozen-repdays.json'), 'utf8'))
    .map((k) => k.rep + '|' + k.date));
  const before = rows.length;
  rows = rows.filter((r) => !frozen.has(r.rep + '|' + r.date));
  if (before !== rows.length) console.log(`  ${before - rows.length} rep/days held by sr_frozen_kc`);
  const prev = await snapshotKnock(SB, H, 'grow', rows, '&method=eq.sr_activity');
  const del = await fetch(`${SB}/rest/v1/knocking?method=eq.sr_activity${scope}`, { method: 'DELETE', headers: H });
  if (!del.ok) { console.error('Delete failed:', del.status, (await del.text()).slice(0, 200)); process.exitCode = 5; return; }
  let ok = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const r = await fetch(`${SB}/rest/v1/knocking`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(rows.slice(i, i + 500)) });
    if (!r.ok) { console.error('Insert failed:', r.status, (await r.text()).slice(0, 200)); process.exitCode = 5; return; }
    ok += Math.min(500, rows.length - i);
  }
  console.log(`Supabase: knocking method=sr_activity ${PUSH_DAYS ? `last ${PUSH_DAYS}d` : 'all'} replaced with ${ok.toLocaleString()} rows`);
  await stampFresh(SB, H, 'grow', prev, rows);
}

// knocking_isp: the same rep/days split by whose door it was. Separate table on
// purpose. Splitting `knocking` itself would put several rows on one rep/day
// and every rollup downstream assumes one, so the board's ISPs view reads this
// and nothing else changes.
async function pushIsp(rows) {
  if (!rows || !rows.length) return;
  const ANON = (readFileSync(join(ROOT, 'index.html'), 'utf8').match(/eyJ[A-Za-z0-9_.-]{50,}/) || [])[0];
  if (!ANON) return;
  const H = { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' };
  let scope = '';
  if (PUSH_DAYS) {
    const cut = new Date(Date.now() - PUSH_DAYS * 86400000).toISOString().slice(0, 10);
    scope = `&date=gte.${cut}`;
    rows = rows.filter((r) => r.date >= cut);
  }
  const del = await fetch(`${SB}/rest/v1/knocking_isp?method=eq.sr_activity${scope}`, { method: 'DELETE', headers: H });
  if (!del.ok) { console.error('ISP delete failed:', del.status, (await del.text()).slice(0, 200)); process.exitCode = 5; return; }
  let ok = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const r = await fetch(`${SB}/rest/v1/knocking_isp`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(rows.slice(i, i + 500)) });
    if (!r.ok) { console.error('ISP insert failed:', r.status, (await r.text()).slice(0, 200)); process.exitCode = 5; return; }
    ok += Math.min(500, rows.length - i);
  }
  console.log(`Supabase: knocking_isp ${PUSH_DAYS ? `last ${PUSH_DAYS}d` : 'all'} replaced with ${ok.toLocaleString()} rows`);
}

// ------------------------------------------------------------- MAIN
// --seed does one thing and stops: open a window, mint a token, save it. Kept
// separate from a sync so re-authing never means sitting through a crawl.
if (SEED) {
  await seedAuth();
  console.log('Seeded. The scheduled syncs will use this until it expires.');
  process.exit(0);
}
await bootstrapStore();
if (!SKIP_CRAWL) await crawl();
const { rows, ispRows } = await compile();
if (!NO_PUSH && !TENANT) { if (!ISP_ONLY) await push(rows); await pushIsp(ispRows); }
if (TENANT) console.log(`(tenant ${TENANT}: no knocking push, Amplify owns those rows)`);
console.log('Done.');
