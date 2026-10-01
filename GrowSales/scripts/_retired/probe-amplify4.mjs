#!/usr/bin/env node
// Final route sweep of the public Amplify API host with versioned / company-scoped
// / public-style prefixes. Read-only GET. Reads keys from .env.local.
//   node --env-file=.env.local scripts/probe-amplify4.mjs

const ACCOUNT = (process.env.SR_ACCOUNT_KEY || '').trim();
const SR = (process.env.SR_SALESRABBIT_KEY || '').trim();
const COMPANY = '51870693-7912-4bc1-a13d-2e6ac69d5f81';
const BASE = 'https://api.amplify.salesrabbit.com';

const PREFIXES = ['', '/v1', '/v2', '/api', '/api/v1', '/public', '/public/v1', '/external', '/external/v1', '/integrations', `/companies/${COMPANY}`, `/company/${COMPANY}`, `/v1/companies/${COMPANY}`];
const RES = ['/reports', '/activities', '/activity', '/metrics', '/users', '/leaderboard', '/stats', '/kpis', '/data'];

async function hit(url) {
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${ACCOUNT}`, 'x-api-key': SR }, redirect: 'manual' });
    const body = (await r.text()).slice(0, 70).replace(/\s+/g, ' ');
    return { status: r.status, body };
  } catch (e) { return { status: 0, body: String((e && e.message) || e).slice(0, 40) }; }
}

console.log('Sweeping', BASE, '— showing anything not 404/000\n');
let found = 0;
for (const pre of PREFIXES) {
  for (const res of RES) {
    const path = pre + res;
    const r = await hit(BASE + path);
    if (r.status !== 404 && r.status !== 0) { console.log(`  ${String(r.status).padEnd(4)} ${path}  ${r.body}`); found++; }
  }
}
// also a few bare docs/spec endpoints with the version prefixes
for (const p of ['/v1', '/v2', '/api', '/swagger/v1/swagger.json', '/v1/swagger.json', '/$metadata', '/routes', '/endpoints']) {
  const r = await hit(BASE + p);
  if (r.status !== 404 && r.status !== 0) { console.log(`  ${String(r.status).padEnd(4)} ${p}  ${r.body}`); found++; }
}
console.log(found ? `\n${found} responsive path(s) above.` : '\nEverything 404 — no public route found by guessing.');
