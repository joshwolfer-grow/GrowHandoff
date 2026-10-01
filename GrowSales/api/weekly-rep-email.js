// api/weekly-rep-email.js
// Weekly per-rep snapshot email. MANUAL send only — no cron. Open the endpoint in a
// browser with the key (e.g. /api/weekly-rep-email?key=SECRET) to get a control
// panel showing how many reps will receive it; click "Send to all" when ready.
// Each rep gets a short card recapping LAST week: knocking, deals + status, deals to
// confirm in Bria, cancelled-deals-to-call, install performance, and (stubbed)
// upfront status. Every stat links into their ?rep= dashboard / Sequifi / Bria.
//
// Data model notes (verified against live Supabase):
//   deals        Sequifi source of truth. week is SUNDAY-anchored (weekday 6).
//                cols: rep, manager, status(Serviced|Pending|Cancelled), customer,
//                sale_date, install_date, planned_install, cancel_date, week.
//   knocking     rep, date, doors, unique_doors, contacts, sold, first_disp, last_disp.
//   bria_deals   rep, customer(OFTEN EMPTY), sale_date, install_date. Because the
//                customer name is usually blank we reconcile by COUNT per rep/week,
//                not by name.
//   rep_onboarding  roster w/ email + manager_email(OFTEN NULL) + manager_name.
//
// Safety: this sends real email to real reps. A plain GET NEVER sends — it only
// shows the panel. Bulk send happens only on the panel's POST (its Send button).
// Modes: (default GET) control panel · ?render=1[&rep=Name] preview one in browser ·
// ?test=you@x send one sample to yourself · ?json=1 machine-readable summary.

import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';
import aliases from './_name-aliases.js';
// Merch blast lives behind ?tool=merch on this route: see api/_merch-send.js for
// why it is not its own function.
import merchSendHandler from './_merch-send.js';
const { canonicalFirstLast, canonicalDisplayName } = aliases;

// Lazy so importing this module (e.g. for a render preview) doesn't construct a
// client or touch the network until a request actually needs data.
let _supabase;
const sb = () => (_supabase ||= createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY));

// ------------------------------ config ------------------------------
// Bria only stores customer names/phones from May 2026; before that rows can
// never be reconciled, so "all time" for the Bria-vs-report check starts here.
const BRIA_USABLE_FROM = '2026-05-01';
const TRAILING_WEEKS = 8;            // window for install-rate / avg-days metrics
const PHONE_MAP_WEEKS = 16;          // Bria history scanned to recover cancelled-deal phones
const UPFRONT_THRESHOLD = 0.75;      // install rate needed to stay on upfront pay
const UPFRONT_WEEKS = 4;             // rolling complete weeks the rate is judged over
const KNOCKING_READY = false;        // Amplify knock data isn't trustworthy yet — show "coming soon" until it is

// Reps enrolled in upfront pay. Read live from public.upfront_optin, which
// api/upfront-optin-sync.js mirrors from the "upfront pay reps" sheet tab.
// The list below is only the fallback for an unreachable/empty table, so a
// Supabase blip can't quietly drop the upfront section from every email.
// Matched by name.
const UPFRONT_OPTIN_FALLBACK = [
  'Owen Langeland', 'Jaylen Brandon', 'Jayden Congleton', 'Spencer Boyd',
  'Marcelo Rios', 'JaQuan Batts', 'Trey Neal', 'Raihan Steed',
  'Justin Chesser', 'Matthew Roby', 'Brady White', 'Alli Lauriano',
];

// Subcontractor marks + manual addresses set in the dashboard. Most subs are not
// in Sequifi at all, so rep_onboarding has no row and therefore no email for
// them; without this they can never receive the weekly report.
async function loadRepFlags() {
  try {
    const { data, error } = await sb().from('rep_flags').select('rep,is_sub,email');
    if (error) throw error;
    return data || [];
  } catch (e) {
    console.warn('rep_flags read failed (table may not exist yet):', (e && e.message) || e);
    return [];
  }
}

async function loadUpfrontOptin() {
  try {
    const { data, error } = await sb().from('upfront_optin').select('name');
    if (error) throw error;
    const names = (data || []).map((r) => r.name).filter(Boolean);
    if (names.length) return names;
    console.warn('upfront_optin empty — falling back to the hardcoded list');
  } catch (e) {
    console.warn('upfront_optin read failed, using fallback:', (e && e.message) || e);
  }
  return UPFRONT_OPTIN_FALLBACK;
}
const SEND_CONCURRENCY = 4;          // parallel Gmail SMTP sends (pooled transport)
// From address. Gmail requires this to be the authenticated Workspace account or a
// configured "send as" alias, so default to the GMAIL_USER address.
const emailFrom = () => process.env.EMAIL_FROM || (process.env.GMAIL_USER ? `Grow Sales <${process.env.GMAIL_USER}>` : 'Grow Sales');
// Must be an ABSOLUTE, publicly reachable URL — email clients won't linkify a
// relative href (a bare "/?rep=" makes iOS Mail require long-press → Open in Safari),
// and VERCEL_URL is a per-deploy, SSO-gated hostname, so neither is usable here.
// Default to the stable production alias; override with EMAIL_DASH_URL if the domain changes.
// The funnel scopes to the recap week itself, so the numbers match the rest of
// the email. Wider windows are available on the snapshot via ?weeks=N.
const FUNNEL_WEEKS = 1;
const DASH_URL = (process.env.EMAIL_DASH_URL || 'https://growsales.vercel.app').replace(/\/$/, '');
const SEQUIFI_URL = process.env.SEQUIFI_URL || 'https://grow.sequifi.com';
const BRIA_URL = process.env.BRIA_URL || 'https://growfiber.vercel.app';

// ------------------------------ auth ------------------------------
// Dedicated EMAIL_ADMIN_KEY for this tool (so the admin key is independent of the
// sync secrets). CRON_SECRET / SYNC_TRIGGER_KEY still accepted as fallback.
// Accepts Bearer <secret> or ?key=<secret>.
function authorized(req) {
  const secrets = [process.env.EMAIL_ADMIN_KEY, process.env.CRON_SECRET, process.env.SYNC_TRIGGER_KEY].filter(Boolean);
  const bearer = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  const key = (req.query && req.query.key) || '';
  return secrets.some((s) => s && (bearer === s || key === s));
}

// ------------------------------ date helpers ------------------------------
// Sunday-anchored week that most recently COMPLETED. If today is Mon 07-13, the
// just-finished week is Sun 07-05..Sat 07-11, anchor 07-05.
function lastCompletedWeekSunday(now) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const thisSunday = new Date(d.getTime() - d.getUTCDay() * 86400000); // back up to Sunday
  return new Date(thisSunday.getTime() - 7 * 86400000);                // previous week
}
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (isoStr, n) => iso(new Date(new Date(isoStr + 'T12:00:00Z').getTime() + n * 86400000));
function daysBetween(a, b) {
  if (!a || !b) return null;
  const n = Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);
  return isNaN(n) ? null : n;
}

// ------------------------------ name matching ------------------------------
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

