#!/usr/bin/env node
// Opendoor RTR "/Ezee Fiber/Activity_Detail" -> per-knock CSV (one row per door).
//
//   node scripts/rtr-activity-detail.mjs --probe                       # dump the parameter panel
//   node scripts/rtr-activity-detail.mjs --team "Houston Contractor Team 5" --from 9/1/2026 --to 9/7/2026
//   node scripts/rtr-activity-detail.mjs --agent "Quay Manuel" --from 9/1/2026 --to 9/7/2026
//
// Uses a COPY of the login (.rtr-profile-backfill) so it never holds the live
// profile lock that the scheduled rtr-sync ticks depend on. Headless by default.
// Export goes through the same window.open stub as rtr-sync.mjs (Chrome 152
// crashes on Playwright downloads). Output: data/_ezee-audit/<slug>_<from>_<to>.csv

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOST = 'https://rtrrealtimeportalwebappprod-reporting.azurewebsites.net';
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const PROBE = flag('--probe'), HEADED = flag('--headed');
const REPORT_PATH = opt('--report', '/Ezee Fiber/Activity_Detail');
const TEAM = opt('--team', null), AGENT = opt('--agent', null), DIVISION = opt('--division', null);
const FROM = opt('--from', null), TO = opt('--to', FROM);
const OUT_DIR = opt('--out-dir', join(ROOT, 'data', '_ezee-audit'));
const PROFILE = join(ROOT, opt('--profile', '.rtr-profile-backfill'));
const REPORT = `${HOST}/?Path=${encodeURIComponent(REPORT_PATH)}`;

const ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chrome', headless: !HEADED, viewport: { width: 1500, height: 950 } });
const page = ctx.pages()[0] || (await ctx.newPage());
const die = async (msg, code = 1) => { console.error(msg); await ctx.close(); process.exit(code); };
await page.goto(REPORT, { waitUntil: 'domcontentloaded' }).catch(() => {});
const VIEW = 'input[name$="$ctl00"][type="submit"], input[value="View Report"]';
let ready = false;
for (let i = 0; i < 60 && !ready; i++) { ready = await page.locator('input[value="View Report"]').count().then((n) => n > 0).catch(() => false); if (!ready) await page.waitForTimeout(1000); }
if (!ready) await die(`Parameter panel never appeared. Page: ${page.url()} (session expired? run rtr-sync.mjs --login and re-copy the profile)`, 3);

const settle = () => page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
const panel = async () => page.$$eval('select, input[type=text]', (els) => els.map((e) => ({
  tag: e.tagName, name: e.name, value: e.value,
  options: e.tagName === 'SELECT' ? [...e.options].map((o) => o.label.replace(/[\s\u00a0]+/g, ' ').trim()).filter(Boolean) : undefined,
  values: e.tagName === 'SELECT' ? [...e.options].filter((o) => o.label.replace(/[\s\u00a0]+/g, ' ').trim()).map((o) => o.value) : undefined,
})));
const labelOf = async (name) => page.evaluate((n) => {
  const el = document.querySelector(`[name="${n}"]`); if (!el) return null;
  const td = el.closest('td'); const prev = td && td.previousElementSibling;
  return prev ? prev.innerText.trim() : null;
}, name);

if (PROBE) {
  const p = await panel();
  for (const c of p) console.log(`${c.tag} ${c.name} label="${await labelOf(c.name)}" value="${c.value}"${c.options ? ` options(${c.options.length})=${c.options.slice(0, 40).join(' | ')}${c.options.length > 40 ? ' …' : ''}` : ''}`);
  const links = await page.$$eval('a', (as) => as.map((a) => a.innerText.trim()).filter(Boolean));
  console.log('links:', links.join(' | '));
  await ctx.close(); process.exit(0);
}
if (!FROM) await die('--from M/D/YYYY required');

