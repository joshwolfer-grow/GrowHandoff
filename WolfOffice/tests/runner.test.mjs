import { describe, it, expect } from 'vitest';
import { pickNext, timedOut, counts, lastLine, statusLine } from '../workers/runner/runner.logic.mjs';
import { resolve, newTask, MENU } from '../workers/runner/menu.mjs';

const facts = {
  analyst: { run: 'node analyst.mjs', label: 'com.wolfoffice.analyst', log: '/tmp/a.log' },
  crawler: { run: 'bash crawl.sh', label: 'com.grow.sr-sync', log: '/tmp/c.log', failCommands: { 3: 'node grow-sync.mjs --seed' } },
  watcher: { run: 'node observe.mjs', observed: true },
};
const agents = [{ id: 'analyst', floor: 'grow' }, { id: 'crawler', floor: 'grow' }, { id: 'watcher', floor: 'grow' }];

describe('menu.resolve', () => {
  it('builds each safe command from facts', () => {
    expect(resolve({ kind: 'run', agent_id: 'analyst' }, facts).cmd).toBe('node analyst.mjs');
    expect(resolve({ kind: 'check', agent_id: 'analyst' }, facts).cmd).toContain('com.wolfoffice.analyst');
    expect(resolve({ kind: 'log', agent_id: 'analyst' }, facts).cmd).toBe('tail -40 "/tmp/a.log"');
    expect(resolve({ kind: 'restart', agent_id: 'crawler' }, facts).cmd).toContain('com.grow.sr-sync.plist');
  });
  it('only offers fix commands that exist for that exit code', () => {
    expect(resolve({ kind: 'fix', agent_id: 'crawler', args: { code: 3 } }, facts).cmd).toBe('node grow-sync.mjs --seed');
    expect(resolve({ kind: 'fix', agent_id: 'crawler', args: { code: 9 } }, facts).error).toMatch(/not available/);
  });
  it('refuses unknown kinds, unknown workers, and workers with no launchd job', () => {
    expect(resolve({ kind: 'deploy', agent_id: 'analyst' }, facts).error).toMatch(/unknown task kind/);
    expect(resolve({ kind: 'run', agent_id: 'ghost' }, facts).error).toMatch(/no facts/);
    expect(resolve({ kind: 'restart', agent_id: 'watcher' }, facts).error).toMatch(/not available/);
  });
  it('marks desk jobs so they run through office-wrap', () => {
    expect(resolve({ kind: 'run', agent_id: 'analyst' }, facts).viaDesk).toBe(true);
    expect(resolve({ kind: 'check', agent_id: 'analyst' }, facts).viaDesk).toBe(false);
  });
});

describe('menu.newTask', () => {
  it('queues safe tasks and parks approval tasks as waiting, with the floor filled in', () => {
    const a = newTask({ kind: 'run', agent: 'analyst', requestedBy: 'page' }, agents, facts).task;
    expect(a).toMatchObject({ agent_id: 'analyst', floor: 'grow', state: 'queued', requested_by: 'page', timeout_seconds: MENU.run.timeout });
    const b = newTask({ kind: 'fix', agent: 'crawler', args: { code: 3 }, note: 'token expired' }, agents, facts).task;
    expect(b.state).toBe('waiting');
    expect(b.note).toBe('token expired');
  });
  it('rejects bad input before it reaches the queue', () => {
    expect(newTask({ kind: 'run', agent: 'nope' }, agents, facts).error).toBe('unknown worker');
    expect(newTask({ kind: 'run', agent: '../x' }, agents, facts).error).toBe('bad agent');
    expect(newTask({ kind: 'fix', agent: 'analyst', args: { code: 1 } }, agents, facts).error).toMatch(/not available/);
  });
});

describe('runner.logic', () => {
  const T = (id, state, extra = {}) => ({ id, state, requested_at: `2026-09-15T10:0${id}:00Z`, ...extra });
  it('picks the oldest queued task and never a waiting one', () => {
    expect(pickNext([T(3, 'queued'), T(1, 'waiting'), T(2, 'queued')]).id).toBe(2);
    expect(pickNext([T(1, 'waiting'), T(2, 'done')])).toBeNull();
  });
  it('finds running tasks past their timeout', () => {
    const now = new Date('2026-09-15T11:00:00Z').getTime();
    const old = T(1, 'running', { started_at: '2026-09-15T10:00:00Z', timeout_seconds: 600 });
    const fresh = T(2, 'running', { started_at: '2026-09-15T10:58:00Z', timeout_seconds: 600 });
    expect(timedOut([old, fresh], now).map(t => t.id)).toEqual([1]);
  });
  it('counts, trims output, and writes the desk line', () => {
    const c = counts([T(1, 'queued'), T(2, 'waiting'), T(3, 'waiting'), T(4, 'done')]);
    expect(c).toEqual({ queued: 1, waiting: 2, running: 0, done: 1, failed: 0 });
    expect(statusLine(c)).toBe('Front desk: 1 queued, 2 waiting for approval');
    expect(statusLine(counts([]))).toBe('Front desk: nothing waiting');
    expect(lastLine('a\n\n  synced 12 rows  \n')).toBe('synced 12 rows');
  });
});
