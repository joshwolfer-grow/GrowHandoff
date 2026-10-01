#!/usr/bin/env node
// Deeper look at api.amplify.salesrabbit.com: headers, GraphQL, doc/spec paths.
//   node --env-file=.env.local scripts/probe-amplify2.mjs

const ACCOUNT = (process.env.SR_ACCOUNT_KEY || '').trim();
const SR = (process.env.SR_SALESRABBIT_KEY || '').trim();
const BASE = 'https://api.amplify.salesrabbit.com';

// 1) Root response headers — often reveal the framework / links / version.
console.log('— GET / headers —');
try {
  const r = await fetch(BASE + '/', { headers: { Authorization: `Bearer ${ACCOUNT}` } });
  console.log('  status', r.status);
  for (const [k, v] of r.headers.entries()) console.log(`  ${k}: ${v}`);
  console.log('  body:', (await r.text()).slice(0, 200));
} catch (e) { console.log('  err', e.message); }

// 2) GraphQL? Try introspection at common paths.
console.log('\n— GraphQL introspection —');
const gqlBody = JSON.stringify({ query: '{ __schema { queryType { name } types { name kind } } }' });
for (const p of ['/graphql', '/v1/graphql', '/api/graphql', '/query', '/gql']) {
  for (const [label, headers] of [
    ['Bearer ACCOUNT', { Authorization: `Bearer ${ACCOUNT}` }],
    ['pair', { 'x-account-key': ACCOUNT, 'x-api-key': SR }],
  ]) {
    try {
      const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: gqlBody });
      const t = (await r.text()).slice(0, 160).replace(/\s+/g, ' ');
      if (r.status !== 404) console.log(`  ${String(r.status).padEnd(4)} POST ${p} [${label}]  ${t}`);
    } catch (e) { console.log(`  ERR POST ${p}  ${e.message}`); }
  }
}

// 3) Doc / spec paths (broader list, plus a docs subdomain).
console.log('\n— Doc/spec paths —');
const docPaths = ['/swagger/index.html', '/swagger/doc.json', '/swagger.yaml', '/openapi.yaml',
  '/api-docs', '/api/docs', '/docs/', '/redoc', '/documentation', '/v1', '/api', '/version', '/ping', '/info', '/status'];
for (const p of docPaths) {
  try {
    const r = await fetch(BASE + p, { headers: { Accept: 'application/json', Authorization: `Bearer ${ACCOUNT}` }, redirect: 'manual' });
    const t = (await r.text()).slice(0, 100).replace(/\s+/g, ' ');
    if (r.status !== 404) console.log(`  ${String(r.status).padEnd(4)} ${p}  ${r.headers.get('location') || t}`);
  } catch (e) { console.log(`  ERR ${p}  ${e.message}`); }
}

// 4) Does a developers/docs subdomain exist?
console.log('\n— Doc subdomains —');
for (const h of ['https://developers.amplify.salesrabbit.com', 'https://docs.amplify.salesrabbit.com']) {
  try { const r = await fetch(h + '/', { redirect: 'manual' }); console.log(`  ${r.status} ${h}  ${r.headers.get('location') || ''}`); }
  catch (e) { console.log(`  ✗ ${h}  ${e.message.slice(0, 40)}`); }
}
console.log('\nDone.');
