import { describe, it, expect } from 'vitest';
import { treeModel, renderTree, renderRadial, coverage, worst } from '../site/tree.js';

const agents = [
  { id: 'runner-grow', floor: 'grow', name: 'Runner', team: 'Front Desk', lead: false, sort: 1 },
  { id: 'crawler', floor: 'grow', name: 'Crawler', team: 'Ops', lead: true, sort: 2 },
  { id: 'courier', floor: 'grow', name: 'Courier', team: 'Ops', lead: false, sort: 3 },
  { id: 'sales-lead', floor: 'grow', name: 'Sales lead', team: 'Sales', lead: true, sort: 4 },
  { id: 'isp-surf', floor: 'grow', name: 'Surf <analyst>', team: 'Sales', lead: false, sort: 5 },
  { id: 'chief-grow', floor: 'grow', name: 'Chief of staff', team: 'Leadership', lead: true, sort: 9 },
  { id: 'scout', floor: 'ops', name: 'Scout', team: 'Field Desk', lead: true, sort: 1 },
];
const states = { 'isp-surf': 'failed', courier: 'blocked', crawler: 'working' };
const stateOf = (id) => states[id];

describe('worst', () => {
  it('ranks failed over blocked over stale over the rest', () => {
    expect(worst(['idle', 'working'])).toBe('working');
    expect(worst(['stale', 'blocked', 'working'])).toBe('blocked');
    expect(worst(['blocked', 'failed'])).toBe('failed');
    expect(worst([])).toBe('idle');
  });
});

describe('treeModel', () => {
  const m = treeModel(agents, 'grow', stateOf);
  it('pulls the chief and the front desk out of the teams', () => {
    expect(m.chief.id).toBe('chief-grow');
    expect(m.desk.map(a => a.id)).toEqual(['runner-grow']);
    expect(m.teams.map(t => t.name)).toEqual(['Ops', 'Sales']);
  });
  it('splits each team into its lead and members, and keeps other floors out', () => {
    const ops = m.teams[0];
    expect(ops.lead.id).toBe('crawler');
    expect(ops.members.map(a => a.id)).toEqual(['courier']);
    expect(JSON.stringify(m)).not.toContain('scout');
  });
  it('rolls the worst state up the branch to the floor', () => {
    expect(m.teams[0].state).toBe('blocked');
    expect(m.teams[1].state).toBe('failed');
    expect(m.state).toBe('failed');
  });
  it('hangs planned desks on their team and counts them', () => {
    expect(m.teams[0].planned.map(p => p.name)).toContain('Stats clerk');
    expect(coverage(m)).toEqual({ staffed: 6, planned: 3 });
    const bare = treeModel(agents, 'ops', stateOf);
    expect(coverage(bare)).toEqual({ staffed: 1, planned: 0 });
  });
  it('still shows a planned team that has no workers yet', () => {
    const m2 = treeModel(agents, 'grow', stateOf, { grow: { Recruiting: [{ name: 'Ad clerk' }] } });
    expect(m2.teams.find(t => t.name === 'Recruiting')).toMatchObject({ lead: null, members: [], planned: [{ name: 'Ad clerk' }] });
  });
});

describe('renderTree', () => {
  const m = treeModel(agents, 'grow', stateOf);
  const html = renderTree(m, stateOf, (id) => (id === 'courier' ? ['Lead desk', '/leads.html', 'Open the lead desk'] : null));
  it('draws every worker as a clickable node and escapes names', () => {
    for (const id of ['chief-grow', 'runner-grow', 'crawler', 'courier', 'sales-lead', 'isp-surf']) expect(html).toContain(`data-open="${id}"`);
    expect(html).toContain('Surf &lt;analyst&gt;'); expect(html).not.toContain('<analyst>');
  });
  it('gives a worker with its own page an open chip', () => {
    expect(html).toContain('data-overlay="/leads.html"');
    expect(html.match(/data-overlay=/g).length).toBe(1);
  });
  it('lights the failed branch and marks planned desks', () => {
    expect(html).toContain('stroke="#F09595" stroke-width="2"');
    expect(html).toContain('Stats clerk'); expect(html).toContain('stroke-dasharray');
    expect(html).toContain('6 staffed · 3 planned');
  });
  it('draws a floor with no chief and no workers without throwing', () => {
    expect(renderTree(treeModel([], 'decision', stateOf), stateOf, null)).toContain('DECISION');
  });
});

describe('renderRadial', () => {
  const models = ['grow', 'ops', 'decision'].map(f => treeModel(agents, f, stateOf));
  const html = renderRadial(models, stateOf, (id) => (id === 'courier' ? ['Lead desk', '/leads.html', 'Open'] : null), { grow: 'Grow' });
  it('puts every floor and every worker on one map that fits its box', () => {
    for (const f of ['grow', 'ops', 'decision']) expect(html).toContain(`data-floor="${f}"`);
    for (const id of ['runner-grow', 'crawler', 'courier', 'sales-lead', 'isp-surf', 'scout']) expect(html).toContain(`data-open="${id}"`);
    expect(html).toContain('data-box="0 0 1500 1010"'); expect(html).toContain('preserveAspectRatio="xMidYMid meet"');
    expect(html).toContain('Grow · 6'); expect(html).toContain('>You<');
  });
  it('keeps the open chip, the planned desks and the lit branch', () => {
    expect(html).toContain('data-overlay="/leads.html"'); expect(html).toContain('Stats clerk (planned)');
    expect(html).toContain('stroke="#F09595" stroke-width="2"');
    expect(html).toContain('7 staffed · 3 planned');
  });
  it('never emits NaN coordinates, even with no floors', () => {
    expect(html).not.toContain('NaN'); expect(renderRadial([], stateOf, null)).not.toContain('NaN');
  });
});