// ------------------------------ formatting ------------------------------
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nameCase = (s) => String(s || '').toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
const md = (d) => (d ? new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '');
const pct = (n) => (n == null ? 'n/a' : Math.round(n * 100) + '%');
const telDigits = (p) => String(p || '').replace(/\D/g, '');
const fmtPhone = (p) => {
  const d = telDigits(p);
  const ten = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)} ${ten.slice(6)}` : (p || '');
};
// Knock disposition time helpers (e.g. "1:15 PM") <-> minutes, for avg first/last knock.
const kToMin = (t) => { const m = String(t || '').match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i); if (!m) return null; let h = +m[1]; const mn = +m[2]; const pm = m[3].toUpperCase() === 'PM'; if (pm && h !== 12) h += 12; if (!pm && h === 12) h = 0; return h * 60 + mn; };
const kFromMin = (m) => { let h = Math.floor(m / 60); const mn = Math.round(m % 60); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return h + ':' + (mn < 10 ? '0' : '') + mn + ' ' + ap; };

// ============================== data load ==============================
// PostgREST/supabase-js caps a select at ~1000 rows by default; deals and
// bria_deals both exceed that over an 8-week window, so page through with
// .range() until a short page comes back. MUST order by a stable unique column —
// without it PostgREST's row order is unstable across pages, so .range() silently
// misses/overlaps rows and the eligible set (and count) jitters between requests.
async function fetchAll(table, columns, orderCol, build) {
  const PAGE = 1000;
  let out = [];
  for (let from = 0; ; from += PAGE) {
    let query = sb().from(table).select(columns).order(orderCol, { ascending: true }).range(from, from + PAGE - 1);
    if (build) query = build(query);
    const { data, error } = await query;
    if (error) throw new Error(`${table}: ${error.message}`);
    out = out.concat(data || []);
    if (!data || data.length < PAGE) break;
  }
  return out;
}

// TDS is a division inside Grow running its own SalesRabbit Amplify account, so
// `knocking` holds a row per (rep, date, source). Collapse to one row per rep/day.
// Doors/contacts add (verified distinct: no lead overlap between the accounts).
// Sold does NOT add — both syncs take sold from Bria, which tracks the person and
// so already covers both accounts; summing would double-count. Mirrors
// _mergeKnockingSources in index.html.
function mergeKnockingSources(rows) {
  const toMin = (t) => {
    const m = String(t || '').trim().match(/^(\d{1,2}):(\d{2})\s*([AaPp])/);
    if (!m) return null;
    let h = +m[1] % 12; if (/[Pp]/.test(m[3])) h += 12;
    return h * 60 + (+m[2]);
  };
  const by = new Map();
  for (const k of rows || []) {
    if (!k || !k.rep || !k.date) continue;
    const key = k.rep + '|' + k.date;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(k);
  }
  return [...by.values()].map((list) => {
    const out = { ...list[0], doors: 0, unique_doors: 0, contacts: 0 };
    // A row with no first_disp and no hours is a Time Track import counting the
    // SAME knocking Amplify already recorded (tell: doors==unique_doors, no
    // times). Where both exist for a rep/day, summing nearly doubles them, so
    // prefer the timed Amplify rows and let Time Track contribute only its sold.
    const timed = list.filter((k) => k.first_disp && (k.doors || 0) > 0);
    for (const k of (timed.length ? timed : list)) {
      out.doors += k.doors || 0; out.unique_doors += k.unique_doors || 0; out.contacts += k.contacts || 0;
    }
    let firstM = null, lastM = null, firstS = null, lastS = null, growSold = null, altSold = 0;
    for (const k of list) {
      if (k.source === 'grow') growSold = (growSold || 0) + (k.sold || 0);
      else altSold = Math.max(altSold, k.sold || 0);
      const f = toMin(k.first_disp); if (f !== null && (firstM === null || f < firstM)) { firstM = f; firstS = k.first_disp; }
      const l = toMin(k.last_disp); if (l !== null && (lastM === null || l > lastM)) { lastM = l; lastS = k.last_disp; }
    }
    out.sold = growSold !== null ? growSold : altSold;
    out.first_disp = firstS; out.last_disp = lastS;
    out.hours = (firstM !== null && lastM !== null && lastM > firstM) ? Math.round((lastM - firstM) / 60 * 100) / 100 : 0;
    return out;
  });
}

// Same as fetchAll, but a failure returns [] instead of rejecting. Used for the
// tables that only power extras (goals, records) — losing a badge is fine,
// taking down the whole email list is not.
async function fetchOptional(table, columns, orderCol, build) {
  try {
    return await fetchAll(table, columns, orderCol, build);
  } catch (e) {
    console.warn(`optional table ${table} unavailable:`, (e && e.message) || e);
    return [];
  }
}

async function loadAll(knockStart, weekSat, dealsStart, briaStart) {
  const [onboarding, attrOverrides, deals, knocking, bria, briaAll, dealsCnt, goals, reportConfig, briaDaily] = await Promise.all([
    fetchAll('rep_onboarding', 'first_name,last_name,email,manager_name,manager_email,is_manager,status_id', 'sequifi_id'),
    fetchAll('rep_manager_overrides', 'rep,week,manager', 'id'),
    fetchAll('deals', 'rep,manager,status,customer,phone,sale_date,install_date,planned_install,cancel_date,week,deal_type,isp', 'id', (q) => q.gte('sale_date', dealsStart)),
    // All sources (grow + the TDS division's own Amplify account); mergeKnockingSources
    // collapses a rep's rows from both into one row per day before aggregating.
    fetchAll('knocking', 'rep,date,doors,unique_doors,contacts,sold,first_disp,last_disp,hours,source', 'id', (q) => q.gte('date', knockStart).lte('date', weekSat)),
    // Just enough for the recap week's Bria-vs-deals gap count.
    fetchAll('bria_deals', 'rep,sale_date', 'bria_id', (q) => q.gte('sale_date', briaStart)),
    // Bria-vs-report scoreboard: full usable history, minimal columns. Kept
    // separate from the fetches above so none of the existing stats shift.
    fetchAll('bria_deals', 'rep,sale_date,customer,phone', 'bria_id', (q) => q.gte('sale_date', BRIA_USABLE_FROM)),
    fetchAll('deals', 'rep,sale_date,week', 'id', (q) => q.gte('sale_date', BRIA_USABLE_FROM)),
    // Weekly sales goals (rep-set, or corporate-set for a specific week), and
    // the per-team PRA mark set on the manager call. `notes` carries
    // "YYYY-MM-DD | what we agreed" for the PRA rows so the recap can quote it.
    fetchOptional('goals', 'scope,metric,target,week,notes', 'id'),
    // Holds the weekly note under a reserved key, alongside per-manager report config.
    fetchOptional('report_config', 'manager,config', 'id'),
    // Per-rep per-day sales for personal records + clubs. Same source the Club
    // page uses; the deal feed undercounts. NOTE: this table has no id column,
    // so it pages on (sale_date, rep) — that pair is unique, one row per rep/day.
    fetchOptional('bria_sales_daily', 'rep,sale_date,deals', 'sale_date', (q) => q.order('rep', { ascending: true })),
  ]);
  // The weekly roster you paste is the ONLY authority on who reports to whom.
  // deals.manager comes from Sequifi onboarding and drifts: as of Jul 2026 it
  // disagreed with the roster on 30 reps, filing Kiefer Neal's whole crew under
  // him after they moved to Caleb Neal, putting Will Archer's own deals under
  // Caleb Neal, and leaving several reps Unassigned. Grouping the email by that
  // field means the texts never match the teams you set.
  const roster = await loadRoster();
  return { onboarding, attrOverrides, deals: applyRosterManagers(deals, attrOverrides, roster),
           knocking, bria, briaAll, dealsCnt, goals, reportConfig, briaDaily, roster };
}

// Served as static files from the public production alias. VERCEL_URL is
// per-deploy and SSO-gated (see the note above DASH_URL), so it can't be used.
async function loadRoster() {
  const grab = async (f) => {
    try {
      const r = await fetch(`${DASH_URL}/${f}?v=${Date.now()}`);
      return r.ok ? await r.json() : {};
    } catch { return {}; }
  };
  const [hist, cur] = await Promise.all([grab('team-assignments.json'), grab('team-current.json')]);
  const byWeek = { ...hist, ...cur };            // a current paste replaces that whole week
  // The live roster saved from Admin > Roster (no deploy needed) wins over
  // whatever the deployed files say for its week.
  try {
    const { data } = await sb().from('report_config').select('config').eq('manager', '__roster_current__').limit(1);
    const live = data && data[0] && data[0].config;
    if (live && live.week && live.teams) byWeek[live.week] = live.teams;
  } catch { /* files remain the fallback */ }
  // Master Manager Pay history (parse-team-assignments.mjs --push) is the
  // roster of record and corrects every completed week. The in-progress week is
  // left alone: Master is only filled in as the week runs, so the paste is
  // fresher there. Mirrors _buildTeamAssign in index.html.
  try {
    const thisSun = (() => { const t = new Date(); t.setDate(t.getDate() - t.getDay()); return t.toISOString().slice(0, 10); })();
    const { data } = await sb().from('report_config').select('config').eq('manager', '__roster_weeks__').limit(1);
    const master = data && data[0] && data[0].config && data[0].config.weeks;
    for (const w of Object.keys(master || {})) {
      if (w >= thisSun && byWeek[w]) continue;
      byWeek[w] = master[w];
    }
  } catch { /* files remain the fallback */ }
  // Sequifi's own weekly teams (api/sequifi-teams-sync.js). From its start_week
  // on this is the only roster anyone maintains: Master stopped at Aug 9 2026,
  // so without it every later week fell back to a month-old crew list. Mirrors
  // the same overlay in _buildTeamAssign. The "latest on or before" lookup in
  // rosterMgr then carries a rep forward through the weeks Sequifi leaves them
  // off, which is what the dashboard does too.
  try {
    const { data } = await sb().from('report_config').select('config').eq('manager', '__bria_teams__').limit(1);
    const seq = data && data[0] && data[0].config && data[0].config.weeks;
    for (const w of Object.keys(seq || {})) byWeek[w] = seq[w];
  } catch { /* earlier sources remain the fallback */ }
  const repSeq = new Map();
  const push = (name, w, mgr) => {
    // Roster and Sequifi spell some people differently (Legrange vs Lagrange,
    // Alli vs Allison). Canonicalise both sides through the shared alias table
    // before matching, or those reps fall under no leader at all.
    const k = norm(aliases.canonicalDisplayName(name));
    if (!repSeq.has(k)) repSeq.set(k, []);
    repSeq.get(k).push({ w, mgr });
  };
  for (const w of Object.keys(byWeek).sort()) {
    for (const mgr of Object.keys(byWeek[w] || {})) {
      if (/^_?subs?$|^sub ?contractors?$/i.test(mgr)) continue;  // marker list, not a crew
      push(mgr, w, mgr);                                          // a lead attributes to themselves
      for (const rep of byWeek[w][mgr] || []) push(rep, w, mgr);
    }
  }
  for (const seq of repSeq.values()) seq.sort((a, b) => (a.w < b.w ? -1 : a.w > b.w ? 1 : 0));
  return { repSeq, weeks: Object.keys(byWeek).sort() };
}

// Levenshtein, capped. Only ever used to forgive a typo, never a real
// difference between two people.
function editDist(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 9;
  const prev = Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = cur;
    }
  }
  return prev[b.length];
}

// The roster and Sequifi spell the same person differently more often than not:
// Schweiger/Schwieger, Colette/Collette, Zach/Zackary, Legrange/Lagrange. An
// exact match drops those reps and their leader silently loses them, which
// defeats the point of pasting a roster at all. So: try exact, then accept a
// near miss where the last names are within two edits and the first initial
// agrees — but ONLY when exactly one roster entry fits, so a genuine second
// person is never absorbed into someone else's crew.
function fuzzyKey(roster, rep) {
  const n = norm(aliases.canonicalDisplayName(rep || ''));
  if (!n) return null;
  if (roster.repSeq.has(n)) return n;
  const parts = n.split(' ');
  if (parts.length < 2) return null;
  const first = parts[0], last = parts[parts.length - 1];
  const hits = [];
  for (const k of roster.repSeq.keys()) {
    const kp = k.split(' ');
    if (kp.length < 2) continue;
    if (kp[0][0] !== first[0]) continue;
    if (editDist(kp[kp.length - 1], last) > 2) continue;
    hits.push(k);
  }
  return hits.length === 1 ? hits[0] : null;
}

// Latest assignment on or before the deal's week, so a rep who moved crews mid
// quarter keeps their old deals under the old lead. Same rule as _authMgr in the
// dashboard, so the email and the app can never disagree.
function rosterMgr(roster, rep, week) {
  if (!roster || !roster.repSeq) return null;
  const key = fuzzyKey(roster, rep);
  const seq = key && roster.repSeq.get(key);
  if (!seq) return null;
  let out = null;
  for (const s of seq) { if (s.w <= week) out = s.mgr; else break; }
  return out;
}

function applyRosterManagers(deals, overrides, roster) {
  const ov = new Map((overrides || []).map((o) => [`${norm(aliases.canonicalDisplayName(o.rep))}|${o.week}`, o.manager]));
  return (deals || []).map((d) => {
    const wk = (d.week || '').slice(0, 10);
    // Manual triage beats the roster. Nothing falls back to Sequifi: its
    // manager field is onboarding data that drifts, and a wrong leader is worse
    // than a visible gap. Unmatched reps show as Unassigned so they get fixed.
    const m = ov.get(`${norm(aliases.canonicalDisplayName(d.rep))}|${d.week}`) || rosterMgr(roster, d.rep, wk) || 'Unassigned';
    return m === d.manager ? d : { ...d, manager: m };
  });
}

// Warm-instance cache of the loaded tables so previews / repeat panel loads don't
// re-run the (slow) paginated Supabase reads. Short TTL; keyed by the fetch window.
let _loadCache = null;
const LOAD_TTL_MS = 5 * 60 * 1000;
async function loadAllCached(knockStart, weekSat, dealsStart, briaStart) {
  const key = `${knockStart}|${weekSat}|${dealsStart}|${briaStart}`;
  if (_loadCache && _loadCache.key === key && Date.now() - _loadCache.at < LOAD_TTL_MS) return _loadCache.data;
  const data = await loadAll(knockStart, weekSat, dealsStart, briaStart);
  _loadCache = { key, at: Date.now(), data };
  return data;
}

// Group an array of rows by rep, keyed via keyFn (defaults to normalized name).
function groupByRep(rows, keyFn) {
  const kf = keyFn || ((r) => norm(r.rep));
  const m = new Map();
  for (const r of rows) {
    const k = kf(r);
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

// Resolve a deal/bria rep name to an onboarding rep key, tolerating nickname vs legal
// name (deals say "Chris Lagrange", onboarding "Christopher Lagrange"). Matches on last
// name + (first-name prefix either way, or same first initial) when it's unambiguous.
// Edit distance, capped — only used to allow a single typo.
function lev1(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 1) return 2;
  let prev = [], cur = [];
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    const t = prev; prev = cur; cur = t;
  }
  return prev[n];
}

function makeRepResolver(onboarding) {
  const keys = new Set();
  const byLast = new Map();
  const byFirst = new Map();
  for (const o of onboarding) {
    const c = canonicalFirstLast(o.first_name, o.last_name);
    const key = norm(`${c.first} ${c.last}`);
    if (!key) continue;
    keys.add(key);
    const parts = key.split(' ');
    const last = parts[parts.length - 1];
    const first = parts[0];
    if (!byLast.has(last)) byLast.set(last, []);
    byLast.get(last).push({ first, key });
    if (!byFirst.has(first)) byFirst.set(first, []);
    byFirst.get(first).push({ last, key });
  }
  return (name) => {
    // Alias first: source systems store the same person under different names
    // (Bria has a bare "Chris", comp has "Christopher Lagrange"), and without
    // this their deals and their Bria rows never meet.
    const k = norm(canonicalDisplayName(name));
    if (!k) return k;
    if (keys.has(k)) return k;
    const parts = k.split(' ');
    if (parts.length < 2) return k;
    const first = parts[0], last = parts[parts.length - 1];
    const cands = byLast.get(last) || [];
    // Safe: exact or prefix either way (Chris->Christopher, Alli->Allison).
    const matches = cands.filter((c) => c.first === first || c.first.startsWith(first) || first.startsWith(c.first));
    if (matches.length === 1) return matches[0].key;
    // Same-initial only when the surname is unique in onboarding — otherwise
    // "Isabella Hansen" would wrongly route to "Isaac Hansen". Catches TJ->Thomas.
    if (cands.length === 1 && cands[0].first[0] === first[0]) return cands[0].key;
    // One-character typo, but only ever in ONE half of the name while the other
    // half matches exactly. That's what makes it safe: "Trey Neal" can't reach
    // "Kiefer Neal" because the first names aren't a typo apart.
    // Catches Collette/Colette Morell and Auston Johnston/Johnson.
    const typoFirst = cands.filter((c) => lev1(c.first, first) === 1);
    if (typoFirst.length === 1) return typoFirst[0].key;
    const typoLast = (byFirst.get(first) || []).filter((c) => lev1(c.last, last) === 1);
    if (typoLast.length === 1) return typoLast[0].key;
    return k;
  };
}

// ============================== per-rep aggregation ==============================
function buildRepStats(rep, ctx) {
  const { weekSun, weekSat, windowStart } = ctx;
  const key = rep.key;

  // Knocking (past week)
  const { priorSun, priorSat } = ctx;
  // Aggregate a set of knocking days like the manager cards do: totals plus the
  // average first/last knock time and hours out.
  const sumK = (rows) => {
    const a = { doors: 0, contacts: 0, sold: 0, uniq: 0, hours: 0, days: 0, firsts: [], lasts: [] };
    for (const r of rows) {
      a.doors += r.doors || 0; a.contacts += r.contacts || 0; a.sold += r.sold || 0;
      a.uniq += r.unique_doors || 0; a.hours += r.hours || 0; a.days += 1;
      const f = kToMin(r.first_disp); if (f != null) a.firsts.push(f);
      const l = kToMin(r.last_disp); if (l != null) a.lasts.push(l);
    }
    const avg = (arr) => (arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : null);
    a.avgFirst = a.firsts.length ? kFromMin(avg(a.firsts)) : null;
    a.avgLast = a.lasts.length ? kFromMin(avg(a.lasts)) : null;
    a.hours = Math.round(a.hours * 10) / 10;
    return a;
  };
  // Per-day grid rows (like _repKnockCard) for a week: aggregate by date, keep
  // first/last knock, and compute totals + close%.
  const gridFor = (rows) => {
    const g = sumK(rows);
    g.close = g.contacts > 0 ? g.sold / g.contacts : 0;
    const byDate = new Map();
    for (const r of rows) {
      const c = byDate.get(r.date) || { date: r.date, doors: 0, unique: 0, contacts: 0, sold: 0, first: '', last: '' };
      c.doors += r.doors || 0; c.unique += r.unique_doors || 0; c.contacts += r.contacts || 0; c.sold += r.sold || 0;
      if (r.first_disp) c.first = r.first_disp;
      if (r.last_disp) c.last = r.last_disp;
      byDate.set(r.date, c);
    }
    g.byDay = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    return g;
  };
  const kkAll = ctx.knockByRep.get(key) || [];
  const knock = gridFor(kkAll.filter((r) => r.date >= weekSun && r.date <= weekSat));
  const knockPrior = gridFor(kkAll.filter((r) => r.date >= priorSun && r.date <= priorSat));
  knock.priorDoors = knockPrior.doors;
  knock.priorSold = knockPrior.sold;
  const rollStart = ctx.rollSun || weekSun;
  knock.roll = gridFor(kkAll.filter((r) => r.date >= rollStart && r.date <= weekSat));
  knock.rollWeeks = ctx.funnelWeeks || 1;

  // Deals for the completed week (by Sunday-anchored week), plus the week before it
  // so the email can show how the rep is trending.
  const allDeals = ctx.dealsByRep.get(key) || [];
  const active = (d) => d.status !== 'Cancelled';
  const breakdown = (list) => ({
    total: list.length,
    serviced: list.filter((d) => d.status === 'Serviced').length,
    pending: list.filter((d) => d.status === 'Pending').length,
    cancelled: list.filter((d) => d.status === 'Cancelled').length,
  });
  const weekDeals = allDeals.filter((d) => d.week === weekSun);
  const priorWeekDeals = allDeals.filter((d) => d.week === priorSun);
  const deals = {
    ...breakdown(weekDeals),
    active: weekDeals.filter(active),   // non-cancelled last-week deals (for the Bria check)
    prior: breakdown(priorWeekDeals),   // two-weeks-ago cohort, so they can watch it mature
  };
  // Headline "sold" is MERGED per day: the install report misses deals (lost
  // rep names, sync lag) and Bria misses others, so for each day the higher
  // source wins — the same rule the dashboard's KPI base uses. Status counts
  // (serviced/pending/cancelled) stay report-only; only the report knows them.
  const briaRows = ctx.briaByRep.get(key) || [];
  const mergedSold = (repDeals, lo, hi) => {
    const m = new Map();
    for (const d of repDeals) if (d.sale_date) m.set(d.sale_date, (m.get(d.sale_date) || 0) + 1);
    const b = new Map();
    for (const r of briaRows) if (r.sale_date >= lo && r.sale_date <= hi) b.set(r.sale_date, (b.get(r.sale_date) || 0) + 1);
    let t = 0;
    for (const k2 of new Set([...m.keys(), ...b.keys()])) t += Math.max(m.get(k2) || 0, b.get(k2) || 0);
    return t;
  };
  deals.sold = mergedSold(weekDeals, weekSun, weekSat);
  deals.prior.sold = mergedSold(priorWeekDeals, priorSun, priorSat);
  // Week in progress, for the live goal card.
  const curSun2 = ctx.curSun || addDays(weekSun, 7);
  deals.curWeek = mergedSold(allDeals.filter((d) => d.week === curSun2), curSun2, addDays(curSun2, 6));

  // Missing in Bria — count-based (Bria has no reliable customer names).
  const briaWeek = (ctx.briaByRep.get(key) || []).filter((b) => b.sale_date >= weekSun && b.sale_date <= weekSat);
  const briaGap = Math.max(0, deals.active.length - briaWeek.length);

  // Install performance — trailing window by sale_date. Install rate matches the
  // dashboard IR% and upfront eligibility: installs / (installs + cancels), i.e.
  // of the FINALIZED deals, what share installed. Pending deals are excluded.
  const windowDeals = allDeals.filter((d) => d.sale_date >= windowStart);
  const installedList = windowDeals.filter((d) => d.status === 'Serviced');
  const cancelledCount = windowDeals.filter((d) => d.status === 'Cancelled').length;
  const finalized = installedList.length + cancelledCount;
  const dtiVals = installedList.filter((d) => d.install_date).map((d) => daysBetween(d.sale_date, d.install_date)).filter((n) => n != null && n >= 0);
  const install = {
    rate: finalized ? installedList.length / finalized : null,
    avgDays: dtiVals.length ? Math.round((dtiVals.reduce((a, b) => a + b, 0) / dtiVals.length) * 10) / 10 : null,
    installed: installedList.length,
    sold: windowDeals.length,
  };

  // Recently-cancelled deals (count is all the email uses now — the tap-to-text list
  // lives in the dashboard, so no phone lookup needed here).
  const cancels = windowDeals.filter((d) => d.status === 'Cancelled' && d.cancel_date && d.cancel_date >= priorSun);

  // Two action counts for the dashboard nudge:
  //  - past-due pending: still Pending but the scheduled install date has passed.
  //  - cancels in the last 7 days: fresh cancels worth a call to win back.
  const sevenAgo = addDays(ctx.today, -7);
  const pastDuePending = allDeals.filter((d) => d.status === 'Pending' && d.planned_install && d.planned_install < ctx.today).length;
  const cancels7 = allDeals.filter((d) => d.status === 'Cancelled' && d.cancel_date && d.cancel_date >= sevenAgo).length;

  // Upfront pay eligibility — mirrors computeUpfront() in index.html: install rate
  // over the last 4 complete weeks, Standard deals only, rate = inst/(inst+canc).
  // A null rate (no finalized deals) counts as On. Only shown for opted-in reps.
  const ufWeeks = new Set([weekSun, addDays(weekSun, -7), addDays(weekSun, -14), addDays(weekSun, -21)]);
  const ufDeals = allDeals.filter((d) => d.deal_type === 'Standard' && ufWeeks.has(d.week));
  const ufInst = ufDeals.filter((d) => d.status === 'Serviced').length;
  const ufCanc = ufDeals.filter((d) => d.status === 'Cancelled').length;
  const ufPend = ufDeals.filter((d) => d.status === 'Pending').length;
  const ufFin = ufInst + ufCanc;
  const ufRate = ufFin ? ufInst / ufFin : null;
  const upfront = {
    optedIn: !!(ctx.upfrontOptin && ctx.upfrontOptin.has(key)),
    rate: ufRate, inst: ufInst, canc: ufCanc, pend: ufPend, fin: ufFin,
    on: ufRate == null || ufRate >= UPFRONT_THRESHOLD,
    // Extra installs (with no new cancels) needed to reach the threshold.
    needInstalls: ufRate != null && ufRate < UPFRONT_THRESHOLD ? Math.max(0, Math.ceil((UPFRONT_THRESHOLD * ufCanc - (1 - UPFRONT_THRESHOLD) * ufInst) / (1 - UPFRONT_THRESHOLD))) : 0,
  };

  return { knock, knockPrior, deals, briaGap, briaWeekCount: briaWeek.length, install, cancels, pastDuePending, cancels7, upfront };
}

// Worth emailing? Must have REAL sales (recent deals), or be on upfront pay. We do
// NOT include reps who only have knocking activity — Amplify knock data pulls in
// people who aren't really selling, and this email is driven off sales.
function isActive(s) {
  return recentSales(s) > 0 || (s.upfront && s.upfront.optedIn);
}
// Recent sales = deals in the last two weeks (used for eligibility and sort order).
function recentSales(s) {
  return (s.deals.total || 0) + (s.deals.prior.total || 0);
}

// Build a rep + stats from just a name (for reps not in onboarding — the panel lets
// you type an email and send them their recap anyway).
function repFromName(name, ctx, email) {
  const parts = String(name || '').trim().split(/\s+/);
  const first = parts[0] || String(name || '');
  const last = parts.slice(1).join(' ');
  // Resolve through the same onboarding resolver the pipeline keys on, or the
  // rep's deals, knocking and goals all miss ("Alli" set a goal, onboarding
  // says "Allison", raw norm() never connects them).
  const key = (ctx.resolveRep ? ctx.resolveRep(name) : null) || norm(name);
  const rep = { key, first, last, email: email || '', managerName: null };
  return { rep, stats: buildRepStats(rep, ctx) };
}

// ============================== upfront (STUB) ==============================
// TODO(upfront): fill in once the upfront model is defined. It will receive the
// rep's computed stats (install rate, avg days-to-install, deal counts) plus a
// per-rep upfront on/off status — likely a new `rep_upfront` table (rep, on_upfront
// bool, requirements JSON) or a field on rep_onboarding. Return '' to render nothing.
// When built, return an HTML block (same inline-style vocabulary as the sections
// below) showing: current upfront status, and if not on it, the specific gap to hit.
function buildUpfrontSection(rep, s) {
  const u = s.upfront;
  if (!u || !u.optedIn) return ''; // only reps enrolled in upfront pay see this
  const ratePct = u.rate == null ? null : Math.round(u.rate * 100);
  const need = Math.round(UPFRONT_THRESHOLD * 100);
  if (u.on) {
    const line = ratePct == null
      ? `No finalized deals in the last ${UPFRONT_WEEKS} weeks yet. Keep your installs clean to stay on.`
      : `Install rate <b style="color:${C.ink};">${ratePct}%</b> over the last ${UPFRONT_WEEKS} weeks, above the ${need}% you need to stay on. ${u.inst} installed of ${u.fin} finalized.`;
    return `<div style="margin-top:18px;padding:14px 16px;background:rgba(48,209,88,0.10);border:1px solid ${C.green};border-radius:12px;">
      <div style="font-size:15px;font-weight:800;color:${C.green};">&#11088; You're on upfront pay</div>
      <div style="font-size:13px;color:${C.sub};margin-top:4px;line-height:1.5;">${line}</div></div>`;
  }
  const needTxt = u.needInstalls > 0 ? `Get <b style="color:${C.ink};">${u.needInstalls} more install${u.needInstalls === 1 ? '' : 's'}</b> in with no new cancels to reach ${need}%. ` : '';
  return `<div style="margin-top:18px;padding:14px 16px;background:rgba(255,159,10,0.10);border:1px solid #ff9f0a;border-radius:12px;">
    <div style="font-size:15px;font-weight:800;color:#ff9f0a;">Upfront pay: not on right now</div>
    <div style="font-size:13px;color:${C.sub};margin-top:4px;line-height:1.5;">Install rate <b style="color:${C.ink};">${ratePct}%</b> over the last ${UPFRONT_WEEKS} weeks (${u.inst} installed of ${u.fin} finalized). You need ${need}% to get on upfront pay. ${needTxt}Protect your scheduled installs and rehash cancels.</div></div>`;
}

// ============================== HTML email ==============================
// Light palette matching the Grow Sales dashboard (index.html :root vars) so the
// email lines up with the site: #f0f0f5 page, white cards, Apple grays, #007aff blue.
const C = { page: '#f2f2ec', bg: '#ffffff', card: '#f4f4ef', ink: '#1d1d1f', sub: '#585d56', faint: '#8a8e87', sep: 'rgba(60,60,67,0.12)', red: '#ff3b30', green: '#1e8f43', gold: '#b8860b', blue: '#178f3f' };

// ---- Team standards -----------------------------------------------------
// What a rep has to hit to stay out. Deals and close rate are judged on the
// WEEK; contacts, hours and doors on the average day out. The bar runs from the
// minimum to the top standard, so the mid standard sits exactly halfway and the
// number that decides whether someone stays out is the left edge of the bar.
const STD = {
  deals:    { min: 10, mid: 20, top: 30, unit: '' },
  // 10 / 15 / 20. Was 10/20/30, which put the top mark out of reach and made the
  // bar read as failure for reps who were closing perfectly well.
  close:    { min: 10, mid: 15, top: 20, unit: '%' },
  contacts: { min: 20, mid: 30, top: 40, unit: '' },
};
const STD_HOURS = 7;    // per day out
const STD_DOORS = 80;   // per day out
const STD_LIME = '#7cb518', STD_AMBER = '#e8a317';
const stdColor = (v, s) => (v >= s.top ? C.green : v >= s.mid ? STD_LIME : v >= s.min ? STD_AMBER : C.red);
const markColor = (v, mark) => (v >= mark ? C.green : C.red);

// One labelled progress bar against a standard.
function stdBar(label, value, valueTxt, s, sub) {
  // Hitting the minimum shows a visible sliver (4%) rather than an empty bar;
  // below it the bar is deliberately empty.
  const pct = value < s.min ? 0 : Math.max(0, Math.min(100, Math.round(4 + ((value - s.min) / (s.top - s.min)) * 96)));
  const col = stdColor(value, s);
  // background-color is the fallback for clients that drop gradients (Outlook).
  // background-size stretches the red-to-green ramp across the FULL track, so
  // the fill's right edge is the colour for where they actually landed instead
  // of every bar showing its own miniature rainbow.
  const fill = pct > 0
    ? `<div style="height:11px;width:${pct}%;background-color:${col};background-image:linear-gradient(90deg,${C.red} 0%,${STD_AMBER} 12%,${STD_LIME} 55%,${C.green} 100%);background-size:${Math.round(10000 / pct)}% 100%;border-radius:6px;"></div>`
    : '';
  return `<div style="margin-top:15px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-size:12.5px;font-weight:700;color:${C.sub};">${label}</td>
      <td align="right" style="font-size:18px;font-weight:800;color:${col};line-height:1;">${valueTxt}</td>
    </tr></table>
    <div style="height:11px;background:#e5e5de;border-radius:6px;overflow:hidden;margin-top:6px;">${fill}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:4px;"><tr>
      <td style="font-size:10px;color:${C.faint};">${s.min}${s.unit}</td>
      <td align="center" style="font-size:10px;color:${C.faint};">${s.mid}${s.unit}</td>
      <td align="right" style="font-size:10px;color:${C.faint};">${s.top}${s.unit}</td>
    </tr></table>
    ${sub ? `<div style="font-size:11.5px;color:${C.faint};margin-top:4px;line-height:1.45;">${sub}</div>` : ''}
  </div>`;
}

// Hours and doors are pass/fail against one mark, so they're a number in red or
// green rather than a bar.
function markTile(label, valueTxt, value, mark, sub) {
  return `<td width="50%" style="padding:13px 8px;text-align:center;background:${C.card};border-radius:10px;">
    <div style="font-size:27px;font-weight:800;color:${markColor(value, mark)};line-height:1;">${valueTxt}</div>
    <div style="font-size:11px;color:${C.sub};margin-top:6px;">${label}</div>
    <div style="font-size:10.5px;color:${C.faint};margin-top:2px;">${sub}</div></td>`;
}

// The standards block that opens the knocking section.
// `soldWk` is the deals-feed count, so the Deals bar matches the Sales section
// further down. Close rate stays on the knock log's own sold/contacts pair —
// mixing the two would let the ratio run past 100% on days with no contacts.
function standardsHtml(k, soldWk) {
  const days = k.days || 0;
  const deals = soldWk == null ? k.sold : soldWk;
  const closePct = k.contacts > 0 ? Math.round(k.sold / k.contacts * 100) : 0;
  const cpd = days ? Math.round(k.contacts / days) : 0;
  const dpd = days ? Math.round(k.doors / days) : 0;
  const hpd = days ? Math.round((k.hours / days) * 10) / 10 : 0;
  const gap = Math.max(0, Math.ceil(STD.deals.min - deals));
  return `<div style="margin-top:22px;font-size:13px;font-weight:700;color:${C.sub};text-transform:uppercase;letter-spacing:0.6px;">Your standards</div>
    <div style="font-size:11.5px;color:${C.faint};margin-top:3px;">The three marks under each bar are targets: minimum &#183; good &#183; great.</div>
    <div style="padding:4px 2px 2px;">
      ${stdBar('Deals &#183; week total', deals, String(deals), STD.deals, gap ? `<b style="color:${C.red};">${gap} deal${gap === 1 ? '' : 's'} short of the ${STD.deals.min} minimum.</b>` : `Everything you sold this week &#183; target ${STD.deals.min}+.`)}
      ${stdBar('Close rate &#183; week', closePct, closePct + '%', STD.close, k.contacts > 0 ? `${k.sold} sold from ${k.contacts} contacts logged &#183; target ${STD.close.min}%+.` : 'No contacts logged.')}
      ${stdBar('Contacts &#183; daily average', cpd, String(cpd), STD.contacts, `Per day out${days ? ` &#183; ${k.contacts} total over ${days} day${days === 1 ? '' : 's'}` : ''} &#183; target ${STD.contacts.min}+ a day.`)}
    </div>
    <table role="presentation" cellpadding="0" cellspacing="6" width="100%" style="margin-top:12px;border-collapse:separate;"><tr>
      ${markTile('Hours out &#183; daily avg', hpd ? hpd + 'h' : '&#8212;', hpd, STD_HOURS, `target ${STD_HOURS}h a day`)}
      ${markTile('Doors &#183; daily avg', dpd ? String(dpd) : '&#8212;', dpd, STD_DOORS, `target ${STD_DOORS} a day`)}
    </tr></table>`;
}

function statTile(label, value, accent) {
  return `<td style="padding:10px 6px;text-align:center;background:${C.card};border-radius:10px;">
    <div style="font-size:24px;font-weight:800;color:${accent || C.ink};line-height:1;">${value}</div>
    <div style="font-size:11px;color:${C.sub};margin-top:5px;letter-spacing:0.3px;">${label}</div></td>`;
}
function button(label, href, accent) {
  return `<a href="${href}" style="display:inline-block;padding:11px 16px;margin:4px 6px 4px 0;background:${accent};color:#fff;text-decoration:none;border-radius:9px;font-size:14px;font-weight:700;">${label}</a>`;
}
// Colored up/down indicator vs the prior week (more is better for doors & deals).
function trendSpan(cur, prev) {
  const d = cur - prev;
  if (d > 0) return `<span style="color:${C.green};font-weight:700;">&#9650; +${d}</span>`;
  if (d < 0) return `<span style="color:${C.red};font-weight:700;">&#9660; ${Math.abs(d)}</span>`;
  return `<span style="color:${C.sub};font-weight:700;">even</span>`;
}
// Small "vs two weeks ago" line under a stat block.
function trendLine(label, cur, prev) {
  return `<div style="font-size:12px;color:${C.sub};margin-top:8px;">Two weeks ago: <b style="color:${C.ink};">${prev}</b> ${label} ${trendSpan(cur, prev)}</div>`;
}
const _md2 = (iso) => { const p = String(iso).split('-'); return (+p[1]) + '/' + (+p[2]); };
const _dow = (iso) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(iso + 'T12:00:00Z').getUTCDay()];
const _ts = (t) => (t ? t.replace(/\s/g, '').toLowerCase() : '—');

