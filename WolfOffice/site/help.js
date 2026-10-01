// site/help.js — plain-English explanations and fixes for each worker state.
// Per-agent facts (launchd label, log, how to run it now). Generic text covers the rest.
// This file is imported by the browser too, so paths are written with $HOME: the run/fix
// commands go through bash, which expands it, and bin/office-serve.mjs expands it for log files.
// Layout assumed: ~/Grow/GrowSales and ~/Grow/WolfOffice.
const G = '$HOME/Grow/GrowSales';
const W = '$HOME/Grow/WolfOffice';
const LOGS = '$HOME/Library/Logs/wolfoffice';

// Workers that Wolf Office itself schedules (bin/install-workers.sh): label, log and run command follow one pattern.
function wo(name, floor, about, extra = {}) {
  return { about, label: `com.wolfoffice.${name}`, log: `${LOGS}/${name}.log`, run: `node ${W}/workers/${floor}/${name}.mjs`, ...extra };
}
export const FACTS = {
  // ---- Runners (one per floor) ----
  'runner-grow': { about: 'The floor\'s front desk. Any task queued for this floor lands here: a fix the Chief queues for a stale worker, or a job another worker asks for. He walks to that desk and runs it from a fixed menu, then writes down how it went. Anything that writes to live data waits on this card for your Approve.', label: 'com.wolfoffice.runner-grow', log: `${LOGS}/runner-grow.log`, run: `node ${W}/workers/runner/runner.mjs grow` },
  // ---- Chiefs of staff (one per floor) ----
  'chief-grow': { about: 'Once a day after this floor\'s workers have reported, takes roll call: anyone stale gets a Run queued with the Runner, a known failure gets its fix queued for your approval. Then reads every worker\'s latest findings and writes one ranked to-do for the floor, with who owns each item and how many days it has been open. Items that were on yesterday\'s list and are gone today are listed as closed. No model involved.', label: 'com.wolfoffice.chief-grow', log: `${LOGS}/chief-grow.log`, run: `node ${W}/workers/chief/chief.mjs grow` },
  // ---- Grow ----
  crawler:  { about: 'Pulls every knock, lead and sale out of SalesRabbit every five minutes and pushes the day\'s numbers to the Grow dashboard. This is where the live knock counts come from.', label: 'com.grow.sr-sync',       log: `${G}/imports/done/sr-sync.log`,      run: `bash ${G}/scripts/run-grow-sync.sh`,
              failHints: { 3: 'The SalesRabbit sign-in token has expired. Press Fix it now: a SalesRabbit window opens, sign in, and the crawl runs right after.', 137: 'The crawl ran past its 4 minute cap and was killed. Compacting the crawl store usually fixes it: run the compact command below.' },
              failCommands: { 3: `cd ${G} && node scripts/grow-sync.mjs --seed`, 137: `cd ${G} && node scripts/compact-store.mjs` } },
  amplify:  { about: 'Signs into the TDS Amplify portal every five minutes, downloads the knocking reports, and folds them into the knocking data so TDS doors count like everyone else\'s.', label: 'com.grow.amplify-sync',  log: `${G}/imports/done/amplify-sync.log`, run: `bash ${G}/scripts/run-amplify-sync.sh` },
  rtr:      { about: 'Every half hour, syncs the RTR feed and refreshes the numbers that depend on it.', label: 'com.grow.rtr-sync',      log: `${G}/imports/done/rtr-sync.log`,     run: `bash ${G}/scripts/run-rtr-sync.sh` },
  exporter: { about: 'Once a day, rebuilds every ISP\'s knocking workbook on the shared Drive: a summary by city, a tab per week, and every door worked. The ISPs\' links never change. Run now forces a fresh build.', label: 'com.grow.isp-export',    log: `${G}/imports/done/isp-export.log`,   run: `ISP_FORCE=1 bash ${G}/scripts/run-isp-export.sh` },
  courier:  { about: 'Watches the ISP lead-file inbox every five minutes. When a file lands it works out which ISP sent it, archives the original to Drive, and parks it until you tell Claude which rep gets it. Then it builds the SalesRabbit import and the dupes report.', label: 'com.grow.isp-intake',    log: `${G}/imports/done/isp-intake.log`,   run: `bash ${G}/scripts/run-isp-intake.sh`,
              blocked: 'A lead file is parked and needs a rep. Open the lead desk on this card, check the columns, pick the rep and build the import. No Claude Code session needed.' },
  analyst:  wo('analyst', 'grow', 'Every morning, compares each rep against the rest of the team over the last two weeks: booking lead time, sold per day, install rate, doors per day. Anyone outside the team\'s middle 80 percent gets flagged, so a rep booking 18 days out shows up the next morning instead of weeks later.'),
  installs: wo('installs', 'grow', 'Every morning, takes a snapshot of every install date from the install reports and compares it with yesterday\'s. Catches bookings pushed out, cancelled installs, and anything booked more than ten days out.'),
  chaser:   wo('chaser', 'grow', 'Every morning, looks at cancelled-order callbacks from the ISPs and finds the ones nobody has touched in three days, grouped by rep.'),
  payaudit: wo('payaudit', 'grow', 'Every Thursday at 6am, before payroll is processed, opens the Grow dashboard headless and reruns its own upfront pay math: who is owed what this week, every closed week\'s frozen amounts against what is owed now, and what changed since last Thursday. Lists adjustments both ways so an overpayment is caught the week it happens, not at the next audit.', { failHints: { 1: 'Usually the dashboard sign-in or the Bria deal feed. Run it by hand below and read the error line; if it says the access code is not corporate, put a corporate code in ~/Grow/RepText/.env as GROW_ACCESS_CODE.' } }),
  mgrcards: { about: 'Every morning at 9, opens the Grow dashboard headless and draws each manager\'s card: yesterday by rep (sold, doors, contacts, close, time out) and the week so far (sold, PRA, booking days, days, doors per day, close). Texts it from this Mac into the group chat named "Daily Report: <Manager>". Only managers whose team knocked yesterday get one. The Mac has to be awake and unlocked with Messages signed in.', label: 'com.wolfoffice.mgrcards', log: `${LOGS}/mgrcards.log`, run: `node ${G}/scripts/daily-report-text.mjs --scheduled --send`,
              failHints: { 1: 'Read the last lines of the log. "did not land" means Messages was locked, asleep or busy; "Cannot read Messages" means node needs Full Disk Access. A manager with no group is skipped, not a failure: make the group in Messages named exactly "Daily Report: <Manager>".' } },
  // ---- Sales team: one analyst per ISP, same script ----
  'sales-lead': { about: 'Every morning after the ISP desks report, rolls every ISP up into one company view: who sold the most, installs and cancels across the board, every flag ranked, and the wins worth sharing with the team.', label: 'com.wolfoffice.sales-lead', log: `${LOGS}/sales-lead.log`, run: `node ${W}/workers/grow/isp.mjs all` },
  'isp-i3': { about: 'Every morning, does the revenue read for i3 Broadband: sales this week from Bria against the 4-week pace, Bria checked deal by deal against the install report, installs, cancels and why, install rate over 8 weeks, booking lag, past-due installs, doors knocked, and whether the lead file was processed and the export is fresh. Flags anything out of the ordinary and calls out the wins.', label: 'com.wolfoffice.isp-i3', log: `${LOGS}/isp-i3.log`, run: `node ${W}/workers/grow/isp.mjs i3` },
  'isp-slic': { about: 'Every morning, does the revenue read for SLIC: sales this week from Bria against the 4-week pace, Bria checked deal by deal against the install report, installs, cancels and why, install rate over 8 weeks, booking lag, past-due installs, doors knocked, and whether the lead file was processed and the export is fresh. Flags anything out of the ordinary and calls out the wins.', label: 'com.wolfoffice.isp-slic', log: `${LOGS}/isp-slic.log`, run: `node ${W}/workers/grow/isp.mjs slic` },
  'isp-lyte': { about: 'Every morning, does the revenue read for Lyte Fiber: sales this week from Bria against the 4-week pace, Bria checked deal by deal against the install report, installs, cancels and why, install rate over 8 weeks, booking lag, past-due installs, doors knocked, and whether the lead file was processed and the export is fresh. Flags anything out of the ordinary and calls out the wins.', label: 'com.wolfoffice.isp-lyte', log: `${LOGS}/isp-lyte.log`, run: `node ${W}/workers/grow/isp.mjs lyte` },
  'isp-surf': { about: 'Every morning, does the revenue read for Surf: sales this week from Bria against the 4-week pace, Bria checked deal by deal against the install report, installs, cancels and why, install rate over 8 weeks, booking lag, past-due installs, doors knocked, and whether the lead file was processed and the export is fresh. Flags anything out of the ordinary and calls out the wins.', label: 'com.wolfoffice.isp-surf', log: `${LOGS}/isp-surf.log`, run: `node ${W}/workers/grow/isp.mjs surf` },
  'isp-tds': { about: 'Every morning, does the revenue read for TDS: sales this week from Bria against the 4-week pace, Bria checked deal by deal against the install report, installs, cancels and why, install rate over 8 weeks, booking lag, past-due installs, doors knocked, and whether the lead file was processed and the export is fresh. Flags anything out of the ordinary and calls out the wins.', label: 'com.wolfoffice.isp-tds', log: `${LOGS}/isp-tds.log`, run: `node ${W}/workers/grow/isp.mjs tds` },
  'isp-ezee': { about: 'Every morning, does the revenue read for Ezee Fiber: sales this week from Bria against the 4-week pace, Bria checked deal by deal against the install report, installs, cancels and why, install rate over 8 weeks, booking lag, past-due installs, doors knocked, and whether the lead file was processed and the export is fresh. Flags anything out of the ordinary and calls out the wins.', label: 'com.wolfoffice.isp-ezee', log: `${LOGS}/isp-ezee.log`, run: `node ${W}/workers/grow/isp.mjs ezee` },
  'isp-omni': { about: 'Every morning, does the revenue read for Omni Fiber: sales this week from Bria against the 4-week pace, Bria checked deal by deal against the install report, installs, cancels and why, install rate over 8 weeks, booking lag, past-due installs, doors knocked, and whether the lead file was processed and the export is fresh. Flags anything out of the ordinary and calls out the wins.', label: 'com.wolfoffice.isp-omni', log: `${LOGS}/isp-omni.log`, run: `node ${W}/workers/grow/isp.mjs omni` },
  'slots-tds': { about: "Three times a day, walks TDS's own signup flow for a real door in each market it sells in, up to the install calendar, and reads the earliest install date and how many windows are open that day and over the next week. It never submits an order or books a slot. Flags a market whose earliest install is a week or more out, one with no dates, and any door it could not read. The doors live in GrowSales data/install-slot-probes.json.", label: 'com.wolfoffice.slots-tds', log: `${LOGS}/slots-tds.log`, run: `node ${W}/workers/grow/slots.mjs tds`, failHints: { 1: "TDS's portal throws a bare 500 now and then. Each door already gets three tries, so a failure usually clears on the next run. If it keeps failing, watch it: cd ~/Grow/GrowSales && node scripts/install-slots.mjs --isp tds --headed --dry", 3: "TDS's portal throws a bare 500 now and then. Each door already gets three tries, so a failure usually clears on the next run. If it keeps failing, watch it: cd ~/Grow/GrowSales && node scripts/install-slots.mjs --isp tds --headed --dry" } },
  'slots-surf': { about: "Three times a day, walks Surf's own signup flow for a real door in each market it sells in, up to the install calendar, and reads the earliest install date and how many windows are open that day and over the next week. It never submits an order or books a slot. Flags a market whose earliest install is a week or more out, one with no dates, and any door it could not read. The doors live in GrowSales data/install-slot-probes.json.", label: 'com.wolfoffice.slots-surf', log: `${LOGS}/slots-surf.log`, run: `node ${W}/workers/grow/slots.mjs surf`, failHints: { 1: "Surf needs the rep User ID and PIN in GrowSales .env.install-slots on every visit. If they were rejected or the portal changed, watch it: cd ~/Grow/GrowSales && node scripts/install-slots.mjs --isp surf --headed --dry", 3: "Surf needs the rep User ID and PIN in GrowSales .env.install-slots on every visit. If they were rejected or the portal changed, watch it: cd ~/Grow/GrowSales && node scripts/install-slots.mjs --isp surf --headed --dry" } },
};

