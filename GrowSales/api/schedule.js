// api/schedule.js
// The weekly schedule form at /schedule?team=<manager>. Public link, no sign in.
//
//   GET  ?team=&week=   team roster for that week + what each rep already submitted
//   POST {team, rep, week, days:[{d,s,e}], off_week}
//
// A public form cannot hold a secret, so this endpoint is fenced instead: a rep
// can only write their own row, for a name that is on that team's roster, for
// this week or next week. Past weeks are frozen so hours cannot be rewritten
// after the fact.
//
// Roster = the team's Sequifi week (report_config.__sequifi_teams__, falling back
// to the latest built week, since next week is usually not built yet) plus reps
// the manager added by hand, minus anyone hidden. Same rule as renderSchedule().
//
// Table: api/team-schedule.sql.

function growBase() { return (process.env.SUPABASE_URL || '').replace(/\/$/, '') + '/rest/v1'; }
function growHeaders(extra) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return Object.assign({ apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, extra || {});
}
async function get(path) {
  const r = await fetch(`${growBase()}/${path}`, { headers: growHeaders() });
  if (!r.ok) throw new Error(`${path.split('?')[0]}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const iso = (d) => d.toISOString().slice(0, 10);
function addDays(ds, n) { const d = new Date(ds + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
// Sunday of the current week in Mountain time, where the teams are. A UTC Sunday
// would flip to next week on Saturday evening.
function thisSunday() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date());
  const d = new Date(today + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return iso(d);
}

async function rosterFor(team, week) {
  const [rc, edits] = await Promise.all([
    get('report_config?select=config&manager=eq.__bria_teams__&limit=1'),
    get(`team_roster?select=rep,added,hidden&team=eq.${encodeURIComponent(team)}`),
  ]);
  const weeks = ((rc[0] || {}).config || {}).weeks || {};
  const built = Object.keys(weeks).filter((w) => w <= week).sort();
  // A team that only exists on a later built week still counts (rare, but a
  // brand new team gets built mid week).
  const src = built.length ? weeks[built[built.length - 1]] : {};
  const known = Object.values(weeks).some((w) => w && w[team]) || edits.length > 0;
  const names = new Set((src[team] || []).filter(Boolean));
  edits.forEach((e) => { if (e.added) names.add(e.rep); });
  edits.forEach((e) => { if (e.hidden) names.delete(e.rep); });
  return { known, reps: [...names].sort((a, b) => a.localeCompare(b)) };
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { resolve({}); } });
  });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const cur = thisSunday(), next = addDays(cur, 7);
    if (req.method === 'GET') {
      const team = String((req.query && req.query.team) || '').trim();
      const week = [cur, next].includes(req.query && req.query.week) ? req.query.week : cur;
      if (!team) return res.status(400).json({ error: 'Missing team' });
      const r = await rosterFor(team, week);
      if (!r.known) return res.status(404).json({ error: 'That team link is not valid. Ask your manager for a new one.' });
      const rows = await get(`rep_schedules?select=rep,days,off_week,submitted_at&team=eq.${encodeURIComponent(team)}&week_start=eq.${week}`);
      const submitted = {};
      rows.forEach((x) => { submitted[x.rep] = { days: x.days || [], off_week: !!x.off_week, submitted_at: x.submitted_at }; });
      return res.status(200).json({ team, week, weeks: [cur, next], reps: r.reps, submitted });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const b = await readBody(req);
    const team = String(b.team || '').trim(), rep = String(b.rep || '').trim(), week = String(b.week || '');
    if (!team || !rep) return res.status(400).json({ error: 'Pick your name first.' });
    if (![cur, next].includes(week)) return res.status(400).json({ error: 'You can only submit this week or next week.' });
    const r = await rosterFor(team, week);
    if (!r.reps.includes(rep)) return res.status(403).json({ error: 'Your name is not on this team. Text your manager.' });

    const offWeek = !!b.off_week;
    const seen = new Set(), days = [];
    if (!offWeek) {
      for (const x of Array.isArray(b.days) ? b.days : []) {
        const d = String(x && x.d || ''), s = Number(x && x.s), e = Number(x && x.e);
        if (d < week || d > addDays(week, 6) || seen.has(d)) return res.status(400).json({ error: 'A day is outside this week.' });
        const ok = Number.isInteger(s) && Number.isInteger(e) && s % 15 === 0 && e % 15 === 0 && s >= 0 && e <= 1440 && e > s;
        if (!ok) return res.status(400).json({ error: `Check the times on ${d}. The end has to be after the start.` });
        seen.add(d);
        days.push({ d, s, e });
      }
      if (!days.length) return res.status(400).json({ error: 'Turn on at least one day, or tap Not working this week.' });
    }
    days.sort((a, b2) => a.d.localeCompare(b2.d));
    const hours = Math.round(days.reduce((t, x) => t + (x.e - x.s), 0) / 60 * 100) / 100;

    const w = await fetch(`${growBase()}/rep_schedules?on_conflict=team,rep,week_start`, {
      method: 'POST',
      headers: growHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify([{ team, rep, week_start: week, days, off_week: offWeek, hours, submitted_at: new Date().toISOString() }]),
    });
    if (!w.ok) throw new Error(`save: ${w.status} ${(await w.text()).slice(0, 200)}`);
    return res.status(200).json({ ok: true, hours, days, off_week: offWeek });
  } catch (e) {
    console.error('schedule:', e);
    return res.status(500).json({ error: 'Could not save right now. Try again in a minute.' });
  }
};
