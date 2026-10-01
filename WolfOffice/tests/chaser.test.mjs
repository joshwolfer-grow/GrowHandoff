import { describe, it, expect } from 'vitest';
import { chase, statusLine } from '../workers/grow/chaser.logic.mjs';

function lead(id, overrides) {
  return { id, isp: 'i3', grow_rep: 'Al', grow_manager: 'Mgr', cancel_date: '2026-09-01', grow_status: 'cancelled', ...overrides };
}

describe('chase', () => {
  it('flags a lead with no pipeline row', () => {
    const r = chase([lead('l1')], [], '2026-09-14', 3);
    expect(r.needs).toEqual(['l1']);
  });

  it('does not flag a lead in a terminal stage regardless of age', () => {
    const pipeline = [{ key: 'l1', stage: 'Won', updated_at: '2026-08-01T00:00:00Z' }];
    const r = chase([lead('l1')], pipeline, '2026-09-14', 3);
    expect(r.needs).toEqual([]);
  });

  it('flags a non-terminal stage stale beyond staleDays', () => {
    const pipeline = [{ key: 'l1', stage: 'Contacted', updated_at: '2026-09-01T00:00:00Z' }];
    const r = chase([lead('l1')], pipeline, '2026-09-14', 3);
    expect(r.needs).toEqual(['l1']);
  });

  it('does not flag a non-terminal stage updated recently (within staleDays)', () => {
    const pipeline = [{ key: 'l1', stage: 'Contacted', updated_at: '2026-09-13T00:00:00Z' }];
    const r = chase([lead('l1')], pipeline, '2026-09-14', 3);
    expect(r.needs).toEqual([]);
  });

  it('treats terminal stage matching case-insensitively (e.g. "Install Scheduled")', () => {
    const pipeline = [{ key: 'l1', stage: 'Install Scheduled', updated_at: '2026-08-01T00:00:00Z' }];
    const r = chase([lead('l1')], pipeline, '2026-09-14', 3);
    expect(r.needs).toEqual([]);
  });

  it('groups stale leads by grow_rep, defaulting to Unassigned', () => {
    const leads = [lead('l1', { grow_rep: 'Al' }), lead('l2', { grow_rep: null })];
    const r = chase(leads, [], '2026-09-14', 3);
    expect(r.byRep.Al.map((x) => x.id)).toEqual(['l1']);
    expect(r.byRep.Unassigned.map((x) => x.id)).toEqual(['l2']);
  });
});

describe('statusLine', () => {
  it('reports all callbacks worked when none need chasing', () => {
    expect(statusLine({ needs: [], byRep: {} }, 15)).toBe('All 15 callbacks are being worked');
  });

  it('reports count, top rep, and oldest age', () => {
    const result = {
      needs: ['l1', 'l2', 'l3'],
      byRep: {
        Al: [{ id: 'l1', ageDays: 5 }, { id: 'l2', ageDays: 2 }],
        Bo: [{ id: 'l3', ageDays: 10 }],
      },
    };
    const line = statusLine(result, 20);
    expect(line).toBe('3 callbacks need a follow-up · Al has 2 · oldest 10d');
  });
});

describe('chase - oldest age uses cancel_date/pipeline update, whichever is older', () => {
  it('uses days since cancel_date when there is no pipeline row', () => {
    const leads = [lead('l1', { cancel_date: '2026-09-01' })];
    const r = chase(leads, [], '2026-09-14', 3);
    expect(r.byRep.Al[0].ageDays).toBe(13);
  });

  it('uses days since the last pipeline update when that is older than cancel_date', () => {
    const leads = [lead('l1', { cancel_date: '2026-09-10' })];
    const pipeline = [{ key: 'l1', stage: 'Contacted', updated_at: '2026-08-01T00:00:00Z' }];
    const r = chase(leads, pipeline, '2026-09-14', 3);
    // pipeline updated_at (44 days ago) is older than cancel_date (4 days ago)
    expect(r.byRep.Al[0].ageDays).toBe(44);
  });

  it('uses days since cancel_date when that is older than the last pipeline update', () => {
    const leads = [lead('l1', { cancel_date: '2026-07-01' })];
    const pipeline = [{ key: 'l1', stage: 'Contacted', updated_at: '2026-09-01T00:00:00Z' }];
    const r = chase(leads, pipeline, '2026-09-14', 3);
    // cancel_date (75 days ago) is older than pipeline update (13 days ago)
    expect(r.byRep.Al[0].ageDays).toBe(75);
  });

  it('reflects the true oldest age in the status line, not 0', () => {
    const leads = [lead('l1', { cancel_date: '2026-06-01' })];
    const r = chase(leads, [], '2026-09-14', 3);
    const line = statusLine(r, 1);
    expect(line).not.toContain('oldest 0d');
    expect(line).toContain('oldest');
  });
});
