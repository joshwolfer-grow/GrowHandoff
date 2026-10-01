#!/usr/bin/env node
// Amplify -> lead records + full knock history, in one run (Grow account).
//
// The daily sync (scripts/amplify-knocking-sync.mjs) already crawls /Reports/Get
// and writes per-event rows to knock_events, but only for the day it runs, and
// it never pulls the LEAD side: address, current status, owner. Without that,
// knock_events is a pile of ids with no doors attached, and the CSV lead export
// can't be joined to it because the export has no id column at all.
//
// So this does two passes against the same logged-in session:
//   1. events  -> every disposition in the window, one row each
//   2. leads   -> one row per door, keyed by the same lead id
// then joins them in memory and writes a REPORT: one row per door with its real
// knock count, how many separate days it was knocked, who knocked it last, and
// when. Nothing goes to Supabase or the dashboard unless you pass --push.
//
//   node scripts/amplify-lead-crawl.mjs --login     # ONE TIME: window opens, sign in
//   node scripts/amplify-lead-crawl.mjs --probe     # discover the lead-list endpoint
//   node scripts/amplify-lead-crawl.mjs --from 2026-01-01 --to 2026-07-28
//   node scripts/amplify-lead-crawl.mjs --out ~/Downloads/knocks.csv
//   node scripts/amplify-lead-crawl.mjs --pages 20  # stop early, for timing a run
//   node scripts/amplify-lead-crawl.mjs --dry       # crawl + print, write nothing
//   node scripts/amplify-lead-crawl.mjs --push      # ALSO upsert to Supabase (opt in)
//
// The login is the shared .amplify-profile/ the Grow sync already uses, so if
// the daily sync is working this needs no new sign-in.
//
// WHY --probe EXISTS: /Reports/Get is known and stable, but Amplify's lead-list
// endpoint is not documented anywhere and the UUID API keys don't authenticate
// (see the notes in amplify-knocking-sync.mjs). --probe watches the app's own
// XHR while you open the Leads grid, keeps whatever returns lead-shaped JSON,
// and writes the winning URL + request body to data/amplify-lead-endpoint.json.
// After that the crawl replays it with the same 20-worker pool as the events.

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
const { canonicalDisplayName } = createRequire(import.meta.url)('../api/_name-aliases.js');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SB = 'https://cmkfohwbejcztctrpdnt.supabase.co';

// Two different products, two different logins.
//   amplify     = SalesScreen, the reporting layer. Has the KNOCK EVENTS
//                 (/Reports/Get: customerId + activity + timestamp) and no doors.
//   salesrabbit = the CRM itself. Has the DOORS (street, city, status, lead id).
// The knock report needs both, so each gets its own persistent profile.
const APPS = {
  amplify: { url: 'https://app.amplify.salesrabbit.com', profile: '.amplify-profile', start: '#/reports/9441' },
  salesrabbit: { url: 'https://app.salesrabbit.com', profile: '.sr-profile', start: '' },
};
const APP_NAME = (opt('--app', 'amplify') || 'amplify').toLowerCase();
if (!APPS[APP_NAME]) { console.error(`--app must be one of: ${Object.keys(APPS).join(', ')}`); process.exit(1); }
const APP = APPS[APP_NAME].url;
const PROFILE = join(ROOT, APPS[APP_NAME].profile);
const ACTIVITY_TYPE = 9441;                              // "Lead Status" (raw dispositions)
const EP_PATH = join(ROOT, 'data', `${APP_NAME}-lead-endpoint.json`);
const CONCURRENCY = 20;                                  // same depth the daily sync runs at

// Grow's disposition table (activity type 9441), so knock_events.activity lands
// as a name instead of an id. Same list the daily sync carries.
const DISPOSITIONS = {
  215337: 'New Lead',       215361: 'Not Home 1',        215389: 'Not Home 2',   215386: 'Not Home 3',
  215334: 'Not Interested', 215336: 'Call Back',         215385: 'Sold',         215695: 'Current Customer',
  215739: 'Drop In Place',  215384: 'Vacant / For Sale', 239563: 'Business',     275566: 'Hot Lead',
  215639: 'No English',     215425: 'Do Not Knock',      279409: 'Previous Customer',
};

