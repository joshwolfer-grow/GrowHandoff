#!/usr/bin/env node
// Daily SalesRabbit Amplify -> `knocking` sync.
//
// Amplify has no usable public API (the UUID keys don't authenticate anywhere),
// so this drives a real Chrome profile that stays logged into Amplify and calls
// the dashboard's own /Reports/Get endpoint, then writes the per-rep/day numbers
// into Supabase exactly like the Time Track importer does.
//
//   node scripts/amplify-knocking-sync.mjs --login    # ONE TIME: window opens, you log in
//   node scripts/amplify-knocking-sync.mjs            # daily: yesterday -> knocking
//   node scripts/amplify-knocking-sync.mjs --from 2026-06-01 --to 2026-07-17   # backfill
//   node scripts/amplify-knocking-sync.mjs --dry      # pull + print, no writes
//
// The login lives in .amplify-profile/ (gitignored). When it eventually expires
// the run exits non-zero with LOGIN_EXPIRED so launchd/you can act on it.

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
// Shared alias table, same as the second-company sync uses, so a rep's knocking
// lands under the same name their deals do — e.g. "Samantha Boyd" is "Sammi Boyd".
const { canonicalDisplayName } = createRequire(import.meta.url)('../api/_name-aliases.js');

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROFILE = join(ROOT, '.amplify-profile');
const SB = 'https://cmkfohwbejcztctrpdnt.supabase.co';
const APP = 'https://app.amplify.salesrabbit.com';
const ACTIVITY_TYPE = 9441;                 // "Lead Status" (the raw dispositions)
const CONTACT_IDS = [215334, 215336, 215385]; // Not Interested, Call Back, Sold
const SOLD_ID = 215385;

// Grow's full disposition table for activity type 9441, pulled from the account's
// own bootstrap payload (/Entity/Get). Every one of these is a tap a rep makes at
// a door — unlike the second-company account, Grow's feed carries no integration
// or CRM-status dispositions, so there is nothing here to filter out. INCLUDE_IDS
// stays empty ("count everything") and exists so a disposition can be excluded
// later without touching the aggregation code.
const DISPOSITIONS = {
  215337: 'New Lead',      215361: 'Not Home 1',       215389: 'Not Home 2',   215386: 'Not Home 3',
  215334: 'Not Interested', 215336: 'Call Back',        215385: 'Sold',         215695: 'Current Customer',
  215739: 'Drop In Place', 215384: 'Vacant / For Sale', 239563: 'Business',     275566: 'Hot Lead',
  215639: 'No English',    215425: 'Do Not Knock',      279409: 'Previous Customer',
};
const INCLUDE_IDS = [];
// Grow's account does not emit SalesRabbit's GPS origin verification: every event
// in this feed carries originId 0. The origin filter the second-company sync uses
// to drop non-GPS imports therefore has nothing to key on here, and there is no
// way to tell a door knocked in person from one dispositioned off-site.
// Intake accounts, not door reps: leads are bulk-assigned to these users and
// assigned out from there, so their events are imports/admin, not knocking.
const EXCLUDE_USERS = new Set(['39500672-ca0b-4227-afd3-912a07c31ea3']); // Nick Boyd

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const LOGIN = flag('--login'), DRY = flag('--dry');

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const y = new Date(Date.now() - 86400000);
const FROM = opt('--from', iso(y)), TO = opt('--to', opt('--from', iso(y)));

const ANON = (readFileSync(join(ROOT, 'index.html'), 'utf8').match(/eyJ[A-Za-z0-9_.-]{50,}/) || [])[0];
if (!ANON && !DRY) { console.error('Could not read anon key from index.html'); process.exit(1); }

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: !LOGIN,
  viewport: { width: 1280, height: 900 },
});
// Capture the app's antiforgery token from its own XHR — /Reports/Get requires it.
await ctx.addInitScript(() => {
  const S = XMLHttpRequest.prototype.send, O = XMLHttpRequest.prototype.open, H = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, u, ...r) { this.__u = u; this.__h = {}; return O.call(this, m, u, ...r); };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) { try { this.__h[k] = v; } catch (e) {} return H.call(this, k, v); };
  XMLHttpRequest.prototype.send = function (b) {
    if ((this.__u || '').includes('/Reports/Get')) { const t = this.__h['__RequestVerificationToken']; if (t) window.__srToken = t; }
    return S.call(this, b);
  };
});

