#!/usr/bin/env node
// Chief of staff (one per floor): node workers/chief/chief.mjs grow
// Once a day after the floor's workers have run: roll call (queues a Run for anyone
// who missed it, a Fix for known failures), a ranked to-do from every worker's
// latest findings, and carry-over from yesterday's brief. Everything is scripted.
import { execFile } from 'node:child_process';
import { get, insert, writeSnapshot, latestSnapshot, today } from '../../lib/db.mjs';
import { FACTS } from '../../site/help.js';
import { FLOORS, newTask } from '../runner/menu.mjs';
import { rollCall, fixesToQueue, todoItems, carryOver, statusLine } from './chief.logic.mjs';

const floor = process.argv[2];
if (!FLOORS.includes(floor)) { console.log(`usage: chief.mjs <${FLOORS.join('|')}>`); process.exit(2); }
const ME = `chief-${floor}`;

async function main() {
  const agents = await get(`office_agents?floor=eq.${floor}&select=*&order=sort`);
  const staff = agents.filter(a => !a.id.startsWith('runner-') && !a.id.startsWith('chief-'));
  // Same view of events the office page uses: recent non-heartbeat history plus the newest heartbeat.
  const events = (await Promise.all(staff.flatMap(a => [
    get(`office_events?agent_id=eq.${a.id}&kind=neq.heartbeat&order=created_at.desc&limit=12&select=agent_id,run_id,kind,ok,status,created_at`),
    get(`office_events?agent_id=eq.${a.id}&kind=eq.heartbeat&order=created_at.desc&limit=1&select=agent_id,run_id,kind,ok,status,created_at`),
  ]))).flat();
  const roll = rollCall(agents, events, FACTS);

  const openTasks = await get(`office_tasks?floor=eq.${floor}&state=in.(queued,waiting,running)&select=agent_id,kind`);
  const queued = [];
  for (const f of fixesToQueue(roll, openTasks)) {
    const made = newTask({ ...f, requestedBy: ME }, agents, FACTS);
    if (made.error) continue;
    const [row] = await insert('office_tasks', [made.task]);
    queued.push({ id: row.id, agent: f.agent, kind: f.kind, state: row.state, note: f.note });
  }
  if (queued.some(q => q.state === 'queued')) execFile('launchctl', ['kickstart', `gui/${process.getuid()}/com.wolfoffice.runner-${floor}`], () => {});

  const snaps = {};
  for (const a of staff) {
    const rows = await get(`office_snapshots?agent_id=eq.${a.id}&order=day.desc&limit=1&select=day,data`);
    if (rows[0]) snaps[a.id] = rows[0];
  }
  const day = today();
  const prev = await latestSnapshot(ME, day);
  const all = todoItems(snaps);
  const minor = all.filter(i => i.severity <= 1);
  const co = carryOver(all.filter(i => i.severity >= 2).slice(0, 12), prev ? { ...prev.data, day: prev.day } : null, day);
  const wins = Object.values(snaps).flatMap(sn => (sn.data && sn.data.wins) || []).slice(0, 8);
  const brief = { floor, day, roll, queued, items: co.items, closed: co.closed, minor: minor.length, minorByOwner: minor.reduce((m, i) => (m[i.owner] = (m[i.owner] || 0) + 1, m), {}), wins, generated: new Date().toISOString() };
  await writeSnapshot(ME, day, brief);
  console.log(statusLine(brief));
}

main().catch((err) => {
  console.log(`error: ${err.message}`);
  process.exit(1);
});
