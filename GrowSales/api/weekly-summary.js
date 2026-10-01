import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

function getWeekMonday() {
  var d = new Date();
  var day = d.getUTCDay();
  var diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff)).toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const monday = getWeekMonday();
  const sun = new Date(new Date(monday + 'T12:00:00Z').getTime() + 6 * 86400000).toISOString().slice(0, 10);

  const { data: deals, error: dealsErr } = await supabase
    .from('deals')
    .select('status')
    .eq('week', monday);

  if (dealsErr) return res.status(500).json({ error: dealsErr.message });

  const sold = deals ? deals.length : 0;
  const installed = deals ? deals.filter(d => d.status === 'Serviced').length : 0;
  const cancelled = deals ? deals.filter(d => d.status === 'Cancelled').length : 0;
  const pending = deals ? deals.filter(d => d.status === 'Pending').length : 0;

  // Avg first/last knock times
  let avgLine = '';
  try {
    const { data: knocking } = await supabase
      .from('knocking')
      .select('first_disp,last_disp')
      // All sources: TDS is a division inside Grow, so its reps' start/end times
      // belong in the average too. This only averages times, so the per-rep/day
      // duplicate rows the dashboard merges away are harmless here.
      .gte('date', monday)
      .lte('date', sun);
    if (knocking && knocking.length) {
      const toMin = (t) => {
        if (!t) return null;
        const m = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
        if (!m) return null;
        let h = parseInt(m[1]); const min = parseInt(m[2]); const pm = m[3].toUpperCase() === 'PM';
        if (pm && h !== 12) h += 12; if (!pm && h === 12) h = 0;
        return h * 60 + min;
      };
      const fromMin = (m) => {
        let h = Math.floor(m / 60); const min = Math.round(m % 60);
        const ampm = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
        return h + ':' + (min < 10 ? '0' : '') + min + ' ' + ampm;
      };
      const firsts = knocking.map(k => toMin(k.first_disp)).filter(v => v !== null);
      const lasts = knocking.map(k => toMin(k.last_disp)).filter(v => v !== null);
      if (firsts.length) {
        const avgFirst = fromMin(firsts.reduce((a, b) => a + b, 0) / firsts.length);
        const avgLast = lasts.length ? fromMin(lasts.reduce((a, b) => a + b, 0) / lasts.length) : null;
        avgLine = `\nAvg knock: ${avgFirst}` + (avgLast ? ` – ${avgLast}` : '');
      }
    }
  } catch (e) { /* skip if knocking table unavailable */ }

  const body = `This week: ${sold} sold, ${installed} installed, ${cancelled} cancelled, ${pending} pending${avgLine}`;

  const { data: subs } = await supabase.from('push_subscriptions').select('*');
  if (!subs || !subs.length) return res.status(200).json({ message: 'No subscribers' });

  const payload = JSON.stringify({ title: '📊 Weekly Summary', body, url: '/' });
  const stale = [];

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys, expirationTime: sub.expires },
          payload
        );
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) stale.push(sub.endpoint);
      }
    })
  );

  if (stale.length) {
    await supabase.from('push_subscriptions').delete().in('endpoint', stale);
  }

  return res.status(200).json({ sent: subs.length - stale.length, body });
}