const LOGIN = flag('--login'), PROBE = flag('--probe'), DRY = flag('--dry');
const SKIP_EVENTS = flag('--leads-only'), SKIP_LEADS = flag('--events-only');
const PAGE_CAP = Number(opt('--pages', '0')) || 0;
// Reporting is the point of this script; the Supabase upsert is opt in, so a run
// can't quietly change what the dashboard shows while you're just pulling numbers.
const PUSH = flag('--push');

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const FROM = opt('--from', iso(new Date(Date.now() - 30 * 86400000)));
const TO = opt('--to', iso(new Date()));

const OUT = opt('--out', join(ROOT, 'data', `lead-knock-report-${FROM}-to-${TO}.csv`));
// Addresses do NOT live in Amplify. Amplify is SalesScreen: a reporting layer
// over SalesRabbit whose endpoints (/Reports/Get, /Metric/GetAll, /Entity/Get)
// carry activity and users but no door records. Its events reference a door
// only by customerId. So street/city/zip have to come from a SalesRabbit lead
// export that includes the lead id column, passed here with --leads.
const LEADS_CSV = opt('--leads', '');

const ANON = PUSH ? (readFileSync(join(ROOT, 'index.html'), 'utf8').match(/eyJ[A-Za-z0-9_.-]{50,}/) || [])[0] : null;
if (PUSH && !ANON) { console.error('Could not read anon key from index.html'); process.exit(1); }

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: !(LOGIN || PROBE),
  viewport: { width: 1280, height: 900 },
});

// Capture the antiforgery token AND the request bodies the app sends. The token
// rides on /Reports/Get; the lead grid's own request is what --probe is after,
// so record every XHR and fetch rather than filtering by URL up front.
await ctx.addInitScript(() => {
  window.__srCalls = [];
  const note = (url, method, body, headers) => {
    try {
      const t = headers && (headers['__RequestVerificationToken'] || headers['__requestverificationtoken']);
      if (t) window.__srToken = t;
      // Keep the auth-ish headers verbatim. Amplify authenticates with an
      // antiforgery token, but the SalesRabbit CRM may use a bearer token held
      // in JS rather than a cookie, and a replayed request has to carry
      // whatever the app itself sent or it just 401s.
      const keep = {};
      for (const k of Object.keys(headers || {})) {
        if (/^(authorization|x-|__request)/i.test(k) && String(headers[k]).length < 4000) keep[k] = headers[k];
      }
      window.__srCalls.push({ url: String(url), method: (method || 'GET').toUpperCase(), body: typeof body === 'string' ? body.slice(0, 20000) : null, headers: keep });
      if (window.__srCalls.length > 400) window.__srCalls.shift();
    } catch (e) {}
  };
  const O = XMLHttpRequest.prototype.open, H = XMLHttpRequest.prototype.setRequestHeader, S = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...r) { this.__u = u; this.__m = m; this.__h = {}; return O.call(this, m, u, ...r); };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) { try { this.__h[k] = v; } catch (e) {} return H.call(this, k, v); };
  XMLHttpRequest.prototype.send = function (b) { note(this.__u, this.__m, b, this.__h); return S.call(this, b); };
  const F = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url);
      const h = {}; const hh = (init && init.headers) || (input && input.headers);
      if (hh && typeof hh.forEach === 'function') hh.forEach((v, k) => { h[k] = v; });
      else Object.assign(h, hh || {});
      note(url, (init && init.method) || 'GET', init && init.body, h);
    } catch (e) {}
    return F.apply(this, arguments);
  };
});