export function cadenceText(sec) {
  if (!sec) return 'only when asked';
  if (sec < 3600) return `every ${Math.round(sec / 60)} minutes`;
  if (sec < 86400) return `every ${Math.round(sec / 3600)} hour${sec >= 7200 ? 's' : ''}`;
  return `every ${Math.round(sec / 86400)} day${sec >= 172800 ? 's' : ''}`;
}
export function ageText(iso) {
  if (!iso) return 'no reports yet';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now'; if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.floor(m / 60); if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `${Math.round(h / 24)} days ago`;
}

// Returns { headline, why, steps: [] , commands: [] } or null when nothing is wrong.
export function explain(agent, status) {
  const f = FACTS[agent.id] || {};
  const name = agent.name;
  if (status.state === 'stale') {
    const steps = [
      status.lastAt ? `${name} should report ${cadenceText(agent.cadence_seconds)}. Its last report was ${ageText(status.lastAt)}.` : `${name} should report ${cadenceText(agent.cadence_seconds)} but has not reported at all yet.`,
      'Most often this means the Mac was asleep or the scheduled job stopped. If the Mac was just asleep, it will catch up on its own within one cycle.',
    ];
    const commands = [];
    if (f.label) {
      steps.push('Check that the job is loaded, restart it, or run the work right now. Each button runs on this Mac and shows the result here. Restarting only reloads the schedule; use Run it now to get a report immediately.');
      commands.push({ label: 'Check the job', action: 'check', text: `launchctl list | grep ${f.label}` });
      commands.push({ label: 'Restart the job', action: 'restart', text: `launchctl unload ~/Library/LaunchAgents/${f.label}.plist; launchctl load ~/Library/LaunchAgents/${f.label}.plist` });
      if (f.run) commands.push({ label: 'Run it now', action: 'run', text: f.run });
    } else if (f.observed) {
      steps.push('This job runs elsewhere, not on this Mac. Press Run now to re-read the database and refresh the report.');
      commands.push({ label: 'Re-check now', action: 'run', text: f.run });
    } else {
      steps.push('This worker has no scheduled job on this Mac yet. It runs when you ask for it.');
    }
    return { headline: `${name} has gone quiet`, steps, commands, log: f.log };
  }
  if (status.state === 'failed') {
    const code = /exit (\d+)/.exec(status.bubble || '');
    const hint = code && f.failHints && f.failHints[code[1]];
    const steps = [
      `The last run of ${name} ended with an error${status.bubble ? `: "${status.bubble}"` : ''}.`,
      f.log ? 'Open the log below to see what went wrong. The last few lines usually say.' : 'Check the run history below for the error.',
      `It will try again on its own ${cadenceText(agent.cadence_seconds)}. To run it now, use the command below.`,
    ];
    if (hint) steps.splice(1, 0, hint);
    const commands = [];
    if (hint && f.failCommands && f.failCommands[code[1]]) commands.push({ label: 'Fix it now', action: 'fix', code: code[1], text: f.failCommands[code[1]] });
    if (f.log) commands.push({ label: 'Show the log', action: 'log', text: `tail -40 "${f.log}"` });
    if (f.run) commands.push({ label: 'Run it now', action: 'run', text: f.run });
    return { headline: `${name}'s last run failed`, steps, commands, log: f.log };
  }
  if (status.state === 'blocked') {
    return { headline: `${name} needs you`, steps: [status.bubble ? `It says: "${status.bubble}"` : 'It stopped and is waiting for a decision.', f.blocked || 'Give it what it asked for and it will carry on.'], commands: [], log: f.log };
  }
  return null;
}

