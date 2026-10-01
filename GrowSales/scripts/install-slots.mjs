#!/usr/bin/env node
// Earliest install availability, read from each ISP's own signup flow.
//
//   node scripts/install-slots.mjs --isp tds            # every probe door for TDS
//   node scripts/install-slots.mjs --isp tds --headed   # watch it
//   node scripts/install-slots.mjs --isp tds --dry      # print, write nothing
//   node scripts/install-slots.mjs                      # every ISP with an adapter
//   node scripts/install-slots.mjs --login --isp surf   # ONE TIME per login ISP: sign in, close the window
//
// Each ISP gets an adapter that walks the flow a rep uses, for a real serviceable
// door in each market (data/install-slot-probes.json), up to the install calendar,
// reads it and closes the browser. It NEVER submits an order, saves a draft or
// books a slot: the only thing any adapter clicks after the calendar is nothing.
// Meant for 2 or 3 runs a day, not a poll.
//
// Output: one row per market per run appended to data/install-slots.jsonl, and
// the same row to Supabase `install_slots` (api/install-slots.sql) unless --dry.

import { chromium } from 'playwright';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SB = 'https://cmkfohwbejcztctrpdnt.supabase.co';
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DRY = flag('--dry'), HEADED = flag('--headed');
const ONLY = opt('--isp', '').toLowerCase();
const MARKET = opt('--market', '').toLowerCase();

const PROBES = JSON.parse(readFileSync(join(ROOT, 'data/install-slot-probes.json'), 'utf8'));
const indexPath = join(ROOT, 'index.html');
const ANON = existsSync(indexPath) ? (readFileSync(indexPath, 'utf8').match(/eyJ[A-Za-z0-9_.-]{50,}/) || [])[0] : null;

const step = (s) => { if (process.env.DEBUG) console.log(`  . ${s}`); };
// Per-ISP credentials the portals need on EVERY visit (Surf's User ID + PIN).
// KEY=value lines in .env.install-slots at the repo root; keep it out of git.
const SECRETS = (() => {
  const f = join(ROOT, '.env.install-slots');
  if (!existsSync(f)) return {};
  return Object.fromEntries(readFileSync(f, 'utf8').split('\n').map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]));
})();
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5);

// ---------------------------------------------------------------------------
// TDS: public D2D offer portal, no login. The checkout page fetches the earliest
// day and the 14-day slot grid BEFORE any customer field is filled in, so this
// types nothing but the address. The cart lives only in this browser context.
// ---------------------------------------------------------------------------
async function tds(page, { address }) {
  await page.goto('https://tdstelecom.com/offers/d2d/offer-portal.html', { waitUntil: 'domcontentloaded' });
  await page.locator('#onetrust-reject-all-handler').click({ timeout: 5000 }).catch(() => {});
  const box = page.getByRole('textbox', { name: 'Address', exact: true });
  await box.click();
  await box.pressSequentially(address, { delay: 25 });
  // The autocomplete returns TDS's own spelling (all caps, no zip). Take the first.
  const street = address.split(',')[0].trim().toUpperCase();
  const sug = page.locator(`text=${street}`).filter({ hasNotText: ',' }).first();
  await sug.waitFor({ timeout: 15000 });
  await sug.click();
  await page.getByRole('button', { name: /Submit/ }).first().click();
  // A door that already has TDS lands on "Existing Service Found" instead of the
  // plans, and the only way on is "I am moving here", which is a different flow.
  // Say so, so the fix (pick a non-customer door) is obvious from the log.
  const landed = await Promise.race([
    page.waitForURL(/best-deals/, { timeout: 60000 }).then(() => 'plans'),
    page.getByText('Existing Service Found').waitFor({ timeout: 60000 }).then(() => 'existing'),
  ]);
  if (landed === 'existing') throw new Error('probe door is already a TDS customer - pick another door in data/install-slot-probes.json');
  step('plans');

  const pkg = page.locator('text=Customize Package').locator('visible=true').first();
  await pkg.click({ timeout: 30000 });
  await page.getByRole('button', { name: 'Add to Cart' }).click({ timeout: 30000 });
  await page.waitForURL(/cart/i, { timeout: 60000 });
  step('cart');
  // The cart page POSTs serviceappointments/stub on load behind a "One moment"
  // overlay that swallows clicks; Begin Checkout only works once it lifts.
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => !document.body.classList.contains('loading'), null, { timeout: 150000 });

  // Begin Checkout first POSTs serviceappointments/stub, which can take 30-60s,
  // and only then asks for the earliest day and fills the From/To pickers. Search
  // Dates before that sends empty dates, so wait for the pickers to be filled.
  const earliestP = page.waitForResponse(/serviceappointments\/earliestday/, { timeout: 150000 }).catch((e) => e);
  await page.getByRole('button', { name: 'Begin Checkout' }).click();
  step('checkout');
  const er = await earliestP;
  if (er instanceof Error) throw er;
  const earliest = await er.json().catch(() => ({}));
  await page.waitForFunction(() => document.querySelector('#installDate')?.value && document.querySelector('#installEndDate')?.value && !document.body.classList.contains('loading'), null, { timeout: 60000 });

  step('dates filled');
  const schedP = page.waitForResponse((r) => /serviceappointments\/schedule/.test(r.url()) && r.request().method() === 'POST', { timeout: 90000 }).catch((e) => e);
  await page.getByRole('button', { name: 'Search Dates' }).click({ timeout: 30000 });
  const sr = await schedP;
  if (sr instanceof Error) throw sr;
  const sched = await sr.json();
  const byDate = sched.scheduleByDate || {};
  // A window with score 0 is shown but greyed out; count only bookable ones.
  const days = Object.entries(byDate)
    .map(([date, v]) => ({ date, windows: (v.windows || []).filter((w) => w.score > 0).length }))
    .filter((d) => d.windows > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  return { earliest_offered: earliest.date ? earliest.date.slice(0, 10) : null, days };
}

