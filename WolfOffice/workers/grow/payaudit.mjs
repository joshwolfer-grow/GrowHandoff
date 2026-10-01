#!/usr/bin/env node
// Pay Auditor: every Thursday before payroll, reruns the upfront pay math and
// lists adjustments both ways.
//
// The math is NOT copied here. This drives the real dashboard in headless Chrome
// (same pattern as GrowSales/scripts/daily-report-text.mjs) and calls its own
// computePayrun / _ufPaidState, so there is one definition of what a rep is owed.
// Signs in with GROW_ACCESS_CODE from ~/Grow/RepText/.env.
//
// The pay functions sit in a nested scope inside the page, so they cannot be
// called from outside. On load, the HTML is patched IN THIS BROWSER ONLY to hang
// them off window._grow.upfront. Nothing on Vercel or on disk changes, and the
// math that runs is exactly the deployed math.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeSnapshot, latestSnapshot, today } from '../../lib/db.mjs';
import { buildAudit, statusLine } from './payaudit.logic.mjs';

const HOME = os.homedir();
const G = path.join(HOME, 'Grow', 'GrowSales');
const { chromium } = createRequire(path.join(G, 'package.json'))('playwright');
const PROFILE = path.join(HOME, '.grow-payaudit-profile');
const APP_URL = process.env.GROW_APP_URL || 'https://growsales.vercel.app/';
const WEEKS = 8;

function accessCode() {
  try {
    for (const line of fs.readFileSync(path.join(HOME, 'Grow/RepText/.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*GROW_ACCESS_CODE\s*=\s*(.*)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return process.env.GROW_ACCESS_CODE || '';
}

async function pullFromDashboard() {
  const code = accessCode();
  if (!code) throw new Error('no GROW_ACCESS_CODE in ~/Grow/RepText/.env');
  const ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chrome', headless: true, viewport: { width: 1280, height: 900 } });
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    page.setDefaultTimeout(60000);
    const origin = new URL(APP_URL).origin;
    const anchor = 'window._grow={';
    const expose = anchor + 'upfront:function(){return {computeUpfront:computeUpfront,computePayrun:computePayrun,loadPaid:_ufLoadPaidRuns,optin:function(){return UPFRONT_OPTIN;},perDeal:UPFRONT_PER_DEAL,auditThru:UF_AUDIT_THRU};},';
    await page.route((u) => u.origin === origin && (u.pathname === '/' || u.pathname.endsWith('/index.html')), async (route) => {
      const res = await route.fetch();
      const body = (await res.text()).replace(anchor, expose);
      const headers = { ...res.headers() }; delete headers['content-length']; delete headers['content-encoding'];
      await route.fulfill({ status: res.status(), headers, body });
    });
    await page.goto(APP_URL + '?code=' + encodeURIComponent(code), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window._grow && window._grow.data && window._grow.data() && window._grow.data().deals && window._grow.data().deals.length && window._grow.data()._briaDeals && window._grow.data()._briaDeals.length), null, { timeout: 120000 })
      .catch(() => { throw new Error('signed in but deal data did not load; is the access code corporate?'); });
    const exposed = await page.evaluate(() => typeof (window._grow && window._grow.upfront) === 'function');
    if (!exposed) throw new Error('could not reach the pay functions: the dashboard no longer has the window._grow anchor; update workers/grow/payaudit.mjs');
    // The roster comes from the synced sheet; synced entries carry a periods array.
    const rosterSynced = await page.waitForFunction(() => { const o = window._grow.upfront().optin(); return Array.isArray(o) && o.some(x => Array.isArray(x.periods)); }, null, { timeout: 30000 }).then(() => true).catch(() => false);
    return await page.evaluate(async (n) => {
      const U = window._grow.upfront();
      await U.loadPaid();
      window._ufData = null;
      const u = U.computeUpfront();
      window._ufData = u;
      const weeks = [];
      for (let wi = 0; wi < n; wi++) {
        const pr = U.computePayrun(wi);
        weeks.push({ wi, start: pr.payWin.start, end: pr.payWin.end, recStart: pr.recWin.start,
          rows: pr.rows.map(r => ({ rep: r.rep, st: r.st, on: r.on, rate: r.rate, fin: r.fin, payCount: r.payCount, pay: r.pay, claw: r.claw, net: r.net, cb: r.cb ? r.cb.amount : 0, cbNew: !!r.cbNew, rFall: r.rFall, gap: r.gap, auditSettled: !!r.auditSettled })) });
      }
      const paid = {};
      for (const k in window._ufPaidRows) { const r = window._ufPaidRows[k]; paid[k] = { amount: r.amount, paid: !!r.paid, deals: r.deals, clawback: r.clawback, status: r.status }; }
      return { weeks, runs: window._ufRuns || {}, paid, perDeal: U.perDeal, auditThru: U.auditThru, tiers: u ? { on: u.on, warn: u.warn, off: u.off, teamRate: u.teamRate } : null };
    }, WEEKS).then(d => ({ ...d, rosterSynced }));
  } finally {
    await ctx.close();
  }
}

async function main() {
  const data = await pullFromDashboard();
  const prev = await latestSnapshot('payaudit', today());
  const audit = buildAudit(data, prev ? { ...prev.data, day: prev.day } : null);
  await writeSnapshot('payaudit', today(), audit);
  console.log(statusLine(audit));
}

main().catch((err) => {
  console.log(`error: ${err.message}`);
  process.exit(1);
});
