// Pure logic for the analyst worker. No I/O.

export function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

// Linear-interpolation percentile (p in [0,1]).
export function percentile(nums, p) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const idx = p * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

const dayMs = 24 * 3600 * 1000;

// Sunday on or before dateISO (YYYY-MM-DD).
export function weekOf(dateISO) {
  const d = new Date(`${dateISO}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0 = Sunday
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

// Resolve the manager (team) a rep was on for a given week.
// Override for the exact week wins; else the roster entry for the latest
// week <= weekISO that contains the rep; else null. Override manager
// 'Unassigned' means "no team" -> null.
export function teamFor(rep, weekISO, roster, overrides) {
  const ov = (overrides || []).find((o) => o.rep === rep && o.week === weekISO);
  if (ov) return ov.manager === 'Unassigned' ? null : ov.manager;

  const weeks = Object.keys(roster || {})
    .filter((w) => w <= weekISO)
    .sort()
    .reverse();
  for (const w of weeks) {
    const teams = roster[w] || {};
    for (const [manager, repsList] of Object.entries(teams)) {
      if ((repsList || []).includes(rep)) return manager;
    }
    // A manager who sells belongs to their own team.
    if (Object.prototype.hasOwnProperty.call(teams, rep)) return rep;
  }
  return null;
}

// Build per-rep metrics from raw rows.
// deals: [{ rep, sale_date, install_date }]
// dailyRows: [{ rep, sale_date, deals, installs }] (bria_sales_daily)
// knockingRows: [{ rep, date, doors, sold }]
export function buildPerRep(deals, dailyRows, knockingRows) {
  const reps = new Set([
    ...deals.map((d) => d.rep),
    ...dailyRows.map((d) => d.rep),
    ...knockingRows.map((d) => d.rep),
  ]);
  const perRep = {};
  for (const rep of reps) {
    const repDeals = deals.filter((d) => d.rep === rep);
    const leadTimes = repDeals
      .filter((d) => d.install_date)
      .map((d) => Math.round((Date.parse(d.install_date) - Date.parse(d.sale_date)) / dayMs))
      .filter((n) => Number.isFinite(n));

    const repDaily = dailyRows.filter((d) => d.rep === rep);
    const sold = repDaily.reduce((s, d) => s + (d.deals || 0), 0);
    const installs = repDaily.reduce((s, d) => s + (d.installs || 0), 0);

    const repKnocking = knockingRows.filter((d) => d.rep === rep);
    const doors = repKnocking.reduce((s, d) => s + (d.doors || 0), 0);
    const knockingSold = repKnocking.reduce((s, d) => s + (d.sold || 0), 0);
    const knockingDays = repKnocking.length;

    perRep[rep] = {
      rep,
      deals: repDeals.length,
      leadTimeDays: leadTimes.length ? median(leadTimes) : null,
      soldPerDay: knockingDays ? knockingSold / knockingDays : null,
      installRate: sold ? installs / sold : null,
      doorsPerDay: knockingDays ? doors / knockingDays : null,
    };
  }
  return perRep;
}

// Assign each rep a `team`: the team they were on for their most recent deal
// in the window, falling back to the most common team across their deals;
// no resolvable team -> 'Unassigned'.
export function assignTeams(perRep, deals, roster, overrides) {
  const dealsByRep = {};
  for (const d of deals) {
    if (!d.rep || !d.sale_date) continue;
    (dealsByRep[d.rep] ||= []).push(d);
  }

  for (const rep of Object.keys(perRep)) {
    const repDeals = dealsByRep[rep] || [];
    let team = null;
    if (repDeals.length) {
      const sorted = [...repDeals].sort((a, b) => (a.sale_date < b.sale_date ? 1 : -1));
      const mostRecentTeam = teamFor(rep, weekOf(sorted[0].sale_date), roster, overrides);
      if (mostRecentTeam) {
        team = mostRecentTeam;
      } else {
        const counts = {};
        for (const d of repDeals) {
          const t = teamFor(rep, weekOf(d.sale_date), roster, overrides);
          if (t) counts[t] = (counts[t] || 0) + 1;
        }
        const entries = Object.entries(counts);
        if (entries.length) {
          entries.sort((a, b) => b[1] - a[1]);
          team = entries[0][0];
        }
      }
    }
    perRep[rep].team = team || 'Unassigned';
  }
  return perRep;
}

const METRICS = ['leadTimeDays', 'soldPerDay', 'installRate', 'doorsPerDay'];

// Percentile-band + (for leadTimeDays) 2x-median flags within one pool of rows.
// Rows just need { rep, [metric]: number }; extra fields are ignored.
function bandFlags(rows, metric) {
  const values = rows.map((r) => r[metric]);
  if (values.length < 2) return [];
  const poolMedian = median(values);
  const poolP10 = percentile(values, 0.1);
  const poolP90 = percentile(values, 0.9);
  const band = poolP90 - poolP10;
  const flags = [];

  for (const r of rows) {
    const value = r[metric];
    let direction = null;
    let distance = 0;

    if (value > poolP90) {
      direction = 'high';
      distance = band > 0 ? (value - poolP90) / band : (value > poolMedian ? 1 : 0);
    } else if (value < poolP10) {
      direction = 'low';
      distance = band > 0 ? (poolP10 - value) / band : (value < poolMedian ? 1 : 0);
    }

    if (metric === 'leadTimeDays' && poolMedian > 0 && value > 2 * poolMedian) {
      const d2 = (value - 2 * poolMedian) / poolMedian;
      if (!direction || d2 > distance) {
        direction = 'high';
        distance = Math.max(distance, d2);
      }
    }

    if (direction) {
      flags.push({ rep: r.rep, metric, value, teamMedian: poolMedian, teamP10: poolP10, teamP90: poolP90, direction, distance });
    }
  }
  return flags;
}

// For each metric, compare eligible reps within their team when the team has
// >= minTeam eligible reps; otherwise compare that team's reps against the
// company-wide pool. Flags carry `scope` ('team' | 'company') and `team`.
export function flagOutliers(perRep, minDeals = 5, minTeam = 3) {
  const reps = Object.values(perRep).filter((r) => r.deals >= minDeals);
  const flags = [];

  for (const metric of METRICS) {
    const eligible = reps.filter((r) => typeof r[metric] === 'number');
    if (eligible.length < 2) continue;

    const byTeam = {};
    for (const r of eligible) {
      const team = r.team || 'Unassigned';
      (byTeam[team] ||= []).push(r);
    }

    const companyByRep = {};
    for (const f of bandFlags(eligible, metric)) companyByRep[f.rep] = f;

    for (const [team, teamReps] of Object.entries(byTeam)) {
      if (teamReps.length >= minTeam) {
        for (const f of bandFlags(teamReps, metric)) {
          flags.push({ ...f, scope: 'team', team });
        }
      } else {
        for (const r of teamReps) {
          const f = companyByRep[r.rep];
          if (f) flags.push({ ...f, scope: 'company', team });
        }
      }
    }
  }

  flags.sort((a, b) => b.distance - a.distance);
  return flags.map(({ distance, ...f }) => f);
}

// Roll up per-rep metrics into per-team aggregates.
export function teamRollup(perRep) {
  const byTeam = {};
  for (const r of Object.values(perRep)) {
    const team = r.team || 'Unassigned';
    (byTeam[team] ||= []).push(r);
  }

  const mean = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);
  const rollup = [];
  for (const [team, reps] of Object.entries(byTeam)) {
    const leadTimes = reps.map((r) => r.leadTimeDays).filter((v) => typeof v === 'number');
    const soldPerDays = reps.map((r) => r.soldPerDay).filter((v) => typeof v === 'number');
    const installRates = reps.map((r) => r.installRate).filter((v) => typeof v === 'number');
    const doorsPerDays = reps.map((r) => r.doorsPerDay).filter((v) => typeof v === 'number');
    const deals = reps.reduce((s, r) => s + (r.deals || 0), 0);

    rollup.push({
      team,
      reps: reps.length,
      deals,
      leadTimeDays: leadTimes.length ? median(leadTimes) : null,
      soldPerDay: mean(soldPerDays),
      installRate: mean(installRates),
      doorsPerDay: mean(doorsPerDays),
    });
  }
  return rollup;
}

// Flag teams whose metric falls outside the company band across teams
// (same percentile/2x-median rule), requiring at least `minTeams` teams
// with a value for that metric.
export function flagTeamOutliers(rollup, minTeams = 3) {
  const teamFlags = [];
  for (const metric of METRICS) {
    const eligible = rollup.filter((t) => typeof t[metric] === 'number');
    if (eligible.length < minTeams) continue;
    const rows = eligible.map((t) => ({ rep: t.team, [metric]: t[metric] }));
    for (const f of bandFlags(rows, metric)) {
      teamFlags.push({ ...f, scope: 'teams', team: f.rep });
    }
  }
  teamFlags.sort((a, b) => b.distance - a.distance);
  return teamFlags.map(({ distance, ...f }) => f);
}

function fmt(n) {
  return Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1);
}

function metricPhrase(f, compareLabel) {
  switch (f.metric) {
    case 'leadTimeDays':
      return `books ${fmt(f.value)}d out (${compareLabel} ${fmt(f.teamMedian)}d)`;
    case 'installRate':
      return `install rate ${Math.round(f.value * 100)}% (${compareLabel} ${Math.round(f.teamMedian * 100)}%)`;
    case 'soldPerDay':
      return `${fmt(f.value)} sold/day (${compareLabel} ${fmt(f.teamMedian)})`;
    case 'doorsPerDay':
      return `${fmt(f.value)} doors/day (${compareLabel} ${fmt(f.teamMedian)})`;
    default:
      return `${f.metric} ${f.value} (${compareLabel} ${f.teamMedian})`;
  }
}

function repFlagText(f) {
  return `${f.rep} (${f.team}) ${metricPhrase(f, 'team')}`;
}

function teamFlagText(f) {
  return `team: ${f.team} ${metricPhrase(f, 'co')}`;
}

export function statusLine(flags, teamFlags, repCount) {
  const list = flags || [];
  const teams = teamFlags || [];
  const suffix = teams.length ? ` · ${teamFlagText(teams[0])}` : '';

  let line;
  if (!list.length) {
    line = `No outliers in any team across ${repCount} reps`;
  } else {
    let body = '';
    for (const f of list.slice(0, 3)) {
      const piece = (body ? ', ' : '') + repFlagText(f);
      body += piece;
    }
    line = `${list.length} flags: ${body}`;
  }
  line += suffix;

  if (line.length > 120) {
    if (!list.length) {
      line = line.slice(0, 120);
    } else {
      const head = `${list.length} flags: `;
      let body = '';
      for (const f of list.slice(0, 3)) {
        const piece = (body ? ', ' : '') + repFlagText(f);
        if ((head + body + piece + suffix).length > 120) break;
        body += piece;
      }
      line = (head + body + suffix).slice(0, 120);
    }
  }
  return line;
}
