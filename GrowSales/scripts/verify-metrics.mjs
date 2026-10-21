// Headless metric check: serve a given index.html (live or a .bak) against the
// live Supabase data, sign in with a stubbed corporate session, and print one
// rep's week on KPIs, the Weeks page, the weekly summary and the manager card.
//   node scripts/verify-metrics.mjs index.html "Will Gabor" 2026-10-04
//   node scripts/verify-metrics.mjs index.html ALL 2026-10-04   (every manager)
// Run it on a .bak first and on the edited file second to see what a change moves.
// The redeem_access_code RPC is answered locally, so no real code is needed.
import { chromium } from 'playwright';
import fs from 'fs';
import http from 'http';
import path from 'path';
const [,, file, REP='Will Gabor', WK='2026-10-04'] = process.argv;
const ROOT = process.env.HOME + '/Grow/GrowSales';
const HOOK = "window._grow={_v:{briaWeek:growBriaWeek,oneRepOk:growBriaOneRepOk,summary:buildWeeklySummaryReport,mgrWeek:_mgrWeekSales},";
let html = fs.readFileSync(file, 'utf8');
if (!html.includes('window._grow={')) throw new Error('hook anchor missing');
html = html.replace('window._grow={', HOOK);
const srv = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/' || u === '/index.html') { res.setHeader('content-type', 'text/html'); return res.end(html); }
  const p = path.join(ROOT, u);
  if (fs.existsSync(p) && fs.statSync(p).isFile()) { res.end(fs.readFileSync(p)); } else { res.statusCode = 404; res.end(); }
}).listen(0);
const port = srv.address().port;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext();
await ctx.addInitScript(() => { localStorage.setItem('growAccess', JSON.stringify({ code: 'verify', role: 'corporate', name: 'Verify', at: Date.now() })); });
const page = await ctx.newPage();
// Verification only: the injected code is not in access_codes, so answer the
// revalidation RPC locally instead of letting the app sign the session out.
await page.route('**/rest/v1/rpc/redeem_access_code', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ r_role: 'corporate', r_name: 'Verify', r_perms: {} }]) }));
const errs = [];
// Safety: a session the app rejects makes it reload on every load, and each load
// fires ~20 Supabase requests. That loop took the database down on Oct 14 2026
// (33k requests in five minutes). Bail out the moment the page reloads itself.
let navs = 0;
page.on('framenavigated', (f) => { if (f === page.mainFrame() && ++navs > 2) { console.error('page is reloading itself, aborting to protect Supabase'); browser.close(); srv.close(); process.exit(2); } });
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
const logs=[]; page.on('console',(m)=>logs.push(m.type()+': '+m.text().slice(0,200)));
try {
  await page.waitForFunction(() => window._grow && window._grow.data && window._grow.data().deals && window._grow.data().deals.length > 0 && window._kwBaseFor && window._kwBaseFor('week'), null, { timeout: 150000 });
} catch (e) {
  const st = await page.evaluate(() => ({ hasGrow: !!window._grow, hasV: !!(window._grow&&window._grow._v), deals: window._grow&&window._grow.data?((window._grow.data().deals||[]).length):null, kwBase: typeof window._kwBaseFor, access: JSON.stringify(window.__ACCESS), bodyText: document.body.innerText.slice(0,600) }));
  console.log('TIMEOUT state', JSON.stringify(st,null,1)); console.log('errors', errs.slice(0,8)); console.log('console', logs.slice(-25));
  await browser.close(); srv.close(); process.exit(1);
}
await page.waitForTimeout(4000);
if (REP === 'ALL') {
  const all = await page.evaluate(({ WK }) => {
    const G = window._grow, D = G.data(), V = G._v;
    const mgrs = Object.keys(D.managers_all || {}).filter((m) => m !== 'Unassigned').sort();
    return mgrs.map((m) => {
      const txt = V.summary(m, WK);
      const team = (txt.match(/TEAM\n\s+(\d+) sold.*\n\s+Install rate.*\n\s+Team PRA: ([^\s•]+)/) || []).slice(1);
      const reps = txt.split('\n').filter((l) => /^\s*\d+\. /.test(l)).map((l) => l.trim().replace(/^\d+\. /, ''));
      const mw = V.mgrWeek(m, WK, null);
      return { m, sold: team[0], pra: team[1], card: { sold: mw.teamSold, days: mw.teamDays, pra: mw.teamPra == null ? null : +mw.teamPra.toFixed(2) }, reps };
    }).filter((x) => +x.sold > 0 || x.card.sold > 0);
  }, { WK });
  console.log(JSON.stringify({ file: path.basename(file), week: WK, all }));
  await browser.close(); srv.close(); process.exit(0);
}
const out = await page.evaluate(({ REP, WK }) => {
  const G = window._grow, D = G.data(), V = G._v, Df = G.Df;
  const r = {};
  // KPIs
  const base = window._kwBaseFor('week') || [];
  const p = base.find((x) => x.wk === WK);
  const kr = p && p.reps[REP];
  r.kpis = kr ? { sales: kr.sales, praDays: kr.praDayCount, praSales: kr.praSales, pra: kr.praDayCount ? +(kr.praSales / kr.praDayCount).toFixed(2) : null } : null;
  r.kpisTeam = p ? { sales: p.sales } : null;
  // Weeks page (growBriaWeek for one rep)
  const bw = V.briaWeek(WK, V.oneRepOk(REP));
  r.weeks = { sold: bw.sold, reps: bw.reps, pra: +bw.pra.toFixed(2), days: bw.days };
  // manager of this rep that week
  let mgr = null;
  for (let i = 0; i < D.deals.length; i++) if (Df(i, 'r') === REP && Df(i, 'w') === WK) { mgr = Df(i, 'm'); break; }
  r.mgr = mgr;
  if (mgr) {
    const txt = V.summary(mgr, WK);
    r.summaryTeam = (txt.match(/TEAM\n\s+(.*)\n\s+Install rate.*\n\s+Team PRA: ([^\s•]+)/) || []).slice(1);
    r.summaryRep = (txt.split('\n').find((l) => /^\s*\d+\. /.test(l) && l.includes(REP)) || '').trim();
    const mw = V.mgrWeek(mgr, WK, null);
    r.mgrCard = { sold: mw.sold[REP] || 0, days: mw.days[REP] || 0, pra: mw.praOf(REP) };
  }
  r.briaDailyRows = (D._briaDaily || []).filter((b) => b.rep === REP && b.sale_date >= WK).length;
  r.knockRaw = (window._knockRaw || []).filter((k) => k.rep === 'Nick Boyd' || k.rep === 'Daxton Day').length;
  r.intakeDeals = D.deals.filter((d) => d[0] === 'Nick Boyd' || d[0] === 'Daxton Day').length;
  return r;
}, { REP, WK });
console.log(JSON.stringify({ file: path.basename(file), rep: REP, week: WK, ...out, pageErrors: errs.slice(0, 5) }, null, 1));
await browser.close(); srv.close();
