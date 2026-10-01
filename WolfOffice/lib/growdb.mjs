// lib/growdb.mjs — PostgREST client for the Grow Sales Supabase project (read-only).
// Grow's own sync scripts read the project's anon key out of the app's index.html;
// we do the same so there is one source of truth and nothing new to configure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL = 'https://cmkfohwbejcztctrpdnt.supabase.co';
function anonKey() {
  const html = fs.readFileSync(path.join(os.homedir(), 'Grow', 'GrowSales', 'index.html'), 'utf8');
  const m = html.match(/eyJ[A-Za-z0-9_.-]{50,}/);
  if (!m) throw new Error('Grow anon key not found in ~/Grow/GrowSales/index.html');
  return m[0];
}
const KEY = anonKey();
export async function growGet(q) {
  const res = await fetch(`${URL}/rest/v1/${q}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`grow GET ${q.split('?')[0]} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