// The per-day knocking grid, ported from _repKnockCard so it matches the manager card:
// Day | Doors | Unq(%) | Cont | Sold | CR | 1st | Last, color-coded, with an AVG row.
// Doors -> contacts -> sales for the week: the three numbers that say WHERE a
// rep leaks. Averages per day worked, never totals.
function funnelHtml(kRoot) {
  const k = kRoot.roll || kRoot;
  const weeks = kRoot.rollWeeks || 1;
  if (!k.byDay || !k.byDay.length) return '';
  let doors = 0, contacts = 0, sold = 0, days = 0;
  for (const c of k.byDay) {
    // Every sale counts toward the total; only days with doors count as days out,
    // so a sale logged on an untracked day can't deflate the per-day averages.
    if ((c.doors || 0) > 0) days++;
    doors += c.doors || 0; contacts += c.contacts || 0; sold += c.sold || 0;
  }
  if (!days || !doors) return '';
  const covered = contacts >= sold; // knock log actually covers these sales
  const dpd = Math.round(doors / days);
  const cpd = Math.round(contacts / days * 10) / 10;
  const cr = contacts ? Math.round(contacts / doors * 100) : 0;
  const dps = (sold && covered) ? Math.round(doors / sold) : null;
  const cps = (sold && covered) ? Math.round(contacts / sold * 10) / 10 : null;
  const step = (label, value, sub) => `<td style="padding:10px 6px;text-align:center;background:${C.card};border-radius:10px;">
    <div style="font-size:20px;font-weight:800;color:${C.ink};line-height:1;">${value}</div>
    <div style="font-size:10.5px;color:${C.sub};margin-top:4px;letter-spacing:0.2px;">${label}</div>
    ${sub ? `<div style="font-size:10px;color:${C.faint};margin-top:2px;">${sub}</div>` : ''}</td>`;
  const spd = Math.round(sold / days * 10) / 10;
  // Under ~8 sales the ratio is still luck, so say so instead of printing a
  // precise number the rep would plan against.
  const settled = sold >= 8;
  const perSale = dps == null ? '&#8212;' : (settled ? dps : '~' + dps);
  return `<div style="margin-top:22px;font-size:13px;font-weight:700;color:${C.sub};text-transform:uppercase;letter-spacing:0.6px;">Your funnel &#183; last ${weeks} weeks</div>
    <table role="presentation" cellpadding="0" cellspacing="6" width="100%" style="margin-top:8px;border-collapse:separate;"><tr>
      ${step('Doors / day', dpd, `${days} day${days === 1 ? '' : 's'} out`)}
      ${step('Contacts / day', cpd, cr + '% of doors')}
      ${step('Sold / day', spd, sold + ' sold')}
      ${step('Doors / sale', perSale, cps == null ? '' : cps + ' contacts / sale')}
    </tr></table>
`;
}

