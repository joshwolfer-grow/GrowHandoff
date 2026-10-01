// ISP sales analyst logic: one ISP's sales, installs, cancels and knocking, with
// flags for anything out of the ordinary and highlights worth sharing.
// Pure functions; the worker (isp.mjs) fetches rows and calls analyze().

export const ISPS = {
  i3:   { name: 'i3 Broadband', deals: ['i3 Broadband'], bria: ['i3 Fiber', 'i3 Broadband'], source: null,   code: 'i3' },
  slic: { name: 'SLIC',         deals: ['SLIC'],         bria: ['SLIC Fiber', 'SLIC'],       source: null,   code: 'slic' },
  lyte: { name: 'Lyte Fiber',   deals: ['Lyte Fiber'],   bria: ['Lyte Fiber'],               source: null,   code: 'lyte' },
  surf: { name: 'Surf',         deals: ['Surf'],         bria: ['Surf Internet', 'Surf'],    source: null,   code: 'surf' },
  tds:  { name: 'TDS',          deals: ['TDS'],          bria: ['TDS Fiber', 'TDS'],         source: 'tds',  code: 'tds' },
  ezee: { name: 'Ezee Fiber',   deals: ['Ezee Fiber'],   bria: ['Ezee Fiber'],               source: 'ezee', code: 'ezee' },
  omni: { name: 'Omni Fiber',   deals: ['Omni Fiber'],   bria: ['Omni Fiber'],               source: 'omni', code: 'omni' },
};

