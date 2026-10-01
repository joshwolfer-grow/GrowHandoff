import { describe, it, expect } from 'vitest';
import { deriveStatus } from '../site/status.mjs';

const T = new Date('2026-09-14T15:00:00Z').getTime();
const ago = (s) => new Date(T - s * 1000).toISOString();
const agent = { id: 'crawler', cadence_seconds: 300 };
const ev = (kind, secs, extra = {}) => ({ agent_id: 'crawler', kind, created_at: ago(secs), status: '', ok: null, ...extra });

describe('deriveStatus', () => {
  it('idle with no events and no cadence', () => {
    expect(deriveStatus({ id: 'x', cadence_seconds: null }, [], T).state).toBe('idle');
  });
  it('stale with no events but a cadence', () => {
    expect(deriveStatus(agent, [], T).state).toBe('stale');
  });
  it('working when newest is a recent start', () => {
    expect(deriveStatus(agent, [ev('start', 30)], T).state).toBe('working');
  });
  it('idle after a good finish inside the window', () => {
    const r = deriveStatus(agent, [ev('finish', 60, { ok: true, status: 'Synced 12 rows' }), ev('start', 90)], T);
    expect(r.state).toBe('idle'); expect(r.bubble).toBe('Synced 12 rows');
  });
  it('failed after a bad finish', () => {
    expect(deriveStatus(agent, [ev('finish', 60, { ok: false, status: 'exit 3' })], T).state).toBe('failed');
  });
  it('blocked when newest is blocked', () => {
    const r = deriveStatus(agent, [ev('blocked', 60, { status: 'Need a rep' })], T);
    expect(r.state).toBe('blocked');
    expect(r.bubble).toBe('Need a rep');
  });
  it('stale when nothing for 2x cadence', () => {
    expect(deriveStatus(agent, [ev('finish', 700, { ok: true })], T).state).toBe('stale');
  });
  it('heartbeats keep a watcher fresh', () => {
    expect(deriveStatus(agent, [ev('heartbeat', 100)], T).state).toBe('idle');
  });
  it('a start older than 6h is not working', () => {
    expect(deriveStatus({ id: 'x', cadence_seconds: null }, [ev('start', 7 * 3600)], T).state).toBe('idle');
  });
  it('ignores other agents and returns the last 7 finishes', () => {
    const evs = [ev('finish', 10, { ok: true }), { ...ev('finish', 20, { ok: false }), agent_id: 'other' }];
    const r = deriveStatus(agent, evs, T);
    expect(r.history).toEqual([true]);
  });
  it('history is the last 7 finishes, oldest first', () => {
    const evs = [];
    for (let i = 0; i < 9; i++) {
      evs.push(ev('finish', 10 * (9 - i), { ok: i % 2 === 0 }));
    }
    const r = deriveStatus(agent, evs, T);
    expect(r.history.length).toBe(7);
    expect(r.history[r.history.length - 1]).toBe(evs[evs.length - 1].ok);
  });
});