function knockGridHtml(k, label, soldWk) {
  const head = `<div style="margin-top:22px;font-size:13px;font-weight:700;color:${C.sub};text-transform:uppercase;letter-spacing:0.6px;">Knocking &#183; ${label}</div>`;
  if (!k.byDay || !k.byDay.length) return head + `<div style="font-size:13px;color:${C.faint};margin-top:6px;">No knocking logged.</div>`;
  const th = `padding:6px 2px;font-size:9px;color:${C.sub};text-transform:uppercase;letter-spacing:0.2px;font-weight:700;`;
  const tdc = 'padding:6px 2px;text-align:center;font-size:11.5px;';
  const cell = (v, style) => `<td style="${tdc}${style || `color:${C.ink};`}">${v}</td>`;
  const dayLine = (c) => {
    const uPct = c.doors > 0 ? Math.round(c.unique / c.doors * 100) : 0;
    // Only rate what the knock log covers: `sold` is complete from the deals
    // feed while contacts exist only on tracked days, so a day with 3 sales and
    // 1 logged contact would otherwise read "300%".
    const rateable = c.contacts > 0 && c.sold <= c.contacts;
    const cr = rateable ? (c.sold / c.contacts * 100) : 0;
    const crTxt = rateable ? Math.round(cr) + '%' : '&#8212;';
    const fM = kToMin(c.first), lM = kToMin(c.last);
    const hrs = (fM != null && lM != null && lM > fM) ? Math.round((lM - fM) / 60 * 10) / 10 : null;
    // Same standards as the bars above, so a day reads the same way the week does.
    const doorsS = c.doors > 0 ? `color:${markColor(c.doors, STD_DOORS)};font-weight:700;` : `color:${C.faint};`;
    const contS = c.contacts > 0 ? `color:${stdColor(c.contacts, STD.contacts)};font-weight:700;` : `color:${C.faint};`;
    const soldS = c.sold >= 8 ? `color:${C.gold};font-weight:800;` : c.sold >= 4 ? `color:${C.green};font-weight:800;` : c.sold === 0 ? `color:${C.red};` : `font-weight:700;color:${C.ink};`;
    const crS = rateable ? `color:${stdColor(cr, STD.close)};font-weight:700;` : `color:${C.faint};`;
    const hS = hrs == null ? `color:${C.faint};` : `color:${markColor(hrs, STD_HOURS)};font-weight:700;`;
    const fS = fM != null ? (fM > 13 * 60 ? `color:${C.red};` : `color:${C.green};`) : `color:${C.faint};`;
    const lS = lM != null ? (lM < 21 * 60 ? `color:${C.red};` : `color:${C.green};`) : `color:${C.faint};`;
    return `<tr>
      <td style="${tdc}text-align:left;font-weight:700;color:${C.ink};white-space:nowrap;">${_dow(c.date)} ${_md2(c.date)}</td>
      ${cell(c.doors, doorsS)}
      ${cell(`${c.unique} <span style="font-size:8.5px;color:${C.sub};">(${uPct}%)</span>`)}
      ${cell(c.contacts, contS)}
      ${cell(c.sold, soldS)}
      ${cell(crTxt, crS)}
      ${cell(hrs == null ? '&#8212;' : hrs + 'h', hS)}
      ${cell(`<span style="font-size:9px;${fS}">${_ts(c.first)}</span>`)}
      ${cell(`<span style="font-size:9px;${lS}">${_ts(c.last)}</span>`)}
    </tr>`;
  };
  const bt = `border-top:1px solid ${C.sep};`;
  const sumUnique = k.byDay.reduce((a, c) => a + c.unique, 0);
  const avgD = k.days ? Math.round(k.doors / k.days) : 0;
  const avgU = k.days ? Math.round(sumUnique / k.days) : 0;
  const avgUpct = avgD > 0 ? Math.round(avgU / avgD * 100) : 0;
  const avgC = k.days ? Math.round(k.contacts / k.days) : 0;
  const avgH = k.days ? Math.round(k.hours / k.days * 10) / 10 : 0;
  const crAll = k.contacts > 0 ? Math.round(k.sold / k.contacts * 100) : 0;
  const avgRow = `<tr>
    <td style="${tdc}text-align:left;font-weight:800;color:${C.blue};${bt}">AVG</td>
    ${cell(avgD, `font-weight:800;color:${markColor(avgD, STD_DOORS)};${bt}`)}
    ${cell(`${avgU} <span style="font-size:8.5px;color:${C.sub};">(${avgUpct}%)</span>`, `font-weight:800;color:${C.ink};${bt}`)}
    ${cell(avgC, `font-weight:800;color:${stdColor(avgC, STD.contacts)};${bt}`)}
    ${cell(k.sold, `font-weight:800;color:${stdColor(k.sold, STD.deals)};${bt}`)}
    ${cell(crAll + '%', `font-weight:800;color:${stdColor(crAll, STD.close)};${bt}`)}
    ${cell(avgH ? avgH + 'h' : '&#8212;', `font-weight:800;color:${avgH ? markColor(avgH, STD_HOURS) : C.faint};${bt}`)}
    ${cell(`<span style="font-size:9px;color:${C.ink};">${k.avgFirst ? _ts(k.avgFirst) : '—'}</span>`, bt)}
    ${cell(`<span style="font-size:9px;color:${C.ink};">${k.avgLast ? _ts(k.avgLast) : '—'}</span>`, bt)}
  </tr>`;
  return standardsHtml(k, soldWk) + head + `<table role="presentation" width="100%" style="margin-top:8px;border-collapse:collapse;background:${C.card};border-radius:10px;overflow:hidden;">
    <tr><th style="${th}text-align:left;">Day</th><th style="${th}">Drs</th><th style="${th}">Unq</th><th style="${th}">Con</th><th style="${th}">Sold</th><th style="${th}">CR</th><th style="${th}">Hrs</th><th style="${th}">1st</th><th style="${th}">Last</th></tr>
    ${k.byDay.map(dayLine).join('')}
    ${avgRow}
  </table>
  <div style="font-size:11px;color:${C.faint};margin-top:6px;line-height:1.5;">Green means at or above standard, red below. Doors ${STD_DOORS} and hours ${STD_HOURS} a day, contacts ${STD.contacts.min}/${STD.contacts.mid}/${STD.contacts.top} a day, close rate ${STD.close.min}/${STD.close.mid}/${STD.close.top}%.</div>`;
}
// Compact deals-by-status tiles for one week.
function salesBlock(label, d) {
  const sold = d.sold != null ? d.sold : d.total;
  const extra = sold - d.total;   // deals Bria has that the report hasn't caught up on
  return `<div style="margin-top:22px;font-size:13px;font-weight:700;color:${C.sub};text-transform:uppercase;letter-spacing:0.6px;">Sales &#183; ${label}</div>
    <table role="presentation" cellpadding="0" cellspacing="6" width="100%" style="margin-top:8px;border-collapse:separate;"><tr>
      ${statTile('Sold', sold)}
      ${statTile('Serviced', d.serviced, d.serviced > 0 ? C.green : null)}
      ${statTile('Pending', d.pending, d.pending > 0 ? C.blue : null)}
      ${statTile('Cancelled', d.cancelled, d.cancelled > 0 ? C.red : null)}
    </tr></table>${extra > 0 ? `<div style="font-size:12px;color:${C.sub};margin-top:6px;">Includes ${extra} deal${extra === 1 ? '' : 's'} from Bria the install report hasn't caught up on yet.</div>` : ''}`;
}

// ============================== corporate email ==============================
// Same look as the rep email, but company-wide numbers and a link to the whole
// dashboard rather than a single rep's card. Sent to a typed list of addresses.
// ---- PRA goal per team, the mark set on the manager call ------------------
// Mirrors the dashboard's _mgrPraStats exactly: sold from Bria, divided by the
// reps who WORKED the week (knocked past the minimum, or sold) for Weekly PRA,
// or by their rep days worked for Daily PRA. Same source and same denominator
// the manager is looking at on their own link, so the recap can never quote a
// different number back at them than the app does.
const PRA_MIN_KNOCKS = 10;
const PRA_GOAL_METRICS = {
  pra_weekly: { label: 'Weekly PRA', dec: 1, unit: 'per rep' },
  pra_daily: { label: 'Daily PRA', dec: 2, unit: 'per rep day' },
};
function buildPraGoals(data, ctx) {
  // The goal in force for the recap week: a week-dated row for that week wins,
  // otherwise the standing row, which is what a mark set on a call becomes.
  // Same precedence the dashboard's _praGoal applies, so the recap and the
  // manager's own link never name a different mark: a row dated to the recap
  // week beats a standing one, a row written on a call (its notes carry a set
  // date) beats a leftover from the old Set Goals screen, and Weekly PRA breaks
  // any remaining tie because it is the headline number everywhere else.
  const dateNote = (g) => /^\d{4}-\d{2}-\d{2}\s*\|/.test(g.notes || '');
  const rank = (g) => (g.week === ctx.weekSun ? 4 : 0) + (dateNote(g) ? 2 : 0) + (g.metric === 'pra_weekly' ? 1 : 0);
  const chosen = new Map();   // normalised manager -> goal row
  for (const g of (data.goals || [])) {
    if (!g || !g.scope || !PRA_GOAL_METRICS[g.metric]) continue;
    if (g.week && g.week !== ctx.weekSun) continue;      // a mark for some other week
    const t = parseFloat(g.target);
    if (!isFinite(t) || t <= 0) continue;
    const k = norm(g.scope);
    const cur = chosen.get(k);
    if (!cur || rank(g) > rank(cur)) chosen.set(k, { ...g, target: t });
  }
  if (!chosen.size) return [];

  const mgrOf = (rep) => {
    const m = rosterMgr(data.roster, rep, ctx.weekSun);
    return m ? norm(m) : null;
  };
  const agg = new Map();   // normalised manager -> { name, sold, reps:Set, days:Set }
  const slot = (k, display) => {
    if (!agg.has(k)) agg.set(k, { name: display, sold: 0, reps: new Set(), days: new Set() });
    return agg.get(k);
  };
  for (const b of (data.bria || [])) {
    if (!b || !b.rep || !b.sale_date) continue;
    if (b.sale_date < ctx.weekSun || b.sale_date > ctx.weekSat) continue;
    const k = mgrOf(b.rep); if (!k || !chosen.has(k)) continue;
    const g = slot(k, b.rep);
    g.sold += 1; g.reps.add(norm(b.rep)); g.days.add(`${norm(b.rep)}|${b.sale_date}`);
  }
  for (const r of mergeKnockingSources(data.knocking || [])) {
    if (!r || !r.rep || !r.date) continue;
    if (r.date < ctx.weekSun || r.date > ctx.weekSat) continue;
    if ((r.doors || 0) <= PRA_MIN_KNOCKS) continue;
    const k = mgrOf(r.rep); if (!k || !chosen.has(k)) continue;
    const g = slot(k, r.rep);
    g.reps.add(norm(r.rep)); g.days.add(`${norm(r.rep)}|${r.date}`);
  }

  const rows = [];
  for (const [k, goal] of chosen) {
    const a = agg.get(k);
    const reps = a ? a.reps.size : 0;
    const repDays = a ? a.days.size : 0;
    const sold = a ? a.sold : 0;
    const M = PRA_GOAL_METRICS[goal.metric];
    const actual = goal.metric === 'pra_daily'
      ? (repDays ? sold / repDays : 0)
      : (reps ? sold / reps : 0);
    // notes are stored "YYYY-MM-DD | what we agreed" by the dashboard.
    const m = /^(\d{4}-\d{2}-\d{2})\s*\|\s*([\s\S]*)$/.exec(goal.notes || '');
    rows.push({
      key: k, name: nameCase(goal.scope), metric: goal.metric, label: M.label, dec: M.dec, unit: M.unit,
      target: goal.target, actual, sold, reps, repDays,
      hit: actual >= goal.target, standing: !goal.week,
      setOn: m ? m[1] : null, note: (m ? m[2] : String(goal.notes || '')).trim(),
    });
  }
  return rows.sort((a, b) => (b.actual / b.target) - (a.actual / a.target));
}

// The PRA-goal block for the recap: every team that has a mark, whether they hit
// it, and the line agreed on the call underneath. This is the part that makes a
// call stick — the number and the sentence travel together.
function praGoalHtml(rows) {
  if (!rows || !rows.length) return '';
  const body = rows.map((r) => {
    const col = r.actual > 0 ? (r.hit ? C.green : C.red) : C.faint;
    const pctv = r.target > 0 ? Math.max(0, Math.min(100, Math.round(r.actual / r.target * 100))) : 0;
    return `<tr><td style="padding:11px 12px;border-top:1px solid ${C.sep};">
      <div style="font-size:13.5px;font-weight:700;color:${C.ink};">${esc(r.name)}</div>
      <div style="font-size:11px;color:${C.faint};margin-top:2px;">${r.label} &#183; ${r.sold} sold &#183; ${r.metric === 'pra_daily' ? `${r.repDays} rep day${r.repDays === 1 ? '' : 's'}` : `${r.reps} rep${r.reps === 1 ? '' : 's'} worked`}</div>
      ${r.note ? `<div style="font-size:11.5px;color:${C.sub};margin-top:5px;line-height:1.45;">&ldquo;${esc(r.note)}&rdquo;</div>` : ''}
      <div style="height:7px;background:#e5e5de;border-radius:4px;overflow:hidden;margin-top:7px;"><div style="height:7px;width:${pctv}%;background:${r.hit ? C.green : C.blue};border-radius:4px;"></div></div>
      </td>
      <td align="right" style="padding:11px 12px;border-top:1px solid ${C.sep};white-space:nowrap;vertical-align:top;">
        <div style="font-size:21px;font-weight:800;color:${col};line-height:1;">${r.actual > 0 ? r.actual.toFixed(r.dec) : '&#8212;'}</div>
        <div style="font-size:11.5px;color:${C.faint};margin-top:4px;">of ${r.target.toFixed(r.dec)}</div>
      </td></tr>`;
  }).join('');
  const hitN = rows.filter((r) => r.hit).length;
  return `<div style="margin-top:22px;font-size:13px;font-weight:700;color:${C.sub};text-transform:uppercase;letter-spacing:0.6px;">PRA goals</div>
    <div style="font-size:11.5px;color:${C.faint};margin-top:3px;">${hitN} of ${rows.length} team${rows.length === 1 ? '' : 's'} hit the mark set on the manager call.</div>
    <table role="presentation" width="100%" style="margin-top:8px;border-collapse:collapse;background:${C.card};border-radius:10px;overflow:hidden;">${body}</table>`;
}

