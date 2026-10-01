import { describe, it, expect } from 'vitest';
import { summarize, statusLine, day } from '../workers/grow/slots.logic.mjs';

const ok = (market, earliest_date, days_out, extra = {}) => ({ isp: 'tds', market, address: `1 Main, ${market}`, checked_at: '2026-09-24T12:00:00Z', ok: true, earliest_date, days_out, windows_first_day: 3, windows_next_7d: 12, error: null, ...extra });
const bad = (market, error) => ({ isp: 'tds', market, checked_at: '2026-09-24T12:00:00Z', ok: false, error });

describe('summarize', () => {
  it('sorts good reads soonest first, failures last', () => {
    const s = summarize('tds', [ok('Oregon', '2026-10-01', 7), bad('Madison', 'boom'), ok('Waunakee', '2026-09-26', 2)]);
    expect(s.markets.map((m) => m.market)).toEqual(['Waunakee', 'Oregon', 'Madison']);
    expect(s.name).toBe('TDS install times');
  });

  it('keeps the newest read per market and ignores other ISPs', () => {
    const s = summarize('tds', [bad('Madison', 'boom'), ok('Madison', '2026-09-25', 1, { checked_at: '2026-09-24T12:05:00Z' }), ok('Braidwood', '2026-09-29', 5, { isp: 'surf' })]);
    expect(s.markets).toHaveLength(1);
    expect(s.markets[0].ok).toBe(true);
  });

  it('flags failed reads, far-out installs and markets with no dates', () => {
    const s = summarize('tds', [ok('Oregon', '2026-10-01', 7), ok('Waunakee', '2026-09-26', 2), bad('Madison', 'TDS 500\nstack'), ok('Stoughton', null, null)]);
    expect(s.flags.map((f) => f.key).sort()).toEqual(['slots:tds:failed', 'slots:tds:far:Oregon', 'slots:tds:none:Stoughton']);
    expect(s.flags.find((f) => f.key.includes('failed')).text).toBe('Madison: could not read the install calendar (TDS 500)');
  });

  it('folds several unread markets into one flag', () => {
    const s = summarize('tds', [bad('Madison', 'TDS 500'), bad('Oregon', 'TDS 500'), ok('Waunakee', '2026-09-26', 2)]);
    expect(s.flags).toEqual([{ key: 'slots:tds:failed', text: '2 markets could not be read (Madison, Oregon): TDS 500', n: 2, severity: 2 }]);
  });
});

describe('statusLine', () => {
  it('names the soonest and latest market', () => {
    expect(statusLine(summarize('tds', [ok('Oregon', '2026-10-01', 7), ok('Waunakee', '2026-09-26', 2), bad('Madison', 'x')])))
      .toBe('TDS: soonest Sep 26 in Waunakee (2d), latest Oct 1 in Oregon (7d) · 2/3 markets, 1 failed');
  });
  it('handles one market and all-failed', () => {
    expect(statusLine(summarize('tds', [ok('Oregon', '2026-10-01', 7)]))).toBe('TDS: earliest Oct 1 in Oregon (7d) · 1/1 markets');
    expect(statusLine(summarize('tds', [bad('Oregon', 'x')]))).toBe('TDS: no install dates read (1 of 1 markets failed)');
  });
  it('formats dates', () => { expect(day('2026-09-04')).toBe('Sep 4'); expect(day(null)).toBe('–'); });
});
