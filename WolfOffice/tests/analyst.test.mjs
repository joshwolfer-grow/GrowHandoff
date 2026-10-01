import { describe, it, expect } from 'vitest';
import {
  median,
  percentile,
  weekOf,
  teamFor,
  buildPerRep,
  assignTeams,
  flagOutliers,
  teamRollup,
  flagTeamOutliers,
  statusLine,
} from '../workers/grow/analyst.logic.mjs';

describe('median', () => {
  it('returns null for empty array', () => {
    expect(median([])).toBeNull();
  });
  it('computes odd-length median', () => {
    expect(median([1, 3, 2])).toBe(2);
  });
  it('computes even-length median as average of middle two', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe('percentile', () => {
  it('returns null for empty array', () => {
    expect(percentile([], 0.5)).toBeNull();
  });
  it('interpolates p10/p90 linearly', () => {
    const vals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(vals, 0.1)).toBeCloseTo(1.9, 5);
    expect(percentile(vals, 0.9)).toBeCloseTo(9.1, 5);
  });
  it('single value returns that value for any percentile', () => {
    expect(percentile([5], 0.1)).toBe(5);
    expect(percentile([5], 0.9)).toBe(5);
  });
});

describe('weekOf', () => {
  it('returns the same date when it is already a Sunday', () => {
    // 2026-08-09 is a Sunday.
    expect(weekOf('2026-08-09')).toBe('2026-08-09');
  });
  it('returns the preceding Sunday for a mid-week date', () => {
    // 2026-08-12 is a Wednesday in the week starting 2026-08-09.
    expect(weekOf('2026-08-12')).toBe('2026-08-09');
  });
});

describe('teamFor', () => {
  const roster = {
    '2026-08-09': { 'Nate Boyd': ['Jeremy Lowe'], 'Anna Lower': ['Brady Miner'] },
    '2026-08-16': { 'Nate Boyd': ['Jeremy Lowe', 'Brady Miner'] },
  };
  const overrides = [{ rep: 'Brady Miner', week: '2026-08-16', manager: 'Gerritt Grondel' }];

  it('an override for the exact week beats the roster', () => {
    expect(teamFor('Brady Miner', '2026-08-16', roster, overrides)).toBe('Gerritt Grondel');
  });

  it('falls back to the roster when there is no override for that week', () => {
    expect(teamFor('Jeremy Lowe', '2026-08-16', roster, overrides)).toBe('Nate Boyd');
  });

  it('falls back to the latest roster week <= the requested week', () => {
    // No roster entry for 2026-08-23; latest <= that week is 2026-08-16.
    expect(teamFor('Brady Miner', '2026-08-23', roster, [])).toBe('Nate Boyd');
  });

  it('returns null when the rep is not found in any applicable week', () => {
    expect(teamFor('Nobody', '2026-08-16', roster, [])).toBeNull();
  });

  it('an override of Unassigned means no team', () => {
    const ov = [{ rep: 'Jeremy Lowe', week: '2026-08-16', manager: 'Unassigned' }];
    expect(teamFor('Jeremy Lowe', '2026-08-16', roster, ov)).toBeNull();
  });
});

describe('buildPerRep', () => {
  it('computes lead time median, sold/day, install rate, doors/day per rep', () => {
    const deals = [
      { rep: 'Al', sale_date: '2026-09-01', install_date: '2026-09-05' },
      { rep: 'Al', sale_date: '2026-09-02', install_date: '2026-09-08' },
      { rep: 'Al', sale_date: '2026-09-03', install_date: null },
    ];
    const daily = [
      { rep: 'Al', sale_date: '2026-09-01', deals: 2, installs: 1 },
      { rep: 'Al', sale_date: '2026-09-02', deals: 1, installs: 1 },
    ];
    const knocking = [
      { rep: 'Al', date: '2026-09-01', doors: 100, sold: 1 },
      { rep: 'Al', date: '2026-09-02', doors: 50, sold: 2 },
    ];
    const perRep = buildPerRep(deals, daily, knocking);
    expect(perRep.Al.deals).toBe(3);
    expect(perRep.Al.leadTimeDays).toBe(5); // median of 4 and 6
    expect(perRep.Al.installRate).toBeCloseTo(2 / 3, 5);
    expect(perRep.Al.soldPerDay).toBeCloseTo(1.5, 5);
    expect(perRep.Al.doorsPerDay).toBeCloseTo(75, 5);
  });

  it('handles a rep with no installs (null leadTimeDays)', () => {
    const deals = [{ rep: 'Bo', sale_date: '2026-09-01', install_date: null }];
    const perRep = buildPerRep(deals, [], []);
    expect(perRep.Bo.leadTimeDays).toBeNull();
  });
});

describe('assignTeams', () => {
  const roster = {
    '2026-08-09': { 'Nate Boyd': ['Al'], 'Anna Lower': ['Bo'] },
  };

  it('assigns the team of the most recent deal in the window', () => {
    const perRep = { Al: { rep: 'Al', deals: 2 } };
    const deals = [
      { rep: 'Al', sale_date: '2026-08-09' },
      { rep: 'Al', sale_date: '2026-08-10' },
    ];
    assignTeams(perRep, deals, roster, []);
    expect(perRep.Al.team).toBe('Nate Boyd');
  });

  it('falls back to Unassigned when no team resolves', () => {
    const perRep = { Ghost: { rep: 'Ghost', deals: 1 } };
    const deals = [{ rep: 'Ghost', sale_date: '2026-08-09' }];
    assignTeams(perRep, deals, roster, []);
    expect(perRep.Ghost.team).toBe('Unassigned');
  });

  it('falls back to the most common team across deals when the most recent has none', () => {
    const overrides = [{ rep: 'Bo', week: '2026-08-16', manager: 'Unassigned' }];
    const perRep = { Bo: { rep: 'Bo', deals: 3 } };
    const deals = [
      { rep: 'Bo', sale_date: '2026-08-09' }, // Anna Lower
      { rep: 'Bo', sale_date: '2026-08-10' }, // Anna Lower
      { rep: 'Bo', sale_date: '2026-08-17' }, // overridden to Unassigned, and most recent
    ];
    assignTeams(perRep, deals, roster, overrides);
    expect(perRep.Bo.team).toBe('Anna Lower');
  });
});

describe('flagOutliers', () => {
  function repRow(rep, team, leadTimeDays) {
    return { rep, team, deals: 10, leadTimeDays, soldPerDay: 1, installRate: 0.8, doorsPerDay: 50 };
  }

  it('compares within team when the team has enough eligible reps, and flags scope/team', () => {
    const perRep = {};
    // Team A: 4 reps, one outlier relative to its own team only.
    for (let i = 0; i < 3; i++) perRep[`A${i}`] = repRow(`A${i}`, 'Team A', 5);
    perRep.AOutlier = repRow('AOutlier', 'Team A', 50);
    // Team B: only 2 reps -> falls back to company comparison.
    perRep.B0 = repRow('B0', 'Team B', 5);
    perRep.B1 = repRow('B1', 'Team B', 6);

    const flags = flagOutliers(perRep, 5, 3);
    const aFlag = flags.find((f) => f.rep === 'AOutlier' && f.metric === 'leadTimeDays');
    expect(aFlag).toBeTruthy();
    expect(aFlag.scope).toBe('team');
    expect(aFlag.team).toBe('Team A');

    // Team B reps should never be flagged as 'team' scope (too few eligible reps).
    const bTeamFlags = flags.filter((f) => f.team === 'Team B' && f.scope === 'team');
    expect(bTeamFlags.length).toBe(0);
  });

  it('falls back to company-wide comparison for a small team', () => {
    const perRep = {};
    for (let i = 0; i < 8; i++) perRep[`C${i}`] = repRow(`C${i}`, 'Big Team', 5);
    perRep.Small0 = repRow('Small0', 'Small Team', 5);
    perRep.Small1 = repRow('Small1', 'Small Team', 60); // extreme outlier vs company too

    const flags = flagOutliers(perRep, 5, 3);
    const flag = flags.find((f) => f.rep === 'Small1' && f.metric === 'leadTimeDays');
    expect(flag).toBeTruthy();
    expect(flag.scope).toBe('company');
    expect(flag.team).toBe('Small Team');
  });

  it('excludes reps below minDeals threshold', () => {
    const perRep = {
      A: { rep: 'A', team: 'T', deals: 2, leadTimeDays: 100, soldPerDay: 1, installRate: 0.8, doorsPerDay: 50 },
      B: repRow('B', 'T', 5),
      C: repRow('C', 'T', 5),
    };
    const flags = flagOutliers(perRep, 5);
    expect(flags.some((f) => f.rep === 'A')).toBe(false);
  });

  it('flags leadTimeDays when more than 2x team median even inside band', () => {
    const perRep = {};
    for (let i = 0; i < 8; i++) perRep[`R${i}`] = repRow(`R${i}`, 'T', 4);
    perRep.Slow = repRow('Slow', 'T', 9);
    const flags = flagOutliers(perRep, 5);
    expect(flags.some((f) => f.rep === 'Slow' && f.metric === 'leadTimeDays' && f.direction === 'high')).toBe(true);
  });

  it('returns no flags when all reps identical', () => {
    const perRep = {};
    for (let i = 0; i < 6; i++) perRep[`R${i}`] = repRow(`R${i}`, 'T', 5);
    expect(flagOutliers(perRep, 5)).toEqual([]);
  });
});

describe('teamRollup and flagTeamOutliers', () => {
  function repRow(rep, team, leadTimeDays) {
    return { rep, team, deals: 10, leadTimeDays, soldPerDay: 1, installRate: 0.8, doorsPerDay: 50 };
  }

  it('rolls up per-rep metrics into per-team aggregates', () => {
    const perRep = {
      A1: repRow('A1', 'Team A', 4),
      A2: repRow('A2', 'Team A', 6),
      B1: repRow('B1', 'Team B', 10),
    };
    const rollup = teamRollup(perRep);
    const teamA = rollup.find((t) => t.team === 'Team A');
    expect(teamA.reps).toBe(2);
    expect(teamA.deals).toBe(20);
    expect(teamA.leadTimeDays).toBe(5); // median of rep medians (4, 6)
  });

  it('flags a team whose metric is outside the company band across teams', () => {
    const perRep = {};
    for (let t = 0; t < 3; t++) {
      perRep[`n${t}`] = repRow(`n${t}`, `Normal${t}`, 5);
    }
    perRep.slow = repRow('slow', 'SlowTeam', 50);
    const rollup = teamRollup(perRep);
    const teamFlags = flagTeamOutliers(rollup, 3);
    expect(teamFlags.some((f) => f.team === 'SlowTeam' && f.metric === 'leadTimeDays')).toBe(true);
  });
});

describe('statusLine', () => {
  it('reports no outliers when there are no rep or team flags', () => {
    expect(statusLine([], [], 12)).toBe('No outliers in any team across 12 reps');
  });

  it('formats top flags with per-metric text and team name', () => {
    const flags = [
      { rep: 'Al', team: 'Team A', metric: 'leadTimeDays', value: 10, teamMedian: 5, teamP10: 3, teamP90: 7, direction: 'high', scope: 'team' },
      { rep: 'Bo', team: 'Team B', metric: 'installRate', value: 0.5, teamMedian: 0.8, teamP10: 0.6, teamP90: 0.9, direction: 'low', scope: 'company' },
    ];
    const line = statusLine(flags, [], 12);
    expect(line).toContain('2 flags:');
    expect(line).toContain('Al (Team A) books 10d out (team 5d)');
    expect(line).toContain('Bo (Team B) install rate 50% (team 80%)');
  });

  it('appends the first team flag when present', () => {
    const flags = [
      { rep: 'Al', team: 'Team A', metric: 'leadTimeDays', value: 10, teamMedian: 5, teamP10: 3, teamP90: 7, direction: 'high', scope: 'team' },
    ];
    const teamFlags = [
      { team: 'Team A', metric: 'soldPerDay', value: 3, teamMedian: 1, teamP10: 0.5, teamP90: 1.5, direction: 'high', scope: 'teams' },
    ];
    const line = statusLine(flags, teamFlags, 12);
    expect(line).toContain('team: Team A 3 sold/day (co 1)');
  });

  it('stays within 120 chars even with long names and many flags', () => {
    const longNames = ['Bartholomew Winchester-Featherstonehaugh', 'Maximilian Constantinopolous-Alexandratos', 'Persephone Van Der Berg-Rothschild'];
    const flags = longNames.map((rep, i) => ({
      rep,
      team: 'A Very Long Team Name Indeed LLC',
      metric: 'leadTimeDays',
      value: 40 + i,
      teamMedian: 5,
      teamP10: 3,
      teamP90: 7,
      direction: 'high',
      scope: 'team',
    }));
    const teamFlags = [
      { team: 'Another Extremely Long Team Name Corporation', metric: 'installRate', value: 0.9, teamMedian: 0.5, teamP10: 0.3, teamP90: 0.6, direction: 'high', scope: 'teams' },
    ];
    const line = statusLine(flags, teamFlags, 50);
    expect(line.length).toBeLessThanOrEqual(120);
    expect(line.startsWith('3 flags:')).toBe(true);
  });

  it('caps at top 3 flags', () => {
    const flags = [1, 2, 3, 4].map((n) => ({
      rep: `R${n}`, team: 'T', metric: 'soldPerDay', value: n, teamMedian: 1, teamP10: 0, teamP90: 2, direction: 'high', scope: 'team',
    }));
    const line = statusLine(flags, [], 10);
    expect(line.startsWith('4 flags:')).toBe(true);
    expect((line.match(/sold\/day/g) || []).length).toBe(3);
  });
});

describe('managers who sell', () => {
  it('are on their own team', async () => {
    const { teamFor } = await import('../workers/grow/analyst.logic.mjs');
    expect(teamFor('Will Gabor', '2026-09-13', { '2026-09-06': { 'Will Gabor': ['Dawson Woodward'] } }, [])).toBe('Will Gabor');
  });
});
