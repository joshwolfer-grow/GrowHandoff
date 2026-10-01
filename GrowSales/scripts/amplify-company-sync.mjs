#!/usr/bin/env node
// Daily SalesRabbit Amplify -> `knocking` sync for a SECOND company (any account
// other than Grow). Same mechanism as scripts/amplify-knocking-sync.mjs: it drives
// a real Chrome profile that stays logged into that company's Amplify and calls the
// dashboard's own /Reports/Get endpoint, then writes per-rep/day numbers into the
// shared `knocking` table — every row TAGGED with `source` so it can be filtered or
// deleted independently of Grow's rows.
//
// Because Amplify's internal ids (activityTypeId, disposition ids) are ACCOUNT
// SPECIFIC, each company's ids live in data/amplify-sources.json keyed by --source.
// Discover them once with --probe, paste them in, then run normally.
//
//   node scripts/amplify-company-sync.mjs --source acme --login   # ONE TIME: window opens, log in
//   node scripts/amplify-company-sync.mjs --source acme --probe   # discover this account's ids
//   node scripts/amplify-company-sync.mjs --source acme           # daily: catches up from the last synced day -> today
//   node scripts/amplify-company-sync.mjs --source acme --from 2026-06-01 --to 2026-07-17   # explicit backfill
//   node scripts/amplify-company-sync.mjs --source acme --dry     # pull + print, no writes
//
// The login lives in .amplify-profile-<source>/ (gitignored, separate from Grow's).
// When it expires the run does NOT give up: it reopens the same profile in a
// visible window and waits — indefinitely, no keypress — until you sign in and
// the report hands over its token, then finishes the pull in that window. So the
// daily command is all you need; --login just does the same thing up front.

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { snapshotKnock, stampFresh } from './_rep-fresh.mjs';
// Shared alias table (CommonJS) so a rep's knocking lands under the same name
// their deals do — e.g. Amplify's "Mana McGuire" is "Kaimana McGuire" in Bria.
const { canonicalDisplayName } = createRequire(import.meta.url)('../api/_name-aliases.js');

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SB = 'https://cmkfohwbejcztctrpdnt.supabase.co';
const APP = 'https://app.amplify.salesrabbit.com';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const LOGIN = flag('--login'), PROBE = flag('--probe'), DRY = flag('--dry');
const SCHEDULED = flag('--scheduled');   // unattended: never open a window

const SOURCE = (opt('--source', '') || '').trim().toLowerCase();
if (!SOURCE) { console.error('Missing --source <company-slug>. This becomes the `source` label on every row.'); process.exit(1); }
if (SOURCE === 'grow') { console.error('Refusing --source grow — Grow uses scripts/amplify-knocking-sync.mjs.'); process.exit(1); }
const PROFILE = join(ROOT, `.amplify-profile-${SOURCE}`);

// --- account-specific config (data/amplify-sources.json), not needed for login/probe
const CFG_PATH = join(ROOT, 'data', 'amplify-sources.json');
const allCfg = existsSync(CFG_PATH) ? JSON.parse(readFileSync(CFG_PATH, 'utf8')) : {};
const cfg = allCfg[SOURCE] || null;
if (!LOGIN && !PROBE) {
  if (!cfg || !cfg.activityTypeId) {
    console.error(`No config for source "${SOURCE}" in data/amplify-sources.json. Run --probe first, then fill activityTypeId / contactIds / soldId.`);
    process.exit(1);
  }
}
const ACTIVITY_TYPE = cfg && cfg.activityTypeId;
const CONTACT_IDS = (cfg && cfg.contactIds) || [];
const SOLD_ID = cfg && cfg.soldId;
// Whitelist of dispositions that count as a door at all. Amplify feeds carry
// integration-generated and CRM-status dispositions that aren't rep knocks, so
// an empty list means "count everything" but a populated one is authoritative.
const INCLUDE_IDS = (cfg && cfg.includeIds) || [];
// Origin = SalesRabbit's GPS verification of where the disposition was logged.
// Empty means "any origin"; a populated list keeps only genuinely-knocked doors
// and drops system imports (origin "Unknown") that have no GPS at all.
const INCLUDE_ORIGINS = (cfg && cfg.includeOrigins) || [];
// Sold always comes from Bria (comp system of record), never Amplify pins —
// standard across all knocking data. Off only for an account outside Bria.
const SOLD_FROM_BRIA = !(cfg && cfg.soldFromBria === false);
// Reps to drop entirely, by resolved name (excludeUsers is by Amplify userId).
// For people who left and were removed from Bria, so their knocking has no
// matching comp data and would sit on unreliable Amplify pins forever.
const EXCLUDE_REPS = new Set(((cfg && cfg.excludeReps) || []).map((s) => String(s).trim().toLowerCase()));
const EXCLUDE_USERS = new Set((cfg && cfg.excludeUsers) || []);
const TZ = (cfg && cfg.tz) || 'America/Denver';

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const y = new Date(Date.now() - 86400000);

