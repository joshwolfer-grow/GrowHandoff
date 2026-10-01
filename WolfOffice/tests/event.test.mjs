import { describe, it, expect } from 'vitest';
import { parseArgs, buildEvent } from '../lib/event.mjs';

describe('parseArgs', () => {
  it('parses start with an agent', () => {
    expect(parseArgs(['start', 'crawler'])).toEqual({ cmd: 'start', agent: 'crawler', flags: {} });
  });
  it('parses flags with values and booleans', () => {
    const r = parseArgs(['finish', 'crawler', '--run', 'r1', '--ok', '--status', 'Synced 12 rows', '--tokens', '10,2']);
    expect(r.flags).toEqual({ run: 'r1', ok: true, status: 'Synced 12 rows', tokens: '10,2' });
  });
  it('rejects unknown commands', () => {
    expect(() => parseArgs(['dance', 'crawler'])).toThrow(/unknown command/);
  });
  it('rejects unknown flags', () => {
    expect(() => parseArgs(['start', 'crawler', '--bogus', 'x'])).toThrow(/unknown flag: --bogus/);
  });
});

describe('buildEvent', () => {
  it('start creates a run id when none is given', () => {
    const e = buildEvent({ cmd: 'start', agent: 'crawler', flags: {} }, () => 'gen1');
    expect(e).toEqual({ agent_id: 'crawler', run_id: 'gen1', kind: 'start', ok: null, status: '', data: {}, tokens_in: null, tokens_out: null });
  });
  it('finish defaults ok to true unless --fail', () => {
    const a = buildEvent({ cmd: 'finish', agent: 'crawler', flags: { run: 'r1', status: 'done' } }, () => 'x');
    const b = buildEvent({ cmd: 'finish', agent: 'crawler', flags: { run: 'r1', fail: true } }, () => 'x');
    expect(a.ok).toBe(true); expect(a.run_id).toBe('r1'); expect(a.status).toBe('done');
    expect(b.ok).toBe(false);
  });
  it('parses tokens and json data', () => {
    const e = buildEvent({ cmd: 'finish', agent: 'crawler', flags: { run: 'r1', tokens: '120,30', data: '{"rows":5}' } }, () => 'x');
    expect(e.tokens_in).toBe(120); expect(e.tokens_out).toBe(30); expect(e.data).toEqual({ rows: 5 });
  });
  it('blocked requires a status', () => {
    expect(() => buildEvent({ cmd: 'blocked', agent: 'crawler', flags: { run: 'r1' } }, () => 'x')).toThrow(/status/);
  });
  it('beat is a heartbeat with its own run id', () => {
    const e = buildEvent({ cmd: 'beat', agent: 'scout', flags: {} }, () => 'h1');
    expect(e.kind).toBe('heartbeat'); expect(e.run_id).toBe('h1');
  });
  it('rejects invalid --data JSON', () => {
    expect(() => buildEvent({ cmd: 'finish', agent: 'crawler', flags: { run: 'r1', data: '{not json' } }, () => 'x')).toThrow();
  });
  it('rejects malformed --tokens', () => {
    expect(() => buildEvent({ cmd: 'finish', agent: 'crawler', flags: { run: 'r1', tokens: '10' } }, () => 'x')).toThrow(/--tokens must be in,out integers/);
    expect(() => buildEvent({ cmd: 'finish', agent: 'crawler', flags: { run: 'r1', tokens: 'a,b' } }, () => 'x')).toThrow(/--tokens must be in,out integers/);
  });
  it('rejects a valueless --run', () => {
    expect(() => buildEvent({ cmd: 'finish', agent: 'crawler', flags: { run: true } }, () => 'x')).toThrow(/--run needs a value/);
  });
  it('rejects a valueless --status on blocked', () => {
    expect(() => buildEvent({ cmd: 'blocked', agent: 'crawler', flags: { run: 'r1', status: true } }, () => 'x')).toThrow(/--status needs a value/);
  });
});
