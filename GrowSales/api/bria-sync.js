// api/bria-sync.js
// Nightly pull of Bria (Supabase project `bria`, oofisagqyhfcpmfmcjwt; the app is
// growfiber.vercel.app. Moved off the old auth.getbria.com Bria in Sep 2026):
//  - training tables  -> compute per-rep / per-course completion
//  - sales table      -> per-rep / per-day deal + install counts
// then upsert the computed results into the Grow Supabase project so the
// dashboard can read them. The Bria service key never leaves the server.
//
// New Bria (read-only role, SELECT only; INSERT is denied on their side):
//   BRIA_SUPABASE_URL              https://oofisagqyhfcpmfmcjwt.supabase.co
//   BRIA_SUPABASE_PUBLISHABLE_KEY  sent as `apikey`
//   BRIA_SUPABASE_READONLY_KEY     grow_sales_readonly JWT, sent as `Bearer` only
//   BRIA_CUTOVER                   optional, default 2026-05-01
// Setting BRIA_SUPABASE_READONLY_KEY switches the sync to the new Bria. Its sales
// history only starts 2026-01-01 and runs ~730 deals short of the old Bria for
// Jan to Apr, so sales are replaced only from BRIA_CUTOVER on; everything earlier
// stays frozen as the old Bria left it (backup in Grow's `backup` schema, 2026-09-11).
//
// Old Bria (auth.getbria.com), used only while the new keys are absent:
//   BRIA_API_KEY  or  BRIA_ANON_KEY (+ BRIA_EMAIL / BRIA_PASSWORD), BRIA_BASE
//
// Grow (always required):
//   SUPABASE_URL          Grow project URL
//   SUPABASE_SERVICE_KEY  Grow service_role key
//   CRON_SECRET           shared secret for the cron / manual trigger
//
// Trigger: Vercel cron (see vercel.json) sends `Authorization: Bearer <CRON_SECRET>`.
// Manual run: GET /api/bria-sync?key=<CRON_SECRET>  (same secret, as a query param).

import notify from './_notify.js';
import { canonicalDisplayName } from './_name-aliases.js';

const NEW_BRIA = !!(process.env.BRIA_SUPABASE_READONLY_KEY || '').trim();
const BRIA_BASE = (NEW_BRIA
  ? (process.env.BRIA_SUPABASE_URL || 'https://oofisagqyhfcpmfmcjwt.supabase.co')
  : (process.env.BRIA_BASE || 'https://auth.getbria.com')).trim().replace(/\/$/, '');
const BRIA_REST = `${BRIA_BASE}/rest/v1`;
const BRIA_AUTH = `${BRIA_BASE}/auth/v1`;
const CUTOVER = NEW_BRIA ? (process.env.BRIA_CUTOVER || '2026-05-01').trim() : null;
const PAGE = 1000;

