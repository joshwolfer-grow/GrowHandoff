#!/usr/bin/env node
// Map the Amplify API (https://api.amplify.salesrabbit.com). Read-only GETs.
//   node --env-file=.env.local scripts/probe-amplify.mjs

const ACCOUNT = (process.env.SR_ACCOUNT_KEY || '').trim();
const SR = (process.env.SR_SALESRABBIT_KEY || '').trim();
const BASE = 'https://api.amplify.salesrabbit.com';

async function hit(path, headers) {
  try {
    const r = await fetch(BASE + path, { headers: { Accept: 'application/json', ...headers }, redirect: 'manual' });
    const body = (await r.text()).slice(0, 120).replace(/\s+/g, ' ');
    return { status: r.status, body };
  } catch (e) { return { status: 0, body: String((e && e.message) || e).slice(0, 60) }; }
}

// 1) Look for a machine-readable spec — that would hand us every route.
console.log('— Looking for an API spec —');
for (const p of ['/openapi.json', '/swagger.json', '/openapi', '/swagger', '/docs', '/api-docs', '/v1/openapi.json', '/redoc', '/.well-known/openapi.json', '/spec']) {
  const r = await hit(p, { Authorization: `Bearer ${ACCOUNT}` });
  if (r.status !== 404 && r.status !== 0) console.log(`  ${String(r.status).padEnd(4)} ${p}  ${r.body}`);
}

// 2) Probe likely resource routes, with several auth styles, to find which
//    return 200 (works) or 401 (route exists, needs different auth).
const PREFIXES = ['', '/v1', '/api', '/api/v1'];
const RESOURCES = ['/users', '/reps', '/teams', '/leaderboard', '/leaderboards', '/metrics',
  '/stats', '/statistics', '/analytics', '/activities', '/activity', '/knocks', '/dispositions',
  '/reports', '/report', '/time-track', '/timetrack', '/sessions', '/accounts', '/account', '/me',
  '/kpis', '/performance', '/scoreboard', '/goals', '/quotas'];

const AUTHS = [
  ['Bearer ACCOUNT', { Authorization: `Bearer ${ACCOUNT}` }],
  ['Bearer SR', { Authorization: `Bearer ${SR}` }],
  ['x-api-key ACCOUNT', { 'x-api-key': ACCOUNT }],
  ['pair (x-account-key+x-api-key)', { 'x-account-key': ACCOUNT, 'x-api-key': SR }],
];

console.log('\n— Probing routes (Bearer ACCOUNT) — showing anything that is not 404 —');
const interesting = [];
for (const pre of PREFIXES) {
  for (const res of RESOURCES) {
    const path = pre + res;
    const r = await hit(path, { Authorization: `Bearer ${ACCOUNT}` });
    if (r.status !== 404 && r.status !== 0) {
      console.log(`  ${String(r.status).padEnd(4)} ${path}  ${r.body}`);
      if (r.status === 401 || (r.status >= 200 && r.status < 300)) interesting.push(path);
    }
  }
}

// 3) For routes that responded (200/401), try every auth style to learn the
//    accepted scheme.
if (interesting.length) {
  console.log('\n— Auth-scheme test on responsive routes —');
  for (const path of interesting.slice(0, 5)) {
    console.log(`  ${path}`);
    for (const [label, headers] of AUTHS) {
      const r = await hit(path, headers);
      const ok = r.status >= 200 && r.status < 300;
      console.log(`     ${String(r.status).padEnd(4)} ${label}${ok ? '  ✓✓✓' : `  ${r.body}`}`);
    }
  }
} else {
  console.log('\n(no 200/401 routes found — will widen the guess list next)');
}
console.log('\nDone.');
