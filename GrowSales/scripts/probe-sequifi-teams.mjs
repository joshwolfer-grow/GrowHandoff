// scripts/probe-sequifi-teams.mjs
// Checks whether the Sequifi marketplace API exposes the Management > Teams data.
// Usage: SEQUIFI_TOKEN=<token> node scripts/probe-sequifi-teams.mjs
//   (or: vercel env pull .env.prod --environment=production, then
//    SEQUIFI_TOKEN=$(grep ^SEQUIFI_TOKEN= .env.prod | cut -d= -f2- | tr -d '"') node scripts/probe-sequifi-teams.mjs)

const BASE = (process.env.SEQUIFI_BASE || 'https://marketplace-api.sequifi.com').replace(/\/$/, '');
const TOKEN = (process.env.SEQUIFI_TOKEN || '').trim();
if (!TOKEN) { console.error('SEQUIFI_TOKEN not set'); process.exit(1); }

const H = { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' };

const CANDIDATES = [
  '/v1/teams', '/v1/team', '/v1/teams?page=1&per_page=100',
  '/v1/management/teams', '/v1/manage/teams', '/v1/user-teams', '/v1/users/teams',
  '/v1/offices', '/v1/positions', '/v1/managers', '/v1/hierarchy', '/v1/org', '/v1/organization',
  '/v1/groups', '/v1/departments', '/v1/regions', '/v1/markets',
  '/v2/teams', '/teams', '/api/v1/teams',
];

async function get(path) {
  const r = await fetch(BASE + path, { headers: H });
  const text = await r.text();
  return { status: r.status, text };
}

console.log('== endpoint probe ==');
for (const p of CANDIDATES) {
  const { status, text } = await get(p);
  const hit = status === 200;
  console.log(`${hit ? 'HIT ' : '    '} ${status}  ${p}  ${text.replace(/\s+/g, ' ').slice(0, 160)}`);
}

console.log('\n== raw /v1/users record (all fields, look for team* keys) ==');
const { status, text } = await get('/v1/users?page=1&per_page=3');
if (status !== 200) { console.log(status, text.slice(0, 300)); process.exit(0); }
const body = JSON.parse(text);
const users = (body.data && body.data.users) || [];
console.log('top-level keys:', Object.keys(body.data || body));
if (users[0]) {
  console.log('user keys:', Object.keys(users[0]).join(', '));
  const teamish = Object.entries(users[0]).filter(([k]) => /team|group|office|region|market|hier|parent|lead/i.test(k));
  console.log('team-like fields:', JSON.stringify(Object.fromEntries(teamish), null, 1));
  console.log('\nfull sample:\n', JSON.stringify(users[0], null, 1).slice(0, 3000));
}

console.log('\n== single user detail (may expose more than the list) ==');
if (users[0]) {
  const d = await get(`/v1/users/${users[0].id}`);
  console.log(d.status, d.text.slice(0, 2000));
}
