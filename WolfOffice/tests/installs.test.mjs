import { describe, it, expect } from 'vitest';
import { diff, statusLine } from '../workers/grow/installs.logic.mjs';

function deal(overrides) {
  return { install_date: null, install_time: null, rep: 'Al', isp: 'i3', sale_date: '2026-09-01', ...overrides };
}

describe('diff', () => {
  it('detects a pushed install date', () => {
    const prev = { d1: deal({ install_date: '2026-09-10' }) };
    const cur = { d1: deal({ install_date: '2026-09-12' }) };
    const r = diff(prev, cur, '2026-09-08');
    expect(r.pushed).toEqual([{ id: 'd1', rep: 'Al', days: 2 }]);
    expect(r.pulledIn).toEqual([]);
  });

  it('detects a pulled-in install date', () => {
    const prev = { d1: deal({ install_date: '2026-09-12' }) };
    const cur = { d1: deal({ install_date: '2026-09-10' }) };
    const r = diff(prev, cur, '2026-09-08');
    expect(r.pulledIn).toEqual([{ id: 'd1', rep: 'Al', days: 2 }]);
  });

  it('detects a cancelled install (had date, now null)', () => {
    const prev = { d1: deal({ install_date: '2026-09-10' }) };
    const cur = { d1: deal({ install_date: null }) };
    const r = diff(prev, cur, '2026-09-08');
    expect(r.cancelled).toEqual([{ id: 'd1', rep: 'Al' }]);
  });

  it('detects a newly booked install (null before, set now)', () => {
    const prev = { d1: deal({ install_date: null }) };
    const cur = { d1: deal({ install_date: '2026-09-10' }) };
    const r = diff(prev, cur, '2026-09-08');
    expect(r.newlyBooked).toEqual([{ id: 'd1', rep: 'Al' }]);
  });

  it('flags deals booked more than 10 days after sale as farOut', () => {
    const cur = { d1: deal({ sale_date: '2026-09-01', install_date: '2026-09-15' }) };
    const r = diff({}, cur, '2026-09-08');
    expect(r.farOut).toEqual([{ id: 'd1', rep: 'Al', days: 14 }]);
  });

  it('flags deals with an install_date in the past as pendingPastWindow', () => {
    const cur = { d1: deal({ install_date: '2026-09-01' }) };
    const r = diff({}, cur, '2026-09-08');
    expect(r.pendingPastWindow).toEqual([{ id: 'd1', rep: 'Al', install_date: '2026-09-01' }]);
  });
});

describe('statusLine', () => {
  it('reports first-run snapshot message', () => {
    const result = { pushed: [], cancelled: [], farOut: [{ id: 'd1' }], newlyBooked: [], worstPush: null };
    expect(statusLine(result, true, 42)).toBe('First snapshot: 42 deals tracked, 1 booked 10+ days out');
  });

  it('formats a normal diff line with worst push rep/days', () => {
    const result = {
      pushed: [{ id: 'd1', rep: 'Al', days: 3 }],
      cancelled: [{ id: 'd2' }],
      farOut: [],
      newlyBooked: [{ id: 'd3' }, { id: 'd4' }],
      worstPush: { id: 'd1', rep: 'Al', days: 3 },
    };
    const line = statusLine(result, false, 10);
    expect(line).toBe('1 pushed (Al +3d) · 1 cancelled · 0 booked 10+ days out · 2 newly booked');
  });
});