function buildCompanyStats(deals, ctx) {
  const wk = { total: 0, serviced: 0, pending: 0, cancelled: 0 };
  const prior = { total: 0, serviced: 0, pending: 0, cancelled: 0 };
  // Per-manager, this week and last, so the email can show direction not just level.
  const blank = () => ({ sold: 0, inst: 0, canc: 0, pend: 0, reps: new Set(), book: [] });
  const mgrs = new Map();   // name -> { cur, prev }
  const slot = (name) => {
    if (!mgrs.has(name)) mgrs.set(name, { cur: blank(), prev: blank() });
    return mgrs.get(name);
  };
  const inWeek = (d, sun, sat) => d.sale_date && d.sale_date >= sun && d.sale_date <= sat;
  const days = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);
  for (const d of deals) {
    const isPresale = d.deal_type === 'Presale';
    let bucket = null, which = null;
    if (inWeek(d, ctx.weekSun, ctx.weekSat)) { bucket = wk; which = 'cur'; }
    else if (inWeek(d, ctx.priorSun, ctx.priorSat)) { bucket = prior; which = 'prev'; }
    if (!bucket) continue;
    bucket.total++;
    if (d.status === 'Serviced') bucket.serviced++;
    else if (d.status === 'Cancelled') bucket.cancelled++;
    else if (d.status === 'Pending') bucket.pending++;
    // Manager table is standard deals only: presale never installs in-window and
    // would drag every rate and booking figure sideways.
    if (isPresale) continue;
    const g = slot(d.manager || 'Unassigned')[which];
    g.sold++;
    if (d.rep) g.reps.add(d.rep);
    if (d.status === 'Serviced') g.inst++;
    else if (d.status === 'Cancelled') g.canc++;
    else if (d.status === 'Pending') g.pend++;
    if (d.planned_install && d.sale_date) {
      const b = days(d.sale_date, d.planned_install);
      if (b >= 0 && b < 120) g.book.push(b);
    }
  }
  // ---- where the week will LAND ----
  // A recap week's installs are still arriving, so its raw install rate is
  // meaningless on its own. Estimate the finish: every deal still Pending will
  // eventually resolve, and historically a known share of resolved deals ends
  // up installed. Take that "settle rate" from cohorts old enough to be done
  // (5+ weeks back), per manager where the sample supports it, company-wide
  // otherwise, and apply it to the pending pool.
  const SETTLE_CUTOFF = addDays(ctx.weekSun, -7 * 4);   // sold before this = matured
  const matured = new Map(); let mi = 0, mc = 0;
  for (const d of deals) {
    if (d.deal_type === 'Presale') continue;
    if (!d.sale_date || d.sale_date >= SETTLE_CUTOFF) continue;
    if (d.status !== 'Serviced' && d.status !== 'Cancelled') continue;
    const k = d.manager || 'Unassigned';
    if (!matured.has(k)) matured.set(k, { i: 0, c: 0 });
    const g = matured.get(k);
    if (d.status === 'Serviced') { g.i++; mi++; } else { g.c++; mc++; }
  }
  const companySettle = (mi + mc) ? mi / (mi + mc) : 0.75;
  const settleFor = (name) => {
    const g = matured.get(name);
    if (!g || (g.i + g.c) < 25) return companySettle;   // thin sample -> company rate
    return g.i / (g.i + g.c);
  };

  const ir = (b) => { const f = b.serviced + b.cancelled; return f ? b.serviced / f : null; };
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const rowFor = (name, g) => ({
    name,
    sold: g.cur.sold, prevSold: g.prev.sold,
    reps: g.cur.reps.size,
    pra: g.cur.reps.size ? g.cur.sold / g.cur.reps.size : null,
    book: avg(g.cur.book), prevBook: avg(g.prev.book),
    inst: g.cur.inst, canc: g.cur.canc, pend: g.cur.pend,
    ir: (g.cur.inst + g.cur.canc) ? g.cur.inst / (g.cur.inst + g.cur.canc) : null,
    projIr: (() => {
      const t = g.cur.inst + g.cur.canc + g.cur.pend;
      if (!t) return null;
      return (g.cur.inst + g.cur.pend * settleFor(name)) / t;
    })(),
    projInst: Math.round(g.cur.inst + g.cur.pend * settleFor(name)),
  });
  const managers = [...mgrs.entries()].map(([n, g]) => rowFor(n, g))
    .filter((r) => r.sold > 0).sort((a, b) => b.sold - a.sold);
  const wkTot = wk.serviced + wk.cancelled + wk.pending;
  const projIrWk = wkTot ? (wk.serviced + wk.pending * companySettle) / wkTot : null;
  return { wk, prior, irWk: ir(wk), irPrior: ir(prior), projIrWk,
           projInstWk: Math.round(wk.serviced + wk.pending * companySettle),
           companySettle, managers };
}

function renderCompanyEmail(cs, ctx, opts) {
  const has = (opts && opts.has) || (() => true);
  const rows = [];
  const range = `${md(ctx.weekSun)} to ${md(ctx.weekSat)}`;
  rows.push(`<div style="font-size:22px;font-weight:800;letter-spacing:-0.3px;">Grow &#183; last week</div>
    <div style="font-size:13px;color:${C.sub};margin-top:2px;">${range}</div>`);

  const delta = (cur, prev) => {
    if (prev == null || !prev) return '';
    const d = cur - prev;
    if (!d) return `<span style="color:${C.faint};font-size:12px;"> even</span>`;
    const up = d > 0;
    return `<span style="color:${up ? C.green : C.red};font-size:12px;"> ${up ? '&#9650;' : '&#9660;'} ${Math.abs(d)}</span>`;
  };

  if (has('tiles')) rows.push(`<table role="presentation" cellpadding="0" cellspacing="6" width="100%" style="margin-top:16px;border-collapse:separate;"><tr>
      ${statTile('Sold', cs.wk.total)}
      ${statTile('Installed', cs.wk.serviced, cs.wk.serviced > 0 ? C.green : null)}
      ${statTile('Pending', cs.wk.pending, cs.wk.pending > 0 ? C.blue : null)}
      ${statTile('Cancelled', cs.wk.cancelled, cs.wk.cancelled > 0 ? C.red : null)}
    </tr></table>`);

  if (has('company')) rows.push(`<table role="presentation" width="100%" style="margin-top:14px;border-collapse:collapse;background:${C.card};border-radius:10px;overflow:hidden;">
    <tr><td style="padding:11px 14px;font-size:14px;color:${C.ink};">Sold</td>
        <td style="padding:11px 14px;text-align:right;font-weight:800;color:${C.ink};">${cs.wk.total}${delta(cs.wk.total, cs.prior.total)}</td></tr>
    <tr><td style="padding:11px 14px;font-size:14px;color:${C.ink};border-top:1px solid ${C.sep};">Install rate <span style="color:${C.faint};font-size:12px;">projected</span></td>
        <td style="padding:11px 14px;text-align:right;font-weight:800;color:${C.ink};border-top:1px solid ${C.sep};">${cs.projIrWk == null ? '&#8212;' : Math.round(cs.projIrWk * 100) + '%'}${cs.irWk != null && cs.wk.pending ? `<span style="color:${C.faint};font-weight:600;font-size:12px;"> (${Math.round(cs.irWk * 100)}% so far)</span>` : ''}</td></tr>
    <tr><td style="padding:11px 14px;font-size:14px;color:${C.ink};border-top:1px solid ${C.sep};">Installs <span style="color:${C.faint};font-size:12px;">projected</span></td>
        <td style="padding:11px 14px;text-align:right;font-weight:800;color:${C.ink};border-top:1px solid ${C.sep};">${cs.projInstWk}<span style="color:${C.faint};font-weight:600;font-size:12px;"> (${cs.wk.serviced} landed)</span></td></tr>
    <tr><td style="padding:11px 14px;font-size:14px;color:${C.ink};border-top:1px solid ${C.sep};">Week before</td>
        <td style="padding:11px 14px;text-align:right;font-weight:700;color:${C.sub};border-top:1px solid ${C.sep};">${cs.prior.total} sold</td></tr>
  </table>`);

  if (cs.managers.length && has('managers')) {
    // Arrow shows direction vs last week. For booking days, fewer is better, so
    // the colour flips — a shrinking booking window is good news.
    const arrow = (cur, prev, lowerIsBetter) => {
      if (prev == null || cur == null || !prev) return '';
      const d = cur - prev;
      if (Math.abs(d) < 0.05) return `<span style="color:${C.faint};"> &#8226;</span>`;
      const good = lowerIsBetter ? d < 0 : d > 0;
      const mag = Math.abs(d) >= 10 ? Math.round(Math.abs(d)) : Math.abs(d).toFixed(1);
      return `<span style="color:${good ? C.green : C.red};font-size:11px;"> ${d > 0 ? '&#9650;' : '&#9660;'}${mag}</span>`;
    };
    const th = (t, align) => `<th style="padding:7px 6px;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:${C.sub};text-align:${align || 'right'};font-weight:700;">${t}</th>`;
    const td = (v, align) => `<td style="padding:8px 6px;font-size:12.5px;color:${C.ink};text-align:${align || 'right'};">${v}</td>`;
    const body = cs.managers.slice(0, 14).map((m) => `<tr>
      ${td(`<b>${esc(m.name)}</b>`, 'left')}
      ${td(m.reps)}
      ${td(`<b>${m.sold}</b>${arrow(m.sold, m.prevSold, false)}`)}
      ${td(m.pra == null ? '&#8212;' : m.pra.toFixed(1))}
      ${td(m.book == null ? '&#8212;' : m.book.toFixed(1) + 'd' + arrow(m.book, m.prevBook, true))}
      ${td(`${m.inst}${m.pend ? `<span style="color:${C.faint};font-size:11px;"> &rarr;${m.projInst}</span>` : ''}`)}
      ${td(m.canc)}
      ${td(m.projIr == null ? '&#8212;' : `<b>${Math.round(m.projIr * 100)}%</b>${m.ir != null && m.pend ? `<span style="color:${C.faint};font-size:11px;"> (${Math.round(m.ir * 100)}%)</span>` : ''}`)}
    </tr>`).join('');
    rows.push(`<div style="margin-top:22px;font-size:13px;font-weight:700;color:${C.sub};text-transform:uppercase;letter-spacing:0.6px;">By manager</div>
      <table role="presentation" width="100%" style="margin-top:8px;border-collapse:collapse;background:${C.card};border-radius:10px;overflow:hidden;">
        <tr>${th('Manager', 'left')}${th('Reps')}${th('Sold')}${th('Per rep')}${th('Booking')}${th('Inst &rarr; proj')}${th('Canc')}${th('IR proj')}</tr>
        ${body}
      </table>
      <div style="font-size:11.5px;color:${C.faint};margin-top:6px;line-height:1.5;">Standard deals only, attributed to the manager on that week's roster. Arrows compare to the week before. For booking days, down is good. Installs and IR are still landing, so both are projected: the arrow after installs and the bold IR are where the week should finish once the pending deals resolve, with what has landed so far in brackets. Based on how each manager's older weeks actually settled (${Math.round(cs.companySettle * 100)}% company-wide).</div>`);
  }

  if (has('checkback')) rows.push(`<div style="font-size:13.5px;color:${C.ink};margin-top:18px;line-height:1.55;background:rgba(23,143,63,0.08);border:1px solid ${C.blue};border-radius:10px;padding:11px 13px;">Installs and cancels keep landing after this sends, so these numbers move all week. <b>Check the dashboard through the week</b> for the live read. Every view has a This week, Last week and YTD switch.</div>`);
  rows.push(`<div style="margin-top:22px;">${button('Open the dashboard', DASH_URL, C.blue)}</div>`);
  if (has('pragoals')) rows.push(praGoalHtml(cs.praGoals));

  rows.push(`<div style="font-size:11px;color:${C.faint};margin-top:22px;border-top:0.5px solid ${C.sep};padding-top:12px;">Grow Sales &#183; company recap</div>`);

  return `<div style="margin:0;padding:24px 12px;background:${C.page};font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:${C.bg};color:${C.ink};border-radius:16px;border:1px solid ${C.sep};overflow:hidden;-webkit-text-size-adjust:100%;">
      <div style="background:#0b0c0b;padding:14px 24px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="vertical-align:middle;"><img src="${DASH_URL}/icon.png" alt="GROW" height="34" style="height:34px;border-radius:8px;vertical-align:middle;"><span style="color:#ffffff;font-weight:800;font-size:14px;letter-spacing:0.08em;margin-left:10px;vertical-align:middle;">GROW</span></td>
          <td style="text-align:right;vertical-align:middle;color:#8b8f88;font-size:12px;">${range}</td>
        </tr></table>
      </div>
      <div style="padding:24px;">${rows.join('')}</div>
    </div></div>`;
}

// What (if anything) they broke last week. Returns null when there's nothing to
// celebrate, so callers can stay quiet rather than manufacture praise.
function prNote(rep, ctx) {
  const r = ctx.recByRep && ctx.recByRep.get(rep.key);
  if (!r) return null;
  const dow = (isoD) => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(isoD + 'T12:00:00Z').getUTCDay()];
  // These lines never restate what the rep sold last week. Records are measured
  // on the Bria feed (the only one carrying full history), while the Deals bar
  // and the Sales section below count the install report, and the two routinely
  // differ by a deal. Printing "9 sold" directly above a bar reading 10 made the
  // whole email look wrong. The record CLAIM still rests on Bria; the only
  // number quoted is the prior best, which has no counterpart elsewhere here.
  if (r.prWeek) return { kind: 'week', head: 'RECORD WEEK', hype: true, line: `<b>Best week you have ever had.</b> Your old record was ${r.priorBestWeek}. Now go beat it again.`, short: `RECORD WEEK` };
  if (r.prDay) return { kind: 'day', head: 'Record day', line: `Your best day ever, on ${dow(r.wkBestDayDate)}. Previous best was ${r.priorBestDay}.`, short: `record day` };
  if (r.tieWeek) return { kind: 'week', head: 'Matched record week', line: `You matched your best week ever. Beat it and it is yours.`, short: `matched best week` };
  if (r.tieDay) return { kind: 'day', head: 'Matched record day', line: `You matched your best day ever, on ${dow(r.wkBestDayDate)}.`, short: `matched best day` };
  return null;
}

