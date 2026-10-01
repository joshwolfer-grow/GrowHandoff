// api/sheet-sync.js
// Manual "Sync now" for the Rep Sales Google Sheet.
//
// The sheet's Apps Script (scripts/rep-sales-sync.gs) is what writes deals,
// knocking, leaderboard and upfront_optin into Supabase. It normally only runs
// on its own hourly timer, so a fresh upload sits in the sheet until the next
// tick. This endpoint pokes that script's web app on demand.
//
// Env:
//   SHEET_SYNC_URL   the Apps Script web app /exec URL
//   SHEET_SYNC_KEY   the WEB_TRIGGER_KEY constant inside that script
//   SUPABASE_URL / SUPABASE_SERVICE_KEY   to read the heartbeat row
//
// Auth (?key= or Bearer): SYNC_TRIGGER_KEY / CRON_SECRET / EMAIL_ADMIN_KEY —
// the same trio api/weekly-rep-email.js accepts, so the admin key the dashboard
// already stores works here without a second prompt.
//
// GET  ?status=1   current heartbeat (last_run, rep_count, error)
// POST (or GET)    kick off a sync
//
// A full sheet sync regularly outruns the 60s function limit. Apps Script keeps
// running server-side once it has the request, so we wait a short while for a
// fast finish and otherwise hand back {started:true} — the dashboard then polls
// ?status=1 until last_run advances past the baseline it was given.

const WAIT_MS = 20000; // long enough that a small sync answers inline

function authorized(req) {
  const secrets = [process.env.SYNC_TRIGGER_KEY, process.env.CRON_SECRET, process.env.EMAIL_ADMIN_KEY]
    .filter(Boolean)
    .map((s) => s.trim());
  if (!secrets.length) return false;
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const qk = ((req.query && req.query.key) || '').trim();
  return secrets.includes(bearer) || secrets.includes(qk);
}

function growBase() { return String(process.env.SUPABASE_URL || '').replace(/\/$/, ''); }
function growHeaders() {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return { apikey: key, Authorization: `Bearer ${key}` };
}

// The heartbeat the Apps Script stamps at the end of every run (see upfrontMeta).
// Returns nulls rather than throwing so a status read never masks a sync that
// actually worked.
async function heartbeat() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return { last_run: null, rep_count: null, error: null };
  try {
    const r = await fetch(`${growBase()}/rest/v1/upfront_optin_sync_meta?id=eq.1&select=last_run,rep_count,error`, { headers: growHeaders() });
    if (!r.ok) return { last_run: null, rep_count: null, error: null };
    const rows = await r.json();
    const d = (rows && rows[0]) || {};
    return { last_run: d.last_run || null, rep_count: d.rep_count == null ? null : d.rep_count, error: d.error || null };
  } catch {
    return { last_run: null, rep_count: null, error: null };
  }
}

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  if (req.query && (req.query.status === '1' || req.query.status === 'true')) {
    return res.status(200).json({ ok: true, ...(await heartbeat()) });
  }

  const url = process.env.SHEET_SYNC_URL;
  const key = process.env.SHEET_SYNC_KEY;
  if (!url || !key) {
    return res.status(500).json({ error: 'SHEET_SYNC_URL / SHEET_SYNC_KEY not set. Deploy the sheet Apps Script as a web app first (see scripts/rep-sales-sync.gs).' });
  }

  // Handed back to the caller so it can tell "finished" from "the timestamp was
  // already this old before I pressed anything".
  const before = await heartbeat();

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), WAIT_MS);
  try {
    const r = await fetch(`${url}?key=${encodeURIComponent(key)}`, { method: 'POST', signal: ctl.signal });
    clearTimeout(timer);
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* Apps Script error pages are HTML */ }

    if (!body) {
      return res.status(502).json({ error: 'The sheet script did not return JSON. Check that the web app is deployed with access set to Anyone.', snippet: text.slice(0, 200), before });
    }
    if (body.error === 'unauthorized') {
      return res.status(502).json({ error: 'The sheet script rejected the key. SHEET_SYNC_KEY must match WEB_TRIGGER_KEY in the Apps Script.', before });
    }
    if (!body.ok) {
      return res.status(body.running ? 409 : 502).json({ error: body.error || 'The sheet sync failed', running: !!body.running, before });
    }
    return res.status(200).json({ ok: true, finished: true, before, after: await heartbeat() });
  } catch (e) {
    clearTimeout(timer);
    // Abort means we stopped listening, not that the sync stopped. Anything else
    // (DNS, TLS, a refused connection) means the request never landed.
    if (e && e.name === 'AbortError') {
      return res.status(202).json({ ok: true, started: true, finished: false, before });
    }
    return res.status(502).json({ error: `Could not reach the sheet script: ${String((e && e.message) || e).slice(0, 200)}`, before });
  }
}
