#!/usr/bin/env node
// Can the UUID API keys open /Reports/Get server-side (no browser cookie)?
//   node --env-file=.env.local scripts/probe-reports.mjs

const ACCOUNT = (process.env.SR_ACCOUNT_KEY || '').trim();
const SR = (process.env.SR_SALESRABBIT_KEY || '').trim();
const COMPANY = '51870693-7912-4bc1-a13d-2e6ac69d5f81';

const payload = {
  period: 4, activityTypeId: 9442, paginationGrouped: { currentPage: 1, numberOfPages: 1 },
  orderBy: 'createdDate', includeDisabledEntities: false, statusIds: [],
  toDateTimeString: '2026-07-17 23:59:59', activityIds: [], userIds: [], originIds: [],
  fromDateTimeString: '2026-07-17 00:00:00', groupBy: 0, filterChangedWhileGrouping: false,
  descending: true, pagination: { numberOfPages: 1, currentPage: 1 }, teamIds: [],
  filterChanged: false, getByMeetingDate: false,
};

const HOSTS = ['https://api.amplify.salesrabbit.com', 'https://app.amplify.salesrabbit.com'];
const AUTHS = [
  ['Bearer ACCOUNT', { Authorization: `Bearer ${ACCOUNT}` }],
  ['Bearer SR', { Authorization: `Bearer ${SR}` }],
  ['x-api-key ACCOUNT', { 'x-api-key': ACCOUNT }],
  ['apikey ACCOUNT', { apikey: ACCOUNT }],
  ['pair account+sr', { 'x-account-key': ACCOUNT, 'x-api-key': SR }],
  ['companyKey + Bearer ACCOUNT', { companyKey: COMPANY, Authorization: `Bearer ${ACCOUNT}` }],
  ['x-api-key SR + companyKey', { 'x-api-key': SR, companyKey: COMPANY }],
];

for (const host of HOSTS) {
  console.log(`\n${'='.repeat(60)}\n${host}/Reports/Get\n${'='.repeat(60)}`);
  for (const [label, headers] of AUTHS) {
    try {
      const r = await fetch(host + '/Reports/Get', {
        method: 'POST', redirect: 'manual',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: JSON.stringify(payload),
      });
      const t = (await r.text()).slice(0, 100).replace(/\s+/g, ' ');
      const ok = r.status >= 200 && r.status < 300 && /reports|numberOfReports/i.test(t);
      console.log(`  ${String(r.status).padEnd(4)} ${label}${ok ? '  ✓✓✓ REAL DATA' : `  ${t}`}`);
    } catch (e) { console.log(`  ERR  ${label}  ${String((e && e.message) || e).slice(0, 50)}`); }
  }
}
console.log('\nDone.');