function renderEmail(rep, s, ctx, opts) {
  opts = opts || {};
  const has = opts.has || (() => true);
  // The dashboard embeds this page (?snapshot=). A dashboard link inside the frame
  // loads the whole app under whoever is signed in on that device, so the
  // embed carries no dashboard buttons.
  const embed = !!opts.embed;
  // Personal no-login dashboard scoped to this rep (?rep= view).
  const repUrl = `${DASH_URL}/?rep=${encodeURIComponent(`${rep.first} ${rep.last}`.trim())}`;

  const twoWeekRange = `${md(ctx.priorSun)} to ${md(ctx.weekSat)}`;

  const rows = [];
  // Header — this card covers the last two full weeks.
  rows.push(`<div style="font-size:22px;font-weight:800;letter-spacing:-0.3px;">${esc(rep.first)}, your last two weeks</div>
    <div style="font-size:13px;color:${C.sub};margin-top:2px;">${twoWeekRange}</div>`);

  // A record beats every other thing in this email, so it goes at the very top
  // where it can't be missed.
  const _pr = has('goalrec') ? prNote(rep, ctx) : null;
  if (_pr && _pr.hype) {
    // A record week is the one moment worth shouting about.
    rows.push(`<div style="margin-top:14px;padding:18px 18px;background:linear-gradient(160deg,#fff6d9,#ffe9a8);border:2px solid #d4a017;border-radius:14px;text-align:center;">
      <div style="font-size:30px;line-height:1;">&#127942;</div>
      <div style="font-size:20px;font-weight:800;color:#7a5c05;letter-spacing:0.5px;margin-top:6px;">${_pr.head}</div>
      <div style="font-size:15px;color:${C.ink};margin-top:6px;line-height:1.5;">${_pr.line}</div></div>`);
  } else if (_pr) {
    rows.push(`<div style="margin-top:14px;padding:12px 15px;background:${C.card};border-left:4px solid #d4a017;border-radius:10px;">
      <div style="font-size:11px;font-weight:800;color:${C.sub};text-transform:uppercase;letter-spacing:0.5px;">${_pr.head}</div>
      <div style="font-size:14px;color:${C.ink};margin-top:2px;line-height:1.5;">${_pr.line}</div></div>`);
  }

  // Your message for the week. Sits above the numbers because it's the part
  // that isn't automated — if it's here, it's because you wrote it.
  if (has('note') && ctx.weekNote) {
    const safe = esc(ctx.weekNote).replace(/\r?\n/g, '<br>');
    rows.push(`<div style="margin-top:14px;padding:14px 16px;background:${C.card};border-left:4px solid ${C.blue};border-radius:10px;">
      <div style="font-size:11px;font-weight:800;color:${C.sub};text-transform:uppercase;letter-spacing:0.5px;">This week</div>
      <div style="font-size:14.5px;color:${C.ink};margin-top:4px;line-height:1.55;">${safe}</div></div>`);
  }

  // Intro — plain-spoken, points them to the dashboard for the actionable stuff.
  rows.push(`<div style="font-size:14px;color:${C.ink};margin-top:14px;line-height:1.55;">Here's your last two weeks. Open your dashboard to call your recent cancels and chase any installs running late${rep.isSub ? '' : ', and check what Bria has against the install report'}.</div>`);

  // These numbers are a snapshot; installs keep landing all week. Tell them so they
  // come back to the live dashboard instead of treating this email as final.

  // Upfront pay status — it's about their money (opted-in reps only).
  const upfront = has('upfront') ? buildUpfrontSection(rep, s) : null;
  if (upfront) rows.push(upfront);

  // Knocking — the exact per-day grid, both weeks. Only when enabled for this rep's
  // manager (their knock data comes from a trusted source, e.g. Time Track). Managers
  // whose data is from Amplify leave it off, and the section is simply omitted.
  if (opts.knocking && has('knocking')) {
    // Last week's per-day grid only — two-weeks-ago knocking was dropped as noise.
    rows.push(knockGridHtml(s.knock, `last week (${md(ctx.weekSun)} to ${md(ctx.weekSat)})`, s.deals.sold != null ? s.deals.sold : s.deals.total));
    rows.push(funnelHtml(s.knock));
  }

  // Sales — both weeks.
  // Sits directly above the numbers it's talking about, so it's read in context
  // rather than skipped at the top of the mail.
  if (has('checkback')) rows.push(`<div style="font-size:13.5px;color:${C.ink};margin-top:20px;line-height:1.55;background:${C.blueBg || 'rgba(23,143,63,0.08)'};border:1px solid ${C.blue};border-radius:10px;padding:11px 13px;">This is a snapshot from when it sent. Your installs, cancels and install rate keep updating all week as jobs get done, so <b>check your dashboard through the week</b> to see where they land. It has a <b>Last week, 2 weeks ago and YTD</b> switch.</div>`);
  if (has('sales')) rows.push(salesBlock(`last week (${md(ctx.weekSun)} to ${md(ctx.weekSat)})`, s.deals));
  if (has('prior')) rows.push(salesBlock(`two weeks ago (${md(ctx.priorSun)} to ${md(ctx.priorSat)})`, s.deals.prior));

  // Install performance.
  if (has('install')) rows.push(`<div style="margin-top:22px;font-size:13px;font-weight:700;color:${C.sub};text-transform:uppercase;letter-spacing:0.6px;">Install performance &#183; last ${TRAILING_WEEKS} weeks</div>
    <table role="presentation" cellpadding="0" cellspacing="6" width="100%" style="margin-top:8px;border-collapse:separate;"><tr>
      ${statTile('Install rate', pct(s.install.rate), s.install.rate != null && s.install.rate >= 0.7 ? C.green : (s.install.rate != null && s.install.rate < 0.5 ? C.red : null))}
      ${statTile('Days to install', s.install.avgDays == null ? 'n/a' : s.install.avgDays)}
      ${statTile('Installed', s.install.installed)}
      ${statTile('Sold', s.install.sold)}
    </tr></table>
    <div style="font-size:12px;color:${C.sub};margin-top:8px;line-height:1.5;">Install rate is installs out of installs plus cancels. Days to install is your average from sale to install on serviced deals.</div>`);

  // Goal, personal records and clubs. This is the only part of the email that
  // tells a rep whether their number was good, so it goes above the raw stats.
  if (has('goalrec')) {
    // ---- Week in progress: the goal the rep set, and the funnel they need
    // to hit it, at their own last-N-weeks rates. Rep, manager and corporate
    // all read this same card. ----
    {
      const gcur = ctx.goalCurByRep ? ctx.goalCurByRep.get(rep.key) : null;
      const soldCur = s.deals.curWeek || 0;
      const roll = s.knock.roll || {};
      let inner = '';
      if (gcur) {
        const toGo = Math.max(0, gcur - soldCur);
        const hit = toGo === 0;
        const pctG = Math.max(0, Math.min(100, Math.round((soldCur / gcur) * 100)));
        let math = '';
        if (!hit && roll.sold > 0 && roll.contacts > 0 && roll.doors > 0) {
          const close = roll.sold / roll.contacts;
          const cRate = roll.contacts / roll.doors;
          const dpd = roll.days ? roll.doors / roll.days : 0;
          const needC = Math.ceil(toGo / close);
          const needD = Math.ceil(needC / cRate);
          const needDays = dpd ? Math.round((needD / dpd) * 10) / 10 : null;
          math = `<div style="font-size:12.5px;color:${C.ink};margin-top:8px;line-height:1.55;">At your last-${s.knock.rollWeeks}-week rates that is about <b>${needC} more contacts</b> &#183; <b>${needD.toLocaleString()} doors</b>${needDays ? ` &#183; <b>${needDays} days out</b>` : ''}.</div>`;
        }
        inner = `<div style="font-size:22px;font-weight:800;color:${C.ink};margin-top:2px;">${soldCur} <span style="font-size:14px;font-weight:700;color:${C.sub};">of ${gcur} so far</span></div>
          <div style="height:8px;background:${C.sep};border-radius:4px;overflow:hidden;margin:9px 0 5px;"><div style="height:8px;width:${pctG}%;background:${hit ? C.green : C.blue};border-radius:4px;"></div></div>
          <div style="font-size:12.5px;font-weight:700;color:${hit ? C.green : C.ink};">${hit ? 'Goal hit &#8212; keep stacking.' : `${toGo} to go.`}</div>${math}`;
      } else {
        inner = `<div style="font-size:13px;color:${C.sub};margin-top:4px;">No goal set for this week yet &#8212; set one on your dashboard and this card shows the doors and contacts it takes.</div>`;
      }
      rows.push(`<div style="margin-top:22px;font-size:13px;font-weight:700;color:${C.sub};text-transform:uppercase;letter-spacing:0.6px;">This week&#8217;s goal</div>
        <div style="padding:13px 15px;background:${C.card};border-radius:10px;margin-top:8px;">
        <div style="font-size:11px;font-weight:700;color:${C.sub};text-transform:uppercase;letter-spacing:0.5px;">Week of ${md(ctx.curSun || '')}</div>${inner}</div>`);
    }
    const goal = ctx.goalByRep ? ctx.goalByRep.get(rep.key) : null;
    const rec = (ctx.recByRep && ctx.recByRep.get(rep.key)) || null;
    const soldWk = s.deals.sold != null ? s.deals.sold : s.deals.total;
    const parts = [];

    if (goal) {
      const hit = soldWk >= goal;
      const pct = Math.max(0, Math.min(100, Math.round((soldWk / goal) * 100)));
      parts.push(`<div style="padding:13px 15px;background:${C.card};border-radius:10px;">
        <div style="font-size:11px;font-weight:700;color:${C.sub};text-transform:uppercase;letter-spacing:0.5px;">Your goal</div>
        <div style="font-size:22px;font-weight:800;color:${C.ink};margin-top:2px;">${soldWk} <span style="font-size:14px;font-weight:700;color:${C.sub};">of ${goal}</span></div>
        <div style="height:8px;background:${C.sep};border-radius:4px;overflow:hidden;margin:9px 0 5px;"><div style="height:8px;width:${pct}%;background:${hit ? C.green : C.blue};border-radius:4px;"></div></div>
        <div style="font-size:12.5px;font-weight:700;color:${hit ? C.green : C.ink};">${hit ? 'Goal met.' : `${goal - soldWk} short of ${goal}.`}</div></div>`);
    }

    if (rec && (rec.d || rec.w)) {
      const gap = rec.w - (rec.lastWeek || 0);
      const near = rec.w && gap > 0 && gap <= 3;
      parts.push(`<div style="padding:13px 15px;background:${C.card};border-radius:10px;">
        <div style="font-size:11px;font-weight:700;color:${C.sub};text-transform:uppercase;letter-spacing:0.5px;">Your records</div>
        <div style="font-size:15px;font-weight:800;color:${C.ink};margin-top:3px;">${rec.d || '&#8212;'} <span style="font-size:12px;font-weight:600;color:${C.sub};">best day</span> &#183; ${rec.w || '&#8212;'} <span style="font-size:12px;font-weight:600;color:${C.sub};">best week</span></div>
        ${_pr ? '' : (near ? `<div style="font-size:12.5px;color:${C.ink};margin-top:4px;">${gap} off your best week.</div>` : '')}</div>`);
    }

    if (parts.length) {
      rows.push(`<div style="margin-top:22px;font-size:13px;font-weight:700;color:${C.sub};text-transform:uppercase;letter-spacing:0.6px;">Goal and records</div>
        <table role="presentation" cellpadding="0" cellspacing="6" width="100%" style="margin-top:8px;border-collapse:separate;"><tr>
          ${parts.map((p) => `<td width="${Math.floor(100 / parts.length)}%" valign="top">${p}</td>`).join('')}
        </tr></table>`);
    }

    // Club deliberately left out of the email — the full ladder lives on the
    // dashboard, and one badge line here was noise on top of the records card.
  }

  // Bria vs install report scoreboard: the two counts side by side, last week
  // and all usable history, plus the corporate flag when one is set.
  // Subcontractors don't log in Bria, so this would read as a total gap every
  // week. Skip it for them entirely.
  // Bria vs the install report is a dashboard job now: it needs the deal list to
  // be useful, and that can't be tapped in an email. Only a flag survives here.
  if (has('briacheck') && !rep.isSub) {
    const flag = ctx.reconFlags ? ctx.reconFlags.get(rep.key) : null;
    const flagHtml = flag ? `<div style="margin-top:10px;padding:11px 13px;background:rgba(255,149,0,0.10);border:1px solid #ff9500;border-radius:10px;line-height:1.5;">
      <div style="font-size:11px;font-weight:800;color:${C.sub};text-transform:uppercase;letter-spacing:0.5px;">Flagged &#183; week of ${md(flag.week)}</div>
      <div style="font-size:12.5px;color:${C.ink};margin-top:2px;">${flag.bria_n != null ? `${flag.bria_n} in Bria &#183; ${flag.report_n != null ? flag.report_n : '?'} on the report. ` : ''}Corporate flagged this week. Get these submitted.${flag.note ? ` <i>${esc(flag.note)}</i>` : ''}</div></div>` : '';
    if (flagHtml) rows.push(flagHtml);
  }

  // Dashboard nudge — the two things worth acting on this week: past-due pending
  // installs to chase, and fresh cancels to call. Plus the Bria vs report check.
  const pastDue = s.pastDuePending || 0;
  const canc7 = s.cancels7 || 0;
  const actionLine = (txt) => `<div style="font-size:13px;color:${C.sub};margin-top:7px;line-height:1.5;">${txt}</div>`;
  const nudgeLines = [];
  if (pastDue > 0) nudgeLines.push(actionLine(`<b style="color:${C.ink};">${pastDue} pending deal${pastDue === 1 ? '' : 's'} past ${pastDue === 1 ? 'its' : 'their'} install date.</b> Open your dashboard and get ${pastDue === 1 ? 'it' : 'them'} moving.`));
  if (canc7 > 0) nudgeLines.push(actionLine(`<b style="color:${C.ink};">${canc7} customer${canc7 === 1 ? '' : 's'} cancelled in the last 7 days.</b> Give them a call and win them back.`));
  if (!rep.isSub) nudgeLines.push(actionLine(`<b style="color:${C.ink};">Check your Bria numbers against the install report there.</b> It shows the exact deals that don't line up, week by week and all time. Tap a customer's name to copy it, search that name in <b>Photos</b>, and send the order screenshot in.`));
  if (has('actions')) rows.push(`<div style="margin-top:22px;padding:15px 16px;background:rgba(0,122,255,0.08);border:1px solid ${C.blue};border-radius:12px;">
    <div style="font-size:15px;font-weight:800;color:${C.blue};">Check out your dashboard</div>
    ${nudgeLines.join('')}
    ${embed ? '' : `<div style="margin-top:11px;">${button('Open your dashboard', repUrl, C.blue)}</div>`}</div>`);

  // Secondary links.
  if (has('links') && !rep.isSub) rows.push(`<div style="margin-top:16px;">
    ${button('Sequifi', SEQUIFI_URL, '#3a3a3f')}</div>`);
  // If the nudge is off, the rep still needs a way in.
  if (!has('actions') && !embed) rows.push(`<div style="margin-top:18px;">${button('Open your dashboard', repUrl, C.blue)}</div>`);

  rows.push(`<div style="font-size:11px;color:${C.faint};margin-top:22px;border-top:0.5px solid ${C.sep};padding-top:12px;">Grow Sales &#183; your last two weeks of knocking and sales</div>`);

  return `<div style="margin:0;padding:24px 12px;background:${C.page};font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:${C.bg};color:${C.ink};border-radius:16px;border:1px solid ${C.sep};overflow:hidden;-webkit-text-size-adjust:100%;">
      <div style="background:#0b0c0b;padding:14px 24px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="vertical-align:middle;"><img src="${DASH_URL}/icon.png" alt="GROW" height="34" style="height:34px;border-radius:8px;vertical-align:middle;"><span style="color:#ffffff;font-weight:800;font-size:14px;letter-spacing:0.08em;margin-left:10px;vertical-align:middle;">GROW</span></td>
          <td style="text-align:right;vertical-align:middle;color:#8b8f88;font-size:12px;">${twoWeekRange}</td>
        </tr></table>
      </div>
      <div style="padding:24px;">${rows.join('')}</div>
    </div></div>`;
}

// ============================== send (Gmail SMTP) ==============================
// Pooled transport so a full run reuses a few connections instead of opening one
// per email (Gmail throttles rapid new connections). Lazy: only built on first send.
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

async function sendEmail({ to, cc, subject, html }) {
  const info = await transport().sendMail({ from: emailFrom(), to, cc: cc || undefined, subject, html });
  return { id: info.messageId };
}

async function pooled(items, size, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx).catch((e) => ({ error: String(e.message || e) }));
    }
  });
  await Promise.all(workers);
  return out;
}