// Resolve Bria credentials into { apikey, bearer } used on every REST request.
// Option A: one key for both. Option B: anon key + a user JWT from password sign-in.
async function briaCredentials() {
  // New Bria: publishable key as apikey, read-only role JWT as the bearer. The
  // read-only JWT must never be used as the apikey.
  if (NEW_BRIA) {
    const pub = (process.env.BRIA_SUPABASE_PUBLISHABLE_KEY || '').trim();
    if (!pub) throw new Error('BRIA_SUPABASE_READONLY_KEY is set but BRIA_SUPABASE_PUBLISHABLE_KEY is not.');
    return { apikey: pub, bearer: process.env.BRIA_SUPABASE_READONLY_KEY.trim() };
  }
  // Trim: pasted env values often carry a stray newline/space that breaks headers.
  const svc = (process.env.BRIA_API_KEY || '').trim();
  const anon = (process.env.BRIA_ANON_KEY || '').trim();
  const email = (process.env.BRIA_EMAIL || '').trim();
  const pw = (process.env.BRIA_PASSWORD || '').trim();

  // Option A: service_role key (bypasses RLS).
  if (svc) return { apikey: svc, bearer: svc };

  if (!anon) {
    throw new Error('Set BRIA_API_KEY, or BRIA_ANON_KEY (+ optional BRIA_EMAIL/BRIA_PASSWORD).');
  }

  // Option B: password sign-in for a user JWT — only if a password is configured
  // (Google-SSO accounts have none, so this is skipped for them).
  if (email && pw) {
    const r = await fetch(`${BRIA_AUTH}/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anon, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pw }),
    });
    if (r.ok) {
      const j = await r.json();
      return { apikey: anon, bearer: j.access_token };
    }
    // Credentials are configured but sign-in failed: surface it, do not fall
    // back to anon (which reads 0 rows and looks like a mysteriously empty pull).
    const t = await r.text();
    throw new Error(`Bria sign-in failed for ${email}: ${r.status} ${t.slice(0, 200)}`);
  }

  // Option C: anon-role access. Works if Bria's RLS lets the public anon role
  // read these tables. If it can't, pulls come back empty (not an error).
  return { apikey: anon, bearer: anon };
}

// Only the columns we actually use, to keep payloads small.
const TABLES = {
  courses: 'id,title,category',
  lessons: 'id,course_id,title',
  quizzes: 'id,course_id,passing_score_pct',
  learning_groups: 'id,primary_course_id,start_date,end_date,trainer_id,created_at',
  learning_group_assignments: 'learning_group_id,user_id',
  learning_group_courses: 'learning_group_id,course_id',
  lesson_completions: 'user_id,lesson_id,completed_at',
  quiz_results: 'user_id,course_id,best_score_pct,passed',
  users: 'id,name,email',
  // client_company_name is the ISP the deal was sold for; product_label is the
  // package. The old Bria had both on the sales row; the new one keeps
  // product_label on the team, so it is filled in from `teams` after the pull.
  sales: NEW_BRIA
    ? 'id,user_id,company_id,team_id,sale_date,install_date,install_time,install_end_time,customer_name,customer_phone,client_company_name'
    : 'id,user_id,sale_date,install_date,install_time,install_end_time,customer_name,customer_phone,client_company_name,product_label',
};
// The read-only role on the new Bria can read users/sales/teams but (so far) not
// the training tables. Those pulls may fail without sinking the sales sync.
const TRAINING = new Set(['courses', 'lessons', 'quizzes', 'learning_groups', 'learning_group_assignments', 'learning_group_courses', 'lesson_completions', 'quiz_results']);

async function briaFetchRange(table, select, creds, offset, orderCol, wantCount) {
  const url = new URL(`${BRIA_REST}/${table}`);
  url.searchParams.set('select', select);
  if (orderCol) url.searchParams.set('order', `${orderCol}.asc`);
  const headers = {
    apikey: creds.apikey,
    Authorization: `Bearer ${creds.bearer}`,
    'Range-Unit': 'items',
    Range: `${offset}-${offset + PAGE - 1}`,
  };
  // count=exact re-runs COUNT(*) under RLS on every request; only the first
  // page needs it (Bria's statement_timeout kills the query otherwise).
  if (wantCount) headers.Prefer = 'count=exact';
  const r = await fetch(url, { headers });
  if (r.status !== 200 && r.status !== 206) {
    const t = await r.text();
    throw new Error(`Bria ${table}: ${r.status} ${t.slice(0, 200)}`);
  }
  const total = parseInt((r.headers.get('content-range') || '').split('/')[1], 10);
  return { rows: await r.json(), total: isNaN(total) ? null : total };
}

// Parallel pagination: first page reveals the total, remaining pages fetch in
// concurrent batches. The old one-page-at-a-time loop pushed the whole sync
// past Vercel's 60s function ceiling.
async function briaPull(table, select, creds) {
  const orderCol = select.includes('created_at') ? 'created_at' : (table === 'sales' ? 'id' : null);
  const first = await briaFetchRange(table, select, creds, 0, orderCol, true);
  const rows = first.rows.slice();
  const total = first.total != null ? first.total : (first.rows.length < PAGE ? rows.length : null);
  if (total == null || rows.length >= total) return rows;
  const offsets = [];
  for (let o = PAGE; o < total; o += PAGE) offsets.push(o);
  const BATCH = 6;
  for (let i = 0; i < offsets.length; i += BATCH) {
    const pages = await Promise.all(offsets.slice(i, i + BATCH).map((o) => briaFetchRange(table, select, creds, o, orderCol)));
    pages.forEach((p) => rows.push(...p.rows));
  }
  return rows;
}

// Port of bria_pull.py compute_completion: one row per (rep, course) they're assigned.
export function computeCompletion(data) {
  const nameById = {};
  for (const u of data.users) nameById[u.id] = u.name || u.email || u.id;

  const titleById = {};
  for (const c of data.courses) titleById[c.id] = c.title;

  const lessonsByCourse = {};
  for (const l of data.lessons) (lessonsByCourse[l.course_id] ||= []).push(l.id);

  const hasQuiz = new Set(data.quizzes.map((q) => q.course_id));

  const doneByUser = {};
  for (const c of data.lesson_completions) (doneByUser[c.user_id] ||= new Set()).add(c.lesson_id);

  const quizByUserCourse = {};
  for (const q of data.quiz_results) quizByUserCourse[`${q.user_id}|${q.course_id}`] = q;

  // group -> set of course ids (primary + attached), and group -> start_date
  const coursesByGroup = {};
  const startByGroup = {};
  for (const g of data.learning_groups) {
    (coursesByGroup[g.id] ||= new Set()).add(g.primary_course_id);
    startByGroup[g.id] = g.start_date || null;
  }
  for (const gc of data.learning_group_courses) {
    (coursesByGroup[gc.learning_group_id] ||= new Set()).add(gc.course_id);
  }

  // expected[(user,course)] = earliest start_date across the groups that assign it
  const expected = new Map();
  for (const a of data.learning_group_assignments) {
    const courses = coursesByGroup[a.learning_group_id];
    if (!courses) continue;
    for (const cid of courses) {
      if (!cid) continue;
      const k = `${a.user_id}|${cid}`;
      const st = startByGroup[a.learning_group_id];
      const cur = expected.get(k);
      if (cur === undefined || (st && (cur === null || st < cur))) expected.set(k, st);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const rows = [];
  for (const [k, start] of expected) {
    const [uid, cid] = k.split('|');
    const lids = lessonsByCourse[cid] || [];
    const done = doneByUser[uid] || new Set();
    const ndone = lids.reduce((n, lid) => n + (done.has(lid) ? 1 : 0), 0);
    const pct = lids.length ? Math.round((100 * ndone) / lids.length) : null;

    let quiz = '—';
    if (hasQuiz.has(cid)) {
      const qp = quizByUserCourse[`${uid}|${cid}`];
      quiz = qp ? (qp.passed ? 'pass' : `fail ${qp.best_score_pct}%`) : 'not taken';
    }

    const complete = (pct === 100) && (quiz === '—' || quiz === 'pass');
    let overdueDays = null;
    if (start && !complete) {
      overdueDays = Math.max(0, Math.round((Date.parse(today) - Date.parse(start)) / 86400000));
    }

    rows.push({
      rep: nameById[uid] || uid,
      course: titleById[cid] || cid,
      start_date: start,
      lessons_done: ndone,
      lessons_total: lids.length,
      lesson_pct: pct,
      quiz,
      complete,
      overdue_days: overdueDays,
    });
  }
  rows.sort((a, b) => (a.rep + a.course).localeCompare(b.rep + b.course));
  return rows;
}

// Per-rep / per-day sales counts from Bria's sales table.
export function computeSalesDaily(data) {
  const nameById = {};
  for (const u of data.users) nameById[u.id] = u.name || u.email || u.id;

  const agg = {}; // key rep|date -> {deals, installs}
  for (const s of data.sales) {
    const rep = s.rep || nameById[s.user_id] || s.user_id;
    const date = (s.sale_date || '').slice(0, 10);
    if (!date) continue;
    const k = `${rep}|${date}`;
    const row = (agg[k] ||= { rep, sale_date: date, deals: 0, installs: 0 });
    row.deals += 1;
    if (s.install_date) row.installs += 1;
  }
  return Object.values(agg);
}

// Deal-level Bria records (for customer-name reconciliation vs the dashboard).
export function computeDeals(data) {
  const nameById = {};
  for (const u of data.users) nameById[u.id] = u.name || u.email || u.id;
  const rows = [];
  let idx = 0;
  for (const s of data.sales) {
    // The browser omits the UUID `id` to stay under the upload size limit; when it's
    // absent we mint a per-run index as the natural key (rows are fully replaced each sync).
    const bid = (s.id != null) ? String(s.id) : ('r' + idx);
    idx++;
    rows.push({
      bria_id: bid,
      rep: s.rep || nameById[s.user_id] || s.user_id || '',
      customer: s.customer_name || '',
      phone: s.customer_phone || '',
      isp: s.client_company_name || s.isp || '',
      product: s.product_label || '',
      sale_date: (s.sale_date || '').slice(0, 10) || null,
      install_date: (s.install_date || '').slice(0, 10) || null,
      // Booking window for the install. Stored verbatim as text so whatever shape
      // Bria sends (HH:MM:SS or a full timestamp) survives the round trip.
      install_time: s.install_time || null,
      install_end_time: s.install_end_time || null,
      // Bria team the sale was booked under; the dashboard's team source.
      team_id: s.team_id != null ? String(s.team_id) : null,
    });
  }
  return rows;
}

// Bria teams as the app's weekly roster, same shape as __sequifi_teams__
// ({weeks: {sunday: {team: [reps]}}, teams, start_week}) so every roster reader
// just points at a different key. A Bria team is a market (Houston, Illinois),
// not a manager's crew. A rep's team for a week is the team they booked the
// most sales under that week; weeks with no sale carry in the app (3 back, 2
// ahead). Reps whose Bria membership names a team are also placed on it for
// the current week, so someone knocking before their first sale is not a sub.
// Starts the first Sunday on or after BRIA_START_WEEK (default: the cutover),
// because older rows are frozen old-Bria history with no team.
function sundayOf(ds) {
  const d = new Date(ds + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}
export function buildBriaRoster(dealRows, teams, memberRows, startDay, today, blitz) {
  const nameOf = new Map((teams || []).map((t) => [String(t.id), (t.name || '').trim() || String(t.id)]));
  let start = sundayOf(startDay);
  if (start < startDay) { const d = new Date(start + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 7); start = d.toISOString().slice(0, 10); }
  // A sale's team_id is whatever team the rep had picked in Bria, which is not
  // always where they sold: 66 Ezee sales sat on Pennsylvania (a Glo team) and
  // i3 sales on New York. Each Bria team carries one ISP, so a sale whose ISP
  // does not match its team moves to a team that does carry it. Two teams on one
  // ISP (Ezee: Houston/Chicago, Omni: Michigan/Pittsburgh) split by the team
  // this rep books that ISP under most, then the team with most of that ISP.
  const ispKey = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ')[0] || '';
  const teamIsps = new Map(); // team name -> Set of isp keys
  const ispTeams = new Map(); // isp key -> [team names]
  for (const t of teams || []) {
    const tm = (t.name || '').trim(); if (!tm) continue;
    const ks = new Set([t.client_company_name, ...(Array.isArray(t.client_company_names) ? t.client_company_names : [])].map(ispKey).filter(Boolean));
    teamIsps.set(tm, ks);
    for (const k of ks) (ispTeams.get(k) || ispTeams.set(k, []).get(k)).push(tm);
  }
  const repIspTeam = {}, ispTeamN = {}; // counts of matching sales, for the split
  for (const r of dealRows) {
    const tm = r.team_id && nameOf.get(String(r.team_id)), k = ispKey(r.isp);
    if (!tm || !k || !(teamIsps.get(tm) || new Set()).has(k)) continue;
    const a = (repIspTeam[r.rep + '|' + k] = repIspTeam[r.rep + '|' + k] || {}); a[tm] = (a[tm] || 0) + 1;
    const b = (ispTeamN[k] = ispTeamN[k] || {}); b[tm] = (b[tm] || 0) + 1;
  }
  const pick = (cands, ...counts) => cands.slice().sort((x, y) => {
    for (const c of counts) { const d = ((c || {})[y] || 0) - ((c || {})[x] || 0); if (d) return d; }
    return x.localeCompare(y);
  })[0];
  const teamFor = (r) => {
    const tm = r.team_id && nameOf.get(String(r.team_id)), k = ispKey(r.isp);
    const cands = k ? ispTeams.get(k) : null;
    if (!cands || !cands.length) return tm || null;        // ISP no team carries (Tachus): keep Bria's tag
    if (tm && cands.includes(tm)) return tm;               // tag matches the ISP
    return pick(cands, repIspTeam[r.rep + '|' + k], ispTeamN[k]);
  };
  const tally = {}; // week -> rep -> team -> deals
  for (const r of dealRows) {
    if (!r.rep || !r.sale_date || r.sale_date < start) continue;
    const tm = teamFor(r);
    if (!tm) continue;
    const w = sundayOf(r.sale_date);
    const byRep = (tally[w] = tally[w] || {});
    const t = (byRep[r.rep] = byRep[r.rep] || {});
    t[tm] = (t[tm] || 0) + 1;
  }
  const weeks = {};
  for (const w of Object.keys(tally)) {
    const roster = {};
    for (const rep of Object.keys(tally[w])) {
      const t = tally[w][rep];
      const best = Object.keys(t).sort((a, b) => t[b] - t[a] || a.localeCompare(b))[0];
      (roster[best] = roster[best] || []).push(rep);
    }
    weeks[w] = roster;
  }
  // Management crews: Bria's blitz groups (learning_groups) are a manager
  // (trainer) + a week + a market course, with reps assigned. Where a rep has a
  // blitz group they sit on that manager's crew; the nearest group within 3
  // weeks back, then 2 ahead, covers a week their manager did not build. Only
  // reps with no blitz group near that week keep the market team from sales.
  const mkt = new Set();
  if (blitz && blitz.groups && blitz.groups.length) {
    const nameOf2 = blitz.nameOf || new Map();
    const courseTeam = new Map((teams || []).filter((t) => t.guide_course_id).map((t) => [t.guide_course_id, (t.name || '').trim()]));
    const members = {};
    for (const a of blitz.assignments || []) (members[a.learning_group_id] = members[a.learning_group_id] || []).push(a.user_id);
    const seq = {}; // rep -> [{w, mgr, at}]
    for (const g of blitz.groups) {
      if (!g.start_date || !g.trainer_id) continue;
      const mgr = nameOf2.get(g.trainer_id); if (!mgr) continue;
      const w = sundayOf(String(g.start_date).slice(0, 10));
      if (w < start) continue;
      const reps = new Set([mgr, ...(members[g.id] || []).map((u) => nameOf2.get(u)).filter(Boolean)]);
      for (const r of reps) (seq[r] = seq[r] || []).push({ w, mgr, at: g.created_at || '', market: courseTeam.get(g.primary_course_id) || null });
    }
    const addW = (w, n) => { const d = new Date(w + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 7 * n); return d.toISOString().slice(0, 10); };
    const crewFor = (rep, w) => {
      const L = seq[rep]; if (!L) return null;
      const same = L.filter((x) => x.w === w).sort((a, b) => (b.at > a.at ? 1 : -1));
      if (same.length) return same[0];
      for (let i = 1; i <= 3; i++) { const h = L.filter((x) => x.w === addW(w, -i)).sort((a, b) => (b.at > a.at ? 1 : -1)); if (h.length) return h[0]; }
      for (let i = 1; i <= 2; i++) { const h = L.filter((x) => x.w === addW(w, i)).sort((a, b) => (b.at > a.at ? 1 : -1)); if (h.length) return h[0]; }
      return null;
    };
    const allWeeks = new Set(Object.keys(weeks));
    for (const L of Object.values(seq)) for (const x of L) allWeeks.add(x.w);
    const cw = sundayOf(today);
    for (const w of [...allWeeks].sort()) {
      if (w > cw) continue;
      const roster = {};
      const reps = new Set(Object.values(weeks[w] || {}).flat());
      for (const [r, L] of Object.entries(seq)) if (L.some((x) => x.w === w)) reps.add(r);
      for (const [tm, list] of Object.entries(weeks[w] || {})) for (const r of list) {
        const c = crewFor(r, w);
        if (!c) { (roster[tm] = roster[tm] || []).push(r); mkt.add(tm); }
      }
      for (const r of reps) {
        const c = crewFor(r, w);
        if (c && !(roster[c.mgr] || []).includes(r)) (roster[c.mgr] = roster[c.mgr] || []).push(r);
        // A carried crew keeps the market of the group it was carried from.
        if (c && c.market) { const mo = (blitz.marketOf = blitz.marketOf || {}); const m = (mo[w] = mo[w] || {}); if (!m[c.mgr] || c.w === w) m[c.mgr] = c.market; }
      }
      weeks[w] = roster;
    }
  } else for (const w of Object.keys(weeks)) for (const tm of Object.keys(weeks[w])) mkt.add(tm);
  const cur = sundayOf(today);
  if (cur >= start) {
    const roster = (weeks[cur] = weeks[cur] || {});
    const placed = new Set(Object.values(roster).flat());
    // Membership is a fallback for reps with no recent sales only. A rep who
    // sold anywhere in the last 3 weeks carries that team in the app; their
    // Bria membership is often stale (Pennsylvania on a Houston Ezee seller).
    const back = new Date(cur + 'T12:00:00Z'); back.setUTCDate(back.getUTCDate() - 21);
    const lo = back.toISOString().slice(0, 10);
    for (const w of Object.keys(weeks)) if (w >= lo && w < cur) for (const reps of Object.values(weeks[w])) for (const r of reps) placed.add(r);
    for (const m of memberRows || []) {
      const tm = m.team_id && nameOf.get(String(m.team_id));
      if (!m.rep || !tm || placed.has(m.rep)) continue;
      (roster[tm] = roster[tm] || []).push(m.rep); mkt.add(tm);
      placed.add(m.rep);
    }
    if (!Object.keys(roster).length) delete weeks[cur];
  }
  const meta = {};
  for (const w of Object.keys(weeks)) {
    for (const tm of Object.keys(weeks[w])) weeks[w][tm].sort();
    meta[w] = Object.keys(weeks[w]).sort().map((tm) => {
      const isMkt = mkt.has(tm) && !(blitz && blitz.marketOf && blitz.marketOf[w] && blitz.marketOf[w][tm]);
      const mk = isMkt ? tm : ((blitz && blitz.marketOf && blitz.marketOf[w] && blitz.marketOf[w][tm]) || null);
      const t = (teams || []).find((x) => (x.name || '').trim() === mk) || {};
      return { id: t.id || null, team_name: tm, market: mk, isp: t.client_company_name || null, manager: tm, is_market: isMkt, members: weeks[w][tm] };
    });
  }
  // Market keys (Houston, Illinois) are not people; the app keeps them off
  // their own roster. Manager keys are people and sit on their own crew.
  return { weeks, teams: meta, start_week: start, market_teams: [...mkt].filter((m) => !(blitz && blitz.managers && blitz.managers.has(m))).sort() };
}

// Idempotent upsert into a Grow table via PostgREST merge-duplicates.
async function growUpsert(table, rows, onConflict) {
  if (!rows.length) return 0;
  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  const chunks = [];
  for (let i = 0; i < rows.length; i += 1000) chunks.push(rows.slice(i, i + 1000));
  let written = 0;
  const BATCH = 6; // concurrent writes; sequential chunks blew the 60s ceiling
  for (let i = 0; i < chunks.length; i += BATCH) {
    await Promise.all(chunks.slice(i, i + BATCH).map(async (chunk) => {
      const url = `${base}/rest/v1/${table}?on_conflict=${onConflict}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(chunk),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`Grow upsert ${table}: ${r.status} ${t.slice(0, 300)}`);
      }
      written += chunk.length;
    }));
  }
  return written;
}

