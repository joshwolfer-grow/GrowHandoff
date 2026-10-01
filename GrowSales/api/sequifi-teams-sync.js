// api/sequifi-teams-sync.js
// Pulls the weekly team roster straight from Sequifi so nobody has to paste it.
//
// Sequifi's /v1/teams is the roster of record from 2026-08-09 forward: one team
// per manager per week, Sunday..Saturday, which is already our week anchor. An
// `effective_date` anywhere inside a week returns that week's teams, so this
// walks every Sunday from START_WEEK to the current one on each run — cheap
// (a handful of requests) and self-healing, since a week that was empty or
// half-built when we last looked gets refetched until it settles.
//
// Written to report_config.__sequifi_teams__, NOT __roster_weeks__. The Master
// Manager Pay push owns that row and still owns every week before Aug 9; giving
// Sequifi its own row keeps the two histories separable and means a bad run
// here can never eat the hand-kept history.
//
// Names go through _name-aliases first. Sequifi stores legal names and the rest
// of the app runs on what people actually go by (Thomas -> TJ Becker, Angel ->
// Krispy Rebollar). Skipping that step would make ~8 of 44 real reps look like
// they were missing from their own team, and the sub rule reads "not on a team"
// as "subcontractor".
//
// Env:
//   SEQUIFI_TOKEN         Sequifi marketplace API bearer token (expires ~60d)
//   SUPABASE_URL          Grow project URL
//   SUPABASE_SERVICE_KEY  Grow service_role key
//   CRON_SECRET           Vercel cron auth (Authorization: Bearer <secret>)
//   SYNC_TRIGGER_KEY      optional second secret for manual triggers (?key=)
//
// Trigger: Vercel cron (vercel.json). Manual: GET /api/sequifi-teams-sync?key=<secret>

const SEQUIFI_BASE = (process.env.SEQUIFI_BASE || 'https://marketplace-api.sequifi.com').replace(/\/$/, '');
const notify = require('./_notify.js');
const { canonicalFirstLast } = require('./_name-aliases.js');

// Sequifi's teams data starts here. The week of 2026-08-02 exists but holds a
// single one-person team — the feature was being switched on — so it reads as a
// company of two and would flag everyone else that week as a subcontractor.
const START_WEEK = '2026-08-09';

function authorized(req) {
  const keys = [process.env.CRON_SECRET, process.env.SYNC_TRIGGER_KEY].filter(Boolean).map((k) => k.trim());
  if (!keys.length) return false;
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const qk = ((req.query && req.query.key) || '').trim();
  return keys.includes(bearer) || keys.includes(qk);
}

function growBase() { return process.env.SUPABASE_URL.replace(/\/$/, ''); }
function growHeaders(extra) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return Object.assign(
    { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    extra || {}
  );
}