const ANON = (readFileSync(join(ROOT, 'index.html'), 'utf8').match(/eyJ[A-Za-z0-9_.-]{50,}/) || [])[0];
if (!ANON && !DRY && !PROBE && !LOGIN) { console.error('Could not read anon key from index.html'); process.exit(1); }

// Pick up where the last run left off instead of assuming "yesterday". A plain
// yesterday-only default silently loses any day you didn't run — a missed Friday
// stays missing forever. The watermark is the newest date already in `knocking`
// for THIS source, and we re-pull that day rather than starting after it: the
// last run may have caught it mid-shift. Safe to redo, since the write path
// deletes by (source, rep, date) before inserting and events upsert on id.
// MAX_BACKFILL stops a fresh/empty table from trying to pull all of history.
const MAX_BACKFILL = 45;
async function lastSyncedDate() {
  if (!ANON) return null;
  try {
    const r = await fetch(`${SB}/rest/v1/knocking?select=date&source=eq.${encodeURIComponent(SOURCE)}&order=date.desc&limit=1`,
      { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } });
    if (!r.ok) return null;
    const j = await r.json();
    return (j && j[0] && j[0].date) || null;
  } catch (e) { return null; }
}

let FROM = opt('--from', null), TO = opt('--to', null);
if (LOGIN || PROBE) { FROM = FROM || iso(y); TO = TO || FROM; }   // dates unused on these paths
else if (!FROM && !TO) {
  const last = await lastSyncedDate();
  const floor = iso(new Date(Date.now() - MAX_BACKFILL * 86400000));
  // TO is today, not yesterday: today's rows are partial until the shift ends,
  // and the next run overwrites them, so there is no reason to lag a full day.
  TO = iso(new Date());
  FROM = last && last > floor ? last : (last ? floor : iso(y));
  if (last) console.log(`[${SOURCE}] Last synced day in knocking is ${last}; catching up ${FROM} .. ${TO}`);
  else console.log(`[${SOURCE}] No existing ${SOURCE} rows in knocking; pulling ${FROM} .. ${TO}`);
  if (last && last <= floor) console.log(`  (clamped to ${MAX_BACKFILL} days — use --from to go further back)`);
} else {
  FROM = FROM || TO;
  TO = TO || FROM;
}

// Capture the app's antiforgery token from its own XHR — /Reports/Get requires it.
const TOKEN_HOOK = () => {
  const S = XMLHttpRequest.prototype.send, O = XMLHttpRequest.prototype.open, H = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, u, ...r) { this.__u = u; this.__h = {}; return O.call(this, m, u, ...r); };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) { try { this.__h[k] = v; } catch (e) {} return H.call(this, k, v); };
  XMLHttpRequest.prototype.send = function (b) {
    if ((this.__u || '').includes('/Reports/Get')) {
      const t = this.__h['__RequestVerificationToken']; if (t) window.__srToken = t;
      try { window.__srBodies = (window.__srBodies || []); window.__srBodies.push(b); } catch (e) {}
    }
    return S.call(this, b);
  };
};

// Chrome's SingletonLock is a SYMLINK whose target ("<host>-<pid>") never
// exists as a file — it carries the owner in its own name. existsSync FOLLOWS
// symlinks, so it answers false on every lock Chrome has ever written, and the
// guard below silently did nothing for its whole life. lstat asks about the
// link itself, which is the only question worth asking here.
function lockPresent(profile) {
  try { lstatSync(join(profile, 'SingletonLock')); return true; } catch (e) { return false; }
}

