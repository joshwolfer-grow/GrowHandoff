// api/_notify.js
// Shared push helper so server crons can alert the manager directly, without an
// extra HTTP hop through /api/send-push. Best-effort by design: notifyPush never
// throws, so calling it inside a sync's error handler can't take that sync down.
//
// Reads/deletes subscriptions via raw PostgREST fetch (the same pattern the
// sync endpoints use) rather than the supabase-js client, so it stays light and
// avoids pulling in realtime-js. Only web-push is imported.
//
// CommonJS on purpose — the ESM syncs import the default (notify.notifyPush) and
// the CommonJS sync requires it; default-object interop works from both sides.
const webpush = require('web-push');

let _configured = false;
function configure() {
  if (_configured) return;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  _configured = true;
}

function growBase() { return process.env.SUPABASE_URL.replace(/\/$/, ''); }
function growHeaders(extra) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return Object.assign({ apikey: key, Authorization: `Bearer ${key}` }, extra || {});
}

// Send one notification to every current subscriber. Returns a small summary;
// swallows every error (returns { error } instead of throwing).
async function notifyPush({ title, body, url }) {
  try {
    if (!process.env.VAPID_PRIVATE_KEY || !process.env.SUPABASE_SERVICE_KEY || !process.env.SUPABASE_URL) {
      return { sent: 0, failed: 0, reason: 'push env not configured' };
    }
    configure();

    const r = await fetch(`${growBase()}/rest/v1/push_subscriptions?select=*`, { headers: growHeaders() });
    if (!r.ok) return { sent: 0, failed: 0, error: `subs ${r.status} ${(await r.text()).slice(0, 120)}` };
    const subs = await r.json();
    if (!Array.isArray(subs) || !subs.length) return { sent: 0, failed: 0, reason: 'no subscribers' };

    const payload = JSON.stringify({ title, body, url: url || '/' });
    const stale = [];
    let sent = 0, failed = 0;
    await Promise.allSettled(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: sub.keys, expirationTime: sub.expires },
            payload
          );
          sent++;
        } catch (err) {
          if (err.statusCode === 410 || err.statusCode === 404) stale.push(sub.endpoint);
          failed++;
        }
      })
    );

    // Prune dead subscriptions one at a time (endpoints are long URLs — eq. with
    // per-value encoding is safe; an in.() list is fiddly to encode).
    for (const endpoint of stale) {
      try {
        await fetch(`${growBase()}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`,
          { method: 'DELETE', headers: growHeaders() });
      } catch (_) { /* best effort */ }
    }

    return { sent, failed, cleaned: stale.length };
  } catch (e) {
    return { sent: 0, failed: 0, error: String((e && e.message) || e) };
  }
}

module.exports = { notifyPush };