// Wait for the app to hand us its antiforgery token. Shared shape with the daily
// sync, including the OIDC redirect nudge that drops the #/reports hash.
const grabToken = async (page) => {
  let token = null;
  for (let i = 0; i < 40 && !token; i++) {
    token = await page.evaluate(() => window.__srToken || null);
    if (token) break;
    if (/signin\.salesrabbit\.com\/u\/login/i.test(page.url())) {
      console.error('LOGIN_EXPIRED. The Amplify session is gone, re-run with --login to sign in again.');
      await ctx.close(); process.exit(2);
    }
    if ((i === 4 || i === 20) && page.url().startsWith(APP) && !page.url().includes('#/reports')) {
      await page.goto(`${APP}/#/reports/${ACTIVITY_TYPE}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    }
    await page.waitForTimeout(1000);
  }
  return token;
};

// ------------------------------------------------------------------ LOGIN
if (LOGIN) {
  const page = await ctx.newPage();
  await page.goto(`${APP}/#/reports/${ACTIVITY_TYPE}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  console.log('\nA Chrome window is open. Log into Amplify, wait for the Reports page to render, then press Enter here.');
  await new Promise((r) => process.stdin.once('data', r));
  await ctx.close();
  console.log('Saved. The session lives in .amplify-profile/');
  process.exit(0);
}

// ------------------------------------------------------------------ PROBE
// Score every JSON response for "looks like a page of leads": an array of
// objects carrying an id plus address-ish fields. The winner, with the exact
// request that produced it, goes to data/amplify-lead-endpoint.json.
if (PROBE) {
  // Record EVERY JSON response with a row-ish array in it, scored but never
  // discarded. The first version only kept payloads matching a guess about
  // field names and threw the rest away, which meant a miss left nothing to
  // look at. Anything captured here can be inspected afterwards.
  const seen = new Map();
  const NOISE = /segment\.io|segment\.com|posthog|cdn\.|google|launchdarkly|sentry|intercom|fullstory|\.png|\.js|\.css|\.woff/i;
  const ADDR = /street|address|city|zip|postal|latitude|longitude|lat\b|lng|lon\b/i;
  const IDISH = /^id$|leadId|customerId|_id$/i;
  ctx.on('response', async (res) => {
    const url = res.url();
    if (NOISE.test(url)) return;
    try {
      if (!/json/i.test(res.headers()['content-type'] || '')) return;
      const txt = await res.text();
      if (txt.length < 60) return;
      const j = JSON.parse(txt);
      let best = null;
      const walk = (v, path, depth) => {
        if (depth > 6) return;
        if (Array.isArray(v)) {
          if (v.length && typeof v[0] === 'object' && v[0] && (!best || v.length > best.rows.length)) best = { rows: v, path };
          return;
        }
        if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], path ? path + '.' + k : k, depth + 1);
      };
      walk(j, '', 0);
      if (!best) return;
      // JSON:API puts every real field under `attributes`, so a row looks like
      // {id, type, attributes:{street1,...}} and scoring the top level sees
      // nothing useful. Flatten before scoring or the real lead endpoint loses
      // to whatever returns the most rows.
      const flatten = (r) => (r && typeof r === 'object' && r.attributes && typeof r.attributes === 'object')
        ? { ...r.attributes, ...r, attributes: undefined } : r;
      const keys = [...new Set(best.rows.slice(0, 5).map(flatten).flatMap((r) => Object.keys(r || {})))].filter((k) => k !== 'attributes');
      const flat = JSON.stringify(best.rows.slice(0, 3).map(flatten));
      const addrHits = keys.filter((k) => ADDR.test(k)).length + (ADDR.test(flat) ? 1 : 0);
      const hasId = keys.some((k) => IDISH.test(k));
      const key = url.split('?')[0];
      const prev = seen.get(key);
      if (!prev || best.rows.length > prev.rows) {
        seen.set(key, { url, rows: best.rows.length, arrayPath: best.path, addrHits, hasId, keys, sample: best.rows[0] });
      }
    } catch (e) {}
  });

  const page = await ctx.newPage();
  await page.goto(`${APP}/${APPS[APP_NAME].start}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

  // Node leaves stdin paused, so a bare .once('data') can sit there looking
  // like the Enter key did nothing. Resume it explicitly.
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  const ask = () => new Promise((r) => process.stdin.once('data', (d) => r(String(d).trim().toLowerCase())));

  console.log(`
A Chrome window is open on ${APP_NAME} (${APP}). It STAYS open until you type q.

  1. Go to the list of doors, wherever it lives (Leads, Territories, a saved list).
  2. Let it load, then page forward once or twice.
  3. Come back here and press Enter to see what got captured.

Press Enter as many times as you like, then q to quit and save.`);

  for (;;) {
    const answer = await ask();
    const all = [...seen.values()].sort((a, b) => (b.hasId - a.hasId) || (b.addrHits - a.addrHits) || (b.rows - a.rows));
    const likely = all.filter((c) => c.addrHits && c.hasId);

    if (!all.length) {
      console.log('\nNo JSON with rows in it yet. Click into the grid and page forward, then press Enter again.');
      if (answer === 'q') break; else continue;
    }

    console.log(`\n${all.length} JSON endpoint(s) captured${likely.length ? `, ${likely.length} look lead-shaped` : ' (none obviously lead-shaped)'}:\n`);
    for (const c of all.slice(0, 12)) {
      const tag = c.addrHits && c.hasId ? 'LIKELY ' : '       ';
      console.log(`${tag}${c.url.replace(/^https?:\/\/[^/]+/, '')}`);
      console.log(`        ${c.rows} rows at "${c.arrayPath || '(root)'}", ${c.addrHits} address-ish field(s), id: ${c.hasId ? 'yes' : 'no'}`);
      console.log(`        keys: ${c.keys.slice(0, 20).join(', ')}\n`);
    }

    if (answer !== 'q') { console.log('Keep clicking, or type q to save and quit.'); continue; }

    const calls = await page.evaluate(() => window.__srCalls || []);
    const win = likely[0] || all[0];
    const winPath = win.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const req = calls.filter((c) => c.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0] === winPath).slice(-1)[0] || null;
    writeFileSync(EP_PATH, JSON.stringify({
      // Keep the FULL url. Amplify's endpoints are same-origin so a path worked,
      // but the CRM may serve its API from another host, and a stripped origin
      // would silently retarget the crawl at the wrong server.
      url: win.url,
      method: req ? req.method : 'GET',
      body: req && req.body ? req.body : null,
      headers: req && req.headers ? req.headers : {},
      arrayPath: win.arrayPath,
      fields: win.keys,
      sample: win.sample,
      note: 'Captured by --probe. Check that `body` carries a page number before crawling; the crawl bumps whatever pagination field it finds.',
    }, null, 2));
    // Everything else, plus the recorded requests (with their auth headers), so
    // a wrong pick can be corrected without re-probing.
    writeFileSync(join(ROOT, 'data', `${APP_NAME}-probe-dump.json`), JSON.stringify({ endpoints: all, calls }, null, 2));
    console.log(`\nWrote ${EP_PATH}`);
    console.log(`Wrote ${join(ROOT, "data", `${APP_NAME}-probe-dump.json`)} (all ${all.length} endpoints + recorded requests)`);
    break;
  }
  await ctx.close();
  process.exit(0);
}

// ------------------------------------------------------------------ CRAWL
const page = await ctx.newPage();
await page.goto(`${APP}/${APPS[APP_NAME].start}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);
// Only Amplify gates its endpoints on the antiforgery token. On the CRM the
// recorded request's own headers (captured by --probe) are the credential.
const token = APP_NAME === 'amplify' ? await grabToken(page) : null;
if (APP_NAME === 'amplify' && !token) { console.error('Could not capture the Amplify request token (is the Reports page loading?).'); await ctx.close(); process.exit(3); }

// --- sample: one page, every field, nothing thrown away -----------------
// The export has no lead id column, so whether these two datasets can be lined
// up at all depends on what /Reports/Get returns per event. One request settles
// it: if the rows carry customer address or name, the join is on that. If they
// only carry customerId, the export has to be re-pulled with its id column.
if (flag('--sample')) {
  const raw = await page.evaluate(async ({ token, FROM, TO, ACTIVITY_TYPE }) => {
    const r = await fetch('/Reports/Get', {
      method: 'POST', headers: { 'Content-Type': 'application/json', '__RequestVerificationToken': token },
      body: JSON.stringify({
        activityTypeId: ACTIVITY_TYPE, period: 0, paginationGrouped: { currentPage: 1, numberOfPages: 1 },
        orderBy: 'createdDate', includeDisabledEntities: false, statusIds: [], activityIds: [], userIds: [], originIds: [],
        groupBy: 0, filterChangedWhileGrouping: false, descending: true, teamIds: [], filterChanged: false, getByMeetingDate: false,
        fromDateTimeString: FROM + ' 00:00:00', toDateTimeString: TO + ' 23:59:59',
        pagination: { numberOfPages: 1, currentPage: 1 },
      }),
    });
    return r.ok ? r.json() : { error: r.status };
  }, { token, FROM, TO, ACTIVITY_TYPE });
  await ctx.close();
  const out = join(ROOT, 'data', 'amplify-report-sample.json');
  writeFileSync(out, JSON.stringify(raw, null, 2));
  const rows = raw.reports || [];
  console.log(`\nPage 1: ${rows.length} rows, ${raw.numberOfReports} records total, ${raw.pagination && raw.pagination.numberOfPages} pages`);
  if (rows[0]) {
    const keys = [...new Set(rows.slice(0, 20).flatMap((r) => Object.keys(r)))];
    console.log(`\nEvery field on an event row:\n  ${keys.join('\n  ')}`);
    const addr = keys.filter((k) => /street|address|city|zip|postal|name|customer|lat|lng|lon/i.test(k));
    console.log(`\nJoinable-looking fields: ${addr.length ? addr.join(', ') : 'NONE beyond customerId'}`);
    console.log('\nFirst row:'); console.log(JSON.stringify(rows[0], null, 2));
  }
  console.log(`\nFull page written to ${out}`);
  process.exit(0);
}

const t0 = Date.now();
let events = [], names = {}, leads = [];

// --- pass 1: every disposition in the window, one row per event ---------
// Amplify only. The CRM has no bulk event feed, so events always come from here.
if (!SKIP_EVENTS && APP_NAME === 'amplify') {
  console.log(`Events: ${FROM} .. ${TO}`);
  const got = await page.evaluate(async ({ token, FROM, TO, ACTIVITY_TYPE, CONCURRENCY, PAGE_CAP }) => {
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
    // Unlike the daily sync this keeps EVERY event, including the bulk-intake
    // accounts it excludes. A door assigned in bulk is still history for that
    // door; filtering to "real knocks" is the reader's call, not the crawl's.
    const out = [];
    const first = await get(1);
    const total = PAGE_CAP ? Math.min(PAGE_CAP, first.pagination.numberOfPages) : first.pagination.numberOfPages;
    // Keep the named fields the report needs, plus ANY other field on the row
    // that could carry customer detail. Cherry-picking six columns is how you
    // finish a 1,750-page crawl and discover the one field that would have made
    // the join work was thrown away on page 1.
    const EXTRA = /street|address|city|zip|postal|name|customer|lat|lng|lon|phone|email/i;
    const ingest = (rows) => { for (const x of rows) {
      const e = { id: x.id, lead: x.customerId || null, uid: x.userId, team: x.teamId || null,
        act: x.activityId, at: x.utcDateTimeString, acctDate: (x.dateTimeString || '').slice(0, 10) };
      for (const k of Object.keys(x)) if (EXTRA.test(k) && x[k] != null && x[k] !== '' && !(k in e)) e[k] = x[k];
      out.push(e);
    } };
    ingest(first.reports || []);
    let next = 2, errors = 0, done = 1;
    const worker = async () => { while (next <= total) { const p = next++; try { ingest((await get(p)).reports || []); } catch (e) { errors++; } done++; } };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    const users = [...new Set(out.map((e) => e.uid))];
    const names = {}; let ui = 0;
    const nameWorker = async () => { while (ui < users.length) { const u = users[ui++];
      try { const r = await fetch('/User360/GetProfileInfo?userId=' + u, { headers: { '__RequestVerificationToken': token } }); const j = await r.json(); names[u] = (j && j.name) || u; } catch (e) { names[u] = u; }
    } };
    await Promise.all(Array.from({ length: 10 }, nameWorker));
    return { records: first.numberOfReports, pages: total, errors, events: out, names };
  }, { token, FROM, TO, ACTIVITY_TYPE, CONCURRENCY, PAGE_CAP });
  events = got.events; names = got.names;
  const secs = (Date.now() - t0) / 1000;
  console.log(`  ${got.records} records over ${got.pages} pages (${got.errors} page errors) in ${secs.toFixed(1)}s, ${(got.pages / secs).toFixed(1)} pages/sec`);
}

// --- pass 2: the lead records themselves --------------------------------
if (!SKIP_LEADS) {
  if (!existsSync(EP_PATH)) {
    console.error(`\nNo lead endpoint recorded yet. Run:  node scripts/amplify-lead-crawl.mjs --probe`);
    if (!events.length) { await ctx.close(); process.exit(5); }
    console.error('Continuing with events only.');
  } else {
    const ep = JSON.parse(readFileSync(EP_PATH, 'utf8'));
    // --probe saves its best candidate even when nothing looked lead-shaped, so
    // check the recorded sample actually has address fields before crawling it.
    // Otherwise this cheerfully pages through the user roster and reports "0 leads".
    const epFields = (ep.fields || []).join(' ');
    if (!/street|address|city|zip|postal/i.test(epFields)) {
      console.log(`Leads: skipping ${ep.url}, it has no address fields (${(ep.fields || []).slice(0, 8).join(', ')}).`);
      console.log('       Amplify has no door records. Re-probe the CRM with --app salesrabbit to get addresses.');
    } else {
    console.log(`Leads: ${ep.method} ${ep.url}`);
    const tL = Date.now();
    const got = await page.evaluate(async ({ token, ep, CONCURRENCY, PAGE_CAP }) => {
      // Bump whatever the app itself uses for a page number. Amplify's grids
      // aren't consistent about this, so try the shapes it actually ships:
      // pagination.currentPage (Reports), a top-level page/pageNumber, or a
      // skip/offset computed from the page size we saw.
      const tmpl = ep.body ? JSON.parse(ep.body) : null;
      const setPage = (obj, p) => {
        const o = JSON.parse(JSON.stringify(obj));
        if (o.pagination && typeof o.pagination === 'object') { o.pagination.currentPage = p; return o; }
        for (const k of ['currentPage', 'page', 'pageNumber', 'pageIndex']) if (k in o) { o[k] = p; return o; }
        for (const k of ['skip', 'offset']) if (k in o) { const size = o.take || o.limit || o.pageSize || 100; o[k] = (p - 1) * size; return o; }
        return o;
      };
      const urlPage = (u, p) => u.replace(/([?&](?:page|pageNumber|currentPage|pageIndex)=)\d+/i, `$1${p}`);
      const dig = (j, path) => { let v = j; for (const k of (path || '').split('.').filter(Boolean)) v = v && v[k]; return Array.isArray(v) ? v : null; };
      const get = async (p) => {
        for (let a = 0; a < 4; a++) {
          try {
            const init = { headers: { ...(ep.headers || {}), ...(token ? { '__RequestVerificationToken': token } : {}) } };
            if (ep.method !== 'GET' && tmpl) { init.method = ep.method; init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(setPage(tmpl, p)); }
            const r = await fetch(urlPage(ep.url, p), init);
            if (r.ok) return r.json();
          } catch (e) {}
          await new Promise((x) => setTimeout(x, 400 * (a + 1)));
        }
        throw new Error('lead page ' + p + ' failed');
      };
      const first = await get(1);
      const pag = first.pagination || first.Pagination || {};
      let total = pag.numberOfPages || pag.totalPages || 0;
      if (!total) {
        const count = first.totalCount || first.total || first.numberOfReports || 0;
        const size = (dig(first, ep.arrayPath) || []).length || 100;
        total = count ? Math.ceil(count / size) : 1;
      }
      if (PAGE_CAP) total = Math.min(PAGE_CAP, total);
      const rows = [...(dig(first, ep.arrayPath) || [])];
      let next = 2, errors = 0;
      const worker = async () => { while (next <= total) { const p = next++; try { rows.push(...(dig(await get(p), ep.arrayPath) || [])); } catch (e) { errors++; } } };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      return { pages: total, errors, rows };
    }, { token, ep, CONCURRENCY, PAGE_CAP });
    leads = got.rows;
    const secs = (Date.now() - tL) / 1000;
    console.log(`  ${leads.length} leads over ${got.pages} pages (${got.errors} page errors) in ${secs.toFixed(1)}s, ${(got.pages / secs).toFixed(1)} pages/sec`);
    }
  }
}
await ctx.close();

// --- shape for Supabase -------------------------------------------------
const pick = (o, ...names) => { for (const n of names) { for (const k of Object.keys(o)) if (k.toLowerCase() === n.toLowerCase() && o[k] != null && o[k] !== '') return o[k]; } return null; };
const num = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));

