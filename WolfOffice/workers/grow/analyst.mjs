#!/usr/bin/env node
// Analyst: flags reps whose booking lead time, sold/day, install rate, or
// doors/day are outliers vs. the team over the last 14 days.
import { growGet } from '../../lib/growdb.mjs';
import { writeSnapshot, today } from '../../lib/db.mjs';
import { buildPerRep, assignTeams, flagOutliers, teamRollup, flagTeamOutliers, statusLine } from './analyst.logic.mjs';

function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('en-CA');
}

// The Grow config stores config.teams[week] as an array of team records
// ({ manager, members: [...] }), not the { manager: [members] } map the
// analyst logic works with. Normalize it, merging multiple team records
// that share the same manager within a week.
function normalizeRoster(rawTeams) {
  const roster = {};
  for (const [week, entry] of Object.entries(rawTeams || {})) {
    const teams = {};
    if (Array.isArray(entry)) {
      for (const teamRecord of entry) {
        const manager = teamRecord?.manager;
        const members = teamRecord?.members;
        if (!manager || !Array.isArray(members)) continue;
        (teams[manager] ||= []).push(...members);
      }
    } else if (entry && typeof entry === 'object') {
      // Already in { manager: [members] } shape.
      for (const [manager, members] of Object.entries(entry)) {
        teams[manager] = Array.isArray(members) ? members : [];
      }
    }
    roster[week] = teams;
  }
  return roster;
}

async function main() {
  const since = daysAgoISO(14);

  const [deals, dailyRows, knockingRows, rosterRows, overrides] = await Promise.all([
    growGet(`bria_deals?select=rep,sale_date,install_date&sale_date=gte.${since}`),
    growGet(`bria_sales_daily?select=rep,sale_date,deals,installs&sale_date=gte.${since}`),
    growGet(`knocking?select=rep,date,doors,sold&date=gte.${since}`),
    growGet(`report_config?select=config&manager=eq.__sequifi_teams__`),
    growGet(`rep_manager_overrides?select=rep,week,manager`),
  ]);

  const roster = normalizeRoster(rosterRows?.[0]?.config?.teams);
  const rosterWeeks = Object.keys(roster).sort();
  const rosterWeek = rosterWeeks.length ? rosterWeeks[rosterWeeks.length - 1] : null;

  const perRep = buildPerRep(deals, dailyRows, knockingRows);
  assignTeams(perRep, deals, roster, overrides);
  const flags = flagOutliers(perRep, 5);
  const teams = teamRollup(perRep);
  const teamFlags = flagTeamOutliers(teams);
  const repCount = Object.keys(perRep).length;

  await writeSnapshot('analyst', today(), { perRep, flags, teamFlags, teams, rosterWeek });
  console.log(statusLine(flags, teamFlags, repCount));
}

main().catch((err) => {
  console.log(`error: ${err.message}`);
  process.exit(1);
});
