// api/sequifi-sync.js
// Hourly pull of Sequifi users -> Grow Supabase rep_onboarding, so the Team
// view can track onboarded -> trained -> selling -> ramped.
//
// onboarded_at semantics (the funnel clock):
//   - stamped with now() the first run where a user shows onboarding_complete
//   - never overwritten on later runs
//   - on the very first sync ever (no meta row), users already complete are
//     backfilled with their Sequifi created_at and flagged onboarded_backfilled
//
// Env:
//   SEQUIFI_TOKEN         Sequifi marketplace API bearer token (expires ~60d)
//   SUPABASE_URL          Grow project URL
//   SUPABASE_SERVICE_KEY  Grow service_role key
//   CRON_SECRET           Vercel cron auth (Authorization: Bearer <secret>)
//   SYNC_TRIGGER_KEY      optional second secret for manual triggers (?key=)
//
// Trigger: Vercel cron (vercel.json). Manual: GET /api/sequifi-sync?key=<secret>

const SEQUIFI_BASE = (process.env.SEQUIFI_BASE || 'https://marketplace-api.sequifi.com').replace(/\/$/, '');
const notify = require('./_notify.js');
const { canonicalFirstLast, canonicalDisplayName } = require('./_name-aliases.js');

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

async function growSelect(table, query) {
  const r = await fetch(`${growBase()}/rest/v1/${table}?${query}`, { headers: growHeaders() });
  if (!r.ok) throw new Error(`select ${table}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

async function growUpsert(table, rows, onConflict) {
  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const r = await fetch(`${growBase()}/rest/v1/${table}?on_conflict=${onConflict}`, {
      method: 'POST',
      headers: growHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(chunk),
    });
    if (!r.ok) throw new Error(`upsert ${table}: ${r.status} ${(await r.text()).slice(0, 300)}`);
    written += chunk.length;
  }
  return written;
}

async function fetchSequifiUsers() {
  const token = (process.env.SEQUIFI_TOKEN || '').trim();
  if (!token) throw new Error('SEQUIFI_TOKEN not set');
  const users = [];
  let page = 1, lastPage = 1;
  do {
    const r = await fetch(`${SEQUIFI_BASE}/v1/users?page=${page}&per_page=100`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`sequifi users p${page}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const body = await r.json();
    const d = body.data || {};
    users.push(...(d.users || []));
    lastPage = d.last_page || 1;
    page++;
  } while (page <= lastPage);
  return users;
}

module.exports = async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  const t0 = Date.now();
  try {
    const [users, existing, metaRows] = await Promise.all([
      fetchSequifiUsers(),
      growSelect('rep_onboarding', 'select=sequifi_id,onboarded_at,onboarded_backfilled'),
      growSelect('sequifi_sync_meta', 'select=id,last_run'),
    ]);
    const firstSyncEver = !metaRows.length || !metaRows[0].last_run;
    const prior = {};
    existing.forEach((r) => { prior[r.sequifi_id] = r; });

    const now = new Date().toISOString();
    let onboardedCount = 0;
    const rows = users.map((u) => {
      const p = prior[u.id] || {};
      const complete = u.onboarding_complete === 1 || u.onboarding_complete === true;
      let onboardedAt = p.onboarded_at || null;
      let backfilled = p.onboarded_backfilled || false;
      if (complete && !onboardedAt) {
        if (firstSyncEver) { onboardedAt = u.created_at || now; backfilled = true; }
        else onboardedAt = now;
      }
      if (onboardedAt) onboardedCount++;
      const mgr = u.manager || null;
      const nm = canonicalFirstLast(u.first_name, u.last_name);
      return {
        sequifi_id: u.id,
        employee_id: u.employee_id || null,
        first_name: nm.first,
        last_name: nm.last,
        email: u.email || null,
        mobile_no: u.mobile_no || null,
        office_name: u.office_name || null,
        state_code: u.state_code || null,
        manager_name: mgr ? canonicalDisplayName(`${mgr.first_name || ''} ${mgr.last_name || ''}`.trim()) : null,
        manager_email: mgr ? mgr.email || null : null,
        position_name: u.position_name || null,
        sub_position_name: u.sub_position_name || null,
        experience: (u.sub_position_name || '').toLowerCase() === 'veteran' ? 'veteran' : 'rookie',
        worker_type: u.worker_type || null,
        status_id: u.status_id == null ? null : u.status_id,
        is_manager: u.is_manager === 1 || u.is_manager === true,
        sequifi_created_at: u.created_at || null,
        onboarding_complete: complete,
        onboarded_at: onboardedAt,
        onboarded_backfilled: backfilled,
        last_seen_at: now,
        updated_at: now,
      };
    });

    const written = await growUpsert('rep_onboarding', rows, 'sequifi_id');
    await growUpsert('sequifi_sync_meta', [{
      id: 1, last_run: now, user_count: users.length,
      onboarded_count: onboardedCount, duration_ms: Date.now() - t0, error: null,
    }], 'id');

    return res.status(200).json({
      ok: true, users: users.length, written,
      onboarded: onboardedCount, first_sync: firstSyncEver, ms: Date.now() - t0,
    });
  } catch (e) {
    try {
      await growUpsert('sequifi_sync_meta', [{
        id: 1, duration_ms: Date.now() - t0, error: String(e.message || e).slice(0, 500),
      }], 'id');
    } catch (_) { /* meta table may not exist yet */ }
    await notify.notifyPush({ title: '⚠️ Sequifi sync failed', body: String(e.message || e).slice(0, 200), url: '/' });
    return res.status(500).json({ error: String(e.message || e).slice(0, 500) });
  }
};