// Delete every row in a Grow table (these tables are fully derived from Bria
// each run, so a clean refresh drops departed reps / stale rows automatically).
async function growDeleteAll(table) {
  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  const url = `${base}/rest/v1/${table}?rep=not.is.null`; // matches all rows (rep is NOT NULL)
  const r = await fetch(url, {
    method: 'DELETE',
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'return=minimal' },
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Grow delete ${table}: ${r.status} ${t.slice(0, 300)}`);
  }
}

// Canonical rep names for everything we write.
//
// Bria stores a rep's name exactly as they typed it when they signed up, so the
// same person is "KRISPY Rebollar" here, "Krispy Rebollar" in the install report,
// "alli Lauriano" vs "Alli Lauriano", "spencer boyd" vs "Spencer Boyd". Every join
// downstream (Upfront eligibility, upfront payroll, rep photos, the weekly email)
// is an exact string match on rep, so those reps silently fall out of their own
// numbers — Krispy's 78 deals and Alli's 53 joined to nothing.
//
// Fixing it by title-casing would be a guess, and a wrong one: "JaQuan Batts" and
// "TJ Becker" are spelled that way on purpose. So the canonical spelling is taken
// from the install report, which already runs every name through canonName, and
// Bria is matched to it case-insensitively. Genuine misspellings (Bria's "Juiian
// Chavez") go through the shared alias table instead.
// Two Bria spellings collapsing onto one canonical name can leave two rows with
// the same (rep, sale_date) / (rep, course) key in one batch, and PostgREST refuses
// an upsert that touches the same row twice. Re-merge after the remap.
function mergeByKey(rows, keyFields, add) {
  const out = new Map();
  for (const r of rows) {
    const k = keyFields.map((f) => r[f]).join('\u0000');
    const prev = out.get(k);
    if (!prev) out.set(k, r);
    else if (add) for (const f of add) prev[f] = (prev[f] || 0) + (r[f] || 0);
  }
  return [...out.values()];
}

async function canonicalRepNames(...rowSets) {
  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  const canon = new Map();
  try {
    const r = await fetch(`${base}/rest/v1/deals?select=rep&limit=50000`, {   // PostgREST caps at 1000 rows without this
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (r.ok) for (const row of await r.json()) {
      if (row.rep) canon.set(String(row.rep).toLowerCase(), row.rep);
    }
  } catch (e) {
    // No canonical list means no remap — leave the names alone rather than guess.
    console.warn('canonicalRepNames: could not read deals.rep:', e.message);
  }
  const fixed = new Map();
  for (const rows of rowSets) {
    for (const row of rows) {
      if (!row || !row.rep) continue;
      // The install report's spelling wins over the alias table when the report
      // already knows this name. The alias table is tuned for Sequifi and Pronto
      // and does not always agree with it — it maps "Alli Lauriano" to "Allison
      // Lauriano" while deals, the upfront roster and the payroll ledger all say
      // Alli — and quietly renaming a rep onto a spelling nothing else uses is
      // the same bug in a new coat.
      const direct = canon.get(String(row.rep).toLowerCase());
      const aliased = canonicalDisplayName(row.rep);
      const to = direct || canon.get(String(aliased).toLowerCase()) || aliased;
      if (to !== row.rep) { fixed.set(`${row.rep} -> ${to}`, 1); row.rep = to; }
    }
  }
  if (fixed.size) console.log('bria rep names canonicalised:', [...fixed.keys()].join(', '));
  return fixed.size;
}

// Full refresh: clear the table, then insert the fresh set.
async function growReplace(table, rows, onConflict) {
  await growDeleteAll(table);
  return growUpsert(table, rows, onConflict);
}

// Cutover refresh: replace only rows with sale_date >= CUTOVER; older rows are
// the frozen old-Bria history and are never touched.
async function growReplaceFrom(table, rows, onConflict) {
  if (!CUTOVER) return growReplace(table, rows, onConflict);
  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  const r = await fetch(`${base}/rest/v1/${table}?sale_date=gte.${CUTOVER}`, {
    method: 'DELETE',
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'return=minimal' },
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Grow delete ${table} from ${CUTOVER}: ${r.status} ${t.slice(0, 300)}`);
  }
  return growUpsert(table, rows.filter((x) => x.sale_date && x.sale_date >= CUTOVER), onConflict);
}