// Find a dropdown by its label text (positional ids shift between reports).
const findSel = async (label) => {
  const p = await panel();
  for (const c of p) if (c.tag === 'SELECT' && (await labelOf(c.name) || '').toLowerCase().startsWith(label.toLowerCase())) return { name: c.name, options: c.options, values: c.values };
  return null;
};
const pick = async (label, value) => {
  const s = await findSel(label);
  if (!s) await die(`No dropdown labelled "${label}". Run --probe.`);
  const norm = (x) => String(x).replace(/[\s\u00a0]+/g, ' ').trim().toLowerCase();
  const idx = value === null ? s.options.findIndex((o) => /^all/i.test(o)) : s.options.findIndex((o) => norm(o) === norm(value));
  if (idx < 0) await die(`"${value}" not in ${label}: ${s.options.join(' | ')}`);
  const want = s.options[idx];
  await page.selectOption(`select[name="${s.name}"]`, { value: s.values[idx] });
  await settle();
  console.log(`  ${label} = ${want}`);
};
await pick('Division', DIVISION);
await pick('Team', TEAM);
await pick('Agent', AGENT);
const disp = await findSel('Disposition'); if (disp) await pick('Disposition', null);

const dateSel = async (label) => { const p = await panel(); for (const c of p) if (c.tag === 'INPUT' && (await labelOf(c.name) || '').toLowerCase().startsWith(label)) return `input[name="${c.name}"]`; return null; };
const S = (await dateSel('start')) || 'input[name="ctl00$MainContent$ReportViewer1$ctl08$ctl03$txtValue"]', E = (await dateSel('end')) || 'input[name="ctl00$MainContent$ReportViewer1$ctl08$ctl05$txtValue"]';
if (!S || !E) await die('Start/End date boxes not found. Run --probe.');
let held = false;
for (let a = 1; a <= 4 && !held; a++) {
  await page.fill(S, FROM); await page.fill(E, TO); await page.waitForTimeout(1200);
  held = (await page.inputValue(S)) === FROM && (await page.inputValue(E)) === TO;
}
if (!held) await die('Date boxes would not hold.');
console.log(`Rendering ${REPORT_PATH} ${FROM}..${TO} team=${TEAM || 'All'} agent=${AGENT || 'All'}…`);
await page.click('input[value="View Report"]');
const t0 = Date.now();
// The report prints no Date Range line, and the CSV link is in the toolbar even
// while the viewer is still rendering (it just throws "being updated" if used).
// So ask the ReportViewer itself whether it is loading, and only then export.
await page.waitForTimeout(2000);
const idle = await page.waitForFunction(() => { try { const rv = $find('ctl00_MainContent_ReportViewer1'); return rv && !rv.get_isLoading(); } catch (e) { return false; } }, null, { timeout: 420000 }).then(() => true).catch(() => false);
if (!idle) await die('Report still rendering after 7 minutes.', 4);
await page.waitForTimeout(1500);
let exportUrl = null;
for (let tries = 0; tries < 6 && !exportUrl; tries++) {
  if (tries) await page.waitForTimeout(5000);
  exportUrl = await page.evaluate(() => {
  let captured = null; const o = window.open;
  window.open = (u) => { captured = u; return { focus() {}, close() {} }; };
  try { $find('ctl00_MainContent_ReportViewer1').exportReport('CSV'); } finally { window.open = o; }
  return captured ? new URL(captured, location.href).href : null;
  }).catch((e) => { console.error('export attempt', tries + 1, 'failed:', e.message.split('\n')[0]); return null; });
}
if (!exportUrl) await die('Could not capture export URL', 4);
const res = await ctx.request.get(exportUrl, { timeout: 300000 }).catch(() => null);
if (!res || !res.ok()) await die(`export request ${res ? res.status() : 'failed'}`, 4);
const csv = await res.text();
await ctx.close();
mkdirSync(OUT_DIR, { recursive: true });
const slug = (AGENT || TEAM || 'all').replace(/[^A-Za-z0-9]+/g, '_');
const iso = (s) => { const m = s.match(/^(\d+)\/(\d+)\/(\d+)$/); return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; };
const file = join(OUT_DIR, `${slug}_${iso(FROM)}_${iso(TO)}.csv`);
writeFileSync(file, csv);
const lines = csv.split(/\r?\n/).filter((l) => l.trim()).length - 1;
console.log(`✓ ${lines} rows in ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${file}`);
console.log('header:', csv.split(/\r?\n/)[0]);
