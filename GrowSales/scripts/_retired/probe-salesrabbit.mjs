#!/usr/bin/env node
// Read-only auth check for SalesRabbit / Amplify API keys.
// GET only. Never writes. Never prints PII or the key values.
//
// Reads both keys from the environment (put them in .env.local):
//   SR_ACCOUNT_KEY, SR_SALESRABBIT_KEY
// Run:
//   node --env-file=.env.local scripts/probe-salesrabbit.mjs

const ACCOUNT = (process.env.SR_ACCOUNT_KEY || '').trim();
const SR = (process.env.SR_SALESRABBIT_KEY || process.env.SALESRABBIT_API_KEY || '').trim();

if (!ACCOUNT && !SR) {
  console.error('No keys found. Put SR_ACCOUNT_KEY and SR_SALESRABBIT_KEY in .env.local, then:');
  console.error('  node --env-file=.env.local scripts/probe-salesrabbit.mjs');
  process.exit(1);
}

const fp = (k) => (k ? `len=${k.length}, ends "${k.slice(-4)}"` : '(missing)');
console.log('key fingerprints (not the values):');
console.log('  SR_ACCOUNT_KEY   ', fp(ACCOUNT));
console.log('  SR_SALESRABBIT_KEY', fp(SR));

const HOSTS = {
  legacy: { base: 'https://api.salesrabbit.com', probe: '/leads?limit=1' },
  srplus: { base: 'https://integrate.salesrabbit.com/v1', probe: '/leads?page[limit]=1' },
};

const b64 = (s) => Buffer.from(s).toString('base64');

// Build the full matrix of things worth trying.
function attempts() {
  const list = [];
  const singles = [
    ['ACCOUNT', ACCOUNT],
    ['SALESRABBIT', SR],
  ].filter(([, v]) => v);
  for (const [name, key] of singles) {
    list.push([`${name} as Bearer`, { Authorization: `Bearer ${key}` }]);
    list.push([`${name} as Token`, { Authorization: `Token ${key}` }]);
    list.push([`${name} raw Authorization`, { Authorization: key }]);
    list.push([`${name} as x-api-key`, { 'x-api-key': key }]);
  }
  // Paired schemes (account id + secret), if we have both.
  if (ACCOUNT && SR) {
    list.push(['Basic account:salesrabbit', { Authorization: `Basic ${b64(`${ACCOUNT}:${SR}`)}` }]);
    list.push(['Basic salesrabbit:account', { Authorization: `Basic ${b64(`${SR}:${ACCOUNT}`)}` }]);
    list.push(['header pair (x-account-key + x-api-key)', { 'x-account-key': ACCOUNT, 'x-api-key': SR }]);
    list.push(['Bearer SR + X-Account-Id', { Authorization: `Bearer ${SR}`, 'X-Account-Id': ACCOUNT }]);
    list.push(['Bearer account:sr', { Authorization: `Bearer ${ACCOUNT}:${SR}` }]);
  }
  return list;
}

async function run() {
  for (const [hname, h] of Object.entries(HOSTS)) {
    console.log(`\n${'='.repeat(60)}\n${hname}  (${h.base})\n${'='.repeat(60)}`);
    let anyOk = false;
    for (const [label, headers] of attempts()) {
      try {
        const r = await fetch(h.base + h.probe, { headers: { Accept: 'application/json', ...headers } });
        const body = (await r.text()).slice(0, 90).replace(/\s+/g, ' ');
        const ok = r.status >= 200 && r.status < 300;
        if (ok) anyOk = true;
        console.log(`  ${String(r.status).padEnd(4)} ${label}${ok ? '   ✓✓✓ AUTHENTICATED' : `   ${body}`}`);
      } catch (e) {
        console.log(`  ERR  ${label}  ${String((e && e.message) || e)}`);
      }
    }
    if (anyOk) console.log(`  >>> ${hname} accepts one of the schemes above.`);
  }
  console.log('\nDone — no PII, no key values printed.');
}
run();