// Dedupe on the Amplify event id before the upsert: Postgres refuses an
// ON CONFLICT that touches the same row twice in one statement, and a paged
// crawl can hand back the same event on two pages if rows shift mid-run.
const _seenEv = new Set();
const eventRows = events.filter((e) => e.lead).map((e) => ({
  id: e.id,
  lead_id: String(e.lead),
  rep: canonicalDisplayName(names[e.uid] || e.uid),
  rep_id: e.uid,
  team_id: e.team,
  activity_id: e.act,
  activity: DISPOSITIONS[e.act] || 'Other',
  at: e.at,
  date: e.acctDate,
  source: 'grow',
})).filter((e) => e.id != null && e.date && !_seenEv.has(e.id) && _seenEv.add(e.id));

// SalesRabbit's lead endpoint speaks JSON:API: the id sits at the top level and
// everything else hangs off `attributes`. Lift them so pick() can see the fields.
const flatLead = (l) => (l && l.attributes && typeof l.attributes === 'object')
  ? { ...l.attributes, id: l.id, type: l.type } : l;
leads = leads.map(flatLead);

const _seenLead = new Set();
let leadRows = leads.map((l) => ({   // reassigned when --leads supplies addresses
  id: String(pick(l, 'id', 'leadId', 'customerId')),
  source: 'grow',
  street: pick(l, 'street1', 'street', 'address1', 'address'),
  street2: pick(l, 'street2', 'address2', 'apt', 'unit'),
  city: pick(l, 'city'),
  state: pick(l, 'state', 'stateProvince', 'region'),
  zip: pick(l, 'zip', 'postalCode', 'postal'),
  status: pick(l, 'statusName', 'status', 'dispositionName', 'disposition'),
  status_id: num(pick(l, 'statusId', 'dispositionId')),
  owner: (() => { const n = pick(l, 'ownerName', 'assignedTo', 'userName', 'repName'); return n ? canonicalDisplayName(String(n)) : null; })(),
  owner_id: pick(l, 'ownerId', 'userId', 'assignedToId'),
  lat: num(pick(l, 'latitude', 'lat')),
  lng: num(pick(l, 'longitude', 'lng', 'lon')),
  created_at: pick(l, 'createdDate', 'dateCreated', 'created', 'createdAt'),
  modified_at: pick(l, 'modifiedDate', 'dateModified', 'modified', 'updatedAt', 'lastModified'),
})).filter((r) => { const k = r.id; return k && k !== 'null' && !_seenLead.has(k) && _seenLead.add(k); });

