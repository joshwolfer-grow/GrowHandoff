// lib/db.mjs — tiny PostgREST client for workers (service key, server side only).
import { loadEnv } from './env.mjs';

const env = loadEnv();
const H = { apikey: env.key, Authorization: `Bearer ${env.key}`, 'Content-Type': 'application/json' };

async function call(method, pathAndQuery, body, prefer) {
  const res = await fetch(`${env.url}/rest/v1/${pathAndQuery}`, {
    method, headers: prefer ? { ...H, Prefer: prefer } : H, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`${method} ${pathAndQuery.split('?')[0]} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? null : res.json();
}
export const get = (q) => call('GET', q);
export const insert = (table, rows) => call('POST', table, rows, 'return=representation');
export const upsert = (table, rows, onConflict) => call('POST', `${table}?on_conflict=${onConflict}`, rows, 'resolution=merge-duplicates,return=representation');
export const patch = (q, body) => call('PATCH', q, body, 'return=representation');
export const del = (q) => call('DELETE', q);

// Snapshot helpers: one JSON blob per agent per day, for diff workers.
export async function readSnapshot(agent, day) {
  const rows = await get(`office_snapshots?agent_id=eq.${agent}&day=eq.${day}&select=data`);
  return rows[0] ? rows[0].data : null;
}
export async function latestSnapshot(agent, beforeDay) {
  const rows = await get(`office_snapshots?agent_id=eq.${agent}&day=lt.${beforeDay}&order=day.desc&limit=1&select=day,data`);
  return rows[0] || null;
}
export async function writeSnapshot(agent, day, data) {
  await upsert('office_snapshots', [{ agent_id: agent, day, data }], 'agent_id,day');
}
export const today = () => new Date().toLocaleDateString('en-CA');   // YYYY-MM-DD local
