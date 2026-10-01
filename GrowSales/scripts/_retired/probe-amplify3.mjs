#!/usr/bin/env node
// Test the real Amplify routes (discovered from the dashboard's network tab)
// against the PUBLIC API host with the UUID keys. Read-only GET.
//   node --env-file=.env.local scripts/probe-amplify3.mjs

const ACCOUNT = (process.env.SR_ACCOUNT_KEY || '').trim();
const SR = (process.env.SR_SALESRABBIT_KEY || '').trim();
const COMPANY = '51870693-7912-4bc1-a13d-2e6ac69d5f81';
const USER = 'd9026347-ddb0-4c1d-94be-20485f9b9081';

const HOSTS = ['https://api.amplify.salesrabbit.com', 'https://app.amplify.salesrabbit.com'];
const ROUTES = [
  '/Metric/GetAll',
  '/LandingPage/GetAvailableScreens',
  '/CompanyPrivacy/GetUserPrivacySettings',
  `/User360/GetProfileInfo?userId=${USER}`,
  `/User360/GetActions?userId=${USER}`,
];
const AUTHS = [
  ['Bearer ACCOUNT', { Authorization: `Bearer ${ACCOUNT}` }],
  ['Bearer SR', { Authorization: `Bearer ${SR}` }],
  ['x-api-key ACCOUNT', { 'x-api-key': ACCOUNT }],
  ['apikey ACCOUNT', { apikey: ACCOUNT }],
  ['pair account+sr', { 'x-account-key': ACCOUNT, 'x-api-key': SR }],
  ['companyKey header', { companyKey: COMPANY, Authorization: `Bearer ${ACCOUNT}` }],
];

async function hit(url, headers) {
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json', ...headers }, redirect: 'manual' });
    const body = (await r.text()).slice(0, 90).replace(/\s+/g, ' ');
    return { status: r.status, body };
  } catch (e) { return { status: 0, body: String((e && e.message) || e).slice(0, 50) }; }
}

for (const host of HOSTS) {
  console.log(`\n${'='.repeat(60)}\n${host}\n${'='.repeat(60)}`);
  for (const route of ROUTES) {
    // First a quick unauth'd probe to see if the route exists at all.
    const bare = await hit(host + route, {});
    if (bare.status === 0) { console.log(`  (host/route unreachable) ${route}  ${bare.body}`); continue; }
    console.log(`  ${route}  [no-auth -> ${bare.status}]`);
    if (bare.status === 404) continue; // route not on this host
    for (const [label, headers] of AUTHS) {
      const r = await hit(host + route, headers);
      const ok = r.status >= 200 && r.status < 300;
      console.log(`     ${String(r.status).padEnd(4)} ${label}${ok ? '  ✓✓✓ ' + r.body.slice(0, 60) : ''}`);
    }
  }
}
console.log('\nDone.');