console.log(`\n${eventRows.length} events, ${leadRows.length} leads, ${((Date.now() - t0) / 1000).toFixed(1)}s total`);

// --- addresses from a SalesRabbit export (--leads) -----------------------
// Quote-aware enough for CRM exports, which routinely carry commas and
// newlines inside note fields.
const parseCsv = (text) => {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const hdr = rows.shift() || [];
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(hdr.map((h, i) => [h.trim(), (r[i] || '').trim()])));
};
if (LEADS_CSV) {
  const csv = parseCsv(readFileSync(LEADS_CSV, 'utf8').replace(/^﻿/, ''));
  const hdr = Object.keys(csv[0] || {});
  const col = (...pats) => hdr.find((h) => pats.some((p) => new RegExp(p, 'i').test(h))) || null;
  const idCol = col('^lead ?id$', '^id$', 'customer ?id', '^lead_id$');
  if (!idCol) {
    console.error(`\n${LEADS_CSV} has no id column, so it cannot be joined to Amplify events.`);
    console.error(`Columns present: ${hdr.join(', ')}`);
    console.error('Re-export from SalesRabbit with the Lead ID column included.');
  } else {
    const c = { street: col('^street1$', '^street$', '^address'), street2: col('^street2$', 'apt', 'unit'), city: col('^city$'),
      state: col('state'), zip: col('postal', '^zip'), status: col('lead status', '^status$'), owner: col('assigned to \\(first', 'assigned'),
      ownerLast: col('assigned to \\(last'), lat: col('latitude'), lng: col('longitude') };
    leadRows = csv.map((r) => ({
      id: String(r[idCol]).trim(), source: 'grow',
      street: c.street ? r[c.street] : '', street2: c.street2 ? r[c.street2] : '', city: c.city ? r[c.city] : '',
      state: c.state ? r[c.state] : '', zip: c.zip ? r[c.zip] : '', status: c.status ? r[c.status] : '',
      status_id: null,
      owner: c.owner ? canonicalDisplayName([r[c.owner], c.ownerLast ? r[c.ownerLast] : ''].filter(Boolean).join(' ')) : '',
      owner_id: '', lat: c.lat ? Number(r[c.lat]) || null : null, lng: c.lng ? Number(r[c.lng]) || null : null,
      created_at: null, modified_at: null,
    })).filter((r) => r.id);
    console.log(`Joined ${leadRows.length} leads from ${LEADS_CSV} on "${idCol}"`);
  }
}