// A killed run leaves Chrome's SingletonLock behind, and launching against a
// locked profile can stall with no output — which is indistinguishable from the
// script never starting. Same guard grow-sync.mjs already uses: clear a lock
// whose owner is gone, and speak up if the browser is genuinely still running.
async function clearStaleLock() {
  if (!lockPresent(PROFILE)) return;
  const { execSync } = await import('node:child_process');
  let running = '';
  try { running = execSync(`pgrep -f "user-data-dir=${PROFILE}" || true`, { encoding: 'utf8' }).trim(); } catch (e) {}
  if (running) {
    console.error(`\nA Chrome window is already using the "${SOURCE}" profile. Close it (or run:`);
    console.error(`  pkill -f "user-data-dir=${PROFILE}"`);
    console.error('), then run the sync again.');
    process.exit(1);
  }
  const { rmSync } = await import('node:fs');
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { rmSync(join(PROFILE, f), { force: true }); } catch (e) {}
  }
  console.log('(cleared a stale profile lock from an earlier run)');
}

async function launchCtx(headless) {
  await clearStaleLock();
  const c = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless,
    viewport: { width: 1280, height: 900 },
  });
  await c.addInitScript(TOKEN_HOOK);
  return c;
}

// Headless Chrome plus the token poll means the first real log line lands nearly
// a minute in. Say what's happening up front, so a slow start doesn't look like
// a script that never ran at all.
console.log(`[${SOURCE}] Starting Chrome (${LOGIN || PROBE ? 'visible' : 'headless'}), profile .amplify-profile-${SOURCE} ...`);
let ctx = await launchCtx(!(LOGIN || PROBE));

