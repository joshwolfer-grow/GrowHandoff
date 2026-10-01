#!/usr/bin/env node
// Local office server: serves site/ and a read-only /api/state from Supabase.
// Binds to 127.0.0.1 only. The service key never leaves this process.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../lib/env.mjs';
import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import { FACTS } from '../site/help.js';
import { boardFor } from '../lib/board.mjs';
import { newTask, FLOORS } from '../workers/runner/menu.mjs';
import { leadsApi } from '../workers/grow/leaddesk.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'site');
const PORT = Number(process.env.OFFICE_PORT || 8787);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml' };
const env = loadEnv();

async function rest(pathAndQuery) {
  const res = await fetch(`${env.url}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: env.key, Authorization: `Bearer ${env.key}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

// Recent events for the animation plus each worker's latest few events so a daily
// or weekly worker still shows its last report. Cached briefly; the page polls every 30s.
let cache = { at: 0, hours: 0, body: null };
async function state(hours) {
  if (cache.body && cache.hours === hours && Date.now() - cache.at < 15000) return cache.body;
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const agents = await rest('office_agents?select=*&order=sort');
  const recent = await rest(`office_events?select=agent_id,run_id,kind,ok,status,created_at&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=5000`);
  const latest = await Promise.all(agents.map(a => rest(`office_events?select=agent_id,run_id,kind,ok,status,created_at&agent_id=eq.${encodeURIComponent(a.id)}&kind=neq.heartbeat&order=created_at.desc&limit=12`)));
  const seen = new Set(recent.map(e => e.agent_id + '|' + e.run_id + '|' + e.kind + '|' + e.created_at));
  const events = recent.slice();
  for (const rows of latest) for (const e of rows) { const k = e.agent_id + '|' + e.run_id + '|' + e.kind + '|' + e.created_at; if (!seen.has(k)) { seen.add(k); events.push(e); } }
  events.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  cache = { at: Date.now(), hours, body: { agents, events } };
  return cache.body;
}

// Only these actions exist; the command text comes from site/help.js, never from the request.
function commandFor(agent, action, code) {
  const f = FACTS[agent]; if (!f) return null;
  if (action === 'check' && f.label) return `launchctl list | grep ${f.label} || echo "not loaded"`;
  if (action === 'restart' && f.label) return `launchctl unload ~/Library/LaunchAgents/${f.label}.plist; launchctl load ~/Library/LaunchAgents/${f.label}.plist && echo restarted`;
  if (action === 'run' && f.run) {
    // If the run fails with a code we know how to fix, fix it and run again, all in one click.
    const fixes = Object.entries(f.failCommands || {});
    if (!fixes.length) return f.run;
    const cases = fixes.map(([c, fix]) => `  ${Number(c)}) echo; echo "Known problem (exit ${Number(c)}). Fixing it now: ${fix.replace(/"/g, '')}"; ( ${fix} ) && { echo; echo "Fixed. Running the job again..."; ${f.run}; } ;;`).join('\n');
    return `${f.run}\ncode=$?\ncase $code in\n${cases}\n  *) exit $code ;;\nesac`;
  }
  // The fix for a known exit code, then the job itself so the card turns green straight away.
  if (action === 'fix' && f.failCommands && f.failCommands[String(code)]) return f.run ? `${f.failCommands[String(code)]} && echo && echo "Fixed. Running the job now..." && ${f.run}` : f.failCommands[String(code)];
  if (action === 'log' && f.log) return `tail -40 "${f.log}"`;
  return null;
}

async function restWrite(method, pathAndQuery, body) {
  const r = await fetch(`${env.url}/rest/v1/${pathAndQuery}`, { method, headers: { apikey: env.key, Authorization: `Bearer ${env.key}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}
// Wake the floor's Runner right away instead of waiting for its next minute.
function kickRunner(floor) {
  execFile('launchctl', ['kickstart', `gui/${process.getuid()}/com.wolfoffice.runner-${floor}`], () => {});
}
async function enqueue(body, requestedBy) {
  const agents = await rest('office_agents?select=id,floor');
  const made = newTask({ ...body, requestedBy }, agents);
  if (made.error) return { error: made.error };
  const [row] = await restWrite('POST', 'office_tasks', [made.task]);
  if (row.state === 'queued') kickRunner(row.floor);
  return { task: row };
}
function readBody(req) { return new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => r(b)); }); }

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (url.pathname === '/api/run' && req.method === 'POST') {
      const { agent, action, code } = JSON.parse(await readBody(req) || '{}');
      const cmd = commandFor(String(agent || ''), String(action || ''), String(code || ''));
      if (!cmd) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'unknown action' })); }
      // Runs right here on this Mac and streams the output to the card as it happens.
      // Run and Fix can take minutes (a sign-in window waits for you), so they get a long cap.
      const limit = action === 'run' || action === 'fix' ? 30 * 60000 : 120000;
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      const child = spawn('/bin/bash', ['-lc', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => child.kill('SIGKILL'), limit);
      child.stdout.on('data', d => res.write(d));
      child.stderr.on('data', d => res.write(d));
      // Most jobs write to their own log file, not the screen, so follow the log while they run.
      // help.js paths are written with $HOME so the browser can import the same file; expand it here.
      const logFile = action !== 'log' && FACTS[agent] && FACTS[agent].log && FACTS[agent].log.replace(/^\$HOME(?=\/)/, os.homedir());
      let logAt = -1; try { if (logFile) logAt = fs.statSync(logFile).size; } catch {}
      const follow = () => { if (logAt < 0) return; try { const size = fs.statSync(logFile).size; if (size > logAt) { const fd = fs.openSync(logFile, 'r'); const buf = Buffer.alloc(Math.min(size - logAt, 1 << 20)); fs.readSync(fd, buf, 0, buf.length, logAt); fs.closeSync(fd); res.write(buf); } logAt = size; } catch {} };
      const poll = setInterval(follow, 700);
      // Finish on exit, not close: a job's leftover helpers (like a watchdog sleep) can hold the pipe open for minutes.
      child.on('exit', (c, sig) => { clearTimeout(timer); setTimeout(() => { clearInterval(poll); follow(); cache.at = 0; res.end(`\n[exit ${sig ? 'killed' : c}]\n`); }, 300); });
      return;
    }
    // Lead desk (site/leads.html): parked ISP files -> SalesRabbit import. All of it lives in workers/grow/leaddesk.mjs.
    if (url.pathname.startsWith('/api/leads')) return await leadsApi(req, res, url);
    if (url.pathname === '/api/tasks') {
      const floor = String(url.searchParams.get('floor') || '');
      if (!FLOORS.includes(floor)) { res.writeHead(400); return res.end('bad floor'); }
      const rows = await rest(`office_tasks?floor=eq.${floor}&order=requested_at.desc&limit=40&select=id,agent_id,kind,args,state,requested_at,started_at,finished_at,requested_by,note,result`);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(rows));
    }
    if (url.pathname === '/api/task' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req) || '{}');
      const q = await enqueue({ kind: String(b.kind || ''), agent: String(b.agent || ''), args: b.args, note: b.note }, 'page');
      res.writeHead(q.error ? 400 : 200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(q));
    }
    if (url.pathname === '/api/task/approve' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req) || '{}');
      const id = Number(b.id); if (!Number.isInteger(id) || id <= 0) { res.writeHead(400); return res.end('bad id'); }
      const rows = await restWrite('PATCH', `office_tasks?id=eq.${id}&state=eq.waiting`, { state: 'queued', approved_at: new Date().toISOString() });
      if (rows[0]) kickRunner(rows[0].floor);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ task: rows[0] || null }));
    }
    if (url.pathname === '/api/task/cancel' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req) || '{}');
      const id = Number(b.id); if (!Number.isInteger(id) || id <= 0) { res.writeHead(400); return res.end('bad id'); }
      const rows = await restWrite('PATCH', `office_tasks?id=eq.${id}&state=in.(waiting,queued)`, { state: 'failed', finished_at: new Date().toISOString(), result: 'cancelled from the page' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ task: rows[0] || null }));
    }
    if (url.pathname === '/api/board') {
      const floor = String(url.searchParams.get('floor') || 'grow');
      if (!FLOORS.includes(floor)) { res.writeHead(400); return res.end('bad floor'); }
      let body;
      try { body = await boardFor(floor); } catch (e) { console.error('board', floor, e.message); body = { tiles: [{ label: 'Board', value: 'unavailable' }], error: true }; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(body));
    }
    if (url.pathname === '/api/snapshot') {
      const agent = String(url.searchParams.get('agent') || '');
      if (!/^[a-z0-9_-]{1,40}$/.test(agent)) { res.writeHead(400); return res.end('bad agent'); }
      const rows = await rest(`office_snapshots?agent_id=eq.${agent}&order=day.desc&limit=1&select=day,data`);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(rows[0] || null));
    }
    if (url.pathname === '/api/state') {
      const hours = Math.min(168, Math.max(1, Number(url.searchParams.get('hours')) || 3));
      const body = JSON.stringify(await state(hours));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(body);
    }
    let file = path.normalize(path.join(ROOT, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    console.error(e.message); res.end(JSON.stringify({ error: 'office server error, see ~/Library/Logs/wolfoffice-site.log' }));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`wolf office on http://127.0.0.1:${PORT}`));