// ============================== control panel ==============================
const PANEL_CSS = `body{margin:0;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;background:#f4f4f7;color:#1c1c1e;padding:28px 16px;}
.wrap{max-width:560px;margin:0 auto;background:#fff;border:1px solid #e4e4ea;border-radius:16px;padding:24px 22px;box-shadow:0 8px 30px rgba(0,0,0,.06);}
h1{font-size:20px;margin:0 0 2px;letter-spacing:-0.3px;}
.sub{color:#6b6b70;font-size:13px;margin:0 0 18px;}
.big{font-size:40px;font-weight:800;letter-spacing:-1px;line-height:1;}
.big span{font-size:15px;font-weight:600;color:#6b6b70;}
.meta{color:#6b6b70;font-size:13px;margin-top:4px;}
table{width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;}
td,th{text-align:left;padding:6px 4px;border-bottom:1px solid #eee;}
th{color:#8a8a8f;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.4px;}
.btns{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px;align-items:center;}
a.preview{display:inline-block;padding:11px 16px;border:1px solid #cfcfd6;border-radius:10px;color:#1c1c1e;text-decoration:none;font-weight:600;font-size:14px;}
button{padding:12px 20px;border:0;border-radius:10px;background:#ff3b30;color:#fff;font-weight:800;font-size:15px;cursor:pointer;}
.note{font-size:12px;color:#8a8a8f;margin-top:14px;line-height:1.5;}
.ok{color:#1a9c4a;font-weight:800;}`;

function panelHtml({ weekLabel, keyParam, eligible, withCc, sample }) {
  const kp = encodeURIComponent(keyParam);
  const rows = sample.map((s) => `<tr><td>${esc(s.rep)}</td><td>${esc(s.email)}</td><td>${s.cc ? 'yes' : 'no'}</td></tr>`).join('');
  const canSend = keyParam && eligible > 0;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Weekly rep email</title><style>${PANEL_CSS}</style>
  <div class="wrap">
    <h1>Weekly rep email</h1>
    <p class="sub">${esc(weekLabel)}</p>
    <div class="big">${eligible} <span>reps will receive this</span></div>
    <div class="meta">${withCc} have a manager CC'd. Nothing sends until you click the button.</div>
    <table><tr><th>Rep</th><th>Email</th><th>Mgr CC</th></tr>${rows}</table>
    ${eligible > sample.length ? `<div class="note">Showing ${sample.length} of ${eligible}.</div>` : ''}
    <div class="btns">
      <a class="preview" href="?key=${kp}&render=1" target="_blank" rel="noopener">Preview a sample email</a>
      ${canSend
        ? `<form method="post" action="?key=${kp}&send=1" onsubmit="return confirm('Send the weekly email to all ${eligible} reps now? This cannot be undone.');"><button type="submit">Send to all ${eligible} reps now</button></form>`
        : `<span class="note">Open this page with your key in the URL to enable sending.</span>`}
    </div>
    <div class="note">Tip: bookmark this URL (it includes your key). Test one to yourself first with <code>?key=…&test=you@email.com</code>.</div>

    <h1 style="margin-top:26px;font-size:19px;">Corporate recap</h1>
    <div class="note">Same layout, company wide numbers. The button opens the whole dashboard instead of one rep's card. Paste any addresses. They don't need to be reps.</div>
    <div class="btns">
      <a class="preview" href="?key=${kp}&corp=1" target="_blank" rel="noopener">Preview the corporate email</a>
    </div>
    <form method="post" action="?key=${kp}&corp=1&send=1" onsubmit="return confirm('Send the corporate recap to these addresses now?');">
      <textarea name="to" rows="3" placeholder="josh@grow.com, bria@grow.com" style="width:100%;padding:10px;border:1px solid #e4e4ea;border-radius:9px;font-family:inherit;font-size:14px;"></textarea>
      <div class="btns"><button type="submit">Send corporate recap</button></div>
    </form>
  </div>`;
}

function resultHtml({ sent, failed, total, keyParam }) {
  const kp = encodeURIComponent(keyParam);
  const failRows = (failed || []).slice(0, 40).map((f) => `<tr><td>${esc(f.rep || '')}</td><td>${esc(f.error || '')}</td></tr>`).join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sent</title><style>${PANEL_CSS}</style>
  <div class="wrap">
    <h1><span class="ok">Sent</span></h1>
    <p class="sub">Weekly rep email</p>
    <div class="big">${sent} <span>of ${total} sent</span></div>
    ${failed && failed.length ? `<div class="meta">${failed.length} failed:</div><table><tr><th>Rep</th><th>Error</th></tr>${failRows}</table>` : '<div class="meta">No failures.</div>'}
    <div class="btns"><a class="preview" href="?key=${kp}">Back to panel</a></div>
  </div>`;
}

// Exported for unit/preview harnesses; the handler is the default export.
export { renderEmail, renderCompanyEmail, buildCompanyStats, buildPraGoals, praGoalHtml, buildRepStats, lastCompletedWeekSunday, addDays, iso, panelHtml, resultHtml };

// ============================== sections ==============================
// What each recap can include. The control panel sends `sections=a,b,c`; anything
// absent from that list is left out. No param at all means "everything", so old
// links and any caller that doesn't know about this keep working unchanged.
export const REP_SECTIONS = [
  { k: 'note',      label: 'Your weekly note',           hint: 'the message written in the panel' },
  { k: 'checkback', label: 'Check back through the week', hint: 'the note saying numbers keep moving' },
  { k: 'upfront',   label: 'Upfront pay status',          hint: 'opted-in reps only' },
  { k: 'knocking',  label: 'Knocking grid + funnel',      hint: 'set per team' },
  { k: 'sales',     label: 'Last week sales',             hint: 'sold, installed, pending, cancelled' },
  { k: 'prior',     label: 'Two weeks ago sales',         hint: 'the comparison week' },
  { k: 'install',   label: 'Install performance',         hint: 'install rate + days to install' },
  { k: 'goalrec',   label: 'Goal + records + clubs',      hint: 'their weekly goal, personal bests, club badges' },
  { k: 'briacheck', label: 'Reconciliation flag',         hint: 'only shows when you flag their week' },
  { k: 'actions',   label: 'Dashboard nudge',             hint: 'past due, recent cancels, button' },
  { k: 'links',     label: 'Sequifi + Bria buttons',      hint: '' },
];
export const CORP_SECTIONS = [
  { k: 'tiles',     label: 'Headline tiles',    hint: 'sold, installed, cancels, install rate' },
  { k: 'company',   label: 'Company table',     hint: 'this week vs last' },
  { k: 'managers',  label: 'By manager',        hint: 'per-manager rows + projections' },
  { k: 'pragoals',  label: 'PRA goals',         hint: 'the mark set on each manager call' },
  { k: 'checkback', label: 'Check back note',   hint: '' },
];
// Returns a predicate. Absent/blank param => everything on.
function sectionGate(raw) {
  if (raw == null || raw === '') return () => true;
  if (raw === '__none__') return () => false;   // explicitly everything off
  const on = new Set(String(raw).split(',').map((s) => s.trim()).filter(Boolean));
  return (k) => on.has(k);
}

