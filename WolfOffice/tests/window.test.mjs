import { describe, it, expect } from 'vitest';
import { deriveStatus, inWindow } from '../site/status.mjs';

const win = { days: [1, 2, 3, 4, 5], start: '06:30', end: '14:15' };
const at = (iso) => new Date(iso).getTime();

describe('inWindow', () => {
  it('true inside a weekday window', () => { expect(inWindow(win, at('2026-09-14T10:00:00'))).toBe(true); });   // Monday local
  it('false before start and after end', () => {
    expect(inWindow(win, at('2026-09-14T06:00:00'))).toBe(false);
    expect(inWindow(win, at('2026-09-14T15:00:00'))).toBe(false);
  });
  it('false on a weekend', () => { expect(inWindow(win, at('2026-09-13T10:00:00'))).toBe(false); });
  it('true when there is no window', () => { expect(inWindow(null, at('2026-09-13T10:00:00'))).toBe(true); });
});

describe('off duty', () => {
  const agent = { id: 'scout', cadence_seconds: 300, duty: win };
  it('is offduty outside the window with no recent events', () => {
    expect(deriveStatus(agent, [], at('2026-09-14T20:00:00')).state).toBe('offduty');
  });
  it('is stale inside the window with no recent events', () => {
    expect(deriveStatus(agent, [], at('2026-09-14T10:00:00')).state).toBe('stale');
  });
  it('a failed finish still shows failed off duty', () => {
    const e = { agent_id: 'scout', kind: 'finish', ok: false, status: 'exit 1', created_at: '2026-09-14T14:10:00' };
    expect(deriveStatus(agent, [e], at('2026-09-14T20:00:00')).state).toBe('failed');
  });
});