async function growCountFrom(table, from) {
  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  const r = await fetch(`${base}/rest/v1/${table}?sale_date=gte.${from}&select=bria_id&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact' },
  });
  if (!r.ok) return null;
  const n = parseInt((r.headers.get('content-range') || '').split('/')[1], 10);
  return isNaN(n) ? null : n;
}

export default async function handler(req, res) {
  // CORS — lets the browser-driven ingest POST here from the Bria app origin.
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Accept the cron's CRON_SECRET, the browser-sync PRONTO_SYNC_KEY, or the
  // manual-trigger SYNC_TRIGGER_KEY (CRON_SECRET is write-only in Vercel).
  const secrets = [process.env.CRON_SECRET, process.env.PRONTO_SYNC_KEY, process.env.SYNC_TRIGGER_KEY].filter(Boolean);
  const auth = req.headers['authorization'] || '';
  const qkey = (req.query && req.query.key) || '';
  const ok = secrets.some((s) => auth === `Bearer ${s}` || qkey === s);
  if (!secrets.length || !ok) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Grow SUPABASE_URL / SUPABASE_SERVICE_KEY not set' });
  }

  const started = Date.now();
  try {
    // Two modes:
    //   POST { data: {<table>: [...]} }  -> ingest raw tables pulled by the browser
    //   GET / cron                        -> pull from Bria server-side (needs credentials)
    let data;
    let photoUsers = null; // pulled separately so a photo_url schema change can never sink the sync
    let trainingErr = null; // new Bria: training tables unreadable, keep the existing training rows
    const posted = req.method === 'POST' && req.body && req.body.data;
    if (posted) {
      data = req.body.data;
      const missing = Object.keys(TABLES).filter((t) => !Array.isArray(data[t]));
      if (missing.length) {
        return res.status(400).json({ error: 'Missing tables in payload: ' + missing.join(', ') });
      }
    } else {
      const creds = await briaCredentials();
      try { photoUsers = await briaPull('users', 'id,name,photo_url', creds); } catch (e) { /* no photo_url column or no read access; avatars keep their initials */ }
      const entries = Object.entries(TABLES);
      const pulled = await Promise.all(entries.map(([t, sel]) => briaPull(t, sel, creds).catch((e) => {
        if (NEW_BRIA && TRAINING.has(t)) { trainingErr = trainingErr || `${t}: ${e.message}`; return null; }
        throw e;
      })));
      data = {};
      entries.forEach(([t], i) => { data[t] = pulled[i]; });

      if (NEW_BRIA) {
        // Package label lives on the team in the new Bria. The whole team row is
        // kept too (select=*): teams are the dashboard's roster source.
        try {
          const teams = await briaPull('teams', '*', creds);
          data.teams = teams;
          const prod = new Map(teams.map((t) => [t.id, t.product_label]));
          for (const s of data.sales) if (s.team_id && prod.get(s.team_id)) s.product_label = prod.get(s.team_id);
        } catch (e) { /* no teams access; product just shows blank */ }
        // Current team per member, for reps who knock before their first sale.
        try { data.memberships = await briaPull('company_memberships', '*', creds); } catch (e) { /* optional */ }
        // The read-only role sees every company on the new Bria. Grow is the only
        // one today, so nothing is filtered; shout the day that changes, because a
        // second company's reps would otherwise land in PRA and the leaderboard.
        const cos = new Set(data.sales.map((s) => s.company_id).filter(Boolean));
        if (cos.size > 1) {
          await notify.notifyPush({ title: '⚠️ Bria has more than one company', body: `${cos.size} companies in Bria sales. The sync pulls all of them; it needs a company filter.`, url: '/' });
        }
      }
    }

    // Guard: a server-side pull that comes back empty (creds lacking read access)
    // must NOT wipe data a browser sync already loaded — growReplace deletes first.
    //
    // Sign-in succeeding but the pull returning nothing means authentication is
    // fine and authorisation is not: the account can log in but can no longer
    // read these tables. That used to return 200 quietly, so last_run simply
    // stopped advancing and only the watchdog noticed, a day late. Push here so
    // it fails as loudly as a thrown error does.
    if (!posted && (!data.users || !data.users.length)) {
      const msg = 'Bria pull returned 0 users — kept existing data. Sign-in worked, so this is read access (RLS/role), not the password.';
      await notify.notifyPush({ title: '⚠️ Bria sync pulled nothing', body: msg, url: '/' });
      return res.status(200).json({
        ok: false,
        skipped: msg,
        duration_ms: Date.now() - started,
      });
    }

    // Guard: every table below is replaced wholesale, so a pull that shrinks sharply
    // (a new Bria without the old history, a filter that drops a company) would erase
    // history the leaderboard and PRA read. Hold the existing data unless ?force=1.
    const force = req.query && (req.query.force === '1' || req.query.force === 'true');
    if (!posted && !force && CUTOVER) {
      // New Bria: only rows from CUTOVER on get replaced, so compare that window.
      const have = await growCountFrom('bria_deals', CUTOVER);
      const got = data.sales.filter((s) => (s.sale_date || '').slice(0, 10) >= CUTOVER).length;
      if (have && got < have * 0.9) {
        const msg = `Bria has ${got} sales since ${CUTOVER}, Grow holds ${have}. Kept existing data. Run with ?force=1 if the drop is expected.`;
        await notify.notifyPush({ title: '⚠️ Bria sync shrank', body: msg, url: '/' });
        return res.status(200).json({ ok: false, skipped: msg, duration_ms: Date.now() - started });
      }
    } else if (!posted && !force) {
      try {
        const base = process.env.SUPABASE_URL.replace(/\/$/, '');
        const key = process.env.SUPABASE_SERVICE_KEY;
        const r = await fetch(`${base}/rest/v1/bria_sync_meta?id=eq.1&select=bria_sales_total`, {
          headers: { apikey: key, Authorization: `Bearer ${key}` },
        });
        const prev = r.ok ? ((await r.json())[0] || {}).bria_sales_total : null;
        if (prev && data.sales.length < prev * 0.9) {
          const msg = `Bria pull has ${data.sales.length} sales, last sync had ${prev}. Kept existing data. Run with ?force=1 if the drop is expected.`;
          await notify.notifyPush({ title: '⚠️ Bria sync shrank', body: msg, url: '/' });
          return res.status(200).json({ ok: false, skipped: msg, duration_ms: Date.now() - started });
        }
      } catch (e) { /* no previous meta to compare against; proceed */ }
    }

    const completion = trainingErr ? [] : computeCompletion(data);
    const salesDaily = computeSalesDaily(data);
    const deals = computeDeals(data);

    // Two Bria users can share a display name, which collides on our (rep,*) keys.
    // Merge those before writing so a single insert never touches the same row twice.
    const compMap = new Map();
    for (const r of completion) {
      const k = r.rep + '\u0000' + r.course;
      const e = compMap.get(k);
      if (!e || (r.lesson_pct || 0) > (e.lesson_pct || 0) || (r.complete && !e.complete)) compMap.set(k, r);
    }
    const dailyMap = new Map();
    for (const r of salesDaily) {
      const k = r.rep + '\u0000' + r.sale_date;
      const e = dailyMap.get(k);
      if (!e) dailyMap.set(k, { ...r });
      else { e.deals += r.deals; e.installs += r.installs; }
    }

    const nowIso = new Date().toISOString();
    const completionRows = [...compMap.values()].map((r) => ({ ...r, updated_at: nowIso }));
    const salesRows = [...dailyMap.values()].map((r) => ({ ...r, updated_at: nowIso }));
    const dealRows = deals.map((r) => ({ ...r, updated_at: nowIso }));

    // Names first: every table below is keyed on rep, so a remap after the write
    // would leave two spellings of one person sitting in the database.
    await canonicalRepNames(completionRows, salesRows, dealRows);
    const completionOut = mergeByKey(completionRows, ['rep', 'course']);
    const salesOut = mergeByKey(salesRows, ['rep', 'sale_date'], ['deals', 'installs']);

    // No training access means no training rows; replacing would blank the page.
    const wc = trainingErr ? 'skipped' : await growReplace('training_completion', completionOut, 'rep,course');
    const ws = await growReplaceFrom('bria_sales_daily', salesOut, 'rep,sale_date');
    let wd = 0;
    try { wd = await growReplaceFrom('bria_deals', dealRows, 'bria_id'); }
    catch (e) {
      // growReplace clears the table before writing, so a rejected insert would
      // otherwise leave bria_deals empty. The usual cause is a column this code
      // sends that the table doesn't have yet (isp/product, until bria-sync.sql
      // is re-run) — retry without them so the deals still land.
      const msg = String(e.message || e);
      if (/isp|product|install_time|install_end_time|team_id|PGRST204/i.test(msg)) {
        const bare = dealRows
          .filter((r) => !CUTOVER || (r.sale_date && r.sale_date >= CUTOVER))
          .map(({ isp, product, install_time, install_end_time, team_id, ...r }) => r);
        try { wd = await growUpsert('bria_deals', bare, 'bria_id'); }
        catch (e2) { /* table may not exist at all; ignore so the rest of the sync still lands */ }
      }
      /* else: table may not exist yet; ignore so the rest of the sync still lands */
    }

    // Bria teams + memberships, stored raw (jsonb) because the read-only role
    // cannot show us the column names ahead of time. The dashboard reads name /
    // manager fields out of raw. Upsert only, so a failed pull never blanks them.
    let wt = 0, wm = 0;
    if (data.teams && data.teams.length) {
      try {
        wt = await growUpsert('bria_teams', data.teams.map((t) => ({
          id: String(t.id), name: t.name || t.team_name || t.title || null, raw: t, updated_at: nowIso,
        })), 'id');
      } catch (e) { console.log('bria_teams write failed:', e.message); }
    }
    if (data.memberships && data.memberships.length) {
      try {
        const nameById = {};
        for (const u of data.users) nameById[u.id] = (u.name || '').trim();
        const mRows = data.memberships.filter((m) => m.user_id).map((m) => ({
          id: String(m.id != null ? m.id : m.user_id + ':' + (m.company_id || '')),
          user_id: String(m.user_id), rep: nameById[m.user_id] || null,
          team_id: m.team_id != null ? String(m.team_id) : null, raw: m, updated_at: nowIso,
        }));
        await canonicalRepNames(mRows);
        wm = await growUpsert('bria_memberships', mRows, 'id');
      } catch (e) { console.log('bria_memberships write failed:', e.message); }
    }

    // The app's roster. Written only when this pull carried teams, so a failed
    // teams read keeps the last roster instead of turning everyone into subs.
    let wroster = null;
    if (data.teams && data.teams.length) {
      try {
        const memberRows = (data.memberships || []).length ? (await (async () => {
          const nameById = {};
          for (const u of data.users) nameById[u.id] = (u.name || '').trim();
          const rows = data.memberships.map((m) => ({ rep: nameById[m.user_id] || null, team_id: m.team_id }));
          await canonicalRepNames(rows);
          return rows;
        })()) : [];
        const startDay = (process.env.BRIA_START_WEEK || CUTOVER || '2026-05-01').trim();
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date());
        let blitz = null;
        if (data.learning_groups && data.learning_group_assignments) {
          const uRows = data.users.map((u) => ({ id: u.id, rep: (u.name || '').trim() }));
          await canonicalRepNames(uRows);
          const nameOf = new Map(uRows.filter((u) => u.rep).map((u) => [u.id, u.rep]));
          blitz = { groups: data.learning_groups, assignments: data.learning_group_assignments, nameOf,
            managers: new Set(data.learning_groups.map((g) => nameOf.get(g.trainer_id)).filter(Boolean)) };
        }
        const roster = buildBriaRoster(dealRows, data.teams, memberRows, startDay, today, blitz);
        if (Object.keys(roster.weeks).length) {
          await growUpsert('report_config', [{ manager: '__bria_teams__', config: { ...roster, synced_at: nowIso, source: 'bria-sync' } }], 'manager');
          wroster = Object.keys(roster.weeks).length;
        }
      } catch (e) { console.log('bria roster write failed:', e.message); }
    }

    // Rep directory: name + profile photo, for avatars on the dashboard.
    // Upsert (not replace) so a failed pull never blanks existing photos, and
    // keyed by display name because that is the only key the dashboard has.
    // Two Bria users sharing a name: the one with a photo wins, else last write.
    let wr = 0;
    if (photoUsers && photoUsers.length) {
      try {
        const repMap = new Map();
        // Same canonical names as every other table, or the dashboard looks a rep's
        // photo up under a spelling that is no longer stored anywhere.
        const photoRows = photoUsers.map((u) => ({ rep: (u.name || '').trim(), u }));
        await canonicalRepNames(photoRows);
        for (const { rep: nm, u } of photoRows) {
          if (!nm) continue;
          const prev = repMap.get(nm);
          if (!prev || (u.photo_url && !prev.photo_url)) {
            repMap.set(nm, { rep: nm, bria_id: String(u.id), photo_url: u.photo_url || null, updated_at: nowIso });
          }
        }
        wr = await growUpsert('bria_reps', [...repMap.values()], 'rep');
      } catch (e) { /* bria_reps table may not exist yet; avatars just fall back to initials */ }
    }

    const meta = [{
      id: 1,
      last_run: nowIso,
      ...(trainingErr ? {} : { completion_rows: completion.length }), // skipped training keeps the last count
      sales_daily_rows: salesDaily.length,
      bria_sales_total: data.sales.length,
      bria_users: data.users.length,
      duration_ms: Date.now() - started,
    }];
    await growUpsert('bria_sync_meta', meta, 'id');

    return res.status(200).json({
      ok: true,
      training_completion: wc,
      bria_sales_daily: ws,
      bria_deals: wd,
      bria_reps: wr,
      bria_teams: wt,
      bria_memberships: wm,
      bria_roster_weeks: wroster,
      bria_sales_total: data.sales.length,
      source: NEW_BRIA ? `new Bria, replacing from ${CUTOVER}` : 'old Bria',
      ...(trainingErr ? { training_skipped: trainingErr.slice(0, 200) } : {}),
      duration_ms: Date.now() - started,
    });
  } catch (e) {
    await notify.notifyPush({ title: '⚠️ Bria sync failed', body: String(e.message || e).slice(0, 200), url: '/' });
    return res.status(500).json({ error: String(e.message || e), duration_ms: Date.now() - started });
  }
}
