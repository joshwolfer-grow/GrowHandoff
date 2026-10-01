import { describe, it, expect } from 'vitest';
import { paidState, closedWeekDrift, adjustments, cycleDiff, buildAudit, statusLine } from '../workers/grow/payaudit.logic.mjs';

const wk = (start, end, rows) => ({ start, end, rows });
const row = (rep, net, st = 'green', extra = {}) => ({ rep, st, on: st !== 'red', rate: 80, fin: 12, payCount: net / 50, pay: net, claw: 0, net, cb: 0, cbNew: false, rFall: 0, ...extra });

describe('paidState', () => {
  it('is pending until the run closes', () => expect(paidState(null, { amount: 100 }, 150)).toEqual({ paid: 0, state: 'pending', had: 100 }));
  it('matches, under, over', () => {
    const run = { closed: true };
    expect(paidState(run, { amount: 100 }, 100).state).toBe('match');
    expect(paidState(run, { amount: 100 }, 150).state).toBe('under');
    expect(paidState(run, { amount: 100 }, 50).state).toBe('over');
  });
  it('assumes paid-at-owed for bare paid rows', () => expect(paidState({ closed: true }, { paid: true }, 200)).toEqual({ paid: 200, state: 'assumed' }));
  it('treats a skipped rep as under', () => expect(paidState({ closed: true }, undefined, 100).state).toBe('under'));
});

describe('closedWeekDrift + adjustments', () => {
  const data = {
    auditThru: '2026-09-02',
    weeks: [
      wk('2026-09-10', '2026-09-16', [row('Ann', 150), row('Bob', 100)]),           // current, not closed
      wk('2026-09-03', '2026-09-09', [row('Ann', 200), row('Bob', 50), row('Cy', 100)]),
      wk('2026-08-27', '2026-09-02', [row('Ann', 100)]),                            // settled by audit
    ],
    runs: { '2026-09-03': { closed: true }, '2026-08-27': { closed: true } },
    paid: {
      '2026-09-03|Ann': { amount: 150, paid: true },   // under by 50
      '2026-09-03|Bob': { amount: 100, paid: true },   // over by 50
      '2026-09-03|Dee': { amount: 50, paid: true },    // no longer owed: over by 50
      '2026-08-27|Ann': { amount: 0, paid: true },     // under, but audit-settled
    },
  };
  it('lists only mismatches per closed week', () => {
    const d = closedWeekDrift(data);
    expect(d.map(w => w.start)).toEqual(['2026-09-03', '2026-08-27']);
    const sep3 = d[0];
    expect(sep3.rows.map(r => [r.rep, r.state])).toEqual([['Ann', 'under'], ['Bob', 'over'], ['Cy', 'under'], ['Dee', 'over']]);
    expect(sep3.owed).toBe(350);
    expect(sep3.paid).toBe(300);
    expect(d[1].settledByAudit).toBe(true);
  });
  it('produces adjustments both ways and skips audit-settled weeks', () => {
    const a = adjustments(closedWeekDrift(data));
    expect(a.owe).toEqual([{ rep: 'Ann', week: '2026-09-03', amount: 50 }, { rep: 'Cy', week: '2026-09-03', amount: 100 }]);
    expect(a.recover).toEqual([{ rep: 'Bob', week: '2026-09-03', amount: 50 }, { rep: 'Dee', week: '2026-09-03', amount: 50 }]);
    expect(a.net).toBe(50);
  });
});

describe('cycleDiff', () => {
  const cur = { start: '2026-09-10', total: 300, rows: [row('Ann', 150, 'yellow'), row('Bob', 100), row('Eve', 50)] };
  it('returns null without a previous snapshot', () => expect(cycleDiff(cur, null)).toBeNull());
  it('reports net changes, tier flips, added and dropped reps', () => {
    const prev = { day: '2026-09-03', current: { start: '2026-09-10', total: 250, rows: [row('Ann', 100, 'green'), row('Bob', 100), row('Cy', 50)] } };
    const d = cycleDiff(cur, prev);
    expect(d.changed).toEqual([{ rep: 'Ann', from: 100, to: 150 }]);
    expect(d.tier).toEqual([{ rep: 'Ann', from: 'green', to: 'yellow' }]);
    expect(d.added.map(r => r.rep)).toEqual(['Eve']);
    expect(d.dropped.map(r => r.rep)).toEqual(['Cy']);
  });
  it('does not compare nets across different pay weeks', () => {
    const prev = { current: { start: '2026-09-03', total: 0, rows: [row('Ann', 999)] } };
    expect(cycleDiff(cur, prev).changed).toEqual([]);
  });
});

describe('buildAudit + statusLine', () => {
  it('summarises the current week and says no adjustments when clean', () => {
    const a = buildAudit({ weeks: [wk('2026-09-10', '2026-09-16', [row('Ann', 150), row('Bob', 100, 'red', { on: false, net: 0, pay: 0 })])], runs: {}, paid: {}, perDeal: 50, auditThru: '2026-09-02' }, null);
    expect(a.current.reps).toBe(2);
    expect(a.current.paidReps).toBe(1);
    expect(a.current.total).toBe(150);
    expect(statusLine(a)).toBe('Pay week Sep 10: 1 reps, $150 to pay · no adjustments');
  });
  it('names adjustments and chargebacks in the status line', () => {
    const a = buildAudit({
      weeks: [wk('2026-09-10', '2026-09-16', [row('Ann', 150, 'red', { on: false, cb: 300, cbNew: true })]), wk('2026-09-03', '2026-09-09', [row('Bob', 100)])],
      runs: { '2026-09-03': { closed: true } }, paid: { '2026-09-03|Bob': { amount: 50, paid: true } }, perDeal: 50, auditThru: '2026-09-02', rosterSynced: false,
    }, null);
    expect(statusLine(a)).toBe('Pay week Sep 10: 0 reps, $150 to pay · owe $50 to 1, 1 new chargeback, roster sheet did not load');
  });
});