// ---------------------------------------------------------------------------
// Surf: the rep portal is a Retool app. After an address search it loads the
// install calendar (query MBSAppointmentOptions) straight away, before any
// subscriber field, so again nothing but the address is typed. Needs a signed-in
// profile: node scripts/install-slots.mjs --login --isp surf
// ---------------------------------------------------------------------------
const SURF_URL = 'https://surf.retool.com/embedded/public/32ac3632-880e-43dd-addf-9012e3bda175';
async function surf(page, { address }) {
  await page.goto(SURF_URL, { waitUntil: 'domcontentloaded' });
  // The portal keeps no session: every load opens on "User Lookup" (User ID + PIN),
  // held in page state, not a cookie. So the rep's own ID and PIN are read from
  // .env.install-slots (never committed, never typed by anyone but this script).
  const box = page.getByPlaceholder('Best Address');
  const lookup = page.getByText('User Lookup');
  const first = await Promise.race([
    box.waitFor({ timeout: 45000 }).then(() => 'app'),
    lookup.waitFor({ timeout: 45000 }).then(() => 'lookup'),
  ]).catch(() => 'none');
  if (first !== 'app') {
    if (!SECRETS.SURF_USER_ID || !SECRETS.SURF_PIN) throw new Error('Surf asks for User ID + PIN on every visit. Add SURF_USER_ID and SURF_PIN to .env.install-slots');
    const inputs = page.getByPlaceholder('Enter value');
    await inputs.nth(0).fill(SECRETS.SURF_USER_ID);
    await inputs.nth(1).fill(SECRETS.SURF_PIN);
    await page.getByRole('button', { name: 'Lookup User' }).click();
    try { await box.waitFor({ timeout: 45000 }); } catch { throw new Error('Surf User ID / PIN in .env.install-slots were not accepted'); }
  }
  await box.fill(address);
  await page.waitForTimeout(1500);   // the formatted-address field updates on a debounce
  const optsP = page.waitForResponse(/queryName=MBSAppointmentOptions/, { timeout: 90000 }).catch((e) => e);
  // The address card's Search is the one right under the Best Address box, not the Hubspot one.
  await page.getByRole('button', { name: 'Search', exact: true }).last().click();
  const r = await optsP;
  if (r instanceof Error) throw r;
  const body = await r.json();
  const data = body.dates ? body : (body.data || body);
  if (!Array.isArray(data.dates)) throw new Error(`no calendar for this address: ${JSON.stringify(body).slice(0, 200)}`);
  const days = data.dates
    .map((d) => ({ date: d.date, windows: (d.times || []).length }))
    .filter((d) => d.windows > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  return { earliest_offered: days[0]?.date || null, days };
}

class LoginNeeded extends Error { constructor(isp) { super(`${isp} session expired - run: node scripts/install-slots.mjs --login --isp ${isp}`); this.isp = isp; } }

// profile: a persistent Chrome profile for ISPs behind a login; home: where --login opens.
const ADAPTERS = {
  tds: { run: tds },
  surf: { run: surf },   // no profile: the portal keeps no session, see SECRETS
};

// ---------------------------------------------------------------------------

async function pushRows(rows) {
  if (DRY || !ANON || !rows.length) return;
  const r = await fetch(`${SB}/rest/v1/install_slots`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!r.ok) console.error(`Supabase write failed ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

const isps = Object.keys(ADAPTERS).filter((k) => !ONLY || k === ONLY);
if (!isps.length) { console.error(`No adapter for "${ONLY}". Have: ${Object.keys(ADAPTERS).join(', ')}`); process.exit(1); }

const today = ymd(new Date());
const rows = [];
let failures = 0, loginFailure = false;

if (flag('--login')) {
  const a = ADAPTERS[ONLY];
  if (!a?.profile) { console.error(`--login needs --isp with a login (${Object.keys(ADAPTERS).filter((k) => ADAPTERS[k].profile).join(', ')})`); process.exit(1); }
  const ctx = await chromium.launchPersistentContext(join(ROOT, a.profile), { channel: 'chrome', headless: false, viewport: { width: 1280, height: 900 } });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(a.home);
  console.log(`Sign in to ${ONLY} in the window, then close it.`);
  await new Promise((res) => ctx.on('close', res));
  process.exit(0);
}

let browser;
for (const isp of isps) {
  const a = ADAPTERS[isp];
  // Login ISPs share one persistent context across their doors (the session lives
  // there); public ones get a fresh context per attempt so no cart carries over.
  const shared = a.profile ? await chromium.launchPersistentContext(join(ROOT, a.profile), { channel: 'chrome', headless: !HEADED, viewport: { width: 1280, height: 900 } }) : null;
  if (!shared && !browser) browser = await chromium.launch({ channel: 'chrome', headless: !HEADED });
  for (const probe of (PROBES[isp] || []).filter((p) => !MARKET || p.market.toLowerCase() === MARKET)) {
    // TDS's AEM server throws a bare 500 now and then (their own guide says to
    // clear cookies and retry), so each door gets up to 3 attempts.
    let ctx, page, res, lastErr;
    const t0 = Date.now();
    for (let attempt = 1; attempt <= 3 && !res; attempt++) {
      if (page && shared) await page.close().catch(() => {});
      if (ctx && !shared) await ctx.close();
      if (!shared) ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      page = await (shared || ctx).newPage();
      try { res = await a.run(page, probe); } catch (e) { lastErr = e; step(`attempt ${attempt} failed: ${String(e.message || e).split('\n')[0]}`); if (e instanceof LoginNeeded) break; }
    }
    try {
      if (!res) throw lastErr;
      const first = res.days[0];
      const wk = res.days.filter((d) => daysBetween(today, d.date) <= 7);
      const row = {
        isp, market: probe.market, address: probe.address, checked_at: new Date().toISOString(),
        earliest_date: first ? first.date : res.earliest_offered,
        days_out: first ? daysBetween(today, first.date) : null,
        windows_first_day: first ? first.windows : 0,
        windows_next_7d: wk.reduce((s, d) => s + d.windows, 0),
        grid: res.days, ok: true, error: null,
      };
      rows.push(row);
      console.log(`${isp.padEnd(8)} ${probe.market.padEnd(16)} earliest ${row.earliest_date} (${row.days_out}d out)  ${row.windows_first_day} windows that day, ${row.windows_next_7d} in 7 days  [${((Date.now() - t0) / 1000).toFixed(0)}s]`);
    } catch (e) {
      failures++;
      if (e instanceof LoginNeeded) loginFailure = true;
      const shot = join(ROOT, `imports/done/install-slots-${isp}-${probe.market.replace(/\W+/g, '_')}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      rows.push({ isp, market: probe.market, address: probe.address, checked_at: new Date().toISOString(), ok: false, error: String(e.message || e).slice(0, 300) });
      console.error(`${isp.padEnd(8)} ${probe.market.padEnd(16)} FAILED: ${String(e.message || e).split('\n')[0]}  (screenshot ${shot})`);
    } finally {
      if (shared) await page.close().catch(() => {}); else await ctx.close().catch(() => {});
    }
    if (loginFailure && a.profile) break;   // every other door for this ISP will fail the same way
  }
  if (shared) await shared.close();
}
if (browser) await browser.close();

if (!DRY) {
  appendFileSync(join(ROOT, 'data/install-slots.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  await pushRows(rows);
}
process.exit(loginFailure ? 3 : failures && failures === rows.length ? 1 : 0);
