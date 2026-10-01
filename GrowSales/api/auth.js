// api/auth.js
// Email + password accounts for GrowSales, tied to Sequifi. See api/app-auth.sql.
//
//   POST {action:'send',  email}                  email a 6 digit code (create account or reset password)
//   POST {action:'set',   email, code, password}  check the code, then create the account or set the new password
//
// Signing in itself is Supabase's password grant, done by the app directly. This
// endpoint only exists because proving the email has to happen server side:
// without it anyone could set a password on a manager's email.
//
// Codes go out through the Gmail account the weekly emails already use, so no
// Supabase SMTP setup is needed. They are stored hashed, expire in 15 minutes,
// allow 5 tries, and each email can get one a minute and 5 an hour.

const crypto = require('crypto');
const nodemailer = require('nodemailer');

const CODE_TTL_MIN = 15, MAX_TRIES = 5, MIN_GAP_SEC = 60, MAX_PER_HOUR = 5;

function base() { return (process.env.SUPABASE_URL || '').replace(/\/$/, ''); }
function headers(extra) {
  const k = process.env.SUPABASE_SERVICE_KEY;
  return Object.assign({ apikey: k, Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }, extra || {});
}
async function rest(path, opts) {
  const r = await fetch(`${base()}/rest/v1/${path}`, Object.assign({ headers: headers() }, opts || {}));
  const t = await r.text();
  if (!r.ok) throw new Error(`${path.split('?')[0]} ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
const rpc = (fn, body) => rest(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(body) });

const hash = (email, code) => crypto.createHmac('sha256', process.env.SUPABASE_SERVICE_KEY || 'x').update(`${email}|${code}`).digest('hex');
const cleanEmail = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

let _tx = null;
function transport() {
  if (_tx) return _tx;
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD not set');
  _tx = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
  return _tx;
}
function codeEmail(code, name) {
  return `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:440px;margin:0 auto;background:#f2f2ec;padding:24px;">
  <div style="background:#000;border-radius:14px;padding:22px 20px;color:#fff;">
    <div style="font-weight:900;font-size:20px;letter-spacing:.04em;">GROW</div>
    <div style="color:#34c759;font-size:11px;font-weight:700;letter-spacing:.16em;margin-top:16px;">GROWSALES SIGN IN</div>
  </div>
  <div style="background:#fff;border-radius:14px;padding:22px 20px;margin-top:10px;color:#0b0c0b;">
    <div style="font-size:15px;">${name ? `Hi ${String(name).split(' ')[0].replace(/[<>&]/g, '')},` : 'Hi,'}</div>
    <div style="font-size:14px;color:#48484a;margin-top:8px;line-height:1.5;">Enter this code in GrowSales to set your password. It works for ${CODE_TTL_MIN} minutes.</div>
    <div style="font-size:34px;font-weight:800;letter-spacing:.3em;text-align:center;margin:20px 0 8px;">${code}</div>
    <div style="font-size:12px;color:#86868b;line-height:1.5;">If you did not ask for this, ignore this email. Nobody can get in without the code.</div>
  </div>
</div>`;
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((resolve) => {
    let s = ''; req.on('data', (c) => { s += c; });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { resolve({}); } });
  });
}

async function whoFor(email) {
  const rows = await rpc('login_role_for', { p_email: email });
  return (rows && rows[0]) || null;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const b = await readBody(req);
    const email = cleanEmail(b.email);
    if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email.' });

    if (b.action === 'send') {
      const who = await whoFor(email);
      if (!who) return res.status(404).json({ error: "We couldn't find that email in Sequifi. Use the email Sequifi has for you, or ask your manager." });
      if (who.r_role === 'none') return res.status(403).json({ error: "You're in Sequifi, but GrowSales access is only open to managers right now." });

      const now = Date.now();
      const prior = (await rest(`auth_codes?select=*&email=eq.${encodeURIComponent(email)}`))[0];
      let hourStart = new Date(now).toISOString(), hourSends = 1;
      if (prior) {
        const gap = (now - new Date(prior.sent_at).getTime()) / 1000;
        if (gap < MIN_GAP_SEC) return res.status(429).json({ error: `A code was just sent. Wait ${Math.ceil(MIN_GAP_SEC - gap)} seconds to send another.` });
        if (now - new Date(prior.hour_start).getTime() < 3600e3) {
          if (prior.hour_sends >= MAX_PER_HOUR) return res.status(429).json({ error: 'Too many codes this hour. Try again later.' });
          hourStart = prior.hour_start; hourSends = prior.hour_sends + 1;
        }
      }
      const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
      await rest('auth_codes?on_conflict=email', {
        method: 'POST', headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify([{ email, code_hash: hash(email, code), expires_at: new Date(now + CODE_TTL_MIN * 60e3).toISOString(), attempts: 0, sent_at: new Date(now).toISOString(), hour_start: hourStart, hour_sends: hourSends }]),
      });
      await transport().sendMail({
        from: process.env.EMAIL_FROM || `Grow Sales <${process.env.GMAIL_USER}>`,
        to: email, subject: `${code} is your GrowSales code`, html: codeEmail(code, who.r_name),
      });
      const hasAccount = !!(await rpc('auth_user_id', { p_email: email }));
      return res.status(200).json({ ok: true, has_account: hasAccount });
    }

    if (b.action === 'set') {
      const code = String(b.code || '').replace(/\D/g, ''), password = String(b.password || '');
      if (password.length < 8) return res.status(400).json({ error: 'Use at least 8 characters for your password.' });
      const row = (await rest(`auth_codes?select=*&email=eq.${encodeURIComponent(email)}`))[0];
      if (!row || new Date(row.expires_at).getTime() < Date.now()) return res.status(400).json({ error: 'That code expired. Send a new one.' });
      if (row.attempts >= MAX_TRIES) return res.status(400).json({ error: 'Too many wrong tries. Send a new code.' });
      const a = Buffer.from(row.code_hash), c = Buffer.from(hash(email, code));
      if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) {
        await rest(`auth_codes?email=eq.${encodeURIComponent(email)}`, { method: 'PATCH', headers: headers({ Prefer: 'return=minimal' }), body: JSON.stringify({ attempts: row.attempts + 1 }) });
        return res.status(400).json({ error: 'That code is not right. Check the email and try again.' });
      }
      // Role can change between sending and setting (removed from a team).
      const who = await whoFor(email);
      if (!who || who.r_role === 'none') return res.status(403).json({ error: 'This email no longer has GrowSales access.' });

      const id = await rpc('auth_user_id', { p_email: email });
      const r = id
        ? await fetch(`${base()}/auth/v1/admin/users/${id}`, { method: 'PUT', headers: headers(), body: JSON.stringify({ password, email_confirm: true }) })
        : await fetch(`${base()}/auth/v1/admin/users`, { method: 'POST', headers: headers(), body: JSON.stringify({ email, password, email_confirm: true }) });
      if (!r.ok) {
        const t = await r.text();
        if (/password/i.test(t) && r.status === 422) return res.status(400).json({ error: 'Pick a stronger password.' });
        throw new Error(`auth admin ${r.status} ${t.slice(0, 200)}`);
      }
      await rest(`auth_codes?email=eq.${encodeURIComponent(email)}`, { method: 'DELETE', headers: headers({ Prefer: 'return=minimal' }) });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('auth:', e);
    return res.status(500).json({ error: 'Something went wrong. Try again in a minute.' });
  }
};