const page = await ctx.newPage();
await page.goto(`${APP}/#/reports/${ACTIVITY_TYPE}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(LOGIN ? 1000 : 6000);

if (LOGIN) {
  console.log('\nA Chrome window is open. Log into Amplify, wait for the Reports page, then press Enter here.');
  await new Promise((r) => process.stdin.once('data', r));
}

if (/signin\.salesrabbit|auth0/i.test(page.url())) {
  console.error('LOGIN_EXPIRED — Amplify session is gone. Re-run with --login to sign in again.');
  await ctx.close(); process.exit(2);
}

// Make sure a report call fires so we capture a token. Headless loads can be
// slow, so poll up to ~40s, nudging with a reload halfway through.
let token = null;
for (let i = 0; i < 40 && !token; i++) {
  token = await page.evaluate(() => window.__srToken || null);
  if (token) break;
  if (/signin\.salesrabbit\.com\/u\/login/i.test(page.url())) {
    console.error('LOGIN_EXPIRED — Amplify session is gone. Re-run with --login to sign in again.');
    await ctx.close(); process.exit(2);
  }
  // The OIDC redirect drops the #/reports hash and lands on Home (which never
  // calls /Reports/Get). Once we're back on the app, steer to Reports again.
  if ((i === 4 || i === 20) && page.url().startsWith(APP) && !page.url().includes('#/reports')) {
    await page.goto(`${APP}/#/reports/${ACTIVITY_TYPE}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  await page.waitForTimeout(1000);
}
if (!token) { console.error('Could not capture the Amplify request token (is the Reports page loading?).'); await ctx.close(); process.exit(3); }

console.log(`Pulling Lead Status ${FROM} .. ${TO}`);
const pulled = await page.evaluate(async ({ token, FROM, TO, ACTIVITY_TYPE, EXCLUDE, INCLUDE }) => {
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
  // Raw events only. Aggregation (and the day each event belongs to) happens back
  // in Node, where each rep's market timezone is known — Amplify renders every
  // stamp in the ACCOUNT timezone (Mountain) but the reps work Central/Eastern,
  // so bucketing on the account-local date lands late knocks on the wrong day.
  const events = [];
  const ingest = (rows) => { for (const x of rows) {
    if (EXCLUDE.indexOf(x.userId) >= 0) continue;                     // bulk-intake accounts
    if (INCLUDE.length && INCLUDE.indexOf(x.activityId) < 0) continue; // not a counted disposition
    events.push({ id: x.id, lead: x.customerId || null, uid: x.userId, team: x.teamId || null,
      act: x.activityId, qty: x.quantity == null ? 1 : x.quantity,
      at: x.utcDateTimeString, acctDate: (x.dateTimeString || '').slice(0, 10) });
  } };
  const first = await get(1);
  const total = first.pagination.numberOfPages; ingest(first.reports || []);
  let next = 2, errors = 0;
  const worker = async () => { while (next <= total) { const p = next++; try { ingest((await get(p)).reports || []); } catch (e) { errors++; } } };
  await Promise.all(Array.from({ length: 20 }, worker));
  // resolve rep names
  const users = [...new Set(events.map((e) => e.uid))];
  const names = {}; let ui = 0;
  const nameWorker = async () => { while (ui < users.length) { const u = users[ui++];
    try { const r = await fetch('/User360/GetProfileInfo?userId=' + u, { headers: { '__RequestVerificationToken': token } }); const j = await r.json(); names[u] = (j && j.name) || u; } catch (e) { names[u] = u; }
  } };
  await Promise.all(Array.from({ length: 10 }, nameWorker));
  return { records: first.numberOfReports, pages: total, errors, names, events };
}, { token, FROM, TO, ACTIVITY_TYPE, EXCLUDE: [...EXCLUDE_USERS], INCLUDE: INCLUDE_IDS });
await ctx.close();