// ---------- Plain English ----------
// What each worker says while it runs. Each output line is checked against these in order;
// the first match is said once. A phrase can be a function of the regex match.
const ISP = (s) => ({ i3: 'i3', slic: 'SLIC', lyte: 'Lyte', surf: 'Surf', tds: 'TDS', ezee: 'Ezee', omni: 'Omni', bluepeak: 'Bluepeak', gfiber: 'GFiber', nlf: 'NLF', glo: 'Glo', gbn: 'GBN' }[String(s).toLowerCase()] || s);
export const TALK = {
  amplify: [
    [/Starting Chrome/, "I'm loading up TDS now"],
    [/Pulling Lead Status/, "I'm pulling the report now"],
    [/Wrote .* rows/, "I'm adding it in"],
    [/still going, skipping/, 'I was already mid-run, so I let that one finish'],
  ],
  crawler: [
    [/^Crawl:/, "I'm checking SalesRabbit for anything new"],
    [/activity \d+\//, "I'm pulling the leads that changed"],
    [/^Compile/, "I'm adding up the numbers"],
    [/^Supabase:/, "I'm sending it to the dashboard"],
  ],
  rtr: [
    [/\[(\w+)\] Rendering/, m => `I'm pulling the ${ISP(m[1])} report`],
    [/\[(\w+)\] Wrote/, m => `I'm adding ${ISP(m[1])} in`],
  ],
  exporter: [
    [/^Lead details|^Compiled:/, "I'm gathering every door"],
    [/^\s*(\w+): \d+ weeks/, m => `I'm building the ${ISP(m[1])} workbook`],
    [/^\d+ (\w+) doors,/, m => `I'm updating the ${ISP(m[1])} map`],
    [/workbooks on Drive/, "I'm putting them on Drive"],
  ],
  courier: [
    [/^\s+ISP\s+(\S+)/, m => `Found a lead file from ${ISP(m[1])}`],
    [/^\s+archived/, "I'm saving the original to Drive"],
    [/Needs a rep|waiting for review/, 'It needs a rep. Tell Claude who gets it'],
  ],
  payaudit: [[/Chrome|browser|launch/i, "I'm opening the Grow dashboard"]],
};
const GENERIC_TALK = [
  [/Known problem \(exit \d+\)/, 'I hit a snag I know how to fix. Fixing it now'],
  [/Fixed\. Running/, 'Fixed. Running it again'],
];

// Next plain line for one raw output line, or null.
export function talkLine(agentId, raw) {
  for (const [re, say] of [...(TALK[agentId] || []), ...GENERIC_TALK]) {
    const m = re.exec(raw); if (m) return typeof say === 'function' ? say(m) : say;
  }
  return null;
}

// A saved status line turned into something a person would say. names: id -> display name.
export function sayStatus(agent, status, names = {}) {
  const b = (status && status.bubble || '').trim();
  const f = FACTS[agent.id] || {};
  if (!status) return '';
  if (status.state === 'working') return b && !/^Run the job now/.test(b) ? b : "I'm working on it now";
  if (status.state === 'offduty') return "I'm off right now. Back next session";
  if (status.state === 'stale') return status.lastAt ? `I haven't checked in since ${ageText(status.lastAt)}` : "I haven't checked in yet";
  if (status.state === 'failed') {
    const code = /exit (\d+)/.exec(b);
    return (code && f.failHints && f.failHints[code[1]]) || "My last run didn't work";
  }
  if (status.state === 'blocked') return f.blocked || b || 'I need you before I can keep going';
  const talked = b && talkLine(agent.id, b); if (talked) return talked;
  let m;
  if ((m = /^Run the job now for ([\w-]+): (.*)$/.exec(b))) return /^exit \d+$/.test(m[2]) ? `Ran ${names[m[1]] || m[1]} for you. It didn't work` : `Ran ${names[m[1]] || m[1]} for you: ${m[2]}`;
  if ((m = /^Front desk: nothing waiting/.exec(b))) return 'Nothing waiting on me';
  if ((m = /^Roll call (\d+)\/(\d+) · (.*)$/.exec(b))) {
    const all = m[1] === m[2] ? 'Everyone checked in' : `${m[1]} of ${m[2]} checked in`;
    const todo = /to-do list clear/.test(m[3]) ? 'nothing on your list' : m[3].replace(/(\d+) to-dos?/, '$1 things on your list').replace(/(\d+) carried over/, '$1 from before').replace(/(\d+) closed/, '$1 cleared');
    return `${all}. ${todo}`;
  }
  if (!b || /^exit 0$/.test(b)) return status.lastAt ? `All caught up (${ageText(status.lastAt)})` : 'All caught up';
  return b;
}
