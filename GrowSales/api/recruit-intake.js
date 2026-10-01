// Recruit intake. One endpoint, three callers:
//
//   1. Meta Lead Ads webhook (Instagram/Facebook lead forms), posting the
//      leadgen envelope. Meta sends only a leadgen_id, so we turn around and
//      fetch the actual answers from the Graph API with a page token.
//   2. Zapier / Make / any middleman, posting flat JSON with a key. This is the
//      path to start on: no Meta app review, wired up in about ten minutes.
//   3. The public apply form at /apply, posting flat JSON with no key at all.
//      A public form cannot hold a secret, so this path is deliberately open and
//      is fenced in instead: it may only ever create a plain new recruit.
//
// GET is Meta's subscription handshake (hub.challenge).
//
// Table: api/recruits.sql. Board: renderRecruiting() in index.html.

import crypto from 'crypto';

// Vercel would parse the body for us, but Meta signs the RAW bytes: any
// re-serialization changes key order and whitespace and the signature stops
// matching. Read the stream ourselves and parse after verifying.
export const config = { api: { bodyParser: false } };

function growBase() {
  const u = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  if (!u) throw new Error('SUPABASE_URL is not set');
  return u + '/rest/v1';
}
function growHeaders() {
  const k = process.env.SUPABASE_SERVICE_KEY;
  if (!k) throw new Error('SUPABASE_SERVICE_KEY is not set');
  return { apikey: k, Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' };
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Same multi-secret idiom as sheet-sync: a browser link can carry ?key=, a
// server can send a bearer. Fails closed when nothing is configured.
function keyed(req) {
  const secrets = [process.env.RECRUIT_INTAKE_KEY, process.env.SYNC_TRIGGER_KEY, process.env.CRON_SECRET]
    .filter(Boolean).map((s) => s.trim());
  if (!secrets.length) return false;
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const url = new URL(req.url, 'http://x');
  const qk = (url.searchParams.get('key') || '').trim();
  return secrets.includes(bearer) || secrets.includes(qk);
}

function signedByMeta(req, raw) {
  const secret = process.env.META_APP_SECRET;
  const sig = req.headers['x-hub-signature-256'];
  if (!secret || !sig) return false;
  const mine = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(mine), b = Buffer.from(String(sig));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const digits10 = (s) => {
  const d = String(s || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
};

// Meta hands back answers as [{name:'phone_number', values:['...']}]. Field
// names vary per form, so match on what the name contains rather than a fixed
// list, and keep every answer in `answers` so nothing is silently dropped.
function fromMetaFields(fields) {
  const out = { answers: {} };
  for (const f of fields || []) {
    const name = String(f.name || '').toLowerCase();
    const val = Array.isArray(f.values) ? f.values.join(', ') : String(f.values || '');
    out.answers[f.name] = val;
    if (!out.name && (name === 'full_name' || name === 'name')) out.name = val;
    if (!out.first && name === 'first_name') out.first = val;
    if (!out.last && name === 'last_name') out.last = val;
    if (!out.phone && name.includes('phone')) out.phone = val;
    if (!out.email && name.includes('email')) out.email = val;
    if (!out.market && (name.includes('city') || name.includes('state') || name.includes('market'))) out.market = val;
  }
  if (!out.name) out.name = [out.first, out.last].filter(Boolean).join(' ');
  delete out.first; delete out.last;
  return out;
}

async function fetchMetaLead(leadgenId) {
  const token = process.env.META_PAGE_TOKEN;
  if (!token) throw new Error('META_PAGE_TOKEN is not set, cannot fetch lead ' + leadgenId);
  const url = 'https://graph.facebook.com/v21.0/' + encodeURIComponent(leadgenId)
    + '?fields=field_data,created_time,ad_id,ad_name,campaign_name,form_id&access_token=' + encodeURIComponent(token);
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Graph API ' + r.status + ': ' + JSON.stringify(j).slice(0, 300));
  const parsed = fromMetaFields(j.field_data);
  return {
    ...parsed,
    source: 'instagram',
    lead_id: String(leadgenId),
    form_id: j.form_id ? String(j.form_id) : null,
    ad: j.ad_name || (j.ad_id ? String(j.ad_id) : null),
    campaign: j.campaign_name || null,
    created_at: j.created_time || null
  };
}

function normalize(body) {
  const pick = (...keys) => {
    for (const k of keys) {
      if (body[k] !== undefined && body[k] !== null && String(body[k]).trim() !== '') return String(body[k]).trim();
    }
    return null;
  };
  const name = pick('name', 'full_name', 'fullName')
    || [pick('first_name', 'firstName'), pick('last_name', 'lastName')].filter(Boolean).join(' ');
  return {
    name: name || null,
    phone: pick('phone', 'phone_number', 'phoneNumber', 'mobile'),
    email: pick('email', 'email_address'),
    market: pick('market', 'city', 'area', 'location'),
    source: pick('source') || 'form',
    campaign: pick('campaign', 'campaign_name', 'utm_campaign'),
    ad: pick('ad', 'ad_name', 'utm_content'),
    creative: pick('creative', 'creative_name'),
    lead_id: pick('lead_id', 'leadgen_id'),
    form_id: pick('form_id'),
    answers: body.answers && typeof body.answers === 'object' ? body.answers : null,
    created_at: pick('created_at')
  };
}

async function insert(rec, { trusted }) {
  const row = {
    name: rec.name,
    phone: rec.phone || null,
    phone10: digits10(rec.phone) || null,
    email: rec.email || null,
    market: rec.market || null,
    stage: 'new',
    source: trusted ? (rec.source || 'manual') : (rec.source === 'instagram' ? 'instagram' : 'form'),
    campaign: rec.campaign || null,
    ad: rec.ad || null,
    creative: rec.creative || null,
    lead_id: rec.lead_id || null,
    form_id: rec.form_id || null,
    answers: rec.answers || null
  };
  if (rec.created_at && !isNaN(Date.parse(rec.created_at))) row.created_at = new Date(rec.created_at).toISOString();

  // A person who taps submit twice, or a Meta retry on a lead we already have,
  // should not become two cards someone has to reconcile by hand. lead_id is
  // caught by the unique index; a bare form submit is caught by phone.
  if (row.phone10) {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const q = growBase() + '/recruits?select=id&phone10=eq.' + encodeURIComponent(row.phone10)
      + '&created_at=gte.' + encodeURIComponent(since) + '&limit=1';
    const r = await fetch(q, { headers: growHeaders() });
    if (r.ok) {
      const hit = await r.json().catch(() => []);
      if (hit.length) return { duplicate: true, id: hit[0].id };
    }
  }

  const r = await fetch(growBase() + '/recruits', {
    method: 'POST',
    headers: { ...growHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify(row)
  });
  const out = await r.json().catch(() => null);
  if (!r.ok) {
    // 23505 is the lead_id unique index doing its job on a Meta retry. That is a
    // success from Meta's point of view: anything but a 200 and it retries forever.
    const code = out && (out.code || (out.details && out.details.code));
    if (code === '23505' || String(r.status) === '409') return { duplicate: true, id: null };
    throw new Error('insert failed ' + r.status + ': ' + JSON.stringify(out).slice(0, 300));
  }
  return { duplicate: false, id: Array.isArray(out) && out[0] ? out[0].id : null };
}

export default async function handler(req, res) {
  // Meta's subscription handshake.
  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token && token === process.env.META_VERIFY_TOKEN) {
      res.setHeader('Content-Type', 'text/plain');
      return res.status(200).send(challenge || '');
    }
    return res.status(403).json({ error: 'Forbidden' });
  }

  // The apply form is served from this same origin, but a form on the ISP sites
  // or a landing page would be cross-origin, so answer the preflight.
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Access-Control-Allow-Origin', '*');

  let raw, body;
  try {
    raw = await readRaw(req);
    body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch {
    return res.status(400).json({ error: 'Body is not JSON' });
  }

  try {
    const fromMeta = signedByMeta(req, raw);
    const hasKey = keyed(req);

    // Meta leadgen envelope. Always answer 200 once we have the payload, even if
    // a single lead fails: a non-200 makes Meta redeliver the whole batch.
    if (body && body.object === 'page' && Array.isArray(body.entry)) {
      if (!fromMeta) return res.status(401).json({ error: 'Bad signature' });
      const ids = [];
      for (const entry of body.entry) {
        for (const ch of entry.changes || []) {
          if (ch.field !== 'leadgen' || !ch.value || !ch.value.leadgen_id) continue;
          ids.push(String(ch.value.leadgen_id));
        }
      }
      const results = [];
      for (const id of ids) {
        try {
          const rec = await fetchMetaLead(id);
          if (!rec.name) rec.name = rec.phone || rec.email || 'Instagram lead';
          results.push({ id, ...(await insert(rec, { trusted: true })) });
        } catch (e) {
          console.error('recruit-intake leadgen', id, e.message);
          results.push({ id, error: e.message });
        }
      }
      return res.status(200).json({ ok: true, leads: results });
    }

    // Flat JSON: keyed (Zapier, a script, a manual curl) or the open apply form.
    const rec = normalize(body);

    if (!hasKey) {
      // Unkeyed means the public form. The honeypot field is hidden in the page,
      // so only a bot fills it; answer 200 anyway so the bot learns nothing.
      if (body.company || body.website) return res.status(200).json({ ok: true });
      if (body.form !== 'apply') return res.status(401).json({ error: 'Unauthorized' });
      // Nobody gets to backdate, relabel the source or attach a Meta lead id
      // through the open door.
      rec.source = 'form';
      rec.lead_id = null;
      rec.created_at = null;
    }

    if (!rec.name && !rec.phone && !rec.email) {
      return res.status(400).json({ error: 'Need at least a name, phone or email' });
    }
    if (!rec.name) rec.name = rec.phone || rec.email;

    const out = await insert(rec, { trusted: hasKey });
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    console.error('recruit-intake', e);
    return res.status(500).json({ error: e.message });
  }
}