// --- Per-rep timezone from where they actually sell (deals table states) ---
// Amplify renders every event in the ACCOUNT timezone (Mountain), but reps work
// in many markets — and "Grow Marketing" is an umbrella team, so the market has
// to come from each rep's own recent deals, not their Amplify team.
const STATE_TZ = {
  UT: 'America/Denver', CO: 'America/Denver', NM: 'America/Denver', WY: 'America/Denver', MT: 'America/Denver', ID: 'America/Boise',
  AZ: 'America/Phoenix',
  IL: 'America/Chicago', TX: 'America/Chicago', OK: 'America/Chicago', KS: 'America/Chicago', MO: 'America/Chicago',
  WI: 'America/Chicago', MN: 'America/Chicago', IA: 'America/Chicago', NE: 'America/Chicago', SD: 'America/Chicago',
  ND: 'America/Chicago', AR: 'America/Chicago', LA: 'America/Chicago', MS: 'America/Chicago', AL: 'America/Chicago', TN: 'America/Chicago',
  IN: 'America/Indiana/Indianapolis', MI: 'America/Detroit',
  OH: 'America/New_York', KY: 'America/New_York', GA: 'America/New_York', FL: 'America/New_York', SC: 'America/New_York',
  NC: 'America/New_York', VA: 'America/New_York', WV: 'America/New_York', PA: 'America/New_York', NY: 'America/New_York',
  NJ: 'America/New_York', MD: 'America/New_York', DE: 'America/New_York', CT: 'America/New_York', RI: 'America/New_York',
  MA: 'America/New_York', VT: 'America/New_York', NH: 'America/New_York', ME: 'America/New_York',
  NV: 'America/Los_Angeles', CA: 'America/Los_Angeles', OR: 'America/Los_Angeles', WA: 'America/Los_Angeles',
};
const DEFAULT_TZ = 'America/Denver';
const nrmName = (s) => { const t = String(s || '').replace(/\s+/g, ' ').trim().toLowerCase().split(' '); return t.length > 1 ? t[0] + ' ' + t[t.length - 1] : (t[0] || ''); };
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const repStates = new Map();   // normrep -> [{d, st}]
try {
  const dr = await fetch(`${SB}/rest/v1/deals?select=rep,sale_date,state&sale_date=gte.${addDays(FROM, -45)}&sale_date=lte.${addDays(TO, 45)}&limit=100000`,
    { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } });
  if (dr.ok) for (const d of await dr.json()) {
    const st = String(d.state || '').trim().toUpperCase();
    if (!d.sale_date || !STATE_TZ[st]) continue;
    const k = nrmName(d.rep); if (!repStates.has(k)) repStates.set(k, []);
    repStates.get(k).push({ d: d.sale_date, st });
  }
} catch (e) { console.warn('deals-state fetch skipped:', String(e).slice(0, 60)); }
const zoneFor = (rep, date) => {
  const list = repStates.get(nrmName(rep));
  if (!list || !list.length) return DEFAULT_TZ;
  let best = null, bestGap = 1e9;
  const t = new Date(date + 'T12:00:00Z').getTime();
  for (const x of list) { const g = Math.abs(new Date(x.d + 'T12:00:00Z').getTime() - t); if (g < bestGap) { bestGap = g; best = x.st; } }
  return bestGap <= 60 * 86400000 ? (STATE_TZ[best] || DEFAULT_TZ) : DEFAULT_TZ;
};
const fmtZ = (iso, zone) => { if (!iso) return null; try { return new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso)); } catch (e) { return null; } };