const iso = (d) => d.toLocaleDateString('en-CA');
export function weekOf(ds) { const d = new Date(ds + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); return d.toISOString().slice(0, 10); }
export function shiftDays(ds, n) { const d = new Date(ds + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (n, d) => d ? Math.round(n / d * 100) : null;
const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 864e5);

// Which ISP a rep is working each week, from the deals they sold that week
// (fallback: their most recent ISP). Used to attribute SalesRabbit knocking,
// which carries no ISP of its own, to an ISP.
export function repIspByWeek(allDeals) {
  const tally = {};
  for (const d of allDeals) { if (!d.rep || !d.sale_date || !d.isp) continue; const w = weekOf(d.sale_date); ((tally[d.rep] ||= {})[w] ||= {})[d.isp] = (tally[d.rep][w][d.isp] || 0) + 1; }
  const out = {};
  for (const [rep, weeks] of Object.entries(tally)) {
    out[rep] = {};
    for (const [w, isps] of Object.entries(weeks)) out[rep][w] = Object.entries(isps).sort((a, b) => b[1] - a[1])[0][0];
  }
  return out;
}
function repIspOn(map, rep, day) {
  const weeks = map[rep]; if (!weeks) return null;
  const w = weekOf(day); if (weeks[w]) return weeks[w];
  const prior = Object.keys(weeks).filter(k => k <= w).sort(); if (prior.length) return weeks[prior[prior.length - 1]];
  const later = Object.keys(weeks).sort(); return later.length ? weeks[later[0]] : null;
}

// deals: rows for this ISP (all history the worker fetched, ~16 weeks).
// knocking: rows already attributed to this ISP (rep, date, doors, sold).
// today: YYYY-MM-DD. exportStampAge: hours since the ISP export last ran, or null.
// parkedFiles: names of lead files parked for this ISP (not processed yet).
// bria: this ISP's deals from Bria (the comp system of record). When given, sales are counted
// from Bria and reconciled against the install report; installs and cancels always come from the report.
export function analyze({ ispKey, deals, bria = null, knocking = [], today, exportStampAge = null, parkedFiles = [] }) {
  const I = ISPS[ispKey];
  const thisWeek = weekOf(today);
  const weeks = []; for (let i = 0; i < 12; i++) weeks.push(shiftDays(thisWeek, -7 * i));   // newest first
  const std = deals.filter(d => (d.deal_type || 'Standard') !== 'Presale');
  const soldRows = bria || std;

  const byWeek = {};
  for (const w of weeks) byWeek[w] = { week: w, sold: 0, installed: 0, cancelled: 0, clawback: 0, doors: 0, reps: new Set(), soldByRep: {}, cancelByRep: {}, installByRep: {}, reasons: {} };
  for (const d of soldRows) {
    const ws = d.sale_date && weekOf(d.sale_date); if (ws && byWeek[ws]) { byWeek[ws].sold++; byWeek[ws].reps.add(d.rep); byWeek[ws].soldByRep[d.rep] = (byWeek[ws].soldByRep[d.rep] || 0) + 1; }
  }
  for (const d of std) {
    const wi = d.status === 'Serviced' && d.install_date && weekOf(d.install_date); if (wi && byWeek[wi]) { byWeek[wi].installed++; byWeek[wi].installByRep[d.rep] = (byWeek[wi].installByRep[d.rep] || 0) + 1; }
    const wc = (d.status === 'Cancelled' || d.status === 'Clawback') && (d.cancel_date || d.sale_date) && weekOf(d.cancel_date || d.sale_date);
    if (wc && byWeek[wc]) { if (d.status === 'Clawback') byWeek[wc].clawback++; else byWeek[wc].cancelled++; byWeek[wc].cancelByRep[d.rep] = (byWeek[wc].cancelByRep[d.rep] || 0) + 1; const r = (d.cancel_reason || 'no reason given').trim(); byWeek[wc].reasons[r] = (byWeek[wc].reasons[r] || 0) + 1; }
  }
  for (const k of knocking) { const w = weekOf(k.date); if (byWeek[w]) byWeek[w].doors += Number(k.doors) || 0; }
  const W = weeks.map(w => byWeek[w]);
  const cur = W[0], prev = W[1], base = W.slice(1, 5);
  const avg = (f) => base.length ? base.reduce((s, w) => s + f(w), 0) / base.length : 0;
  // Fair comparison for a week in progress: completed workdays only (Mon–Sat, not
  // today, since today's report is not in yet), against the same days of the prior
  // 4 weeks. Sunday never counts. The report lands days after the sale, so this is
  // still conservative early in the week; flags need at least two completed days.
  const offsets = []; for (let i = 1; i < 7; i++) { const d = shiftDays(thisWeek, i); if (d < today) offsets.push(i); }
  const daysIn = offsets.length;
  const throughSame = (weekStart, rows, field) => rows.filter(r => r[field] && offsets.some(i => r[field] === shiftDays(weekStart, i))).length;
  const soldThrough = (weekStart) => throughSame(weekStart, soldRows, 'sale_date');
  const instThrough = (weekStart) => throughSame(weekStart, std.filter(d => d.status === 'Serviced'), 'install_date');
  const doorsThrough = (weekStart) => knocking.filter(k => offsets.some(i => k.date === shiftDays(weekStart, i))).reduce((s, k) => s + (Number(k.doors) || 0), 0);
  const sameAvg = (fn) => base.length ? base.reduce((s, w) => s + fn(w.week), 0) / base.length : 0;
  const soldSoFar = soldThrough(thisWeek), soldSame = sameAvg(soldThrough);
  const instSoFar = instThrough(thisWeek), instSame = sameAvg(instThrough);
  const doorsSoFar = doorsThrough(thisWeek), doorsSame = sameAvg(doorsThrough);
  const pace = (n) => daysIn ? n / daysIn * 6 : 0;

  // Install rate on deals that have settled, sold in the last 8 weeks vs the 8 before.
  const settled = (from, to) => std.filter(d => d.sale_date >= from && d.sale_date < to && (d.status === 'Serviced' || d.status === 'Cancelled' || d.status === 'Clawback'));
  const recent = settled(shiftDays(thisWeek, -56), shiftDays(thisWeek, 7)), older = settled(shiftDays(thisWeek, -112), shiftDays(thisWeek, -56));
  const rate = (rows) => pct(rows.filter(d => d.status === 'Serviced').length, rows.length);
  const installRate = rate(recent), installRatePrev = rate(older);

  // Booking lag on deals sold in the last 4 weeks with a planned or actual install date.
  const lagOf = (rows) => median(rows.filter(d => d.sale_date && (d.install_date || d.planned_install)).map(d => daysBetween(d.sale_date, d.install_date || d.planned_install)));
  const lag = lagOf(std.filter(d => d.sale_date >= shiftDays(thisWeek, -28))), lagPrev = lagOf(std.filter(d => d.sale_date >= shiftDays(thisWeek, -84) && d.sale_date < shiftDays(thisWeek, -28)));

  const pending = std.filter(d => d.status === 'Pending');
  const pastDue = pending.filter(d => d.past_due === true || (d.planned_install && d.planned_install < today && !d.install_date));
  const staleSales = pending.filter(d => d.sale_date && daysBetween(d.sale_date, today) > 30);

  const flags = [], wins = [];
  const flag = (key, text, severity = 2, n = null) => flags.push({ key: `${ispKey}:${key}`, text, severity, n });
  const win = (key, text, n = null) => wins.push({ key: `${ispKey}:${key}`, text, n });

  // ---- sales pace ----
  const soldAvg = avg(w => w.sold);
  if (soldSame >= 5 && daysIn >= 2 && soldSoFar < soldSame * 0.55) flag('sales-slow', `Sales are ${Math.round((1 - soldSoFar / soldSame) * 100)}% under the usual by this point in the week (${soldSoFar} vs ${Math.round(soldSame)} through ${['Mon','Tue','Wed','Thu','Fri','Sat'][daysIn - 1]})`, 3, soldSoFar);
  if (soldSame >= 5 && daysIn >= 2 && soldSoFar > soldSame * 1.4) win('sales-hot', `Sales are ${Math.round((soldSoFar / soldSame - 1) * 100)}% ahead of the usual by this point in the week (${soldSoFar} vs ${Math.round(soldSame)})`, soldSoFar);
  if (prev && prev.sold >= 5 && prev.sold >= Math.max(...W.slice(1).map(w => w.sold))) win('record-week', `Last week was the best week in 12 for ${I.name}: ${prev.sold} sold`, prev.sold);
  // ---- cancels ----
  const cancAvg = avg(w => w.cancelled);
  if (cur.cancelled >= 3 && cur.cancelled > Math.max(cancAvg * 1.6, 2)) flag('cancels-up', `${cur.cancelled} cancels this week vs a usual ${cancAvg.toFixed(1)}`, 3, cur.cancelled);
  const topReason = Object.entries(cur.reasons).filter(([r]) => r !== 'no reason given').sort((a, b) => b[1] - a[1])[0];
  if (topReason && topReason[1] >= 3 && topReason[1] >= cur.cancelled * 0.5) flag('reason', `Half of this week's cancels say "${topReason[0]}" (${topReason[1]})`, 2, topReason[1]);
  for (const [rep, n] of Object.entries(cur.cancelByRep)) if (n >= 4) flag(`rep-cancels:${rep}`, `${rep} has ${n} cancels this week`, 2, n);
  if (cur.clawback >= 2) flag('clawbacks', `${cur.clawback} clawbacks this week`, 3, cur.clawback);
  if (prev && prev.sold >= 5 && prev.cancelled === 0) win('clean-week', `Zero cancels last week on ${prev.sold} sales`, prev.sold);
  // ---- installs ----
  if (installRate != null && installRatePrev != null && installRate <= installRatePrev - 10) flag('install-rate', `Install rate fell to ${installRate}% from ${installRatePrev}% over the last 8 weeks`, 3, installRate);
  if (installRate != null && recent.length >= 20 && installRate >= 85) win('install-rate', `Install rate is ${installRate}% on the last 8 weeks (${recent.length} settled)`, installRate);
  if (lag != null && lagPrev != null && lag >= lagPrev + 5) flag('booking-lag', `Installs are being booked ${lag} days out, up from ${lagPrev}`, 2, lag);
  if (pastDue.length >= 3 && pastDue.length > pending.length * 0.1) flag('past-due', `${pastDue.length} installs are past their planned date and still pending`, 3, pastDue.length);
  if (staleSales.length >= 5 && staleSales.length > pending.length * 0.15) flag('stale-pending', `${staleSales.length} sales older than 30 days have neither installed nor cancelled`, 2, staleSales.length);
  if (instSame >= 5 && daysIn >= 3 && instSoFar < instSame * 0.5) flag('installs-slow', `Only ${instSoFar} installs so far this week vs a usual ${Math.round(instSame)} by now`, 2, instSoFar);
  // ---- knocking ----
  const doorsAvg = avg(w => w.doors);
  if (doorsSame >= 200 && daysIn >= 2 && doorsSoFar < doorsSame * 0.5) flag('doors-slow', `Knocking is at half the usual pace (${doorsSoFar} doors so far vs ${Math.round(doorsSame)} by now)`, 2, doorsSoFar);
  if (soldAvg >= 5 && cur.reps.size > 0 && prev && cur.reps.size <= Math.floor(prev.reps.size / 2)) flag('reps-down', `Only ${cur.reps.size} reps have sold ${I.name} this week, down from ${prev.reps.size}`, 2, cur.reps.size);
  // ---- Bria vs the install report ----
  const recon = bria ? reconcile({ bria, reports: deals, from: shiftDays(thisWeek, -56), today }) : null;
  if (recon && recon.notOnReport.length >= 3) flag('bria-missing', `${recon.notOnReport.length} sales in Bria aren't on the ${I.name} install report (last 8 weeks, report covers through ${recon.through})`, recon.notOnReport.length >= 10 ? 3 : 2, recon.notOnReport.length);
  if (recon && recon.reportOnly.length >= 3) flag('report-only', `${recon.reportOnly.length} deals on the ${I.name} install report aren't in Bria (last 8 weeks)`, 2, recon.reportOnly.length);
  if (recon && recon.bria >= 20 && recon.notOnReport.length === 0 && recon.reportOnly.length === 0) win('recon-clean', `Bria and the ${I.name} install report match on all ${recon.matched} deals from the last 8 weeks`, recon.matched);
  // ---- ops ----
  if (parkedFiles.length) flag('lead-file', `A lead file from ${I.name} is parked and not processed: ${parkedFiles.join(', ')}`, 3, parkedFiles.length);
  if (exportStampAge != null && exportStampAge > 36) flag('export-stale', `The ISP export last ran ${Math.round(exportStampAge)} hours ago`, 2, exportStampAge);
  // ---- people to highlight ----
  const topRep = Object.entries(prev ? prev.installByRep : {}).sort((a, b) => b[1] - a[1])[0];
  if (topRep && topRep[1] >= 3) win(`top-installer:${topRep[0]}`, `${topRep[0]} had the most installs last week for ${I.name}: ${topRep[1]}`, topRep[1]);
  const topSeller = Object.entries(cur.soldByRep).sort((a, b) => b[1] - a[1])[0];

  const summary = {
    isp: ispKey, name: I.name, today, week: thisWeek, daysIn,
    sold: cur.sold, soldPrev: prev ? prev.sold : 0, soldAvg: Math.round(soldAvg * 10) / 10, soldPace: Math.round(pace(soldSoFar)), soldSoFar, soldSame: Math.round(soldSame),
    installed: cur.installed, cancelled: cur.cancelled, clawback: cur.clawback, doors: cur.doors, doorsAvg: Math.round(doorsAvg),
    soldPer100: cur.doors ? Math.round(cur.sold / cur.doors * 1000) / 10 : null,
    reps: cur.reps.size, topSeller: topSeller ? { rep: topSeller[0], n: topSeller[1] } : null,
    installRate, installRatePrev, lag, lagPrev, pending: pending.length, pastDue: pastDue.length,
    weeks: W.map(w => ({ week: w.week, sold: w.sold, installed: w.installed, cancelled: w.cancelled, clawback: w.clawback, doors: w.doors, reps: w.reps.size })),
    reasons: Object.entries(cur.reasons).sort((a, b) => b[1] - a[1]).slice(0, 5),
    flags: flags.sort((a, b) => b.severity - a.severity), wins,
    soldFrom: bria ? 'Bria' : 'install report',
    recon: recon && { ...recon, notOnReport: recon.notOnReport.slice(0, 60), reportOnly: recon.reportOnly.slice(0, 60), notOnReportN: recon.notOnReport.length, reportOnlyN: recon.reportOnly.length },
  };
  return summary;
}

export function statusLine(s) {
  const trend = s.soldSame >= 5 && s.daysIn >= 2 ? ` (${s.soldSoFar >= s.soldSame ? '+' : ''}${Math.round((s.soldSoFar / s.soldSame - 1) * 100)}% vs usual by now)` : '';
  const head = `${s.name}: ${s.sold} sold this week${trend} · ${s.installed} installed · ${s.cancelled} cancelled`;
  const bits = [];
  if (s.flags.length) bits.push(`${s.flags.length} flag${s.flags.length > 1 ? 's' : ''}`);
  if (s.wins.length) bits.push(`${s.wins.length} win${s.wins.length > 1 ? 's' : ''}`);
  return bits.length ? `${head} · ${bits.join(', ')}` : `${head} · nothing unusual`;
}

// The Sales lead rolls every ISP up: ranking, company totals, the highlight reel.
export function rollup(summaries) {
  const rows = summaries.filter(Boolean).sort((a, b) => b.sold - a.sold);
  const total = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
  const flags = rows.flatMap(r => r.flags.map(f => ({ ...f, isp: r.name }))).sort((a, b) => b.severity - a.severity);
  const wins = rows.flatMap(r => r.wins.map(w => ({ ...w, isp: r.name })));
  const settledN = rows.reduce((s, r) => s + 0, 0);
  return { day: rows[0] ? rows[0].today : null, week: rows[0] ? rows[0].week : null, sold: total('sold'), installed: total('installed'), cancelled: total('cancelled'), doors: total('doors'), pending: total('pending'), pastDue: total('pastDue'),
    isps: rows.map(r => ({ isp: r.isp, name: r.name, sold: r.sold, soldPace: r.soldPace, soldAvg: r.soldAvg, installed: r.installed, cancelled: r.cancelled, installRate: r.installRate, lag: r.lag, doors: r.doors, reps: r.reps, flags: r.flags.length, wins: r.wins.length, notOnReport: r.recon ? r.recon.notOnReportN : null, reportOnly: r.recon ? r.recon.reportOnlyN : null })),
    flags, wins };
}
export function rollupLine(r) {
  const lead = r.isps[0];
  return `Company: ${r.sold} sold this week · ${r.installed} installed · ${r.cancelled} cancelled${lead ? ` · ${lead.name} leads with ${lead.sold}` : ''} · ${r.flags.length} flag${r.flags.length === 1 ? '' : 's'}, ${r.wins.length} win${r.wins.length === 1 ? '' : 's'}`;
}

// ---------- Bria vs the ISP install report ----------
// Same pairing rules as the Grow dashboard's reconciliation (index.html pairDeals),
// so a deal the dashboard calls missing is the deal this report calls missing.
const toks = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(t => t && !['jr', 'sr', 'ii', 'iii', 'iv'].includes(t));
const fkey = (s) => { const p = toks(s); if (!p.length) return ''; return (p.length === 1 ? [p[0]] : [p[0], p[p.length - 1]]).sort().join(' '); };
const first = (s) => toks(s)[0] || '';
const last = (s) => { const p = toks(s); return p.length > 1 ? p[p.length - 1] : ''; };
const phKey = (s) => { const d = String(s || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };
function lev(a, b) {
  if (a === b) return 0; if (!a.length) return b.length; if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j), cur = [];
  for (let i = 1; i <= a.length; i++) { cur = [i]; for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[b.length];
}
const lastCompat = (a, b) => !!a && !!b && (a === b || (a.length === 1 ? b[0] === a : b.length === 1 ? a[0] === b : lev(a, b) <= 1));

// brias: { customer, sale_date, install_date, phone }. reports: { customer, sale_date, planned_install, phone }.
// Returns [briaIndex -> reportIndex or -1], [reportIndex -> taken].
export function pairDeals(brias, reports) {
  const u = (x, isB) => ({ x, k: fkey(x.customer), f: first(x.customer), l: last(x.customer), ph: phKey(x.phone), sd: x.sale_date || '', id: isB ? (x.install_date || '') : '', pd: isB ? '' : (x.planned_install || x.install_date || '') });
  const B = brias.map(x => u(x, true)), G = reports.map(x => u(x, false));
  const taken = G.map(() => false), bm = B.map(() => -1);
  const run = (pred) => { for (let bi = 0; bi < B.length; bi++) { if (bm[bi] >= 0) continue; for (let gi = 0; gi < G.length; gi++) { if (taken[gi]) continue; if (pred(B[bi], G[gi])) { bm[bi] = gi; taken[gi] = true; break; } } } };
  run((b, g) => b.ph && b.ph === g.ph);
  run((b, g) => b.k && b.k === g.k);
  run((b, g) => b.f && b.f === g.f && lastCompat(b.l, g.l));
  run((b, g) => b.f && b.f === g.f && b.sd && b.sd === g.sd);
  run((b, g) => b.f && g.f && lev(b.f, g.f) <= 2 && lastCompat(b.l, g.l));
  run((b, g) => { const bt = toks(b.x.customer); if (bt.length !== 1) return false; const t = bt[0]; if (t !== g.f && t !== g.l) return false; return (b.sd && b.sd === g.sd) || (b.id && (b.id === g.pd || b.id === g.sd)); });
  run((b, g) => lastCompat(b.l, g.l) && b.sd && b.sd === g.sd);
  run((b, g) => lastCompat(b.l, g.l) && b.id && (b.id === g.pd || b.id === g.sd));
  run((b, g) => b.f && b.f === g.f && b.id && (b.id === g.pd || b.id === g.sd));
  run((b, g) => b.sd && b.sd === g.sd && b.id && b.id === g.pd);
  return { bm, taken };
}

// Rows no one can match by name: placeholders and first-name-only entries without a phone.
export function unmatchable(x) {
  const n = String(x.customer || '').trim();
  if (!n) return 'no name in Bria';
  if (/^(past sale|past sales|test|n\/a|none|xx+)$/i.test(n)) return 'placeholder name in Bria';
  if (n.split(/\s+/).length === 1 && !phKey(x.phone)) return 'only a first name in Bria';
  return '';
}

// The newest sale date the install report really covers: walk back from the newest
// day until one carries at least half the usual daily volume, so one straggler row
// doesn't make a half-delivered report look complete.
export function reportThrough(reports) {
  const days = {}; for (const d of reports) if (d.sale_date) days[d.sale_date] = (days[d.sale_date] || 0) + 1;
  const keys = Object.keys(days).sort(); if (!keys.length) return null;
  const recent = keys.slice(-14).map(k => days[k]).sort((a, b) => a - b);
  const bar = Math.max(1, recent[recent.length >> 1] * 0.5);
  for (let i = keys.length - 1; i >= 0; i--) if (days[keys[i]] >= bar) return keys[i];
  return keys[keys.length - 1];
}

// Pools the whole window and pairs once, so a deal that landed in a neighbouring week still matches.
export function reconcile({ bria, reports, from, today }) {
  const through = reportThrough(reports);
  const b = bria.filter(d => d.sale_date >= from && d.sale_date < today);
  const g = reports.filter(d => d.sale_date >= from && d.sale_date < today);
  const { bm, taken } = pairDeals(b, g);
  const notOnReport = [], awaiting = [], cantMatch = [];
  b.forEach((d, i) => {
    if (bm[i] >= 0) return;
    const row = { customer: d.customer || '', rep: d.rep || '', sale_date: d.sale_date };
    if (through && d.sale_date > through) awaiting.push(row);
    else if (unmatchable(d)) cantMatch.push({ ...row, why: unmatchable(d) });
    else notOnReport.push(row);
  });
  const reportOnly = g.filter((_, i) => !taken[i]).map(d => ({ customer: d.customer || '', rep: d.rep || '', sale_date: d.sale_date, status: d.status || '' }));
  const byDate = (a, c) => (a.sale_date < c.sale_date ? 1 : -1);
  return { from, through, bria: b.length, report: g.length, matched: bm.filter(x => x >= 0).length,
    notOnReport: notOnReport.sort(byDate), awaiting: awaiting.length, cantMatch: cantMatch.length, reportOnly: reportOnly.sort(byDate) };
}
