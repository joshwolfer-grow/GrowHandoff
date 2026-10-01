// Pay Auditor logic: pure functions over the numbers the dashboard itself computed.
// The browser half (payaudit.mjs) hands in { weeks, runs, paid, perDeal, auditThru };
// everything here is deterministic and unit tested.

// Same rule as the dashboard's _ufPaidState, so the auditor and the page agree.
export function paidState(run, row, owed) {
  if (!run || !run.closed) return { paid: 0, state: 'pending', had: row && row.amount != null ? row.amount : null };
  if (row && row.amount != null) return { paid: row.amount, state: row.amount === owed ? 'match' : owed > row.amount ? 'under' : 'over' };
  if (row && row.paid) return { paid: owed, state: 'assumed' };
  return { paid: 0, state: owed ? 'under' : 'match' };
}

// Drift for every closed week: live owed vs the amount frozen at close.
export function closedWeekDrift({ weeks = [], runs = {}, paid = {}, auditThru = '' }) {
  const out = [];
  for (const w of weeks) {
    const run = runs[w.start];
    if (!run || !run.closed) continue;
    const settledByAudit = !!auditThru && w.end <= auditThru;
    const seen = new Set();
    const rows = [];
    for (const r of w.rows) {
      seen.add(r.rep);
      const ps = paidState(run, paid[w.start + '|' + r.rep], r.net);
      rows.push({ rep: r.rep, owed: r.net, paid: ps.paid, state: ps.state });
    }
    // Reps paid at close but no longer owed anything: the whole amount is over.
    for (const k of Object.keys(paid)) {
      const [wk, rep] = k.split('|');
      if (wk !== w.start || seen.has(rep)) continue;
      const p = paid[k];
      const amt = p.amount != null ? p.amount : 0;
      if (amt > 0) rows.push({ rep, owed: 0, paid: amt, state: 'over' });
    }
    const owed = rows.reduce((s, r) => s + r.owed, 0);
    const paidSum = rows.reduce((s, r) => s + r.paid, 0);
    out.push({ start: w.start, end: w.end, settledByAudit, owed, paid: paidSum, rows: rows.filter(r => r.state !== 'match') });
  }
  return out;
}

// Adjustments both ways, skipping weeks the September audit already settled.
export function adjustments(drift) {
  const owe = [], recover = [];
  for (const w of drift) {
    if (w.settledByAudit) continue;
    for (const r of w.rows) {
      const diff = r.owed - r.paid;
      if (r.state === 'under' && diff > 0) owe.push({ rep: r.rep, week: w.start, amount: diff });
      else if (r.state === 'over' && diff < 0) recover.push({ rep: r.rep, week: w.start, amount: -diff });
    }
  }
  const oweTotal = owe.reduce((s, a) => s + a.amount, 0);
  const recoverTotal = recover.reduce((s, a) => s + a.amount, 0);
  return { owe, recover, oweTotal, recoverTotal, net: oweTotal - recoverTotal };
}

// What moved since the last audit: per-rep net for the same pay week, tier flips,
// reps who appeared or dropped off the run.
export function cycleDiff(current, prev) {
  if (!prev || !prev.current) return null;
  const P = prev.current, C = current;
  const sameWeek = P.start === C.start;
  const pm = new Map(P.rows.map(r => [r.rep, r]));
  const cm = new Map(C.rows.map(r => [r.rep, r]));
  const changed = [], tier = [], added = [], dropped = [];
  for (const r of C.rows) {
    const p = pm.get(r.rep);
    if (!p) { added.push({ rep: r.rep, net: r.net, st: r.st }); continue; }
    if (sameWeek && p.net !== r.net) changed.push({ rep: r.rep, from: p.net, to: r.net });
    if (p.st !== r.st) tier.push({ rep: r.rep, from: p.st, to: r.st });
  }
  for (const p of P.rows) if (!cm.has(p.rep)) dropped.push({ rep: p.rep, net: p.net, st: p.st });
  return { prevDay: prev.day || null, prevWeek: P.start, sameWeek, changed, tier, added, dropped, prevTotal: P.total, total: C.total };
}

export function buildAudit(data, prev) {
  const weeks = data.weeks || [];
  const w0 = weeks[0] || { start: null, end: null, rows: [] };
  const rows = w0.rows.map(r => ({ rep: r.rep, st: r.st, on: r.on, rate: r.rate, fin: r.fin, payCount: r.payCount, pay: r.pay, claw: r.claw, net: r.net, cb: r.cb || 0, cbNew: !!r.cbNew, rFall: r.rFall || 0 }));
  const current = {
    start: w0.start, end: w0.end, recStart: w0.recStart || null,
    reps: rows.length, paidReps: rows.filter(r => r.on).length,
    total: rows.reduce((s, r) => s + r.net, 0),
    pay: rows.reduce((s, r) => s + r.pay, 0),
    claw: rows.reduce((s, r) => s + r.claw, 0),
    chargebacks: rows.filter(r => r.cbNew).map(r => ({ rep: r.rep, amount: r.cb })),
    rows,
  };
  const drift = closedWeekDrift(data);
  const adj = adjustments(drift);
  const diff = cycleDiff(current, prev);
  return { current, drift, adjustments: adj, diff, tiers: data.tiers || null, rosterSynced: data.rosterSynced !== false, perDeal: data.perDeal || 50, generated: new Date().toISOString() };
}

const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString();
const mdShort = (iso) => { if (!iso) return '?'; const d = new Date(iso + 'T12:00:00Z'); return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()] + ' ' + d.getUTCDate(); };

export function statusLine(a) {
  const c = a.current, adj = a.adjustments;
  const head = `Pay week ${mdShort(c.start)}: ${c.paidReps} reps, ${money(c.total)} to pay`;
  const parts = [];
  if (adj.owe.length) parts.push(`owe ${money(adj.oweTotal)} to ${adj.owe.length}`);
  if (adj.recover.length) parts.push(`recover ${money(adj.recoverTotal)} from ${adj.recover.length}`);
  if (c.chargebacks.length) parts.push(`${c.chargebacks.length} new chargeback${c.chargebacks.length > 1 ? 's' : ''}`);
  if (!a.rosterSynced) parts.push('roster sheet did not load');
  return parts.length ? `${head} · ${parts.join(', ')}` : `${head} · no adjustments`;
}