// The Amplify session lives in a cookie that expires with no warning, and a dead
// session is the single most common reason an unattended run produces nothing.
// Rather than exit and make you re-run with --login (which you only discover
// AFTER the failed run), reopen the same profile in a visible window, let you
// sign in, and carry on with the pull in that window. Matches how grow-sync.mjs
// behaves, so both daily crawls fail the same recoverable way.
// Opens the SAME profile in a visible window and hands the page back. It does
// NOT wait on stdin: requiring a keypress meant a mistimed Enter (or an Enter
// pressed before the report finished loading) killed the run outright. The token
// poll below decides when we're actually in, exactly like grow-sync.mjs does.
// --scheduled turns that recovery off. On a 10-minute launchd cadence, popping
// a window that then waits forever is the worst possible failure: it appears
// while you're mid-sentence or driving, and it holds the profile lock so every
// later tick dies on it too. Exit 3 instead and let the wrapper notify, exactly
// like grow-sync.mjs --scheduled.
const AMP_LOGIN_NEEDED = 3;
let reauthed = false;
async function recoverLogin() {
  if (SCHEDULED) {
    console.error(`[${SOURCE}] Not signed in, and --scheduled means no window. Run: node scripts/amplify-company-sync.mjs --source ${SOURCE} --login`);
    await ctx.close().catch(() => {});
    process.exit(AMP_LOGIN_NEEDED);
  }
  if (reauthed) return null;              // only ever swap to a window once
  reauthed = true;
  console.log(`\n[${SOURCE}] Not signed in. Opening a Chrome window — sign in there and the sync continues on its own.`);
  await ctx.close().catch(() => {});
  ctx = await launchCtx(false);
  const p = await ctx.newPage();
  await p.goto(`${APP}/#/reports/${ACTIVITY_TYPE || ''}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  return p;
}

// ---------------------------------------------------------------- PROBE MODE
// Discover this account's activityTypeId + disposition ids. We capture every
// report/activity/config response the app makes while you click into the raw
// "Lead Status" disposition report and open its Activity filter.
if (PROBE) {
  const captured = [];
  // Attach BEFORE navigation and capture broadly — the disposition name->id list
  // loads once at app bootstrap, so a URL-filtered listener attached after load
  // misses it. Skip analytics/cdn noise and the bulky /Reports/Get event dumps.
  const NOISE = /segment\.io|segment\.com|posthog|cdn\.|google|launchdarkly|sentry|intercom|fullstory|\.png|\.js|\.css|\.woff/i;
  ctx.on('response', async (res) => {
    const url = res.url();
    if (NOISE.test(url) || /\/Reports\/Get/i.test(url)) return;
    try {
      const ct = res.headers()['content-type'] || '';
      if (!/json/i.test(ct)) return;
      const txt = await res.text();
      // Keep responses that mention disposition-ish name fields — that's the map.
      if (txt.length > 60000) return;
      captured.push({ url, sample: txt.slice(0, 12000) });
    } catch (e) {}
  });
  const page = await ctx.newPage();
  await page.goto(`${APP}/#/reports/2451`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  console.log(`\nA Chrome window is open for source "${SOURCE}".`);
  console.log('1) Log in if needed, land on the disposition report.');
  console.log('2) Open the report\'s ACTIVITY / disposition filter dropdown (so the name list loads).');
  console.log('   If names still don\'t show, also open a rep\'s row to expand dispositions.');
  console.log('Then come back here and press Enter.\n');
  await new Promise((r) => process.stdin.once('data', r));

  const hash = page.url();
  const ATID = Number((hash.match(/reports\/(\d+)/) || [])[1]) || 2451;

  // Active fallback: with the captured token, hit candidate endpoints that list
  // this activity type's dispositions (name + id), and pull distinct activityIds
  // straight from the report so we always have the candidate ids even if the
  // name list never fires.
  const token = await page.evaluate(() => window.__srToken || null);
  const probe = await page.evaluate(async ({ token, ATID }) => {
    const out = { token: !!token, endpoints: [], dispositions: null, activityIdSummary: [] };
    const tryUrls = [
      `/Activity/GetActivitiesByActivityType?activityTypeId=${ATID}`,
      `/Activity/GetByActivityType?activityTypeId=${ATID}`,
      `/ActivityType/Get?id=${ATID}`,
      `/ActivityType/GetActivities?activityTypeId=${ATID}`,
      `/Reports/GetActivities?activityTypeId=${ATID}`,
      `/Reports/GetFilters?activityTypeId=${ATID}`,
      `/Company/GetActivityTypes`,
      `/Activity/GetAll`,
    ];
    for (const u of tryUrls) {
      try {
        const r = await fetch(u, { headers: token ? { '__RequestVerificationToken': token } : {} });
        const t = (await r.text()).slice(0, 6000);
        if (r.ok && /\[|\{/.test(t)) out.endpoints.push({ url: u, status: r.status, body: t });
      } catch (e) {}
    }
    // Distinct activityIds + a sample customer name + count, from a 60-day pull.
    try {
      const now = new Date();
      const from = new Date(now.getTime() - 60 * 86400000);
      const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const base = { activityTypeId: ATID, period: 0, paginationGrouped: { currentPage: 1, numberOfPages: 1 }, orderBy: 'createdDate', includeDisabledEntities: false, statusIds: [], activityIds: [], userIds: [], originIds: [], groupBy: 0, filterChangedWhileGrouping: false, descending: true, teamIds: [], filterChanged: false, getByMeetingDate: false, fromDateTimeString: fmt(from) + ' 00:00:00', toDateTimeString: fmt(now) + ' 23:59:59' };
      const seen = new Map();
      for (let p = 1; p <= 6; p++) {
        const r = await fetch('/Reports/Get', { method: 'POST', headers: { 'Content-Type': 'application/json', '__RequestVerificationToken': token }, body: JSON.stringify({ ...base, pagination: { numberOfPages: 1, currentPage: p } }) });
        if (!r.ok) break;
        const j = await r.json();
        for (const x of (j.reports || [])) {
          let e = seen.get(x.activityId); if (!e) { e = { activityId: x.activityId, count: 0, withName: 0, sample: '' }; seen.set(x.activityId, e); }
          e.count++;
          const nm = (x.customer || '').trim();
          if (nm) { e.withName++; if (!e.sample) e.sample = nm; }
        }
        if (!j.pagination || p >= j.pagination.numberOfPages) break;
      }
      out.activityIdSummary = [...seen.values()].sort((a, b) => b.count - a.count);
    } catch (e) { out.activityIdSummary = [{ error: String(e).slice(0, 80) }]; }
    return out;
  }, { token, ATID });

  const file = join(ROOT, `amplify-${SOURCE}-probe.json`);
  writeFileSync(file, JSON.stringify({ source: SOURCE, url: hash, activityTypeId: ATID, probe, captured }, null, 2));
  console.log(`\nactivityTypeId = ${ATID}`);
  console.log(`Endpoints that responded: ${probe.endpoints.length}, distinct activityIds seen: ${probe.activityIdSummary.length}`);
  console.log(`Wrote ${file} — paste it to me.`);
  await ctx.close();
  process.exit(0);
}

let page = await ctx.newPage();
console.log(`[${SOURCE}] Loading the reports page ...`);
await page.goto(`${APP}/#/reports/${ACTIVITY_TYPE || ''}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(LOGIN ? 1000 : 6000);

if (LOGIN) {
  console.log(`\nA Chrome window is open. Log into the "${SOURCE}" Amplify account, wait for the Reports page, then press Enter here.`);
  await new Promise((r) => process.stdin.once('data', r));
  console.log(`Saved login to ${PROFILE}`);
  await ctx.close();
  process.exit(0);
}

if (/signin\.salesrabbit|auth0/i.test(page.url())) {
  page = (await recoverLogin()) || page;
}

// Wait for the antiforgery token. Headless gets HEADLESS_TRIES seconds to prove
// the saved session still works; anything else (expired cookie, an Amplify error
// page, a slow boot) drops us into a visible window that then waits as long as
// it takes, so a login hiccup costs one sign-in instead of a dead run. Ctrl+C is
// the way out. --login-timeout <seconds> caps the wait for unattended use.
const HEADLESS_TRIES = 20;
const loginCap = Number(opt('--login-timeout', 0));
let token = null;
for (let i = 0; !token; i++) {
  if (loginCap && i >= loginCap) break;
  // The window can be closed out from under us; put a live page back instead of
  // polling something detached.
  if (page.isClosed()) {
    page = await ctx.newPage();
    await page.goto(`${APP}/#/reports/${ACTIVITY_TYPE || ''}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  }
  token = await page.evaluate(() => window.__srToken || null).catch(() => null);
  if (token) break;
  // Either we can see we're on the login page, or headless has had its chance
  // and something is wrong we cannot diagnose blind. Both mean: show a window.
  const onLogin = /signin\.salesrabbit|auth0/i.test(page.url());
  if (!reauthed && (onLogin || i >= HEADLESS_TRIES)) {
    const p = await recoverLogin();
    if (p) { page = p; i = 0; }
  } else if (reauthed && i > 0 && i % 120 === 0) {
    console.log(`[${SOURCE}] still waiting for sign-in, ${Math.round(i / 60)}m in — Ctrl+C to stop; reloading the report`);
    await page.goto(`${APP}/#/reports/${ACTIVITY_TYPE || ''}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  if ((i === 4 || i === 20) && page.url().startsWith(APP) && !page.url().includes('#/reports')) {
    await page.goto(`${APP}/#/reports/${ACTIVITY_TYPE}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  if (i === 5) console.log(`[${SOURCE}] still waiting for the Amplify token, page is ${page.url().slice(0, 80)}`);
  await page.waitForTimeout(1000).catch(() => {});
}
// Only reachable with --login-timeout, since the interactive path waits forever.
// Print the URL either way: it says which of the three this is — a sign-in page,
// a stuck report, or an Amplify error page.
if (!token) {
  console.error(`Could not capture the Amplify request token within --login-timeout ${loginCap}s. Page was: ${page.url()}`);
  console.error(`Run without --login-timeout to get a window and sign in.`);
  await ctx.close(); process.exit(3);
}

console.log(`[${SOURCE}] Pulling Lead Status ${FROM} .. ${TO}`);
const pulled = await page.evaluate(async ({ token, FROM, TO, ACTIVITY_TYPE, CONTACT_IDS, SOLD_ID, EXCLUDE, INCLUDE, ORIGINS, TZ }) => {
  const base = {
    activityTypeId: ACTIVITY_TYPE, period: 0, paginationGrouped: { currentPage: 1, numberOfPages: 1 },
    orderBy: 'createdDate', includeDisabledEntities: false, statusIds: [], activityIds: [], userIds: [], originIds: [],
    groupBy: 0, filterChangedWhileGrouping: false, descending: true, teamIds: [], filterChanged: false, getByMeetingDate: false,
    fromDateTimeString: FROM + ' 00:00:00', toDateTimeString: TO + ' 23:59:59',
  };
  const get = async (p) => {
    for (let a = 0; a < 4; a++) {
      try {
        const r = await fetch('/Reports/Get', { method: 'POST', headers: { 'Content-Type': 'application/json', '__RequestVerificationToken': token }, body: JSON.stringify({ ...base, pagination: { numberOfPages: 1, currentPage: p } }) });
        if (r.ok) return r.json();
      } catch (e) {}
      await new Promise((x) => setTimeout(x, 400 * (a + 1)));
    }
    throw new Error('page ' + p + ' failed');
  };
  const agg = new Map();
  const events = [];
  // Bucket each event by its date in the REP'S timezone, derived from the UTC
  // stamp — not from Amplify's account-local string. They agree today (the
  // account renders Central and the reps are Central), but if the account
  // timezone is ever changed this keeps days from silently shifting. tzMismatch
  // counts any disagreement so a drift surfaces instead of corrupting history.
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dateIn = (utcIso) => { try { return dtf.format(new Date(utcIso)); } catch (e) { return ''; } };
  let tzMismatch = 0;
  // "0 kept" is the failure mode that looks like a broken sync, and the count
  // alone cannot tell you whether the day was quiet or a filter stopped matching.
  // Tally why each row was dropped, and what ids actually showed up.
  const rej = { user: 0, activity: 0, origin: 0 };
  const sawAct = {}, sawOrigin = {};
  const ingest = (rows) => { for (const x of rows) {
    sawAct[x.activityId] = (sawAct[x.activityId] || 0) + 1;
    sawOrigin[x.originId] = (sawOrigin[x.originId] || 0) + 1;
    if (EXCLUDE.indexOf(x.userId) >= 0) { rej.user++; continue; }
    if (INCLUDE.length && INCLUDE.indexOf(x.activityId) < 0) { rej.activity++; continue; }   // not a real door
    if (ORIGINS.length && ORIGINS.indexOf(x.originId) < 0) { rej.origin++; continue; }       // not GPS-verified at the door
    const d = dateIn(x.utcDateTimeString) || (x.dateTimeString || '').slice(0, 10);
    if (d !== (x.dateTimeString || '').slice(0, 10)) tzMismatch++;
    events.push({ id: x.id, lead: x.customerId || null, uid: x.userId, team: x.teamId || null, act: x.activityId, at: x.utcDateTimeString, date: d });
    const k = x.userId + '|' + d;
    let e = agg.get(k); if (!e) { e = { doors: 0, leads: new Set(), contactLeads: new Set(), soldLeads: new Set(), min: x.dateTimeString, max: x.dateTimeString }; agg.set(k, e); }
    e.doors += x.quantity || 1;
    const leadKey = x.customerId || ('evt' + x.id);
    if (CONTACT_IDS.indexOf(x.activityId) >= 0) e.contactLeads.add(leadKey);
    if (x.activityId === SOLD_ID) e.soldLeads.add(leadKey);
    if (x.customerId) e.leads.add(x.customerId);
    if (x.dateTimeString < e.min) e.min = x.dateTimeString;
    if (x.dateTimeString > e.max) e.max = x.dateTimeString;
    if (!e.minU || x.utcDateTimeString < e.minU) e.minU = x.utcDateTimeString;
    if (!e.maxU || x.utcDateTimeString > e.maxU) e.maxU = x.utcDateTimeString;
  } };
  const first = await get(1);
  const total = first.pagination.numberOfPages; ingest(first.reports || []);
  let next = 2, errors = 0;
  const worker = async () => { while (next <= total) { const p = next++; try { ingest((await get(p)).reports || []); } catch (e) { errors++; } } };
  await Promise.all(Array.from({ length: 20 }, worker));
  const users = [...new Set([...agg.keys()].map((k) => k.split('|')[0]))];
  const names = {}; let ui = 0;
  const nameWorker = async () => { while (ui < users.length) { const u = users[ui++];
    try { const r = await fetch('/User360/GetProfileInfo?userId=' + u, { headers: { '__RequestVerificationToken': token } }); const j = await r.json(); names[u] = (j && j.name) || u; } catch (e) { names[u] = u; }
  } };
  await Promise.all(Array.from({ length: 10 }, nameWorker));
  return { records: first.numberOfReports, pages: total, errors, names, events, tzMismatch, kept: events.length, rej, sawAct, sawOrigin, rows: [...agg.entries()].map(([k, e]) => {
    const [uid, date] = k.split('|');
    return { name: names[uid] || uid, date, doors: e.doors, uniq: e.leads.size, contacts: e.contactLeads.size, sold: e.soldLeads.size, min: e.min, max: e.max, minU: e.minU, maxU: e.maxU };
  }) };
}, { token, FROM, TO, ACTIVITY_TYPE, CONTACT_IDS, SOLD_ID, EXCLUDE: [...EXCLUDE_USERS], INCLUDE: INCLUDE_IDS, ORIGINS: INCLUDE_ORIGINS, TZ });
await ctx.close();

// Single account timezone for this company (no per-rep market inference — that's
// Grow-only). first/last disposition + hours are rendered in TZ from config.
const fmtZ = (isoStr, zone) => { if (!isoStr) return null; try { return new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(isoStr)); } catch (e) { return null; } };

const recs = pulled.rows.map((r) => {
  const rep = canonicalDisplayName(String(r.name).replace(/\s+/g, ' ').trim());
  return {
    rep, date: r.date, doors: r.doors, unique_doors: r.uniq, contacts: r.contacts, sold: r.sold,
    first_disp: fmtZ(r.minU, TZ), last_disp: fmtZ(r.maxU, TZ),
    hours: +(Math.max(0, (new Date(r.maxU) - new Date(r.minU)) / 3600000).toFixed(2)),
    // Same omission as rtr-sync had: writing NULL method leaves these rows
    // untaggable, so readers that filter by method silently drop them and readers
    // that don't will double count. tds/amplify rows stopped being tagged after
    // 2026-07-20 and have been landing as NULL since.
    source: SOURCE, method: 'amplify',
  };
}).filter((r) => r.rep && r.date && !EXCLUDE_REPS.has(r.rep.toLowerCase()));

// --- SOLD comes from Bria (booked deals), NOT the Amplify pin ---
// Same rule the Grow sync follows: doors/unique/contacts/hours are Amplify's,
// but sold is Bria's, because reps use the "Sold" disposition inconsistently
// while Bria is the comp system of record. Bria covers the person, not the
// Amplify account, so it is already the rep's complete daily total.
// Reps with no Bria match keep their Amplify pin count rather than dropping to
// zero — unlike Grow, this account has reps who aren't in Bria at all.
if (SOLD_FROM_BRIA) {
  const nrm = (s) => { const t = String(s || '').replace(/\s+/g, ' ').trim().toLowerCase().split(' '); return t.length > 1 ? t[0] + ' ' + t[t.length - 1] : (t[0] || ''); };
  try {
    const bres = await fetch(`${SB}/rest/v1/bria_sales_daily?select=rep,sale_date,deals&sale_date=gte.${FROM}&sale_date=lte.${TO}&limit=100000`, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } });
    if (bres.ok) {
      const bria = await bres.json();
      const briaBy = new Map(), briaReps = new Set();
      for (const b of bria) { const k = nrm(b.rep); briaReps.add(k); briaBy.set(k + '|' + b.sale_date, (briaBy.get(k + '|' + b.sale_date) || 0) + (b.deals || 0)); }
      let swapped = 0; const noBria = new Set();
      for (const r of recs) {
        const k = nrm(r.rep);
        if (briaReps.has(k)) { r.sold = briaBy.get(k + '|' + r.date) || 0; swapped++; }
        else noBria.add(r.rep);
      }
      console.log(`[${SOURCE}] Sold sourced from Bria for ${swapped}/${recs.length} rep/day rows (${bria.length} bria rows in range)`);
      if (noBria.size) console.warn(`[${SOURCE}] Not in Bria, keeping Amplify pins: ${[...noBria].join(', ')}`);
    } else console.warn(`[${SOURCE}] Bria fetch failed (${bres.status}) — keeping Amplify pins this run`);
  } catch (e) { console.warn(`[${SOURCE}] Bria join skipped:`, String(e).slice(0, 80)); }
}

console.log(`[${SOURCE}] Pulled ${pulled.records} records over ${pulled.pages} pages (${pulled.errors} page errors); ${pulled.kept} kept after disposition/origin filters -> ${recs.length} rep/day rows`);
// When nothing survives, show the breakdown rather than leaving "0 kept" to be
// read as either a quiet day or a broken filter.
if (!pulled.kept && pulled.records) {
  const r = pulled.rej || {};
  console.log(`  dropped: ${r.activity || 0} by disposition, ${r.origin || 0} by GPS origin, ${r.user || 0} by excluded user`);
  const top = (o) => Object.entries(o || {}).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}(${v})`).join(' ');
  console.log(`  activityIds seen: ${top(pulled.sawAct)}`);
  console.log(`  config includeIds: ${INCLUDE_IDS.join(', ') || '(any)'}`);
  console.log(`  originIds seen:   ${top(pulled.sawOrigin)}`);
  console.log(`  config includeOrigins: ${INCLUDE_ORIGINS.join(', ') || '(any)'}`);
}
if (pulled.tzMismatch) {
  console.warn(`[${SOURCE}] WARNING: ${pulled.tzMismatch} events landed on a different day in ${TZ} than in Amplify's account timezone.`);
  console.warn(`  The account timezone may have changed. Dates use ${TZ} (the reps' zone); verify before trusting this run.`);
}
if (DRY) {
  // Per-day roll-up first: over a range, "which days actually have data" is the
  // question, and a raw dump of the first 8 rows cannot answer it.
  const byDay = new Map();
  for (const r of recs) {
    const e = byDay.get(r.date) || { reps: 0, doors: 0, sold: 0 };
    e.reps++; e.doors += r.doors || 0; e.sold += r.sold || 0;
    byDay.set(r.date, e);
  }
  console.log(`\n  day          reps  doors  sold`);
  for (const d of [...byDay.keys()].sort()) {
    const e = byDay.get(d);
    const dow = new Date(d + 'T12:00:00').toDateString().slice(0, 3);
    console.log(`  ${d} ${dow} ${String(e.reps).padStart(4)} ${String(e.doors).padStart(6)} ${String(e.sold).padStart(5)}`);
  }
  process.exit(0);
}
if (!recs.length) { console.log('Nothing to write.'); process.exit(0); }

const H = { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' };
// Scope deletes by source so this NEVER touches Grow's (or any other source's) rows.
const del = async (rep, date) => {
  const r = await fetch(`${SB}/rest/v1/knocking?source=eq.${encodeURIComponent(SOURCE)}&rep=eq.${encodeURIComponent(rep)}&date=eq.${date}`, { method: 'DELETE', headers: H });
  if (!r.ok && r.status !== 204) throw new Error(`delete ${rep} ${date}: ${r.status}`);
};
const prev = await snapshotKnock(SB, H, SOURCE, recs);
for (let i = 0; i < recs.length; i += 25) await Promise.all(recs.slice(i, i + 25).map((r) => del(r.rep, r.date)));
for (let i = 0; i < recs.length; i += 500) {
  const r = await fetch(`${SB}/rest/v1/knocking`, { method: 'POST', headers: H, body: JSON.stringify(recs.slice(i, i + 500)) });
  if (!r.ok) { console.error('insert failed:', r.status, (await r.text()).slice(0, 200)); process.exit(4); }
}
console.log(`✓ [${SOURCE}] Wrote ${recs.length} rep/day rows to knocking for ${FROM}${TO !== FROM ? ' .. ' + TO : ''}`);
await stampFresh(SB, H, SOURCE, prev, recs);

// Event-level rows -> knock_events, tagged with source. Upsert on Amplify event id.
const _evSeen = new Set();
const evRows = (pulled.events || []).map((e) => ({
  id: e.id, lead_id: e.lead, rep: String(pulled.names[e.uid] || e.uid).replace(/\s+/g, ' ').trim(),
  rep_id: e.uid, team_id: e.team, activity_id: e.act,
  activity: e.act === SOLD_ID ? 'Sold' : (CONTACT_IDS.indexOf(e.act) >= 0 ? 'Contact' : 'Other'),
  at: e.at, date: e.date, source: SOURCE,
})).filter((e) => e.date && e.id != null && !_evSeen.has(e.id) && _evSeen.add(e.id));
let evOk = 0;
for (let i = 0; i < evRows.length; i += 500) {
  const r = await fetch(`${SB}/rest/v1/knock_events?on_conflict=id`, {
    method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(evRows.slice(i, i + 500)),
  });
  if (r.ok) evOk += Math.min(500, evRows.length - i);
  else {
    const t = (await r.text()).slice(0, 160);
    if (r.status === 404 || /relation .* does not exist|Could not find the table/i.test(t)) {
      console.warn('knock_events table missing — run api/knock-events.sql in Supabase, then re-sync.');
      break;
    }
    console.error('knock_events insert failed:', r.status, t); process.exitCode = 5; break;
  }
}
if (evOk) console.log(`✓ [${SOURCE}] Wrote ${evOk} event rows to knock_events`);
