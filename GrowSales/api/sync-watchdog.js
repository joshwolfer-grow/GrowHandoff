// api/sync-watchdog.js
// Backstop monitor for the daily syncs. Runs a bit after they do and pushes the
// manager if any sync failed to complete (stale last_run) or recorded an error.
// This is the layer that catches the "silent failure for days" class of bug
// (e.g. the Bria admin login breaking, or a cron simply not firing) — the inline
// alerts in each sync only fire when that function actually runs and throws.
//
// A healthy run sends NO push. No news is good news. The four API syncs are
// checked by their meta rows, and the two MANUAL knock feeds (Grow's SalesRabbit
// crawl and the TDS Amplify crawl) by how fresh their rows in `knocking` are;
// weekly-summary (weekly cadence) is intentionally not staleness-checked.
//
// Reads meta via raw PostgREST fetch (same pattern as the sync endpoints).
// Trigger: Vercel cron (vercel.json). Manual: GET /api/sync-watchdog?key=<SYNC_TRIGGER_KEY>
import notify from './_notify.js';

const STALE_HOURS = 20; // healthy last_run is ~1-2h old at watchdog time; 20h = a run was missed

function authorized(req) {
  const secrets = [process.env.CRON_SECRET, process.env.SYNC_TRIGGER_KEY].filter(Boolean).map((s) => s.trim());
  if (!secrets.length) return false;
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const qk = ((req.query && req.query.key) || '').trim();
  return secrets.includes(bearer) || secrets.includes(qk);
}

