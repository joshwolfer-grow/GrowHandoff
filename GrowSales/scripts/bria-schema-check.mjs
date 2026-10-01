// scripts/bria-schema-check.mjs
// Checks that a Bria project exposes every table and column api/bria-sync.js reads.
// Run before pointing the sync at a new Bria, so a renamed column shows up here
// instead of as a failed nightly cron.
//
//   node scripts/bria-schema-check.mjs
//
// Reads BRIA_SUPABASE_URL, BRIA_SUPABASE_PUBLISHABLE_KEY and BRIA_SUPABASE_READONLY_KEY
// from the environment, or from .env.bria in the project root (kept out of deploys
// by .vercelignore's .env*).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env.bria');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const base = (process.env.BRIA_SUPABASE_URL || 'https://oofisagqyhfcpmfmcjwt.supabase.co').replace(/\/$/, '');
const apikey = (process.env.BRIA_SUPABASE_PUBLISHABLE_KEY || '').trim();
const bearer = (process.env.BRIA_SUPABASE_READONLY_KEY || '').trim();
if (!apikey || !bearer) { console.error('Need BRIA_SUPABASE_PUBLISHABLE_KEY and BRIA_SUPABASE_READONLY_KEY (env or .env.bria).'); process.exit(1); }

// Same list as TABLES in api/bria-sync.js (new-Bria shape), plus users.photo_url and
// teams.product_label. The training tables are optional: without them the sync
// keeps the existing training rows and still loads sales.
const WANT = {
  courses: 'id,title,category',
  lessons: 'id,course_id,title',
  quizzes: 'id,course_id,passing_score_pct',
  learning_groups: 'id,primary_course_id,start_date',
  learning_group_assignments: 'learning_group_id,user_id',
  learning_group_courses: 'learning_group_id,course_id',
  lesson_completions: 'user_id,lesson_id,completed_at',
  quiz_results: 'user_id,course_id,best_score_pct,passed',
  users: 'id,name,email,photo_url',
  sales: 'id,user_id,company_id,team_id,sale_date,install_date,install_time,install_end_time,customer_name,customer_phone,client_company_name',
  teams: 'id,product_label',
};

const headers = { apikey, Authorization: `Bearer ${bearer}` };

async function get(url, extra = {}) {
  const r = await fetch(url, { headers: { ...headers, ...extra } });
  return { r, body: await r.text() };
}

let bad = 0;
for (const [table, cols] of Object.entries(WANT)) {
  const { r, body } = await get(`${base}/rest/v1/${table}?select=*&limit=1`, { Prefer: 'count=exact' });
  if (!r.ok) { bad++; console.log(`✗ ${table}: ${r.status} ${body.slice(0, 160)}`); continue; }
  const total = (r.headers.get('content-range') || '').split('/')[1] || '?';
  const rows = JSON.parse(body);
  const have = rows[0] ? Object.keys(rows[0]) : null;
  // No sample row: ask for the columns directly, PostgREST 400s on a missing one.
  let missing = [];
  if (have) missing = cols.split(',').filter((c) => !have.includes(c));
  else {
    for (const c of cols.split(',')) {
      const t = await get(`${base}/rest/v1/${table}?select=${c}&limit=0`);
      if (!t.r.ok) missing.push(c);
    }
  }
  if (missing.length) bad++;
  console.log(`${missing.length ? '✗' : '✓'} ${table} (${total} rows)${missing.length ? '  missing: ' + missing.join(', ') : ''}`);
  if (have && missing.length) console.log(`    has: ${have.join(', ')}`);
}
// History and tenancy: the sync fully replaces Grow's Bria tables, so a Bria that
// starts later than the old one would erase history, and a service_role key reads
// every company, not just Grow.
const first = await get(`${base}/rest/v1/sales?select=sale_date&order=sale_date.asc.nullslast&limit=1`);
const last = await get(`${base}/rest/v1/sales?select=sale_date&order=sale_date.desc.nullslast&limit=1`);
if (first.r.ok && last.r.ok) {
  const f = JSON.parse(first.body)[0], l = JSON.parse(last.body)[0];
  console.log(`\nsales range: ${f?.sale_date || '?'} to ${l?.sale_date || '?'}`);
}

console.log(bad ? `\n${bad} table(s) need attention before switching.` : '\nAll tables and columns present.');
process.exit(bad ? 1 : 0);
