import { describe, it, expect } from 'vitest';
import { rollCall, fixesToQueue, todoItems, carryOver, statusLine } from '../workers/chief/chief.logic.mjs';

const NOW = new Date('2026-09-15T15:00:00Z').getTime();
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const agents = [
  { id: 'analyst', name: 'Analyst', cadence_seconds: 86400 },
  { id: 'crawler', name: 'Crawler', cadence_seconds: 300 },
  { id: 'chaser', name: 'Callback chaser', cadence_seconds: 86400 },
  { id: 'watcher', name: 'Banker', cadence_seconds: 86400 },
  { id: 'runner-grow', name: 'Runner', cadence_seconds: 120 },
];
const facts = {
  analyst: { run: 'node analyst.mjs' },
  crawler: { run: 'bash crawl.sh', failHints: { 3: 'token expired' }, failCommands: { 3: 'node grow-sync.mjs --seed' } },
  chaser: { run: 'node chaser.mjs' },
  watcher: { run: 'node observe.mjs', observed: true, blocked: 'Sign the portal back in.' },
  'runner-grow': { run: 'node runner.mjs grow' },
};
const events = [
  { agent_id: 'analyst', run_id: 'a', kind: 'finish', ok: true, status: 'fine', created_at: ago(60) },
  { agent_id: 'crawler', run_id: 'c', kind: 'finish', ok: false, status: 'exit 3', created_at: ago(5) },
  { agent_id: 'chaser', run_id: 'h', kind: 'finish', ok: true, status: 'old', created_at: ago(60 * 24 * 3) },
  { agent_id: 'watcher', run_id: 'b', kind: 'blocked', ok: null, status: 'Portal needs a re-login', created_at: ago(30) },
];

describe('rollCall', () => {
  const roll = rollCall(agents, events, facts, NOW);
  it('skips the Runner and Chief themselves', () => expect(roll.rows.map(r => r.id)).toEqual(['analyst', 'crawler', 'chaser', 'watcher']));
  it('counts present and missed', () => { expect(roll.present).toBe(1); expect(roll.missed.map(r => r.id)).toEqual(['crawler', 'chaser', 'watcher']); });
  it('picks a fix command for a known exit code, a rerun for stale, nothing for blocked or observed', () => {
    const by = Object.fromEntries(roll.rows.map(r => [r.id, r]));
    expect(by.crawler.fix).toEqual({ kind: 'fix', args: { code: 3 } });
    expect(by.crawler.hint).toBe('token expired');
    expect(by.chaser.fix).toEqual({ kind: 'run' });
    expect(by.watcher.fix).toBeNull();
    expect(by.watcher.hint).toBe('Sign the portal back in.');
  });
  it('does not queue a second task for a worker that already has one open', () => {
    const q = fixesToQueue(roll, [{ agent_id: 'chaser', kind: 'run' }]);
    expect(q.map(x => x.agent)).toEqual(['crawler']);
    expect(q[0].note).toMatch(/failed/);
  });
});

describe('todoItems + carryOver', () => {
  const snaps = {
    payaudit: { day: '2026-09-15', data: { adjustments: { owe: [{ rep: 'Ann', week: '2026-09-03', amount: 50 }], recover: [] }, current: { chargebacks: [{ rep: 'Bob', amount: 300 }] } } },
    chaser: { day: '2026-09-15', data: { byRep: { Unassigned: new Array(36).fill(0), Cy: [1, 2], Dee: new Array(12).fill(0) } } },
    analyst: { day: '2026-09-15', data: { flags: [{ rep: 'Eve', metric: 'leadTimeDays', direction: 'high' }] } },
    installs: { day: '2026-09-15', data: { diff: { cancelled: [{ rep: 'Fay', id: 'D1' }], pushed: [{ rep: 'Gus', id: 'D2', days: 9 }, { rep: 'Hal', id: 'D3', days: 2 }] } } },
    ghost: { day: '2026-09-15', data: { anything: 1 } },
  };
  const items = todoItems(snaps);
  it('ranks by severity then size and ignores workers without an extractor', () => {
    expect(items[0].title).toMatch(/chargeback: Bob/);
    expect(items.slice(0, 3).every(i => i.severity === 3)).toBe(true);
    expect(items.find(i => i.key === 'chaser:Cy')).toBeUndefined();
    expect(items.find(i => i.key === 'installs:push:D3')).toBeUndefined();
    expect(items[items.length - 1].owner).toBe('analyst');
  });
  it('carries firstSeen forward and lists what closed', () => {
    const prev = { day: '2026-09-12', items: [{ key: 'chaser:Dee', title: 'Dee has 11 untouched callbacks', owner: 'chaser', firstSeen: '2026-09-08' }, { key: 'installs:cancel:OLD', title: 'Install cancelled: Ivy · OLD', owner: 'installs' }] };
    const co = carryOver(items, prev, '2026-09-15');
    const dee = co.items.find(i => i.key === 'chaser:Dee');
    expect(dee.carried).toBe(true); expect(dee.firstSeen).toBe('2026-09-08'); expect(dee.daysOpen).toBe(7);
    expect(co.items.find(i => i.key === 'payaudit:cb:Bob').carried).toBe(false);
    expect(co.closed).toEqual([{ key: 'installs:cancel:OLD', title: 'Install cancelled: Ivy · OLD', owner: 'installs', daysOpen: 3 }]);
  });
  it('writes the desk line', () => {
    const roll = rollCall(agents, events, facts, NOW);
    const co = carryOver(items, { day: '2026-09-14', items: [{ key: 'chaser:Dee', title: 'x', owner: 'chaser' }, { key: 'gone', title: 'y', owner: 'z' }] }, '2026-09-15');
    expect(statusLine({ roll, queued: [{ id: 1 }], items: co.items, closed: co.closed })).toBe('Roll call 1/4, 3 missed, 1 fix queued · 7 to-dos, 1 carried over, 1 closed');
    expect(statusLine({ roll: { present: 4, total: 4, missed: [] }, queued: [], items: [], closed: [] })).toBe('Roll call 4/4 · to-do list clear');
  });
});