// ============================== handler ==============================
export default async function handler(req, res) {
  // Merch blast: a separate tool that shares this route only because of the
  // 12-function cap. It does its own auth, so hand off before anything here runs.
  if ((req.query || {}).tool === 'merch') return merchSendHandler(req, res);

  // ?snapshot=<rep> is the ONE canonical rep view: the dashboard embeds it so
  // the rep, their manager and corporate all look at the identical page this
  // email sends. Read-only (GET only) and unauthenticated on purpose — the
  // dashboard itself is anon-key public, and this path can never send email.
  const wantSnapshot = req.method === 'GET' && (req.query || {}).snapshot != null;
  if (!wantSnapshot && !authorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const q = req.query || {};
  const testTo = q.test || null;                 // ?test=addr → send one sample to addr
  const wantJson = q.json === '1' || q.dry === '1'; // machine-readable summary
  const keyParam = q.key ? String(q.key) : '';
  // Bulk send is manual only: a POST from the control panel's Send button. There is
  // no cron and no auto-send — a plain GET never emails anyone.
  const doSend = req.method === 'POST' && q.send === '1';
  // Section picker from the control panel. Bulk sends POST a body, so accept it
  // there too; no param anywhere means every section stays in.
  const sectionsRaw = q.sections != null ? q.sections
    : (req.body && req.body.sections != null ? (Array.isArray(req.body.sections) ? req.body.sections.join(',') : req.body.sections) : null);
  const has = sectionGate(sectionsRaw);
  // Per-rep overrides: a bulk send carries one list per rep, because two
  // managers can legitimately want different sections (knocking is the usual
  // reason). Falls back to the batch-wide gate for anyone not in the map.
  const sectionsByRep = (req.body && req.body.sectionsByRep && typeof req.body.sectionsByRep === 'object') ? req.body.sectionsByRep : null;
  const gateCache = new Map();
  const hasFor = (rep) => {
    if (!sectionsByRep) return has;
    const full = `${rep.first} ${rep.last}`.trim();
    const raw = sectionsByRep[full] != null ? sectionsByRep[full] : sectionsByRep[norm(full)];
    if (raw == null) return has;
    if (!gateCache.has(raw)) gateCache.set(raw, sectionGate(raw));
    return gateCache.get(raw);
  };

  try {
    const now = new Date();
    const sun = iso(lastCompletedWeekSunday(now));       // completed week (Sun..Sat)
    const sat = addDays(sun, 6);
    const priorSun = addDays(sun, -7);                   // the week before, for trending
    const priorSat = addDays(priorSun, 6);
    // The funnel scopes to the recap week so it agrees with every other number
    // in the email. Doors-per-sale needs a handful of sales before it settles,
    // so funnelHtml marks it with a ~ under 8 sales rather than widening the
    // window. Wider windows are switchable on the embedded snapshot (?weeks=N);
    // sent emails always use the default. Each window has its own warm cache.
    const funnelWeeks = (() => { const n = parseInt(q.weeks, 10); return [1, 2, 4, 8, 12].includes(n) ? n : FUNNEL_WEEKS; })();
    const rollSun = addDays(sun, -7 * (funnelWeeks - 1));
    const windowStart = addDays(sun, -7 * (TRAILING_WEEKS - 1));
    const briaStart = priorSun; // Bria only needed for the recap week's gap count now.
    const weekLabel = `Week of ${md(sun)} to ${md(sat)}`;

    // Cached across warm invocations (~5 min) so previews / repeat loads don't re-run
    // the expensive Supabase pagination. Keyed by the fetch window.
    const data = await loadAllCached(rollSun, sat, windowStart, briaStart);

    // Resolve deal/bria rep names to onboarding keys so nickname-vs-legal-name reps
    // (Chris->Christopher, Alli->Allison) attach to the right onboarding record.
    const resolveRep = makeRepResolver(data.onboarding);
    const knockByRep = groupByRep(mergeKnockingSources(data.knocking), (r) => resolveRep(r.rep));
    const dealsByRep = groupByRep(data.deals, (r) => resolveRep(r.rep));
    const briaByRep = groupByRep(data.bria, (r) => resolveRep(r.rep));

    const upfrontOptin = new Set((await loadUpfrontOptin()).map((n) => norm(n)));

    // Candidate reps: anyone in onboarding with an email. We do NOT skip is_manager —
    // plenty of managers also sell, and eligibility (recent sales) gates who actually
    // gets an email, so a non-selling manager is filtered out anyway.
    const reps = [];
    for (const o of data.onboarding) {
      if (!o.email) continue;
      const c = canonicalFirstLast(o.first_name, o.last_name);
      const key = norm(`${c.first} ${c.last}`);
      reps.push({ key, first: c.first, last: c.last, email: o.email, managerName: o.manager_name });
    }

    // Flagged subcontractors. A manual address wins over onboarding, and a sub
    // with no onboarding row at all gets added so they receive the same report
    // every other rep does. Their stats resolve on the normalized name, which is
    // the same key groupByRep used for their deals.
    const flagRows = await loadRepFlags();
    const byKey = new Map(reps.map((r) => [r.key, r]));
    for (const f of flagRows) {
      if (!f || !f.rep || !f.email) continue;
      const key = resolveRep(f.rep);
      const existing = byKey.get(key);
      if (existing) { existing.email = f.email; existing.isSub = !!f.is_sub; continue; }
      const parts = String(f.rep).trim().split(/\s+/);
      const rec = { key, first: parts[0] || f.rep, last: parts.slice(1).join(' '), email: f.email, managerName: null, isSub: !!f.is_sub };
      reps.push(rec);
      byKey.set(key, rec);
    }

    // ---- Bria-vs-report scoreboard + corporate flags -----------------------
    // Same exclusion rule as the dashboard: rows with no usable customer name
    // (blank, "Past Sale", or a bare first name with no phone) can never be
    // matched, so they don't count against the rep.
    const phDigits = (v) => { let s = String(v == null ? '' : v).replace(/\D/g, ''); if (s.length === 11 && s[0] === '1') s = s.slice(1); return s.length === 10 ? s : ''; };
    const briaUnusable = (customer, phone) => {
      const n = String(customer || '').trim();
      if (!n) return true;
      if (/^(past sale|past sales|test|n\/a|none|xx+)$/i.test(n)) return true;
      if (n.split(/\s+/).filter(Boolean).length === 1 && !phDigits(phone)) return true;
      return false;
    };
    const briaCheckByRep = new Map();   // key -> array of sale_dates (usable rows only)
    for (const b of (data.briaAll || [])) {
      if (briaUnusable(b.customer, b.phone)) continue;
      const k = resolveRep(b.rep); if (!k) continue;
      if (!briaCheckByRep.has(k)) briaCheckByRep.set(k, []);
      briaCheckByRep.get(k).push(b.sale_date);
    }
    const reportCheckByRep = new Map(); // key -> array of sale_dates
    for (const d of (data.dealsCnt || [])) {
      const k = resolveRep(d.rep); if (!k) continue;
      if (!reportCheckByRep.has(k)) reportCheckByRep.set(k, []);
      reportCheckByRep.get(k).push(d.sale_date);
    }
    // Corporate flags for the recap week and the two before it.
    const reconFlags = new Map();
    try {
      const { data: fl } = await sb().from('bria_recon_flags').select('rep,week,status,bria_n,report_n,note').gte('week', addDays(sun, -14));
      for (const f of (fl || [])) { const k = resolveRep(f.rep); if (k && !reconFlags.has(k)) reconFlags.set(k, f); }
    } catch (e) { /* table may not exist yet */ }

    // ---- Goals + personal records -----------------------------------------
    // Goal: a week-dated goal for the recap week wins, otherwise the rep's
    // standing goal (no week) applies.
    const goalByRep = new Map();
    for (const g of (data.goals || [])) {
      if (!g || !g.scope || g.metric !== 'sales_weekly') continue;
      const t = parseFloat(g.target); if (isNaN(t) || t <= 0) continue;
      const k = resolveRep(g.scope); if (!k) continue;
      if (g.week) { if (g.week === sun) goalByRep.set(k, t); }
      else if (!goalByRep.has(k)) goalByRep.set(k, t);
    }
    // Same again for the week IN PROGRESS: reps set this in their dashboard,
    // and the snapshot turns it into the funnel they need to hit, so the rep,
    // their manager and corporate are all looking at the same target.
    const curSun = addDays(sun, 7);
    const goalCurByRep = new Map();
    for (const g of (data.goals || [])) {
      if (!g || !g.scope || g.metric !== 'sales_weekly') continue;
      const t = parseFloat(g.target); if (isNaN(t) || t <= 0) continue;
      const k = resolveRep(g.scope); if (!k) continue;
      if (g.week) { if (g.week === curSun) goalCurByRep.set(k, t); }
      else if (!goalCurByRep.has(k)) goalCurByRep.set(k, t);
    }
    // Records: best single day and best week ever, from the Bria daily feed.
    const recByRep = new Map();
    {
      const sunOf = (isoD) => { const d = new Date(isoD + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); return d.toISOString().slice(0, 10); };
      // rep -> { days:{date:n}, weeks:{sun:n} }
      const agg = new Map();
      for (const x of (data.briaDaily || [])) {
        if (!x || !x.rep || !x.sale_date) continue;
        const c = x.deals || 0; if (!c) continue;
        const k = resolveRep(x.rep); if (!k) continue;
        if (!agg.has(k)) agg.set(k, { days: {}, weeks: {} });
        const a = agg.get(k);
        a.days[x.sale_date] = (a.days[x.sale_date] || 0) + c;
        const w = sunOf(x.sale_date);
        a.weeks[w] = (a.weeks[w] || 0) + c;
      }
      for (const [k, a] of agg) {
        // Split history at the recap week so we can tell a record that was SET
        // last week from one they already held. A first-ever week isn't a
        // record, it's just their only week, so require prior history.
        let bestDay = 0, bestDayDate = '', priorBestDay = 0;
        let wkBestDay = 0, wkBestDayDate = '';
        for (const d of Object.keys(a.days)) {
          const v = a.days[d];
          if (v > bestDay) { bestDay = v; bestDayDate = d; }
          if (d >= sun && d <= sat) { if (v > wkBestDay) { wkBestDay = v; wkBestDayDate = d; } }
          else if (v > priorBestDay) priorBestDay = v;
        }
        let bestWeek = 0, bestWeekSun = '', priorBestWeek = 0;
        for (const w of Object.keys(a.weeks)) {
          const v = a.weeks[w];
          if (v > bestWeek) { bestWeek = v; bestWeekSun = w; }
          if (w !== sun && v > priorBestWeek) priorBestWeek = v;
        }
        const lastWeek = a.weeks[sun] || 0;
        recByRep.set(k, {
          d: bestDay, dDate: bestDayDate, w: bestWeek, wSun: bestWeekSun, lastWeek,
          // set during the recap week
          prDay: !!(wkBestDay && priorBestDay && wkBestDay > priorBestDay),
          tieDay: !!(wkBestDay && priorBestDay && wkBestDay === priorBestDay),
          wkBestDay, wkBestDayDate, priorBestDay,
          prWeek: !!(lastWeek && priorBestWeek && lastWeek > priorBestWeek),
          tieWeek: !!(lastWeek && priorBestWeek && lastWeek === priorBestWeek),
          priorBestWeek,
        });
      }
    }

    // ---- Has each installer actually reported the recap week? -------------
    // Reports land at different times. If an installer hasn't sent theirs, their
    // reps look like they sold nothing, and mailing that is worse than waiting.
    // Compare the recap week against the week before, per installer.
    const ispNow = new Map(), ispPrior = new Map(), repIsp = new Map(), repIspDate = new Map();
    for (const d of (data.deals || [])) {
      const isp = d.isp || '';
      if (isp) {
        if (d.week === sun) ispNow.set(isp, (ispNow.get(isp) || 0) + 1);
        else if (d.week === priorSun) ispPrior.set(isp, (ispPrior.get(isp) || 0) + 1);
      }
      const k = resolveRep(d.rep);
      if (k && isp && d.sale_date && d.sale_date >= (repIspDate.get(k) || '')) { repIspDate.set(k, d.sale_date); repIsp.set(k, isp); }
    }
    // "Pending" = sold real volume last week and now has none, or under a fifth
    // of it. A quiet installer looks the same as a late one, so require the
    // prior week to have been meaningful before crying wolf.
    const ispPending = new Map();
    for (const [isp, prior] of ispPrior) {
      const now = ispNow.get(isp) || 0;
      if (prior >= 5 && now < prior * 0.2) ispPending.set(isp, { now, prior });
    }

    // The week's note, only if it was written for THIS recap week — a stale one
    // going out again would read as a message that was never updated.
    let weekNote = '';
    try {
      const row = (data.reportConfig || []).find((r) => r && r.manager === '__weekly_note__');
      const cfg = row && row.config;
      if (cfg && cfg.text && (!cfg.week || cfg.week === sun)) weekNote = String(cfg.text).trim();
    } catch (e) { /* note is optional */ }

    const ctx = { weekSun: sun, weekSat: sat, priorSun, priorSat, rollSun, funnelWeeks: funnelWeeks, windowStart, weekLabel, today: iso(now), knockByRep, dealsByRep, briaByRep, upfrontOptin, briaCheckByRep, reportCheckByRep, reconFlags, goalByRep, goalCurByRep, curSun, recByRep, weekNote, resolveRep };

    // Compute + filter to reps with real sales, then sort by most recent sales.
    const eligible = [];
    for (const rep of reps) {
      const stats = buildRepStats(rep, ctx);
      if (!isActive(stats)) continue;
      eligible.push({ rep, stats });
    }
    eligible.sort((a, b) => recentSales(b.stats) - recentSales(a.stats) || (b.stats.install.sold - a.stats.install.sold));

    // Sellers with recent deals who did NOT attach to an onboarding rep (no email on
    // file) — flagged in the panel so you can type an address and send them manually.
    const obKeys = new Set(reps.map((r) => r.key));
    const soldRecent = new Map();
    for (const d of data.deals) {
      if (d.week !== sun && d.week !== priorSun) continue;
      if (obKeys.has(resolveRep(d.rep))) continue;
      const k = norm(d.rep);
      if (!k) continue;
      const cur = soldRecent.get(k) || { rep: d.rep, deals: 0 };
      cur.deals++;
      soldRecent.set(k, cur);
    }
    const unmatched = [...soldRecent.values()].sort((a, b) => b.deals - a.deals);

    const subject = `Last week's numbers: ${md(sun)} to ${md(sat)}`;
    // A record is the one thing worth changing the inbox line for.
    const subjectFor = (rep) => {
      if (!has('goalrec')) return subject;
      const pr = prNote(rep, ctx);
      if (!pr) return subject;
      return pr.hype ? `\u{1F3C6} ${rep.first}, ${pr.short}!` : `${rep.first}, ${pr.short} (${md(sun)} to ${md(sat)})`;
    };

    // ---- render mode: return one rep's HTML in the browser, no send. Works for any
    // rep name (builds on the fly if they're not in the onboarding-matched list). ----
    // ---- CORPORATE recap: ?corp=1 to preview, POST ?corp=1&send=1 with a
    // comma/newline separated ?to= list to send. Same layout as the rep email,
    // company numbers, and its button opens the whole dashboard. ----
    if (q.corp === '1') {
      // Manual attribution fixes from the dashboard win over the sheet's roster
      // match — that's the whole point of the triage screen.
      const ovMap = new Map((data.attrOverrides || []).map((o) => [`${norm(o.rep)}|${o.week}`, o.manager]));
      const dealsFixed = ovMap.size
        ? (data.deals || []).map((d) => {
            const hit = ovMap.get(`${norm(d.rep)}|${d.week}`);
            return hit ? { ...d, manager: hit } : d;
          })
        : (data.deals || []);
      const cs = buildCompanyStats(dealsFixed, ctx);
      // The PRA marks set on the manager calls, judged on the recap week.
      try { cs.praGoals = buildPraGoals(data, ctx); }
      catch (e) { cs.praGoals = []; console.error('pra goals', e); }
      const html = renderCompanyEmail(cs, ctx, { has });
      const subject = `Grow last week: ${cs.wk.total} sold (${md(sun)} to ${md(sat)})`;
      if (doSend) {
        const list = String(q.to || (req.body && req.body.to) || '')
          .split(/[,;\s]+/).map((s) => s.trim()).filter((s) => s.includes('@'));
        if (!list.length) return res.status(400).json({ error: 'No recipient addresses. Pass ?to=a@x.com,b@y.com' });
        const sent = [], failed = [];
        for (const to of list) {
          try { await sendEmail({ to, subject, html }); sent.push(to); }
          catch (e) { failed.push({ rep: to, error: String(e.message || e).slice(0, 200) }); }
        }
        if (wantJson) return res.status(200).json({ ok: true, mode: 'corp', sent, failed, total: list.length });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(resultHtml({ sent, failed, total: list.length, keyParam }));
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(html);
    }

    // ---- canonical embedded snapshot (unauthenticated GET, render-only) ----
    if (wantSnapshot) {
      let pick = eligible.find((e) => norm(`${e.rep.first} ${e.rep.last}`) === norm(q.snapshot));
      if (!pick) { try { pick = repFromName(String(q.snapshot), ctx, ''); } catch (e) { pick = null; } }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      // Short cache: warm-instance data is ~5 min anyway, and the embed gets hit
      // once per rep tap while browsing a team.
      // s-maxage caches the rendered page on Vercel's CDN, so after the first
      // load a rep's snapshot comes back instantly for everyone for 10 minutes.
      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600, stale-while-revalidate=86400');
      if (!pick) return res.status(200).send('<div style="font-family:-apple-system,Helvetica,sans-serif;padding:34px;color:#666;font-size:14px;">No email snapshot for this rep yet (needs a sale in the last few weeks).</div>');
      const page = renderEmail(pick.rep, pick.stats, ctx, { knocking: true, has, embed: true });
      // No funnel-window switcher here. This page's job is to be exactly what
      // the rep receives; chrome that only exists in the preview makes the
      // embed stop being a faithful copy of the email. ?weeks= still works for
      // anyone who wants a different window by URL, and the dashboard has its
      // own funnel-window control on the Team card.
      return res.status(200).send(page);
    }

    if (q.render === '1') {
      let pick = q.rep ? eligible.find((e) => norm(`${e.rep.first} ${e.rep.last}`) === norm(q.rep)) : eligible[0];
      if (!pick && q.rep) pick = repFromName(q.rep, ctx, '');
      if (!pick) return res.status(200).json({ ok: true, message: 'No matching active rep', eligibleCount: eligible.length });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(renderEmail(pick.rep, pick.stats, ctx, { knocking: q.knocking === '1', has }));
    }

    // ---- test mode: render + send exactly one to the test address ----
    if (testTo) {
      const sample = eligible[0];
      if (!sample) return res.status(200).json({ ok: true, message: 'No active reps to sample', week: { sun, sat } });
      const html = renderEmail(sample.rep, sample.stats, ctx, { knocking: q.knocking === '1', has });
      const result = await sendEmail({ to: testTo, subject: `[TEST] ${subject}`, html });
      return res.status(200).json({ ok: true, mode: 'test', sentTo: testTo, sampleRep: `${sample.rep.first} ${sample.rep.last}`, result });
    }

    // ---- SEND (POST with ?send=1). Optionally scope to a subset: ?rep=Name for a
    // single rep, or a POST body { reps:[names] } to send an explicit list (the panel
    // uses this to send everyone except excluded subcontractors). Checked before the
    // JSON summary so a POST that also carries ?json=1 sends (and returns JSON). ----
    if (doSend) {
      // Manual send: a rep name + a typed email (for sellers not in onboarding).
      if (q.rep && q.to) {
        let sent = 0, failed = [];
        try {
          const one = repFromName(q.rep, ctx, String(q.to));
          const r = await sendEmail({ to: one.rep.email, subject: subjectFor(one.rep), html: renderEmail(one.rep, one.stats, ctx, { knocking: q.knocking === '1', has }) });
          if (r && r.id) sent = 1;
        } catch (e) { failed = [{ rep: String(q.rep), error: String(e.message || e) }]; }
        if (wantJson) return res.status(200).json({ ok: true, mode: 'send', sent, sentReps: sent ? [String(q.rep)] : [], failed, total: 1 });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(resultHtml({ sent, failed, total: 1, keyParam }));
      }
      let toSend = eligible;
      const bodyReps = req.body && Array.isArray(req.body.reps) ? req.body.reps : null;
      if (q.rep) {
        toSend = eligible.filter((e) => norm(`${e.rep.first} ${e.rep.last}`) === norm(q.rep));
      } else if (bodyReps) {
        const want = new Set(bodyReps.map(norm));
        toSend = eligible.filter((e) => want.has(norm(`${e.rep.first} ${e.rep.last}`)));
      }
      // Reps whose manager has knocking turned on (Time Track sources), from the panel.
      const knockOn = new Set((req.body && Array.isArray(req.body.knockOn) ? req.body.knockOn : []).map(norm));
      const knockFlag = q.knocking === '1';
      const results = await pooled(toSend, SEND_CONCURRENCY, async ({ rep, stats }) => {
        const showKnock = knockFlag || knockOn.has(norm(`${rep.first} ${rep.last}`));
        const html = renderEmail(rep, stats, ctx, { knocking: showKnock, has: hasFor(rep) });
        const r = await sendEmail({ to: rep.email, subject: subjectFor(rep), html });
        return { rep: `${rep.first} ${rep.last}`, id: r && r.id };
      });
      const sent = results.filter((r) => r && r.id).length;
      const failed = results.filter((r) => r && r.error).map((r, i) => ({ rep: results[i] && results[i].rep, error: r.error }));
      // Names, not just a count, so the panel can mark who has been sent this week.
      const sentReps = results.filter((r) => r && r.id).map((r) => r.rep);
      if (wantJson) return res.status(200).json({ ok: true, mode: 'send', sent, sentReps, failed, total: toSend.length });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(resultHtml({ sent, failed, total: toSend.length, keyParam }));
    }

    // ---- machine-readable list (?json=1): the full set of who would receive it ----
    if (wantJson) {
      return res.status(200).json({
        ok: true, mode: 'summary', week: { sun, sat, label: weekLabel },
        eligibleCount: eligible.length,
        withManagerCc: 0,
        reps: eligible.map((e) => ({
          rep: `${e.rep.first} ${e.rep.last}`, email: e.rep.email, manager: e.rep.managerName || null,
          doors: e.stats.knock.doors, deals: e.stats.deals.total, briaGap: e.stats.briaGap,
          cancels: e.stats.cancels.length,
          installRate: e.stats.install.rate == null ? null : Math.round(e.stats.install.rate * 100),
          isp: repIsp.get(e.rep.key) || null,
          ispPending: (() => { const i = repIsp.get(e.rep.key); const p = i && ispPending.get(i); return p ? { isp: i, now: p.now, prior: p.prior } : null; })(),
          upfront: e.stats.upfront.optedIn ? { on: e.stats.upfront.on, rate: e.stats.upfront.rate == null ? null : Math.round(e.stats.upfront.rate * 100) } : null,
        })),
        unmatched: unmatched.map((u) => ({ rep: u.rep, deals: u.deals })),
        ispCoverage: [...new Set([...ispPrior.keys(), ...ispNow.keys()])].sort().map((isp) => ({
          isp, now: ispNow.get(isp) || 0, prior: ispPrior.get(isp) || 0, pending: !!ispPending.get(isp),
        })),
      });
    }

    // ---- default: the control panel (GET) — review, preview, then click Send ----
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(panelHtml({
      weekLabel, keyParam,
      eligible: eligible.length,
      withCc: 0,
      sample: eligible.slice(0, 10).map((e) => ({ rep: `${e.rep.first} ${e.rep.last}`, email: e.rep.email, cc: false })),
    }));
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