// Amplify hands back names inconsistently ("erin rust", "Josh  Wolfer"), and a
// few reps carry a different name in comp than in SalesRabbit. Normalise once,
// here, so knocking joins cleanly to deals/Bria.
const titleCase = (s) => String(s || '').replace(/\s+/g, ' ').trim()
  .replace(/(^|[\s'-])([a-z])/g, (m, p, c) => p + c.toUpperCase());
const repNameOf = (uid) => canonicalDisplayName(titleCase(pulled.names[uid] || uid));

// Bucket every event into the day it happened in the REP'S market, not the
// account's. The rep's market comes from their own recent deals, so resolve the
// zone off the account-local date first, then re-date the event inside it.
const dateFmt = new Map();
const dateIn = (utcIso, zone) => {
  if (!dateFmt.has(zone)) dateFmt.set(zone, new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }));
  try { return dateFmt.get(zone).format(new Date(utcIso)); } catch (e) { return ''; }
};

const zoneCounts = {};
const agg = new Map();   // rep|date -> tallies
let tzShift = 0;
for (const ev of pulled.events) {
  const rep = repNameOf(ev.uid);
  if (!rep) continue;
  const zone = zoneFor(rep, ev.acctDate || FROM);
  const date = dateIn(ev.at, zone) || ev.acctDate;
  if (!date) continue;
  if (date !== ev.acctDate) tzShift++;
  const k = rep + '|' + date;
  let e = agg.get(k);
  if (!e) { e = { rep, date, zone, doors: 0, leads: new Set(), contactLeads: new Set(), soldLeads: new Set(), minU: null, maxU: null }; agg.set(k, e); zoneCounts[zone] = (zoneCounts[zone] || 0) + 1; }
  e.doors += ev.qty;
  // contacts/sold count DISTINCT doors, not events — a lead double-tapped as
  // Sold twice within seconds is one sale, not two.
  const leadKey = ev.lead || ('evt' + ev.id);
  if (CONTACT_IDS.indexOf(ev.act) >= 0) e.contactLeads.add(leadKey);
  if (ev.act === SOLD_ID) e.soldLeads.add(leadKey);
  if (ev.lead) e.leads.add(ev.lead);
  if (!e.minU || ev.at < e.minU) e.minU = ev.at;
  if (!e.maxU || ev.at > e.maxU) e.maxU = ev.at;
}
const recs = [...agg.values()].map((e) => ({
  rep: e.rep, date: e.date, doors: e.doors, unique_doors: e.leads.size,
  contacts: e.contactLeads.size, sold: e.soldLeads.size,
  first_disp: fmtZ(e.minU, e.zone), last_disp: fmtZ(e.maxU, e.zone),
  hours: +(Math.max(0, (new Date(e.maxU) - new Date(e.minU)) / 3600000).toFixed(2)),
}));
console.log('Rep/day rows by market timezone:', JSON.stringify(zoneCounts));
if (tzShift) console.log(`${tzShift} events re-dated into the rep's market day (Amplify renders Mountain).`);

// --- SOLD comes from Bria (booked deals), NOT the Amplify pin ---
// Reps use SalesRabbit's "Sold" disposition inconsistently, so pins don't match
// reality; Bria is the comp system of record (verified: pins 9% match Bria,
// Bria/Pronto ~90%+). Doors/unique/contacts/hours stay from Amplify. Scoped to
// the reps in THIS pull so the ezee/Bluepeak rows in the table are never touched.
const nrm = (s) => { const t = String(s || '').replace(/\s+/g, ' ').trim().toLowerCase().split(' '); return t.length > 1 ? t[0] + ' ' + t[t.length - 1] : (t[0] || ''); };
try {
  const bres = await fetch(`${SB}/rest/v1/bria_sales_daily?select=rep,sale_date,deals&sale_date=gte.${FROM}&sale_date=lte.${TO}&limit=100000`, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } });
  if (bres.ok) {
    const bria = await bres.json();
    const briaBy = new Map();   // "normrep|date" -> deals
    for (const b of bria) { const k = nrm(b.rep) + '|' + b.sale_date; briaBy.set(k, (briaBy.get(k) || 0) + (b.deals || 0)); }
    const ampReps = new Set(recs.map((r) => nrm(r.rep)));
    const nameOf = new Map(recs.map((r) => [nrm(r.rep), r.rep]));   // canonical display name from Amplify
    const have = new Set(recs.map((r) => nrm(r.rep) + '|' + r.date));
    for (const r of recs) r.sold = briaBy.get(nrm(r.rep) + '|' + r.date) || 0;   // overwrite pins with Bria
    for (const [key, deals] of briaBy) {   // Bria deals on days a rep didn't knock -> doors=0 row
      const [nr, date] = key.split('|');
      if (deals > 0 && ampReps.has(nr) && !have.has(key)) recs.push({ rep: nameOf.get(nr), date, doors: 0, unique_doors: 0, contacts: 0, sold: deals, first_disp: null, last_disp: null, hours: 0 });
    }
    console.log(`Sold sourced from Bria (${bria.length} bria rows in range)`);
  } else console.warn(`Bria fetch failed (${bres.status}) — keeping Amplify sold this run`);
} catch (e) { console.warn('Bria join skipped:', String(e).slice(0, 80)); }

