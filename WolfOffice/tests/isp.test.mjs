import { describe, it, expect } from 'vitest';
import { analyze, statusLine, rollup, rollupLine, repIspByWeek, weekOf, shiftDays } from '../workers/grow/isp.logic.mjs';

const today = '2026-09-16';                 // a Wednesday; week of 2026-09-13
const wk = weekOf(today);
const deal = (o) => ({ rep: 'Ann', status: 'Pending', isp: 'i3 Broadband', sale_date: today, install_date: null, cancel_date: null, cancel_reason: null, planned_install: null, past_due: false, deal_type: 'Standard', ...o });
function baseline(perWeek, weeksBack = 4, extra = {}) {
  const out = [];
  for (let w = 1; w <= weeksBack; w++) for (let i = 0; i < perWeek; i++) out.push(deal({ sale_date: shiftDays(wk, -7 * w + (i % 5)), status: 'Serviced', install_date: shiftDays(wk, -7 * w + 3), rep: ['Ann', 'Bob', 'Cy'][i % 3], ...extra }));
  return out;
}

describe('analyze', () => {
  it('flags a slow sales week against the 4-week average', () => {
    const deals = [...baseline(20), deal({ sale_date: shiftDays(wk, 1) }), deal({ sale_date: shiftDays(wk, 2) })];
    const s = analyze({ ispKey: 'i3', deals, today });
    expect(s.sold).toBe(2); expect(s.soldAvg).toBe(20); expect(s.daysIn).toBe(2);
    expect(s.flags.find(f => f.key === 'i3:sales-slow')).toBeTruthy();
    expect(statusLine(s)).toMatch(/^i3 Broadband: 2 sold this week/);
  });
  it('celebrates a hot week, a record week and a clean week', () => {
    const deals = [...baseline(20), ...Array.from({ length: 16 }, (_, i) => deal({ sale_date: shiftDays(wk, 1 + (i % 2)) }))];
    const s = analyze({ ispKey: 'i3', deals, today });
    expect(s.wins.map(w => w.key)).toEqual(expect.arrayContaining(['i3:sales-hot', 'i3:clean-week']));
  });
  it('flags cancel spikes, a dominant reason, and a rep with three cancels', () => {
    const deals = [...baseline(10), ...Array.from({ length: 4 }, () => deal({ status: 'Cancelled', cancel_date: today, cancel_reason: 'moved', rep: 'Dee' }))];
    const s = analyze({ ispKey: 'i3', deals, today });
    const keys = s.flags.map(f => f.key);
    expect(keys).toEqual(expect.arrayContaining(['i3:cancels-up', 'i3:reason', 'i3:rep-cancels:Dee']));
    expect(s.flags[0].severity).toBe(3);
  });
  it('flags a falling install rate and past-due installs', () => {
    const good = baseline(10, 16, {}).map((d, i) => (d.sale_date < shiftDays(wk, -56) ? d : { ...d, status: i % 3 === 0 ? 'Cancelled' : 'Serviced', cancel_date: d.sale_date }));
    const late = Array.from({ length: 3 }, () => deal({ sale_date: shiftDays(today, -12), planned_install: shiftDays(today, -2) }));
    const s = analyze({ ispKey: 'i3', deals: [...good, ...late], today });
    expect(s.installRatePrev).toBe(100);
    expect(s.installRate).toBeLessThan(90);
    expect(s.flags.map(f => f.key)).toEqual(expect.arrayContaining(['i3:install-rate', 'i3:past-due']));
  });
  it('flags parked lead files and a stale export', () => {
    const s = analyze({ ispKey: 'slic', deals: baseline(3), today, exportStampAge: 50, parkedFiles: ['slic leads 9-15.xlsx'] });
    expect(s.flags.map(f => f.key)).toEqual(expect.arrayContaining(['slic:lead-file', 'slic:export-stale']));
  });
  it('attributes doors and reports sold per 100 doors', () => {
    const s = analyze({ ispKey: 'i3', deals: [...baseline(10), deal(), deal()], knocking: [{ rep: 'Ann', date: today, doors: 100 }, { rep: 'Bob', date: shiftDays(wk, -8), doors: 300 }], today });
    expect(s.doors).toBe(100); expect(s.soldPer100).toBe(2);
  });
});

describe('repIspByWeek + rollup', () => {
  it('maps each rep to the ISP they sold most that week', () => {
    const m = repIspByWeek([{ rep: 'Ann', isp: 'SLIC', sale_date: today }, { rep: 'Ann', isp: 'SLIC', sale_date: today }, { rep: 'Ann', isp: 'i3 Broadband', sale_date: today }]);
    expect(m.Ann[wk]).toBe('SLIC');
  });
  it('ranks ISPs and pools flags and wins', () => {
    const a = analyze({ ispKey: 'i3', deals: [...baseline(10), deal(), deal(), deal()], today });
    const b = analyze({ ispKey: 'tds', deals: [...baseline(10, 4, { isp: 'TDS' }), deal({ isp: 'TDS' })], today });
    const r = rollup([b, a]);
    expect(r.isps[0].isp).toBe('i3'); expect(r.sold).toBe(4);
    expect(rollupLine(r)).toMatch(/^Company: 4 sold this week/);
    expect(r.flags.every(f => f.isp)).toBe(true);
  });
});

import { pairDeals, reconcile, reportThrough } from '../workers/grow/isp.logic.mjs';
describe('Bria vs install report', () => {
  it('pairs by phone, name variants and dates like the dashboard', () => {
    const bria = [{ customer: 'Micheal Moody', sale_date: '2026-09-01' }, { customer: 'Poer', sale_date: '2026-09-02' }, { customer: 'Ann Lee', phone: '(555) 111-2222', sale_date: '2026-09-03' }, { customer: 'Zed Nobody', sale_date: '2026-09-03' }];
    const rep = [{ customer: 'MICHAEL MOODY', sale_date: '2026-09-01' }, { customer: 'Geoffrey Poer', sale_date: '2026-09-02' }, { customer: 'Annie Smith', phone: '5551112222', sale_date: '2026-09-03' }, { customer: 'Only Report', sale_date: '2026-09-03' }];
    const { bm, taken } = pairDeals(bria, rep);
    expect(bm).toEqual([0, 1, 2, -1]);
    expect(taken).toEqual([true, true, true, false]);
  });
  it('holds sales newer than the report as waiting, not missing', () => {
    const reports = ['2026-09-01', '2026-09-01', '2026-09-01', '2026-09-01', '2026-09-02', '2026-09-02', '2026-09-02', '2026-09-02', '2026-09-05'].map((d, i) => ({ customer: 'R' + i + ' X', sale_date: d }));
    expect(reportThrough(reports)).toBe('2026-09-02');
    const r = reconcile({ bria: [{ customer: 'New Sale', sale_date: '2026-09-04' }, { customer: 'Lost Sale', sale_date: '2026-09-01' }], reports, from: '2026-08-01', today: '2026-09-10' });
    expect(r.awaiting).toBe(1);
    expect(r.notOnReport.map(x => x.customer)).toEqual(['Lost Sale']);
    expect(r.reportOnly.length).toBe(9);
  });
});