// --- the report ---------------------------------------------------------
// One row per door. `knocks` is a real count of dispositions, not the status
// guess you have to make from a CSV export, and `last_knock` is the actual last
// event time rather than a lastModified stamp that bulk reassignments overwrite.
// If the lead pass didn't run, this still reports per lead id, minus addresses.
const byLead = new Map();
for (const e of eventRows) {
  let g = byLead.get(e.lead_id);
  if (!g) { g = { knocks: 0, days: new Set(), reps: new Set(), first: e.at, last: e.at, lastAct: e.activity, lastRep: e.rep }; byLead.set(e.lead_id, g); }
  g.knocks++; g.days.add(e.date); g.reps.add(e.rep);
  if (e.at < g.first) g.first = e.at;
  if (e.at > g.last) { g.last = e.at; g.lastAct = e.activity; g.lastRep = e.rep; }
}
const dayOf = (s) => (s || '').slice(0, 10);
const daysAgo = (s) => (s ? Math.floor((Date.now() - Date.parse(s)) / 86400000) : '');
const base = leadRows.length ? leadRows : [...byLead.keys()].map((id) => ({ id }));
const report = base.map((l) => {
  const g = byLead.get(l.id) || { knocks: 0, days: new Set(), reps: new Set(), first: '', last: '', lastAct: '', lastRep: '' };
  return {
    lead_id: l.id, street: l.street || '', unit: l.street2 || '', city: l.city || '', state: l.state || '', zip: l.zip || '',
    current_status: l.status || '', assigned_to: l.owner || '',
    knocks: g.knocks, days_knocked: g.days.size, reps: g.reps.size,
    first_knock: dayOf(g.first), last_knock: dayOf(g.last), days_since_last_knock: daysAgo(g.last),
    // Full precision too: the CRM export's `Updated` column is the only field
    // these two systems might share, and matching it needs sub-second times.
    first_knock_at: g.first || '', last_knock_at: g.last || '',
    last_knocked_by: g.lastRep || '', last_disposition: g.lastAct || '',
    lat: l.lat == null ? '' : l.lat, lng: l.lng == null ? '' : l.lng,
  };
}).sort((a, b) => b.knocks - a.knocks || String(a.city).localeCompare(String(b.city)) || String(a.street).localeCompare(String(b.street)));