console.log(`Pulled ${pulled.records} records over ${pulled.pages} pages (${pulled.errors} page errors) -> ${recs.length} rep/day rows`);
if (DRY) { console.log(JSON.stringify(recs.slice(0, 5), null, 2)); process.exit(0); }
if (!recs.length) { console.log('Nothing to write.'); process.exit(0); }

const H = { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' };
const del = async (rep, date) => {
  // source=eq.grow so re-syncs only clear Grow's rows, never a second company's
  // (see scripts/amplify-company-sync.mjs). Grow rows default to source 'grow'.
  const r = await fetch(`${SB}/rest/v1/knocking?source=eq.grow&rep=eq.${encodeURIComponent(rep)}&date=eq.${date}`, { method: 'DELETE', headers: H });
  if (!r.ok && r.status !== 204) throw new Error(`delete ${rep} ${date}: ${r.status}`);
};
for (let i = 0; i < recs.length; i += 25) await Promise.all(recs.slice(i, i + 25).map((r) => del(r.rep, r.date)));
for (let i = 0; i < recs.length; i += 500) {
  const r = await fetch(`${SB}/rest/v1/knocking`, { method: 'POST', headers: H, body: JSON.stringify(recs.slice(i, i + 500)) });
  if (!r.ok) { console.error('insert failed:', r.status, (await r.text()).slice(0, 200)); process.exit(4); }
}
console.log(`✓ Wrote ${recs.length} rep/day rows to knocking for ${FROM}${TO !== FROM ? ' .. ' + TO : ''}`);

// Event-level rows -> knock_events (revisit tracking). Upsert on the Amplify
// event id so re-syncs are idempotent. Table created by api/knock-events.sql.
const _evSeen = new Set();
const evRows = (pulled.events || []).map((e) => {
  const rep = repNameOf(e.uid);
  const zone = zoneFor(rep, e.acctDate || FROM);
  return {
    id: e.id, lead_id: e.lead, rep, rep_id: e.uid, team_id: e.team, activity_id: e.act,
    // Real disposition name, not 'Contact'/'Other' — the whole table is here now.
    activity: DISPOSITIONS[e.act] || 'Other',
    at: e.at, date: dateIn(e.at, zone) || e.acctDate,
  };
}).filter((e) => e.date && e.id != null && !_evSeen.has(e.id) && _evSeen.add(e.id));
// ^ drop duplicate event ids — Amplify occasionally returns the same row on
//   two pages, and Postgres upsert rejects dupes within one INSERT command.
// A failing chunk used to `break`, so one bad batch silently truncated the whole
// event feed while the daily summary above still reported success — knock_events
// went a week without a row before anyone noticed. Now every chunk is attempted,
// retried, and any shortfall is reported loudly at the end.
let evOk = 0, evFailed = 0, evErr = null, evMissing = false;
for (let i = 0; i < evRows.length; i += 500) {
  const chunk = evRows.slice(i, i + 500);
  let ok = false;
  for (let a = 0; a < 3 && !ok; a++) {
    const r = await fetch(`${SB}/rest/v1/knock_events?on_conflict=id`, {
      method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(chunk),
    });
    if (r.ok) { ok = true; break; }
    const t = (await r.text()).slice(0, 200);
    if (r.status === 404 || /relation .* does not exist|Could not find the table/i.test(t)) { evMissing = true; break; }
    evErr = `${r.status} ${t}`;
    await new Promise((x) => setTimeout(x, 500 * (a + 1)));
  }
  if (ok) evOk += chunk.length; else { evFailed += chunk.length; if (evMissing) break; }
}
if (evMissing) {
  console.error('knock_events table missing — run api/knock-events.sql in Supabase, then re-sync.');
  process.exitCode = 5;
} else if (evFailed) {
  console.error(`knock_events INCOMPLETE: ${evOk} written, ${evFailed} FAILED. Last error: ${evErr}`);
  process.exitCode = 5;
} else if (evOk) {
  console.log(`✓ Wrote ${evOk} event rows to knock_events`);
}
