#!/usr/bin/env node
// Host discovery: find which host actually recognizes the Amplify UUID keys.
// GET only, read-only. Reads keys from .env.local.
//   node --env-file=.env.local scripts/probe-sr-hosts.mjs

const ACCOUNT = (process.env.SR_ACCOUNT_KEY || '').trim();
const SR = (process.env.SR_SALESRABBIT_KEY || '').trim();
const KEY = ACCOUNT || SR;
if (!KEY) { console.error('No key in env.'); process.exit(1); }

// Candidate hosts + a path to try on each.
const HOSTS = [
  'https://api.amplify.salesrabbit.com',
  'https://amplify.salesrabbit.com',
  'https://amplify.salesrabbit.com/api',
  'https://api.srplus.salesrabbit.com',
  'https://srplus.salesrabbit.com',
  'https://srplus.salesrabbit.com/api',
  'https://integrate.srplus.salesrabbit.com',
  'https://api-amplify.salesrabbit.com',
  'https://gateway.salesrabbit.com',
  'https://api.salesrabbit.com/amplify',
  'https://integrate.salesrabbit.com',      // no /v1
  'https://integrate.salesrabbit.com/amplify',
];
const PATHS = ['/', '/leads', '/v1/leads', '/users', '/me', '/health'];

async function hit(url, headers) {
  try {
    const r = await fetch(url, { headers, redirect: 'manual' });
    const body = (await r.text()).slice(0, 80).replace(/\s+/g, ' ');
    return { status: r.status, body, loc: r.headers.get('location') || '' };
  } catch (e) {
    return { status: 0, body: String((e && e.message) || e).slice(0, 60) };
  }
}

for (const host of HOSTS) {
  // First, does the host resolve at all? Try root with the bearer key.
  const root = await hit(host + '/', { Accept: 'application/json', Authorization: `Bearer ${KEY}` });
  if (root.status === 0 && /getaddrinfo|ENOTFOUND|EAI_AGAIN/i.test(root.body)) {
    console.log(`✗ ${host}  (no such host)`);
    continue;
  }
  console.log(`\n● ${host}  (host resolves)`);
  for (const p of PATHS) {
    if (p === '/') { console.log(`    ${String(root.status).padEnd(4)} /  ${root.loc ? '-> ' + root.loc : root.body}`); continue; }
    const r = await hit(host + p, { Accept: 'application/json', Authorization: `Bearer ${KEY}` });
    const flag = r.status >= 200 && r.status < 300 ? '  ✓✓✓' : (r.status === 401 ? '' : '');
    console.log(`    ${String(r.status).padEnd(4)} ${p}  ${r.loc ? '-> ' + r.loc : r.body}${flag}`);
  }
}
console.log('\nDone.');
