// Chief of staff logic: roll call, a ranked to-do built from the floor's latest
// findings, and carry-over from the previous brief. No model anywhere.
import { deriveStatus } from '../../site/status.mjs';

const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString();
const isStaff = (id) => id.startsWith('runner-') || id.startsWith('chief-');

// ---- roll call ----
export function rollCall(agents, events, facts, now = Date.now()) {
  const rows = [];
  for (const a of agents) {
    if (isStaff(a.id)) continue;
    const s = deriveStatus(a, events, now);
    const f = facts[a.id] || {};
    const code = (s.state === 'failed' && /exit (\d+)/.exec(s.bubble || '')) ? Number(RegExp.$1) : null;
    let fix = null;
    if (s.state === 'stale' && f.run && !f.observed) fix = { kind: 'run' };
    else if (s.state === 'failed' && code != null && f.failCommands && f.failCommands[code]) fix = { kind: 'fix', args: { code } };
    else if (s.state === 'failed' && f.run && !f.observed) fix = { kind: 'run' };
    rows.push({ id: a.id, name: a.name, team: a.team || '', lead: !!a.lead, state: s.state, lastAt: s.lastAt, bubble: s.bubble || '', fix,
      hint: s.state === 'blocked' ? (f.blocked || 'Blocked; open the card for what to do.') : (code != null && f.failHints && f.failHints[code]) || null });
  }
  const present = rows.filter(r => r.state === 'working' || r.state === 'idle' || r.state === 'offduty').length;
  return { rows, present, total: rows.length, missed: rows.filter(r => r.state === 'stale' || r.state === 'failed' || r.state === 'blocked') };
}

// Which fixes to queue: one open task per worker+kind, nothing for workers that already have one.
export function fixesToQueue(roll, openTasks) {
  const open = new Set(openTasks.map(t => t.agent_id + '|' + t.kind));
  return roll.missed.filter(r => r.fix && !open.has(r.id + '|' + r.fix.kind)).map(r => ({ agent: r.id, kind: r.fix.kind, args: r.fix.args || {}, note: r.state === 'stale' ? `Chief: ${r.name} missed roll call (no report since ${r.lastAt ? r.lastAt.slice(0, 16).replace('T', ' ') : 'ever'})` : `Chief: ${r.name} failed (${r.bubble.slice(0, 60)})` }));
}

// ---- to-do items from each worker's latest snapshot ----
// key must be stable across days so carry-over can match; severity 3 high, 2 medium, 1 low.
const X = {
  payaudit(d) {
    const out = [];
    for (const a of (d.adjustments && d.adjustments.owe) || []) out.push({ key: `payaudit:owe:${a.rep}:${a.week}`, title: `Pay ${a.rep} ${money(a.amount)} more for week ${a.week}`, amount: a.amount, severity: 3 });
    for (const a of (d.adjustments && d.adjustments.recover) || []) out.push({ key: `payaudit:recover:${a.rep}:${a.week}`, title: `Recover ${money(a.amount)} from ${a.rep} for week ${a.week}`, amount: a.amount, severity: 3 });
    for (const c of (d.current && d.current.chargebacks) || []) out.push({ key: `payaudit:cb:${c.rep}`, title: `New chargeback: ${c.rep} ${money(c.amount)} (came off upfront)`, amount: c.amount, severity: 3 });
    if (d.rosterSynced === false) out.push({ key: 'payaudit:roster', title: 'Upfront roster sheet did not load for the pay audit', severity: 2 });
    return out;
  },
  installs(d) {
    const x = d.diff || {}; const out = [];
    for (const p of x.cancelled || []) out.push({ key: `installs:cancel:${p.id}`, title: `Install cancelled: ${p.rep} · ${p.id}`, severity: 2 });
    for (const p of (x.pushed || []).filter(p => p.days >= 7)) out.push({ key: `installs:push:${p.id}`, title: `Install pushed ${p.days}d: ${p.rep} · ${p.id}`, amount: p.days, severity: 2 });
    return out;
  },
  chaser(d) {
    const by = d.byRep || {}; const out = [];
    for (const rep of Object.keys(by)) { const n = by[rep].length; if (n >= 3) out.push({ key: `chaser:${rep}`, title: `${rep} has ${n} untouched callbacks`, amount: n, severity: rep === 'Unassigned' ? 2 : n >= 10 ? 3 : 2 }); }
    return out;
  },
  analyst(d) {
    return (d.flags || []).map(f => ({ key: `analyst:${f.rep}:${f.metric}`, title: `${f.rep}: ${f.metric} is ${f.direction} vs team`, severity: 1 }));
  },
  isp(d) {
    const out = [];
    for (const f of (d && d.flags) || []) out.push({ key: `isp:${f.key}`, title: `${d.name}: ${f.text}`, amount: f.n || 0, severity: f.severity || 2 });
    return out;
  },
  slots(d) {
    return ((d && d.flags) || []).map(f => ({ key: f.key, title: `${d.name}, ${f.text}`, amount: f.n || 0, severity: f.severity || 2 }));
  },
};

export function todoItems(snapshots) {
  const items = [];
  for (const [agent, snap] of Object.entries(snapshots)) {
    const fn = X[agent] || (agent.startsWith('isp-') ? X.isp : agent.startsWith('slots-') ? X.slots : null);
    if (!snap || !fn) continue;
    let list = [];
    try { list = fn(snap.data) || []; } catch { list = []; }
    for (const it of list) items.push({ ...it, owner: agent, seen: snap.day });
  }
  return items.sort((a, b) => (b.severity - a.severity) || ((b.amount || 0) - (a.amount || 0)) || a.title.localeCompare(b.title));
}

// Carry-over: keep firstSeen from the previous brief; anything that vanished is closed.
export function carryOver(items, prev, today) {
  const prevItems = new Map(((prev && prev.items) || []).map(i => [i.key, i]));
  const days = (a, b) => Math.max(0, Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 864e5));
  const out = items.map(i => { const p = prevItems.get(i.key); const firstSeen = p ? (p.firstSeen || prev.day || today) : today; return { ...i, firstSeen, daysOpen: days(firstSeen, today), carried: !!p }; });
  const closed = [...prevItems.values()].filter(p => !items.some(i => i.key === p.key)).map(p => ({ key: p.key, title: p.title, owner: p.owner, daysOpen: days(p.firstSeen || prev.day || today, today) }));
  return { items: out, closed };
}

export function statusLine(b) {
  const r = b.roll;
  const head = `Roll call ${r.present}/${r.total}${r.missed.length ? `, ${r.missed.length} missed` : ''}${b.queued.length ? `, ${b.queued.length} fix${b.queued.length > 1 ? 'es' : ''} queued` : ''}`;
  const carried = b.items.filter(i => i.carried).length;
  const todo = b.items.length ? `${b.items.length} to-do${b.items.length > 1 ? 's' : ''}${carried ? `, ${carried} carried over` : ''}${b.closed.length ? `, ${b.closed.length} closed` : ''}` : (b.closed.length ? `to-do list clear, ${b.closed.length} closed` : 'to-do list clear');
  return `${head} · ${todo}`;
}
