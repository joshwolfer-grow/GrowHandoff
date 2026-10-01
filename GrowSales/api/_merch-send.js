// api/_merch-send.js
// The one-time merch/prize blast. Admin-keyed, never on a cron: this list is a
// hand-built snapshot, so every send is a person deciding to send it.
//
// Mounted under /api/weekly-rep-email?tool=merch rather than as its own route.
// Vercel's Hobby plan caps a deployment at 12 Serverless Functions and this was
// the 13th; the two tools already share an admin key, a Gmail transport and an
// audience, so folding this one in costs nothing. The leading underscore keeps
// Vercel from treating the file as a route of its own.
//
//   GET  ?tool=merch&key=…&json=1        → roster with addresses and send state
//   GET  ?tool=merch&key=…&preview=Name  → the exact HTML for one rep
//   POST ?tool=merch&key=…  {test:'a@b'} → send ONE rep's email to that address
//   POST ?tool=merch&key=…  {reps:[…]}   → send to those reps, skipping sent
//
// Addresses are joined from rep_onboarding at send time; merch_gear holds no
// email. Sends are recorded on the row (sent_at/sent_to) so a re-run cannot
// double-mail someone unless you explicitly pass resend:true.
import nodemailer from 'nodemailer';
// Default import, matching weekly-rep-email.js: this helper is CommonJS and the
// default form is the one that works in every bundler it passes through.
import merchEmail from './_merch-email.js';
const { renderMerchEmail, merchSubject, merchText } = merchEmail;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DASH_URL = (process.env.EMAIL_DASH_URL || 'https://growsales.vercel.app').replace(/\/$/, '');
const SEND_CONCURRENCY = 4;

const emailFrom = () =>
  process.env.EMAIL_FROM || (process.env.GMAIL_USER ? `Grow Sales <${process.env.GMAIL_USER}>` : 'Grow Sales');

// Same key set as the weekly email console, so one admin key opens both.
function authorized(req) {
  const secrets = [process.env.EMAIL_ADMIN_KEY, process.env.CRON_SECRET, process.env.SYNC_TRIGGER_KEY].filter(Boolean);
  const bearer = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  const key = (req.query && req.query.key) || '';
  return secrets.some((s) => s && (bearer === s || key === s));
}

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
}

// merch_gear + the address from rep_onboarding, matched on sequifi_name (the
// roster spelling, which differs from the merch sheet for 13 people).
async function loadReps() {
  const [gear, roster] = await Promise.all([
    sb('merch_gear?select=*&order=sort_order.asc'),
    sb('rep_onboarding?select=first_name,last_name,email'),
  ]);
  const byName = new Map();
  for (const r of roster || []) {
    const full = `${r.first_name || ''} ${r.last_name || ''}`.trim().toLowerCase();
    if (full && r.email && !byName.has(full)) byName.set(full, r.email);
  }
  return (gear || []).map((g) => ({
    name: g.name,
    first: g.first_name,
    shirt: g.shirt,
    polo: g.polo,
    count: g.item_count,
    items: g.items || [],
    email: byName.get(String(g.sequifi_name || g.name).trim().toLowerCase()) || '',
    sentAt: g.sent_at || null,
    sentTo: g.sent_to || null,
    sendError: g.send_error || null,
  }));
}

let _transport;
function transport() {
  if (_transport) return _transport;
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD not set');
  _transport = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user, pass },
    pool: true, maxConnections: SEND_CONCURRENCY, maxMessages: 100,
  });
  return _transport;
}

async function pooled(items, size, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]).catch((e) => ({ rep: items[idx].name, error: String(e.message || e) }));
    }
  }));
  return out;
}

async function markSent(name, to, err) {
  const body = err
    ? { send_error: String(err).slice(0, 400) }
    : { sent_at: new Date().toISOString(), sent_to: to, send_error: null };
  await sb(`merch_gear?name=eq.${encodeURIComponent(name)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  }).catch(() => {});
}

export default async function merchSendHandler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'Supabase env not set' });

  try {
    const reps = await loadReps();

    if (req.method === 'GET') {
      const want = req.query.preview;
      if (want) {
        const rep = reps.find((r) => r.name === want);
        if (!rep) return res.status(404).send('No such rep');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(renderMerchEmail(rep, { origin: DASH_URL }));
      }
      return res.status(200).json({
        from: emailFrom(),
        reps: reps.map((r) => ({ ...r, subject: merchSubject(r), text: merchText(r) })),
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { test, reps: want, resend } = body;

    // Test send: one rep's real email, delivered to an address you name. Nothing
    // is marked sent, so a test can never make a rep look already-mailed.
    if (test) {
      const rep = reps.find((r) => r.name === (body.rep || '')) || reps.find((r) => r.email);
      if (!rep) return res.status(400).json({ error: 'no rep to preview' });
      await transport().sendMail({
        from: emailFrom(),
        to: test,
        subject: `[TEST] ${merchSubject(rep)}`,
        html: renderMerchEmail(rep, { origin: DASH_URL }),
      });
      return res.status(200).json({ ok: true, test: true, to: test, rep: rep.name });
    }

    if (!Array.isArray(want) || !want.length) return res.status(400).json({ error: 'no reps given' });

    const pick = new Set(want);
    const targets = reps.filter((r) => pick.has(r.name) && r.email && (resend || !r.sentAt));
    const skipped = reps.filter((r) => pick.has(r.name) && (!r.email || (!resend && r.sentAt)))
      .map((r) => ({ rep: r.name, why: r.email ? 'already sent' : 'no email' }));

    if (!targets.length) return res.status(200).json({ ok: true, sent: [], failed: [], skipped });

    const results = await pooled(targets, SEND_CONCURRENCY, async (rep) => {
      try {
        await transport().sendMail({
          from: emailFrom(),
          to: rep.email,
          subject: merchSubject(rep),
          html: renderMerchEmail(rep, { origin: DASH_URL }),
        });
        await markSent(rep.name, rep.email, null);
        return { rep: rep.name, to: rep.email };
      } catch (e) {
        await markSent(rep.name, rep.email, e.message || e);
        return { rep: rep.name, error: String(e.message || e) };
      }
    });

    return res.status(200).json({
      ok: true,
      sent: results.filter((r) => !r.error),
      failed: results.filter((r) => r.error),
      skipped,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