async function growUpsert(table, rows, onConflict) {
  const r = await fetch(`${growBase()}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: growHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`upsert ${table}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return rows.length;
}

function iso(d) {
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

// Every Sunday from START_WEEK through the Sunday of the week we're in now.
// UTC throughout: these are calendar labels, not moments, and a Vercel function
// running in UTC must not land on a different Sunday than a browser in Mountain.
function weeksToSync(todayISO) {
  const out = [];
  const start = new Date(START_WEEK + 'T00:00:00Z');
  const now = todayISO ? new Date(todayISO + 'T00:00:00Z') : new Date();
  const cur = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  cur.setUTCDate(cur.getUTCDate() - cur.getUTCDay());   // back up to Sunday
  for (const d = new Date(start); iso(d) <= iso(cur); d.setUTCDate(d.getUTCDate() + 7)) out.push(iso(d));
  return out;
}

// Sequifi is typed by hand, so names arrive as "alexa colbert" and "kaden
// Nixon" often enough to matter — and a lowercase name is a different string to
// every join in the app. Only an all-lowercase token is touched: anything with
// an internal capital is somebody's actual spelling (McGuire, DuBose) and gets
// left exactly as it is.
function fixCase(s) {
  return String(s || '').split(/\s+/).map((w) => (
    w && w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w
  )).join(' ');
}

function personName(p) {
  if (!p) return null;
  const n = canonicalFirstLast(fixCase(p.first_name), fixCase(p.last_name));
  const full = `${n.first || ''} ${n.last || ''}`.trim();
  return full || null;
}

// A team is named "<Market> <Manager> - <Date>" ("Ezee Kiefer - Aug 9", "TDS
// Lukas - Aug 9", "Ezee Devon Daniel - Sep 6"). Only the leading word is taken:
// trying to strip the manager's name off the end fails the moment the team is
// named for what the manager goes by while Sequifi holds their legal name
// ("Ezee Nate" led by Nathan Boyd came out as the market "Ezee Nate"). Every
// market seen so far is one word — Ezee, TDS, i3, Lyte, GFiber, SLIC, Omni,
// Bluepeak, Cityside, Chicago. This is a label for display; it keys nothing,
// so a wrong guess costs a caption and not a number.
function marketOf(teamName) {
  const s = String(teamName || '').trim();
  if (!s) return null;
  return s.split(/\s+/)[0].replace(/[,:]+$/, '') || null;
}

async function fetchTeamsForWeek(token, week) {
  const teams = [];
  let page = 1, lastPage = 1;
  do {
    const url = `${SEQUIFI_BASE}/v1/teams?page=${page}&per_page=100&effective_date=${week}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (!r.ok) throw new Error(`teams ${week} p${page}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const d = (await r.json()).data || {};
    teams.push(...(d.teams || []));
    lastPage = d.last_page || 1;
    page++;
  } while (page <= lastPage);
  return teams;
}

module.exports = async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  const t0 = Date.now();
  const now = new Date().toISOString();
  try {
    const token = (process.env.SEQUIFI_TOKEN || '').trim();
    if (!token) throw new Error('SEQUIFI_TOKEN not set');

    const weeks = weeksToSync((req.query && req.query.today) || null);
    const byWeek = {}, meta = {}, empty = [];

    for (const wk of weeks) {
      const teams = await fetchTeamsForWeek(token, wk);
      const roster = {}, tmeta = [];
      for (const t of teams) {
        const mgr = personName(t.team_manager);
        if (!mgr) continue;
        const members = (t.team_members || []).map(personName).filter(Boolean);
        // Two teams can share a manager in one week (a market split). Merge them
        // rather than letting the second silently replace the first's crew.
        const prior = roster[mgr] || [];
        roster[mgr] = prior.concat(members.filter((m) => prior.indexOf(m) < 0));
        tmeta.push({
          id: t.id,
          team_name: t.team_name || null,
          market: marketOf(t.team_name),
          type: t.type || null,
          manager: mgr,
          start_date: t.start_date || null,
          end_date: t.end_date || null,
          members: members,
        });
      }
      byWeek[wk] = roster;
      meta[wk] = tmeta;
      if (!tmeta.length) empty.push(wk);
    }

    // A week that comes back empty is almost always "not built yet" (the current
    // week early on) rather than "nobody worked". Dropping it keeps the app from
    // reading an unbuilt week as a company where every seller is a sub.
    empty.forEach((wk) => { delete byWeek[wk]; delete meta[wk]; });

    const kept = Object.keys(byWeek).sort();
    const people = {};
    kept.forEach((wk) => {
      Object.keys(byWeek[wk]).forEach((m) => {
        people[m] = 1;
        (byWeek[wk][m] || []).forEach((r) => { people[r] = 1; });
      });
    });

    // Refuse to publish an empty history. Without this a bad token or an API
    // change would write {} and every rep in the app would flip to sub at once.
    if (!kept.length) throw new Error(`no teams returned for any of ${weeks.length} weeks (${weeks[0]}..${weeks[weeks.length - 1]})`);

    // ?dry=1 fetches and shapes everything but writes nothing — the way to see
    // what a run would do to the roster before letting it do it.
    if (req.query && (req.query.dry === '1' || req.query.dry === 'true')) {
      return res.status(200).json({ ok: true, dry: true, weeks: kept, skipped_empty: empty, people: Object.keys(people).length, config: { weeks: byWeek, teams: meta } });
    }

    await growUpsert('report_config', [{
      manager: '__sequifi_teams__',
      config: {
        weeks: byWeek,
        teams: meta,
        start_week: START_WEEK,
        synced_at: now,
        source: 'sequifi-teams-sync',
      },
    }], 'manager');

    await growUpsert('sequifi_teams_sync_meta', [{
      id: 1, last_run: now, week_count: kept.length, team_count: kept.reduce((n, w) => n + meta[w].length, 0),
      people_count: Object.keys(people).length, duration_ms: Date.now() - t0, error: null,
    }], 'id');

    return res.status(200).json({
      ok: true,
      weeks: kept,
      skipped_empty: empty,
      teams: kept.reduce((n, w) => n + meta[w].length, 0),
      people: Object.keys(people).length,
      duration_ms: Date.now() - t0,
    });
  } catch (e) {
    const msg = String((e && e.message) || e);
    try {
      await growUpsert('sequifi_teams_sync_meta', [{ id: 1, error: msg.slice(0, 500), duration_ms: Date.now() - t0 }], 'id');
    } catch (_) { /* meta write is best-effort; the push below is the real alert */ }
    try { await notify.notifyPush({ title: '\u26a0\ufe0f Sequifi teams sync failed', body: msg.slice(0, 200), url: '/' }); } catch (_) {}
    return res.status(500).json({ ok: false, error: msg });
  }
};

module.exports.weeksToSync = weeksToSync;
module.exports.marketOf = marketOf;
