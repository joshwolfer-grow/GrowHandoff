#!/usr/bin/env node
// Runner (one per floor): node workers/runner/runner.mjs grow
// Each tick: fail anything that ran past its timeout, then claim the oldest queued
// task for this floor and execute it from the menu. Jobs that belong to a desk run
// through office-wrap AS THAT WORKER, so the right desk lights up. Idle ticks only
// heartbeat, so the Runner's desk is not spammed with start/finish every minute.
import { execFile, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { get, patch } from '../../lib/db.mjs';
import { FLOORS, resolve } from './menu.mjs';
import { pythonDirs } from '../../lib/python.mjs';
import { pickNext, timedOut, counts, lastLine, statusLine } from './runner.logic.mjs';

const floor = process.argv[2];
if (!FLOORS.includes(floor)) { console.log(`usage: runner.mjs <${FLOORS.join('|')}>`); process.exit(2); }
const ME = `runner-${floor}`;
const HOME = os.homedir();
const LOG = path.join(HOME, 'bin', 'office-log');
const WRAP = path.join(HOME, 'bin', 'office-wrap');
const PATHV = [path.dirname(process.execPath), process.env.PATH || '/usr/bin:/bin:/usr/local/bin', ...pythonDirs()].join(':');
const ENV = { ...process.env, HOME, PATH: PATHV };

const log = (...a) => spawnSync(LOG, a, { encoding: 'utf8', env: ENV }).stdout.trim();
const now = () => new Date().toISOString();

function sh(cmd, timeoutSec) {
  return new Promise((res) => {
    execFile('/bin/bash', ['-lc', cmd], { timeout: timeoutSec * 1000, maxBuffer: 1 << 22, env: ENV }, (err, stdout, stderr) => {
      res({ code: err ? (err.killed ? 124 : (err.code ?? 1)) : 0, out: String(stdout || '') + (stderr ? '\n' + stderr : '') });
    });
  });
}
// Runs the job as the target worker so its desk shows start/finish.
function viaDesk(agent, cmd, timeoutSec) {
  return new Promise((res) => {
    execFile(WRAP, [agent, '--status-from-last-line', '--', '/bin/bash', '-lc', cmd], { timeout: timeoutSec * 1000, maxBuffer: 1 << 22, env: ENV }, (err, stdout, stderr) => {
      res({ code: err ? (err.killed ? 124 : (err.code ?? 1)) : 0, out: String(stdout || '') + (stderr ? '\n' + stderr : '') });
    });
  });
}

async function main() {
  const tasks = await get(`office_tasks?floor=eq.${floor}&state=in.(queued,waiting,running)&order=requested_at.asc&select=*`);
  for (const t of timedOut(tasks)) {
    await patch(`office_tasks?id=eq.${t.id}&state=eq.running`, { state: 'failed', finished_at: now(), result: `timed out after ${t.timeout_seconds || 600}s` });
    t.state = 'failed';
  }
  const next = pickNext(tasks);
  if (!next) {
    log('beat', ME, '--status', statusLine(counts(tasks)));
    console.log(statusLine(counts(tasks)));
    return;
  }
  const r = resolve(next);
  if (r.error) {
    await patch(`office_tasks?id=eq.${next.id}`, { state: 'failed', finished_at: now(), result: r.error });
    log('beat', ME, '--status', `Could not run task ${next.id}: ${r.error}`);
    console.log(`task ${next.id} failed: ${r.error}`);
    return;
  }
  // Claim it. state=eq.queued makes a double pickup impossible.
  const claimed = await patch(`office_tasks?id=eq.${next.id}&state=eq.queued`, { state: 'running', started_at: now() });
  if (!claimed || !claimed.length) { console.log('task already claimed'); return; }
  const run = log('start', ME, '--status', `${r.label} for ${next.agent_id}`);
  await patch(`office_tasks?id=eq.${next.id}`, { run_id: run || null });
  const res = r.viaDesk ? await viaDesk(next.agent_id, r.cmd, r.timeout) : await sh(r.cmd, r.timeout);
  const tail = res.code === 124 ? `timed out after ${r.timeout}s` : (lastLine(res.out) || (res.code ? `exit ${res.code}` : 'done'));
  await patch(`office_tasks?id=eq.${next.id}`, { state: res.code ? 'failed' : 'done', finished_at: now(), result: tail.slice(0, 1000) });
  const status = `${r.label} for ${next.agent_id}: ${tail}`.slice(0, 140);
  log('finish', ME, '--run', run, res.code ? '--fail' : '--ok', '--status', status);
  console.log(status);
}

main().catch((err) => {
  console.log(`error: ${err.message}`);
  log('beat', ME, '--status', `Runner error: ${err.message}`.slice(0, 140));
  process.exit(1);
});