const hist = {};
for (const r of report) { const k = r.knocks >= 5 ? '5+' : String(r.knocks); hist[k] = (hist[k] || 0) + 1; }
console.log('Knocks per door: ' + ['0', '1', '2', '3', '4', '5+'].filter((k) => hist[k]).map((k) => `${k}: ${hist[k]}`).join(', '));

if (DRY) {
  console.log('\n--dry, nothing written. Sample report row:');
  if (report[0]) console.log(JSON.stringify(report[0], null, 2));
  if (leadRows.length && !leadRows[0].street) console.log('\nHeads up: no street resolved. Check `fields` in data/amplify-lead-endpoint.json against the pick() list above.');
  process.exit(0);
}

const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const cols = Object.keys(report[0] || { lead_id: '' });
writeFileSync(OUT, [cols.join(','), ...report.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n');
console.log(`\nReport: ${OUT} (${report.length} doors)`);

// --- optional: also land it in Supabase ---------------------------------
if (PUSH) {
  const H = { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' };
  const push = async (table, rows, conflict) => {
    let ok = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const r = await fetch(`${SB}/rest/v1/${table}?on_conflict=${conflict}`, { method: 'POST', headers: H, body: JSON.stringify(rows.slice(i, i + 500)) });
      if (r.ok) { ok += rows.slice(i, i + 500).length; continue; }
      const t = await r.text();
      if (r.status === 404 || /does not exist/i.test(t)) { console.warn(`${table} missing. Run api/amplify-leads.sql in Supabase, then re-run.`); return ok; }
      console.error(`${table} insert failed:`, r.status, t.slice(0, 300)); process.exitCode = 5; return ok;
    }
    return ok;
  };
  if (eventRows.length) console.log(`Wrote ${await push('knock_events', eventRows, 'id')} rows to knock_events`);
  if (leadRows.length) console.log(`Wrote ${await push('amplify_leads', leadRows, 'id')} rows to amplify_leads`);
}