function growBase() { return process.env.SUPABASE_URL.replace(/\/$/, ''); }
function growHeaders() {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return { apikey: key, Authorization: `Bearer ${key}` };
}
async function growSelect(query) {
  const r = await fetch(`${growBase()}/rest/v1/${query}`, { headers: growHeaders() });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 160)}`);
  return r.json();
}

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_KEY not set' });
  }

  const now = Date.now();
  const staleMs = STALE_HOURS * 3600 * 1000;
  const problems = [];
  const checked = [];

  const ageH = (iso) => (iso ? Math.round((now - new Date(iso).getTime()) / 3600000) : null);
  const isStale = (iso) => !iso || now - new Date(iso).getTime() > staleMs;

  // Sequifi teams — the weekly roster. Worth its own check because a silent
  // stall here does not look like a broken sync, it looks like a week where
  // half the company stopped being on a team, and the sub rule reads that as
  // "they are all subcontractors".
  try {
    const rows = await growSelect('sequifi_teams_sync_meta?id=eq.1&select=last_run,error,week_count');
    const d = rows && rows[0];
    checked.push({ sync: 'sequifi_teams', last_run: d && d.last_run, age_h: d && ageH(d.last_run), error: d && d.error });
    if (!d || !d.last_run) problems.push('Sequifi teams: no successful run on record');
    else if (isStale(d.last_run)) problems.push(`Sequifi teams: no successful run in ${ageH(d.last_run)}h (token expired?)`);
    else if (d.error) problems.push(`Sequifi teams: last run errored — ${String(d.error).slice(0, 140)}`);
  } catch (e) {
    checked.push({ sync: 'sequifi_teams', meta_error: String((e && e.message) || e) });
  }

  // Sequifi — singleton id=1, has both last_run and an error column.
  try {
    const rows = await growSelect('sequifi_sync_meta?id=eq.1&select=last_run,error');
    const d = rows && rows[0];
    checked.push({ sync: 'sequifi', last_run: d && d.last_run, age_h: d && ageH(d.last_run), error: d && d.error });
    if (!d || !d.last_run) problems.push('Sequifi: no successful run on record');
    else if (isStale(d.last_run)) problems.push(`Sequifi: no successful run in ${ageH(d.last_run)}h (token expired?)`);
    else if (d.error) problems.push(`Sequifi: last run errored — ${String(d.error).slice(0, 140)}`);
  } catch (e) {
    problems.push('Sequifi: sync meta unreadable');
    checked.push({ sync: 'sequifi', meta_error: String((e && e.message) || e) });
  }

  // Bria — singleton id=1, no error column. Staleness covers both a hard throw
  // and the empty-pull skip (both leave last_run un-advanced).
  try {
    const rows = await growSelect('bria_sync_meta?id=eq.1&select=last_run,bria_users');
    const d = rows && rows[0];
    checked.push({ sync: 'bria', last_run: d && d.last_run, age_h: d && ageH(d.last_run) });
    if (!d || !d.last_run) problems.push('Bria: no successful run on record');
    else if (isStale(d.last_run)) problems.push(`Bria: no successful run in ${ageH(d.last_run)}h (admin login / creds?)`);
  } catch (e) {
    problems.push('Bria: sync meta unreadable');
    checked.push({ sync: 'bria', meta_error: String((e && e.message) || e) });
  }

  // Pronto was dropped on 2026-08-21 along with api/pronto-sync.js. Nothing
  // refreshes pronto_sync_meta any more, so watching it would page every day
  // about a sync that is gone on purpose.

  // Upfront opt-in — singleton id=1. last_run only advances on a successful,
  // non-empty pull, so a broken sheet share shows up as staleness here even
  // though the table still holds the last good roster.
  try {
    const rows = await growSelect('upfront_optin_sync_meta?id=eq.1&select=last_run,rep_count,error');
    const d = rows && rows[0];
    checked.push({ sync: 'upfront_optin', last_run: d && d.last_run, age_h: d && ageH(d.last_run), rep_count: d && d.rep_count, error: d && d.error });
    if (!d || !d.last_run) problems.push('Upfront opt-in: no successful run on record');
    else if (isStale(d.last_run)) problems.push(`Upfront opt-in: no successful run in ${ageH(d.last_run)}h (sheet sharing changed?)`);
    if (d && d.error) problems.push(`Upfront opt-in: ${String(d.error).slice(0, 120)}`);
  } catch (e) {
    problems.push('Upfront opt-in: sync meta unreadable');
    checked.push({ sync: 'upfront_optin', meta_error: String((e && e.message) || e) });
  }

  // Knock feeds — these are MANUAL runs on the manager's Mac, not crons, so they
  // have no meta row to read. Freshness is the newest date present in `knocking`
  // for that source. This is the check that would have caught TDS sitting nine
  // days stale: the crawl drives a browser session that expires with no warning,
  // and a dead session simply writes nothing rather than failing loudly.
  //
  // Measured in DAYS, not hours, because nobody knocks every single day and the
  // run is a human habit. A gap this size means the pipeline broke, not that the
  // team took a day off.
  const KNOCK_STALE_DAYS = 3;
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
  const knockFeeds = [
    { key: 'knock_tds', label: 'TDS Amplify crawl', q: 'knocking?source=eq.tds&select=date&order=date.desc&limit=1',
      hint: 'run: node scripts/amplify-company-sync.mjs --source tds (session may have expired)' },
    { key: 'knock_grow', label: 'Grow knock sync', q: 'knocking?method=eq.sr_activity&select=date&order=date.desc&limit=1',
      hint: 'run: node scripts/grow-sync.mjs' },
  ];
  for (const f of knockFeeds) {
    try {
      const rows = await growSelect(f.q);
      const newest = rows && rows.length ? rows[0].date : null;
      const gapDays = newest ? Math.round((today - new Date(newest + 'T00:00:00Z').getTime()) / 86400000) : null;
      checked.push({ sync: f.key, newest_date: newest, gap_days: gapDays });
      if (!newest) problems.push(`${f.label}: no knocking rows at all`);
      else if (gapDays > KNOCK_STALE_DAYS) problems.push(`${f.label}: newest data is ${newest} (${gapDays}d old) — ${f.hint}`);
    } catch (e) {
      problems.push(`${f.label}: knocking table unreadable`);
      checked.push({ sync: f.key, meta_error: String((e && e.message) || e) });
    }
  }

  // Runner-reported failures. The knock-freshness check above is a LAGGING
  // signal: it waits KNOCK_STALE_DAYS for missing data to prove a break, which
  // on 2026-09-04 meant a TDS login that died Friday morning went unreported
  // until Monday. The bash runners already know they are failing — they stamp
  // report_config with ok:false on every tick — so read that directly and the
  // same break surfaces on the next watchdog run instead of three days later.
  //
  // Only a FRESH failing marker counts. A stale one means the runner itself
  // stopped (the Mac is off, or launchd is unloaded), which is a different
  // problem the knock-freshness check is the right tool for — paging about a
  // days-old marker every morning would just train the alert to be ignored.
  const MARKER_FRESH_H = 6;
  // Only the bash runners, which stamp via sync-marker.sh and share its
  // {ran_at, ok, detail, fix} shape. __knock_sync__ is deliberately absent:
  // grow-sync.mjs writes its own {crawled_at, watermark} shape with no ok flag,
  // so there is no failure to read there — its break shows up as knock staleness.
  const markers = [
    { key: '__amplify_sync__', label: 'Amplify sync (TDS)' },
    { key: '__rtr_sync__', label: 'RTR sync' },
  ];
  try {
    const names = markers.map((m) => m.key).join(',');
    const rows = await growSelect(`report_config?manager=in.(${names})&select=manager,config`);
    const byName = Object.fromEntries((rows || []).map((r) => [r.manager, r.config || {}]));
    for (const m of markers) {
      const c = byName[m.key];
      if (!c || !c.ran_at) continue;              // never stamped: nothing to say
      const age = ageH(c.ran_at);
      checked.push({ sync: m.key, ran_at: c.ran_at, age_h: age, ok: c.ok });
      if (c.ok === false && age !== null && age < MARKER_FRESH_H) {
        const fix = c.fix ? ` — fix: ${c.fix}` : '';
        problems.push(`${m.label}: runner reporting failure — ${String(c.detail || 'no detail').slice(0, 160)}${fix}`);
      }
    }
  } catch (e) {
    checked.push({ sync: 'runner_markers', meta_error: String((e && e.message) || e) });
  }

  // ISP knocking workbooks (run-isp-export.sh, launchd on the Mac, once a day
  // after 7am). Unlike the runners above this is judged on ABSENCE too: the ISPs
  // are the audience, so a workbook that silently stopped refreshing matters as
  // much as one that failed. Whatever the cause (Mac off, agent unloaded,
  // Drive unmounted, Python missing), no successful run in ISP_STALE_H pages.
  const ISP_STALE_H = 30;
  try {
    const rows = await growSelect('report_config?manager=eq.__isp_export__&select=config');
    const c = (rows && rows[0] && rows[0].config) || null;
    const age = c && c.ran_at ? ageH(c.ran_at) : null;
    checked.push({ sync: '__isp_export__', ran_at: c && c.ran_at, age_h: age, ok: c && c.ok });
    const fix = ' — fix: ISP_FORCE=1 bash scripts/run-isp-export.sh';
    if (!c || !c.ran_at) problems.push('ISP workbooks: never run' + fix);
    else if (c.ok === false) problems.push(`ISP workbooks: last run failed — ${String(c.detail || 'no detail').slice(0, 160)} — fix: ${c.fix || 'ISP_FORCE=1 bash scripts/run-isp-export.sh'}`);
    else if (age !== null && age > ISP_STALE_H) problems.push(`ISP workbooks: no successful run in ${age}h (is the Mac on? launchctl list | grep isp-export)` + fix);
  } catch (e) {
    checked.push({ sync: '__isp_export__', meta_error: String((e && e.message) || e) });
  }

  let push = null;
  if (problems.length) {
    push = await notify.notifyPush({
      title: '⚠️ Sync needs attention',
      body: problems.join('\n'),
      url: '/',
    });
  }

  return res.status(200).json({ ok: problems.length === 0, problems, checked, push, stale_hours: STALE_HOURS });
}
