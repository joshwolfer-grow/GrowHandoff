// sources.js — the Sources tab (More > Admin > Sources). Built from WolfOffice/site: status.mjs, links.js, findings.js and the pathway. Loaded by index.html; no module imports so it runs in the single-file app.
(function(){
'use strict';
const SIX_H = 6 * 3600 * 1000;
const MIN_STALE = 10 * 60 * 1000;
const RANK = { finish: 3, blocked: 2, start: 1, heartbeat: 0 };

// A duty window: { days: [0-6, Sunday=0], start: 'HH:MM', end: 'HH:MM' } in local time.
function inWindow(win, now = Date.now()) {
  if (!win) return true;
  const d = new Date(now);
  if (win.days && !win.days.includes(d.getDay())) return false;
  const mins = d.getHours() * 60 + d.getMinutes();
  const [sh, sm] = (win.start || '00:00').split(':').map(Number), [eh, em] = (win.end || '23:59').split(':').map(Number);
  return mins >= sh * 60 + sm && mins <= eh * 60 + em;
}

function deriveStatus(agent, events, now = Date.now()) {
  const mine = events.filter(e => e.agent_id === agent.id)
    .sort((a, b) => (new Date(b.created_at) - new Date(a.created_at)) || RANK[b.kind] - RANK[a.kind]);
  const newest = mine[0];
  const history = mine.filter(e => e.kind === 'finish').slice(0, 7).map(e => !!e.ok).reverse();
  const bubble = (newest && newest.status) || '';
  const age = newest ? now - new Date(newest.created_at).getTime() : Infinity;
  const staleAfter = agent.cadence_seconds ? Math.max(agent.cadence_seconds * 2000, MIN_STALE) : null;

  let state = 'idle';
  // Paused from the card (lib/pause.mjs): grey, never stale, never auto-run by the Chief.
  if (agent.paused) state = 'paused';
  else if (newest && newest.kind === 'start' && age < SIX_H) state = 'working';
  else if (newest && newest.kind === 'blocked') state = 'blocked';
  else if (newest && newest.kind === 'finish' && newest.ok === false) state = 'failed';
  else if (staleAfter !== null && age > staleAfter) state = inWindow(agent.duty, now) ? 'stale' : 'offduty';

  return { state, bubble, history, lastAt: newest ? newest.created_at : null };
}

// site/links.js — deep links from a finding into the Grow dashboard.
// The dashboard accepts ?go=<area> (weeks, cancels, callbacks, upfront, alldeals,
// knockboard, ops, customreport, markets) and ?rep=<Name> for a rep's own view.
// Nothing here changes the dashboard; when an area cannot be pinned closer than
// its tab (there is no ?isp= filter yet), the link lands on the tab.
const GROW = location.origin + '/';
const go = (area, isp) => `${GROW}?go=${encodeURIComponent(area)}${isp ? `&isp=${encodeURIComponent(isp)}` : ''}`;
// ISP names exactly as they appear on deal rows, keyed by the desk code.
const ISP_NAME = { i3: 'i3 Broadband', slic: 'SLIC', lyte: 'Lyte Fiber', surf: 'Surf', tds: 'TDS', ezee: 'Ezee Fiber', omni: 'Omni Fiber' };
const rep = (name) => `${GROW}?rep=${encodeURIComponent(name)}`;

// A Custom Report opened with the exact setup for a finding.
const CR_COLS = ['sold', 'inst', 'canc', 'pend', 'cir', 'ir', 'book'];
function report(setup) {
  const st = { range: 'tw', f: {}, group: 'rep', cols: CR_COLS, sort: 'sold', ...setup };
  return `${GROW}?go=customreport&cr=${encodeURIComponent(JSON.stringify(st))}`;
}
const forIsp = (name, more = {}) => report({ ...more, f: { ...(name ? { isp: [name] } : {}), ...(more.f || {}) } });

// Area for a worker's card button: [label, url, buttonText?].
const AGENT_AREA = {
  // Personal floor. A path (not a full URL) is an office page and opens in the overlay, not the Grow dashboard.
  trainer: ['Training program', '/program.html', 'Open the program'],
  payaudit: ['Upfront pay', go('upfront')],
  chaser: ['Callbacks', go('callbacks')],
  installs: ['All deals', go('alldeals')],
  analyst: ['Rep cards', go('funnels')],
  crawler: ['Knock board', go('knockboard')],
  amplify: ['Knock board', go('knockboard')],
  rtr: ['Knock board', go('knockboard')],
  courier: ['Lead desk', '/leads.html', 'Open the lead desk'],
  exporter: ['Ops tasks', go('ops')],
  mapper: ['ISP Maps', go('ispmaps'), 'Open the maps'],
  'sales-lead': ['Last 4 weeks by ISP', report({ range: 'l4', group: 'isp', sort: 'sold' })],
};
function agentArea(id) {
  if (AGENT_AREA[id]) return AGENT_AREA[id];
  if (id.startsWith('isp-')) return ['Last 4 weeks for ' + (ISP_NAME[id.slice(4)] || 'this ISP'), forIsp(ISP_NAME[id.slice(4)], { range: 'l4', group: 'week', sort: 'sold' })];
  if (id.startsWith('slots-')) return ['Install slots', go('installslots')];
  if (id === 'chief-grow') return ['Grow dashboard', GROW];
  return null;
}

// Link for one finding key, e.g. "isp:slic:cancels-up", "chaser:Kyle Camp",
// "payaudit:owe:Ann:2026-09-03", "installs:cancel:D1", "analyst:Eve:leadTimeDays".
function linkFor(key) {
  if (!key) return null;
  const parts = String(key).split(':');
  const head = parts[0];
  if (head === 'payaudit') return go('upfront');
  if (head === 'chaser') return go('callbacks');
  if (head === 'slots') return go('installslots');
  if (head === 'installs') return parts[1] === 'cancel' ? go('cancels') : go('alldeals');
  if (head === 'analyst') return parts[1] ? rep(parts[1]) : go('funnels');
  if (head === 'isp') {
    const kind = parts[2] || '', name = ISP_NAME[parts[1]] || null, who = parts[3] || null;
    // Each flag opens the Custom Report already set up to show the thing it is about.
    if (kind === 'rep-cancels' && who) return forIsp(name, { range: 'l4', f: { rep: [who] }, group: 'week', sort: 'canc' });
    // Cancels land on deals sold weeks earlier, and the install report lags the sale by about a week, so these use the last 4 weeks rather than this week.
    if (/^(cancels-up|reason|clawbacks)$/.test(kind)) return forIsp(name, { range: 'l4', f: { status: ['Cancelled', 'Clawback'] }, group: 'rep', sort: 'canc' });
    if (kind === 'clean-week') return forIsp(name, { range: 'lw', group: 'rep', sort: 'sold' });
    if (/^(past-due|stale-pending)$/.test(kind)) return forIsp(name, { range: 'all', f: { status: ['Pending'] }, group: 'rep', cols: ['sold', 'pend', 'book'], sort: 'pend' });
    if (/^(install-rate|booking-lag|installs-slow)$/.test(kind)) return forIsp(name, { range: 'l4', group: 'week', cols: ['sold', 'inst', 'canc', 'pend', 'cir', 'ir', 'book', 'spd'], sort: 'sold' });
    if (kind === 'top-installer' && who) return forIsp(name, { range: 'lw', f: { rep: [who] }, group: 'week', sort: 'inst' });
    if (/^(sales-slow|sales-hot|record-week|reps-down)$/.test(kind)) return forIsp(name, { range: 'l4', group: 'week', cols: ['sold', 'inst', 'canc', 'pend', 'cir', 'ir', 'reps', 'pra'], sort: 'sold' });
    if (kind === 'doors-slow') return go('weeks', name);
    return null;   // lead-file and export-stale are fixed here, not in the dashboard
  }
  return null;
}
// A flag's own key may already start with the isp code ("slic:cancels-up").
function ispLink(ispKey, flagKey) { return linkFor(flagKey.startsWith('isp:') ? flagKey : `isp:${flagKey}`); }
const out = (url, label = 'open ↗') => url ? ` <a class="deep" href="${url}" target="_blank" rel="noopener" title="Open this in the Grow dashboard">${label}</a>` : '';

// site/findings.js — renders a worker's latest snapshot as a complete, readable list.

// Every item the worker found is shown; the speech bubble only had room for a summary.
const escF = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n1 = (v, d = 1) => (typeof v === 'number' && isFinite(v) ? v.toFixed(d) : '–');
const pct = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 100) + '%' : '–');
const money = (v) => (typeof v === 'number' && isFinite(v) ? (v < 0 ? '-' : '') + '$' + Math.abs(Math.round(v)).toLocaleString() : '–');
const table = (head, rows) => rows.length ? `<table class="ft"><thead><tr>${head.map(h => `<th>${escF(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '<p class="muted">Nothing to list.</p>';
const METRIC = { leadTimeDays: ['Booking lead time', v => n1(v) + 'd'], soldPerDay: ['Sold per day', v => n1(v, 2)], installRate: ['Install rate', pct], doorsPerDay: ['Doors per day', v => n1(v, 0)] };

const R = {
  analyst(d) {
    const flags = d.flags || [];
    const teamFlags = d.teamFlags || [];
    const teams = d.teams || [];
    const perRep = d.perRep || {};
    const flagged = new Set(flags.map(f => f.rep));
    const flaggedTeams = new Set(teamFlags.map(f => f.team));

    const flagRows = flags.map(f => {
      const [name, fmt] = METRIC[f.metric] || [f.metric, n1];
      const band = f.scope === 'team' ? 'vs team' : 'vs company';
      return [escF(f.rep), escF(f.team || ''), escF(name), `<strong>${fmt(f.value)}</strong>`, `${fmt(f.teamMedian)} <span class="muted">(${fmt(f.teamP10)}–${fmt(f.teamP90)}, ${band})</span>`, f.direction === 'high' ? '▲ high' : '▼ low'];
    });

    const teamRows = teams
      .slice()
      .sort((a, b) => (b.deals || 0) - (a.deals || 0))
      .map(t => [escF(t.team), t.reps, t.deals, n1(t.leadTimeDays) + 'd', n1(t.soldPerDay, 2), pct(t.installRate), n1(t.doorsPerDay, 0), flaggedTeams.has(t.team) ? '⚑' : '']);

    const byTeam = {};
    for (const r of Object.values(perRep)) {
      const team = r.team || 'Unassigned';
      (byTeam[team] ||= []).push(r);
    }
    const teamNames = Object.keys(byTeam).sort((a, b) => (byTeam[b].length || 0) - (byTeam[a].length || 0));
    const repSections = teamNames.map(team => {
      const rows = byTeam[team]
        .slice()
        .sort((a, b) => (b.deals || 0) - (a.deals || 0))
        .map(r => [flagged.has(r.rep) ? `<strong>${escF(r.rep)}</strong> ⚑` : escF(r.rep), r.deals, n1(r.leadTimeDays) + 'd', n1(r.soldPerDay, 2), pct(r.installRate), n1(r.doorsPerDay, 0)]);
      return `<h5>${escF(team)}</h5>${table(['Rep', 'Deals', 'Lead time', 'Sold/day', 'Install rate', 'Doors/day'], rows)}`;
    }).join('');

    return `<h4>${flags.length} flag${flags.length === 1 ? '' : 's'} this fortnight</h4>${table(['Rep', 'Team', 'Metric', 'Theirs', 'Compare (band)', ''], flagRows)}
      <h4>Teams</h4>${table(['Team', 'Reps', 'Deals', 'Lead time', 'Sold/day', 'Install rate', 'Doors/day', ''], teamRows)}
      <h4>Every rep, last 14 days, by team</h4><p class="muted">Reps with fewer than 5 deals are listed but not compared.</p>${repSections}`;
  },
  installs(d) {
    const x = d.diff || {};
    if (d.first || !d.diff) return `<p>First snapshot taken. Changes will be listed from the next run.</p>${table(['Rep', 'Deal', 'Days out'], (x.farOut || []).map(p => [escF(p.rep), escF(p.id), p.days]))}`;
    const sec = (title, rows, head) => `<h4>${title} (${rows.length})</h4>${table(head, rows)}`;
    return sec('Pushed out', (x.pushed || []).sort((a, b) => b.days - a.days).map(p => [escF(p.rep), escF(p.id), '+' + p.days + 'd']), ['Rep', 'Deal', 'Moved'])
      + sec('Cancelled', (x.cancelled || []).map(p => [escF(p.rep), escF(p.id)]), ['Rep', 'Deal'])
      + sec('Booked 10+ days out', (x.farOut || []).sort((a, b) => b.days - a.days).map(p => [escF(p.rep), escF(p.id), p.days + 'd']), ['Rep', 'Deal', 'Days out'])
      + sec('Pulled in', (x.pulledIn || []).map(p => [escF(p.rep), escF(p.id), '-' + p.days + 'd']), ['Rep', 'Deal', 'Moved'])
      + sec('Newly booked', (x.newlyBooked || []).map(p => [escF(p.rep), escF(p.id)]), ['Rep', 'Deal']);
  },
  slots(d) {
    const ms = d.markets || [], fl = d.flags || [];
    const when = (s) => { if (!s) return '–'; const [y, m, dd] = s.split('-'); return new Date(Date.UTC(+y, m - 1, +dd)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }); };
    const rows = ms.map(m => m.ok
      ? [escF(m.market), `<strong>${when(m.earliest_date)}</strong>`, m.days_out == null ? '–' : m.days_out + 'd', m.windows_first_day ?? '–', m.windows_next_7d ?? '–', '']
      : [escF(m.market), '–', '–', '–', '–', `<span class="warn">${escF(m.error)}</span>`]);
    const at = d.ranAt ? new Date(d.ranAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
    return `<h4>Earliest install by market${at ? ` <span class="muted">(read ${escF(at)})</span>` : ''}</h4>${table(['Market', 'Earliest', 'Days out', 'Windows that day', 'Windows next 7 days', ''], rows)}`
      + (fl.length ? `<h4>Flags (${fl.length})</h4><ul>${fl.map(f => `<li>${escF(f.text)}${out(linkFor(f.key))}</li>`).join('')}</ul>` : '')
      + `<p class="muted">Read from ${escF(d.name ? d.name.replace(/ install times$/, '') : 'the ISP')}'s own signup flow at one real door per market; nothing is ever submitted.</p>`;
  },
  chaser(d) {
    const byRep = d.byRep || {};
    const reps = Object.keys(byRep).sort((a, b) => byRep[b].length - byRep[a].length);
    return reps.map(rep => `<h4>${escF(rep)} · ${byRep[rep].length}${out(linkFor('chaser:' + rep))}</h4>${table(['Callback', 'ISP', 'Cancelled', 'Stage', 'Untouched'], byRep[rep].sort((a, b) => b.ageDays - a.ageDays).map(l => [escF(l.order || l.id), escF(l.isp), escF(l.cancelled), escF(l.stage || 'no pipeline row'), Math.round(l.ageDays) + 'd']))}`).join('') || '<p>All callbacks are being worked.</p>';
  },
  payaudit(d) {
    const c = d.current || { rows: [] }, adj = d.adjustments || { owe: [], recover: [] }, diff = d.diff, drift = d.drift || [];
    const tierTxt = (st) => st === 'green' ? 'On' : st === 'yellow' ? 'Grace' : st === 'red' ? 'Off' : escF(st || '');
    let h = `<h4>Pay week ${escF(c.start || '')} to ${escF(c.end || '')} · ${money(c.total)} net (${money(c.pay)} pay, ${money(c.claw)} clawback)</h4>`;
    h += table(['Rep', 'Tier', 'Deals', 'Pay', 'Claw', 'Net', 'Rate'], (c.rows || []).slice().sort((a, b) => b.net - a.net).map(r => [escF(r.rep), tierTxt(r.st) + (r.cbNew ? ` <span class="warn">chargeback ${money(r.cb)}</span>` : ''), r.payCount, money(r.pay), r.claw ? money(-r.claw) : '', `<strong>${money(r.net)}</strong>`, r.rate == null ? '–' : r.rate + '%']));
    const adjRows = [...adj.owe.map(a => [escF(a.rep), escF(a.week), 'Owe rep', `<strong>${money(a.amount)}</strong>`]), ...adj.recover.map(a => [escF(a.rep), escF(a.week), 'Recover', `<strong>${money(-a.amount)}</strong>`])];
    h += `<h4>Adjustments (${adjRows.length})${adjRows.length ? ` · net ${money(adj.net)}` : ''}${out(linkFor('payaudit'), 'open Upfront pay ↗')}</h4>` + (adjRows.length ? table(['Rep', 'Pay week', 'Direction', 'Amount'], adjRows) : '<p>Every closed week matches what was paid.</p>');
    if (diff) {
      const rows = [...diff.changed.map(x => [escF(x.rep), 'Net changed', `${money(x.from)} → ${money(x.to)}`]), ...diff.tier.map(x => [escF(x.rep), 'Tier', `${tierTxt(x.from)} → ${tierTxt(x.to)}`]), ...diff.added.map(x => [escF(x.rep), 'New on run', money(x.net)]), ...diff.dropped.map(x => [escF(x.rep), 'Dropped off run', money(x.net)])];
      h += `<h4>Since last audit (${escF(diff.prevDay || '')})</h4>` + (rows.length ? table(['Rep', 'Change', 'Detail'], rows) : '<p>No changes.</p>');
    } else h += '<p class="muted">First audit. Week-over-week changes start next Thursday.</p>';
    if (drift.length) h += '<h4>Closed weeks</h4>' + table(['Pay week', 'Owed now', 'Paid at close', 'Mismatches', ''], drift.map(w => [escF(w.start), money(w.owed), money(w.paid), w.rows.length, w.settledByAudit ? '<span class="muted">settled in Sep audit</span>' : '']));
    if (d.rosterSynced === false) h += '<p class="warn">The upfront roster sheet did not load; this run used the built-in fallback list.</p>';
    return h;
  },
  chief(d) {
    const roll = d.roll || { rows: [], missed: [] }, items = d.items || [], closed = d.closed || [], queued = d.queued || [];
    const sev = (s) => s >= 3 ? '<span class="warn">high</span>' : s === 2 ? 'medium' : '<span class="muted">low</span>';
    let h = `<h4>To-do (${items.length})</h4>` + (items.length ? table(['', 'Item', 'Owner', 'Open'], items.map(i => [sev(i.severity), escF(i.title) + out(linkFor(i.key)), `<a href="#" data-open="${escF(i.owner)}">${escF(i.owner)}</a>`, i.carried ? `${i.daysOpen}d` : '<span class="muted">new</span>'])) : '<p>Nothing on the list.</p>');
    if (d.minor) h += `<p class="muted">Plus ${d.minor} minor flag${d.minor === 1 ? '' : 's'} not listed (${Object.entries(d.minorByOwner || {}).map(([k, v]) => `${escF(k)} ${v}`).join(', ')}).</p>`;
    if (d.wins && d.wins.length) h += `<h4>Wins to share (${d.wins.length})</h4>` + table(['Highlight'], d.wins.map(w => [escF(w.text)]));
    if (closed.length) h += `<h4>Closed since last brief (${closed.length})</h4>` + table(['Item', 'Owner', 'Was open'], closed.map(c => [escF(c.title), escF(c.owner), `${c.daysOpen}d`]));
    h += `<h4>Roll call · ${roll.present}/${roll.total} present</h4>`;
    const byTeam = {}; for (const r of roll.rows || []) (byTeam[r.team || 'Staff'] ||= []).push(r);
    for (const [team, rows] of Object.entries(byTeam)) {
      const bad = rows.filter(r => ['failed', 'blocked', 'stale'].includes(r.state)).length;
      h += `<p><strong>${escF(team)}</strong> <span class="muted">· ${rows.length} · ${bad ? `<span class="warn">${bad} need attention</span>` : 'all present'}</span></p>` + table(['Worker', 'State', 'Last word'], rows.sort((a, b) => (b.lead === true) - (a.lead === true)).map(r => [`<a href="#" data-open="${escF(r.id)}">${escF(r.name)}</a>${r.lead ? ' <span class="muted">lead</span>' : ''}`, `<span class="st-${escF(r.state)}">${escF(r.state)}</span>${r.hint ? `<br><span class="muted">${escF(r.hint)}</span>` : ''}`, escF(r.bubble || '')]));
    }
    if (queued.length) h += `<h4>Handed to the Runner</h4>` + table(['Task', 'For', 'State', 'Why'], queued.map(q => [escF(q.kind), escF(q.agent), escF(q.state), escF(q.note || '')]));
    return h;
  },
  isp(d) {
    const s = d || {}; const flags = s.flags || [], wins = s.wins || [], weeks = s.weeks || [];
    const sev = (x) => x >= 3 ? '<span class="warn">high</span>' : 'medium';
    const trend = s.soldAvg ? `${s.soldPace >= s.soldAvg ? '▲' : '▼'} pace ${s.soldPace}/wk vs ${s.soldAvg} avg` : '';
    let h = `<h4>This week (${escF(s.week || '')}, day ${s.daysIn || '?'})${s.soldFrom ? ` · sales from ${escF(s.soldFrom)}` : ''}</h4>` + table(['Sold', 'Installed', 'Cancelled', 'Doors', 'Sold/100 doors', 'Reps'], [[`<strong>${s.sold ?? 0}</strong> <span class="muted">${escF(trend)}</span>`, s.installed ?? 0, (s.cancelled ?? 0) + (s.clawback ? ` <span class="warn">+${s.clawback} clawback</span>` : ''), s.doors ?? 0, s.soldPer100 ?? '–', s.reps ?? 0]]);
    h += table(['Install rate (8 wk)', 'Booking lag', 'Pending', 'Past due'], [[`${s.installRate ?? '–'}%${s.installRatePrev != null ? ` <span class="muted">was ${s.installRatePrev}%</span>` : ''}`, `${s.lag ?? '–'}d${s.lagPrev != null ? ` <span class="muted">was ${s.lagPrev}d</span>` : ''}`, s.pending ?? 0, s.pastDue ? `<span class="warn">${s.pastDue}</span>` : 0]]);
    h += `<h4>Flags (${flags.length})</h4>` + (flags.length ? table(['', 'What'], flags.map(x => [sev(x.severity), escF(x.text) + out(ispLink(s.isp, x.key))])) : '<p>Nothing out of the ordinary.</p>');
    h += `<h4>Wins (${wins.length})</h4>` + (wins.length ? table(['Share this'], wins.map(x => [escF(x.text) + out(ispLink(s.isp, x.key))])) : '<p class="muted">Nothing to shout about yet this week.</p>');
    if (s.recon) {
      const r = s.recon;
      h += `<h4>Bria vs the install report (since ${escF(r.from)})</h4><p>${r.matched} of ${r.bria} Bria sales are on the report. The report covers sales through ${escF(r.through || '–')}${r.awaiting ? `; ${r.awaiting} newer sale${r.awaiting === 1 ? ' is' : 's are'} still waiting on it` : ''}${r.cantMatch ? `; ${r.cantMatch} can't be matched (no full name in Bria)` : ''}.</p>`;
      h += `<h4>In Bria, not on the report (${r.notOnReportN ?? r.notOnReport.length})</h4>` + (r.notOnReport.length ? table(['Customer', 'Rep', 'Sold'], r.notOnReport.map(x => [escF(x.customer), escF(x.rep), escF(x.sale_date)])) : '<p>None. Every Bria sale made it onto the report.</p>');
      h += `<h4>On the report, not in Bria (${r.reportOnlyN ?? r.reportOnly.length})</h4>` + (r.reportOnly.length ? table(['Customer', 'Rep', 'Sold', 'Status'], r.reportOnly.map(x => [escF(x.customer), escF(x.rep), escF(x.sale_date), escF(x.status)])) : '<p>None.</p>');
    }
    if (s.reasons && s.reasons.length) h += `<h4>Cancel reasons this week</h4>` + table(['Reason', 'Count'], s.reasons.map(r => [escF(r[0]), r[1]]));
    h += `<h4>Last 12 weeks</h4>` + table(['Week', 'Sold', 'Installed', 'Cancelled', 'Doors', 'Reps'], weeks.map(w => [escF(w.week), w.sold, w.installed, w.cancelled + (w.clawback ? `+${w.clawback}` : ''), w.doors, w.reps]));
    return h;
  },
  'sales-lead'(d) {
    const r = d || {}; const isps = r.isps || [], flags = r.flags || [], wins = r.wins || [];
    let h = `<h4>Company this week (${escF(r.week || '')})</h4>` + table(['Sold', 'Installed', 'Cancelled', 'Doors', 'Pending', 'Past due'], [[`<strong>${r.sold ?? 0}</strong>`, r.installed ?? 0, r.cancelled ?? 0, r.doors ?? 0, r.pending ?? 0, r.pastDue ? `<span class="warn">${r.pastDue}</span>` : 0]]);
    h += `<h4>By ISP</h4>` + table(['ISP', 'Sold (Bria)', 'Pace vs avg', 'Installed', 'Cancelled', 'Install rate', 'Lag', 'Bria not on report', 'Report not in Bria', 'Doors', 'Reps', 'Flags'], isps.map(i => [`<a href="#" data-open="isp-${escF(i.isp)}">${escF(i.name)}</a>`, `<strong>${i.sold}</strong>`, i.soldAvg ? `${i.soldPace} / ${i.soldAvg}` : '–', i.installed, i.cancelled, i.installRate == null ? '–' : i.installRate + '%', i.lag == null ? '–' : i.lag + 'd', i.notOnReport ?? '–', i.reportOnly ?? '–', i.doors, i.reps, i.flags ? `<span class="warn">${i.flags}</span>` : '']));
    h += `<h4>Wins to share (${wins.length})</h4>` + (wins.length ? table(['ISP', 'Highlight'], wins.map(w => [escF(w.isp), escF(w.text) + out(linkFor('isp:' + w.key))])) : '<p class="muted">No highlights yet this week.</p>');
    h += `<h4>Flags across ISPs (${flags.length})</h4>` + (flags.length ? table(['ISP', '', 'What'], flags.map(x => [escF(x.isp), x.severity >= 3 ? '<span class="warn">high</span>' : 'medium', escF(x.text) + out(linkFor('isp:' + x.key))])) : '<p>Nothing out of the ordinary anywhere.</p>');
    return h;
  },
  subs(list) {
    const rows = (Array.isArray(list) ? list : []).map(s => [escF(s.displayName || s.merchant || s.name), escF(s.cadence), money(s.latest ?? s.latestAmount), money(s.monthlyEquivalent), s.priceIncrease ? `▲ from ${money(s.previous ?? s.previousAmount)}` : '', s.possiblyLapsed ? 'maybe lapsed' : escF(s.expectedNext || '')]);
    return table(['Merchant', 'Cadence', 'Last charge', 'Per month', 'Change', 'Next expected'], rows);
  },
  evaltrack(d) {
    const acc = d.accounts || d.rows || [];
    const rules = (a) => a.hasRules === false ? '<span class="warn">set in hub</span>' : null;
    return table(['Account', 'Firm', 'Trades', 'Net since start', 'Worst drop', 'Progress', 'Drawdown used', 'Days left'], acc.map(a => [escF(a.account_id || a.id), escF(a.firm), a.trades ?? '–', money(a.net), money(a.maxDd), rules(a) || pct(a.progress), rules(a) || pct(a.ddUsed), a.daysLeft ?? '–'])) + (d.warnings && d.warnings.length ? `<p class="warn">Warnings: ${escF(d.warnings.join(', '))}</p>` : '');
  },
  journal(d) {
    if (!d || !d.n) return '<p>No trades that day.</p>';
    return table(['Stat', 'Value'], [['Trades today', d.copiedTo > 1 ? `${d.n} (copied to ${d.copiedTo} accounts, ${d.fills} rows)` : d.accounts > 1 ? `${d.n} (${d.accounts} accounts)` : d.n], ['Wins / losses', `${d.wins} / ${d.losses}`], ['Win rate', pct((d.winRate || 0) / 100)], ['Net', money(d.netTotal)], ['Average', money(d.avgNet)], ['Best hour', escF(d.bestHour)], ['Worst hour', escF(d.worstHour)], ['Biggest win', money(d.biggestWin?.net ?? d.biggestWin)], ['Biggest loss', money(d.biggestLoss?.net ?? d.biggestLoss)], ['Longest loss streak', d.lossStreak ?? d.longestLossStreak ?? '–']]);
  },
  trainer(d) {
    return table(['Item', 'Value'], [['Workouts this week', `${d.done ?? d.thisWeek ?? '–'} of ${d.planned ?? '–'}`], ['Missed so far', d.missed ?? d.missedSoFar ?? 0], ['PRs this week', d.prsThisWeek ?? d.prs ?? 0], ['Stalled lifts', escF((d.stalled || []).join(', ') || 'none')]]);
  },
  debt(d) {
    return table(['Debt', 'Balance', 'APR', 'Minimum'], (d.debts || []).map(x => [escF(x.name), money(x.balance ?? x.current_balance), pct(x.apr > 1 ? x.apr / 100 : x.apr), money(x.minimum ?? x.minimum_payment)])) + (d.plan ? `<p>Payoff estimate: <strong>${escF(d.plan.label || d.plan.payoffLabel || '')}</strong> · interest ${money(d.plan.totalInterest)} · paid this month ${money(d.paid30)}</p>` : '');
  },
};

function renderFindings(agentId, snap) {
  if (!snap) return '<p class="muted">No findings saved yet. Run it once.</p>';
  const key = agentId.startsWith('chief-') ? 'chief' : agentId.startsWith('isp-') ? 'isp' : agentId.startsWith('slots-') ? 'slots' : agentId;
  const body = R[key] ? R[key](snap.data) : `<pre class="raw">${escF(JSON.stringify(snap.data, null, 1)).slice(0, 4000)}</pre>`;
  return `<div class="findings"><div class="muted">Findings from ${escF(snap.day)}</div>${body}</div>`;
}


function cadenceText(sec) { if (!sec) return 'only when asked'; if (sec < 3600) return `every ${Math.round(sec / 60)} minutes`; if (sec < 86400) return `every ${Math.round(sec / 3600)} hour${sec >= 7200 ? 's' : ''}`; return `every ${Math.round(sec / 86400)} day${sec >= 172800 ? 's' : ''}`; }
function ageText(iso) { if (!iso) return 'no reports yet'; const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000); if (m < 1) return 'just now'; if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`; const h = Math.floor(m / 60); if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`; return `${Math.round(h / 24)} days ago`; }
const SRC_FACTS = {
 "runner-grow": {
  "about": "The floor's front desk. Any task queued for this floor lands here: a fix the Chief queues for a stale worker, or a job another worker asks for. He walks to that desk and runs it from a fixed menu, then writes down how it went. Anything that writes to live data waits on this card for your Approve.",
  "label": "com.wolfoffice.runner-grow",
  "run": true,
  "log": true,
  "failHints": null,
  "fixes": [],
  "blocked": null
 },
 "chief-grow": {
  "about": "Once a day after this floor's workers have reported, takes roll call: anyone stale gets a Run queued with the Runner, a known failure gets its fix queued for your approval. Then reads every worker's latest findings and writes one ranked to-do for the floor, with who owns each item and how many days it has been open. Items that were on yesterday's list and are gone today are listed as closed. No model involved.",
  "label": "com.wolfoffice.chief-grow",
  "run": true,
  "log": true,
  "failHints": null,
  "fixes": [],
  "blocked": null
 },
 "crawler": {
  "about": "Pulls every knock, lead and sale out of SalesRabbit every five minutes and pushes the day's numbers to the Grow dashboard. This is where the live knock counts come from.",
  "label": "com.grow.sr-sync",
  "run": true,
  "log": true,
  "failHints": {
   "3": "The SalesRabbit sign-in token has expired. Press Fix it now: a SalesRabbit window opens, sign in, and the crawl runs right after.",
   "137": "The crawl ran past its 4 minute cap and was killed. Compacting the crawl store usually fixes it: run the compact command below."
  },
  "fixes": [
   "3",
   "137"
  ],
  "blocked": null
 },
 "amplify": {
  "about": "Signs into the TDS Amplify portal every five minutes, downloads the knocking reports, and folds them into the knocking data so TDS doors count like everyone else's.",
  "label": "com.grow.amplify-sync",
  "run": true,
  "log": true,
  "failHints": null,
  "fixes": [],
  "blocked": null
 },
 "rtr": {
  "about": "Every half hour, syncs the RTR feed and refreshes the numbers that depend on it.",
  "label": "com.grow.rtr-sync",
  "run": true,
  "log": true,
  "failHints": null,
  "fixes": [],
  "blocked": null
 },
 "exporter": {
  "about": "Once a day, rebuilds every ISP's knocking workbook on the shared Drive: a summary by city, a tab per week, and every door worked. The ISPs' links never change. Run now forces a fresh build.",
  "label": "com.grow.isp-export",
  "run": true,
  "log": true,
  "failHints": null,
  "fixes": [],
  "blocked": null
 },
 "mapper": {
  "about": "Redraws the ISP sector maps on the Grow site (Ops > ISP Maps) once a day, right after the Exporter builds the workbooks around 7am: fresh doors, knocks, new lead drops and any new towns cut into areas. Run now redraws every map straight away, so a lead drop from today shows up without waiting for tomorrow. Takes about 10 to 20 minutes.",
  "label": null,
  "run": true,
  "log": true,
  "failHints": null,
  "fixes": [],
  "blocked": null
 },
 "courier": {
  "about": "Watches the ISP lead-file inbox every five minutes. When a file lands it works out which ISP sent it, archives the original to Drive, and parks it until you tell Claude which rep gets it. Then it builds the SalesRabbit import and the dupes report.",
  "label": "com.grow.isp-intake",
  "run": true,
  "log": true,
  "failHints": null,
  "fixes": [],
  "blocked": "A lead file is parked and needs a rep. Open the lead desk on this card, check the columns, pick the rep and build the import. No Claude Code session needed."
 },
 "analyst": {
  "about": "Every morning, compares each rep against the rest of the team over the last two weeks: booking lead time, sold per day, install rate, doors per day. Anyone outside the team's middle 80 percent gets flagged, so a rep booking 18 days out shows up the next morning instead of weeks later.",
  "label": "com.wolfoffice.analyst",
  "run": true,
  "log": true,
  "failHints": null,
  "fixes": [],
  "blocked": null
 },
 "installs": {
  "about": "Every morning, takes a snapshot of every install date from the install reports and compares it with yesterday's. Catches bookings pushed out, cancelled installs, and anything booked more than ten days out.",
  "label": "com.wolfoffice.installs",
  "run": true,
  "log": true,
  "failHints": null,
  "fixes": [],
  "blocked": null
 },
 "chaser": {
  "about": "Every morning, looks at cancelled-order callbacks from the ISPs and finds the ones nobody has touched in three days, grouped by rep.",
  "label": "com.wolfoffice.chaser",
  "run": true,
  "log": true,
  "failHints": null,
  "fixes": [],
  "blocked": null
 },
 "sales-lead": {
  "about": "Every morning after the ISP desks report, rolls every ISP up into one company view: who sold the most, installs and cancels across the board, every flag ranked, and the wins worth sharing with the team.",
  "label": "com.wolfoffice.sales-lead",
  "run": true,
  "log": true,
  "failHints": null,
  "fixes": [],
  "blocked": null
 },
 "isp-i3": {
  "about": "Every morning, does the revenue read for i3 Broadband: sales this week from Bria against the 4-week pace, Bria checked deal by deal against the install report, installs, cancels and why, install rate over 8 weeks, booking lag, past-due installs, doors knocked, and whether the lead file was processed and the export is fresh. Flags anything out of the ordinary and calls out the wins.",
  "label": "com.wolfoffice.isp-i3",
  "run": true,
  "log": true,
  "failHints": null,
  "fixes": [],
  "blocked": null
 },
 "isp-slic": {
  "about": "Every morning, does the revenue read for SLIC: sales this week from Bria against the 4-week pace, Bria checked deal by deal against the install report, installs, cancels and why, install rate over 8 weeks, booking lag, past-due installs, doors knocked, and whether the lead file was processed and the export is fresh. Flags anything out of the ordinary and calls out the wins.",
  "label": "com.wolfoffice.isp-slic",
  "run": true,
  "log": true,
  "failHints": null,
  "fixes": [],
  "blocked": null
 },
 "isp-lyte": {
  "about": "Every morning, does the revenue read for Lyte Fiber: sales this week from Bria against the 4-week pace, Bria checked deal by deal against the install report, installs, cancels and why, install rate over 8 weeks, booking lag, past-due installs, doors knocked, and whether the lead file was processed and the export is fresh. Flags anything out of the ordinary and calls out the wins.",
  "label": "com.wolfoffice.isp-lyte",
  "run": true,
  "log": true,
  "failHints": null,
  "fixes": [],
  "blocked": null
 },
 "isp-surf": {
  "about": "Every morning, does the revenue read for Surf: sales this week from Bria against the 4-week pace, Bria checked deal by deal against the install report, installs, cancels and why, install rate over 8 weeks, booking lag, past-due installs, doors knocked, and whether the lead file was processed and the export is fresh. Flags anything out of the ordinary and calls out the wins.",
  "label": "com.wolfoffice.isp-surf",
  "run": true,
  "log": true,
  "failHints": null,
  "fixes": [],
  "blocked": null
 },
 "isp-tds": {
  "about": "Every morning, does the revenue read for TDS: sales this week from Bria against the 4-week pace, Bria checked deal by deal against the install report, installs, cancels and why, install rate over 8 weeks, booking lag, past-due installs, doors knocked, and whether the lead file was processed and the export is fresh. Flags anything out of the ordinary and calls out the wins.",
  "label": "com.wolfoffice.isp-tds",
  "run": true,
  "log": true,
  "failHints": null,
  "fixes": [],
  "blocked": null
 },
 "isp-ezee": {
  "about": "Every morning, does the revenue read for Ezee Fiber: sales this week from Bria against the 4-week pace, Bria checked deal by deal against the install report, installs, cancels and why, install rate over 8 weeks, booking lag, past-due installs, doors knocked, and whether the lead file was processed and the export is fresh. Flags anything out of the ordinary and calls out the wins.",
  "label": "com.wolfoffice.isp-ezee",
  "run": true,
  "log": true,
  "failHints": null,
  "fixes": [],
  "blocked": null
 },
 "isp-omni": {
  "about": "Every morning, does the revenue read for Omni Fiber: sales this week from Bria against the 4-week pace, Bria checked deal by deal against the install report, installs, cancels and why, install rate over 8 weeks, booking lag, past-due installs, doors knocked, and whether the lead file was processed and the export is fresh. Flags anything out of the ordinary and calls out the wins.",
  "label": "com.wolfoffice.isp-omni",
  "run": true,
  "log": true,
  "failHints": null,
  "fixes": [],
  "blocked": null
 },
 "slots-tds": {
  "about": "Three times a day, walks TDS's own signup flow for a real door in each market it sells in, up to the install calendar, and reads the earliest install date and how many windows are open that day and over the next week. It never submits an order or books a slot. Flags a market whose earliest install is a week or more out, one with no dates, and any door it could not read. The doors live in GrowSales data/install-slot-probes.json.",
  "label": "com.wolfoffice.slots-tds",
  "run": true,
  "log": true,
  "failHints": {
   "1": "TDS's portal throws a bare 500 now and then. Each door already gets three tries, so a failure usually clears on the next run. If it keeps failing, watch it: cd ~/Grow/GrowSales && node scripts/install-slots.mjs --isp tds --headed --dry",
   "3": "TDS's portal throws a bare 500 now and then. Each door already gets three tries, so a failure usually clears on the next run. If it keeps failing, watch it: cd ~/Grow/GrowSales && node scripts/install-slots.mjs --isp tds --headed --dry"
  },
  "fixes": [],
  "blocked": null
 },
 "slots-surf": {
  "about": "Three times a day, walks Surf's own signup flow for a real door in each market it sells in, up to the install calendar, and reads the earliest install date and how many windows are open that day and over the next week. It never submits an order or books a slot. Flags a market whose earliest install is a week or more out, one with no dates, and any door it could not read. The doors live in GrowSales data/install-slot-probes.json.",
  "label": "com.wolfoffice.slots-surf",
  "run": true,
  "log": true,
  "failHints": {
   "1": "Surf needs the rep User ID and PIN in GrowSales .env.install-slots on every visit. If they were rejected or the portal changed, watch it: cd ~/Grow/GrowSales && node scripts/install-slots.mjs --isp surf --headed --dry",
   "3": "Surf needs the rep User ID and PIN in GrowSales .env.install-slots on every visit. If they were rejected or the portal changed, watch it: cd ~/Grow/GrowSales && node scripts/install-slots.mjs --isp surf --headed --dry"
  },
  "fixes": [],
  "blocked": null
 }
};

// ---------- Sources tab: the data pathway, drawn inside GrowSales ----------
// Everything is read straight from Supabase with the app's anon key: office_agents /
// office_events / office_snapshots / office_tasks (the Mac workers write them through
// office-log), report_config markers, the sync meta rows and data_versions.
// Run now / Fix / Show log queue a row in office_tasks; the Task queue worker on the
// Mac picks it up within a minute and writes the result back on the same row.
const SRC_POLL_MS = 30000;
const srcEsc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SRC_STATE_WORD = { working: 'running', idle: 'fine', failed: 'failed', blocked: 'needs you', stale: 'quiet', offduty: 'off hours', paused: 'paused', manual: 'by hand', fresh: 'fresh', old: 'stale', none: '' };
const SRC_COLOR = { working: 'var(--green)', idle: 'var(--green)', fresh: 'var(--green)', failed: 'var(--red)', blocked: 'var(--amber)', stale: 'var(--amber)', old: 'var(--amber)', offduty: '#8b8f88', paused: '#8b8f88', manual: '#8b8f88', none: '#b9bcb6' };
const SRC_RANK = { failed: 4, blocked: 3, stale: 2, old: 2, working: 1, idle: 0, fresh: 0, offduty: 0, paused: 0, manual: 0, none: 0 };
const srcHot = (s) => s === 'failed' || s === 'blocked';
const srcWarm = (s) => s === 'stale' || s === 'old';
const SRC_COLS = ['Sources', 'Syncs', 'Data', 'Reads', 'Out'];
const SRC_GROW = location.origin + '/';
const SRC_NODES = [
  { id: 'src-sr', col: 0, kind: 'source', title: 'SalesRabbit', sub: 'knocks, leads, pins', about: 'Every door a Grow rep knocks is a pin in SalesRabbit. The crawl reads the activity feed every ten minutes during knocking hours.' },
  { id: 'src-amplify', col: 0, kind: 'source', title: 'TDS Amplify portal', sub: 'TDS knocking reports', about: 'TDS runs its own door tool (Amplify). Its knocking reports are downloaded by a headless sign-in.' },
  { id: 'src-portals', col: 0, kind: 'source', title: 'Ezee, Bluepeak, Omni portals', sub: 'RTR / Opendoor exports', about: 'Three ISPs expose knocking through their own reporting portals. One runner pulls each export on its own cadence.' },
  { id: 'src-files', col: 0, kind: 'source', title: 'ISP lead files', sub: 'email + inbox folder', about: 'ISPs send address lists by email or file. The intake watcher archives each one to Drive and parks it until a rep is chosen.' },
  { id: 'src-bria', col: 0, kind: 'source', title: 'Bria', sub: 'sold deals, reps, teams', about: 'Bria is the sales system of record: every sold deal, who sold it, and the team roster.' },
  { id: 'src-sequifi', col: 0, kind: 'source', title: 'Sequifi', sub: 'deals feed, install status, roster', about: 'Sequifi holds the installed and cancelled status of every deal and the weekly roster.' },
  { id: 'src-sheet', col: 0, kind: 'source', title: 'Upfront opt-in sheet', sub: 'Google Sheet', about: 'The list of reps on upfront pay, kept in a Google Sheet and pulled by the Sync now button in Payroll.' },
  { id: 'src-signup', col: 0, kind: 'source', title: 'ISP signup flows', sub: 'TDS, Surf install calendars', about: 'Each ISP\'s own order page shows the earliest install date. The slot walkers read it for a real door in every market, never submitting an order.' },
  { id: 'crawler', col: 1, kind: 'job', agent: 'crawler', pauseKey: 'sr' },
  { id: 'amplify', col: 1, kind: 'job', agent: 'amplify', pauseKey: 'tds' },
  { id: 'rtr', col: 1, kind: 'job', agent: 'rtr', pauseKey: 'rtr' },
  { id: 'courier', col: 1, kind: 'job', agent: 'courier' },
  { id: 'vc-bria', col: 1, kind: 'cron', grow: 'bria', title: 'Bria sync', sub: 'Vercel, daily 3:00am MT', about: 'api/bria-sync.js on Vercel copies Bria\'s sales, reps and teams into bria_deals, bria_sales_daily and bria_teams once a day.', cadence: 86400 },
  { id: 'vc-sequifi', col: 1, kind: 'cron', grow: 'sequifi', title: 'Sequifi sync', sub: 'Vercel, daily 2:30am MT', about: 'api/sequifi-sync.js on Vercel refreshes the deals feed (install and cancel status) and rep onboarding.', cadence: 86400 },
  { id: 'vc-teams', col: 1, kind: 'cron', grow: 'teams', title: 'Sequifi teams sync', sub: 'Vercel, daily 2:45am MT', about: 'api/sequifi-teams-sync.js on Vercel keeps the week-by-week roster that places reps on teams.', cadence: 86400 },
  { id: 'sheet', col: 1, kind: 'cron', grow: 'optin', title: 'Opt-in sheet sync', sub: 'manual, Sync now in Payroll', about: 'The Rep Sales sheet sync runs when someone presses Sync now. Nothing schedules it.', manual: true },
  { id: 'slots-tds', col: 1, kind: 'job', agent: 'slots-tds', pauseKey: 'slots_tds' },
  { id: 'slots-surf', col: 1, kind: 'job', agent: 'slots-surf', pauseKey: 'slots_surf' },
  { id: 't-knocking', col: 2, kind: 'data', grow: 'knocking', title: 'knocking', sub: 'one row per rep per day per source', about: 'The knocking table: doors, contacts, sold pins and hours per rep per day. knocking_isp splits SalesRabbit doors by ISP.' },
  { id: 't-parked', col: 2, kind: 'data', title: 'Parked lead files', sub: 'imports/isp/parked', about: 'Lead files waiting for a rep. The isp-leads skill turns each into a SalesRabbit import.', manual: true },
  { id: 't-bria', col: 2, kind: 'data', grow: 'bria_deals', title: 'bria_deals, bria_sales_daily', sub: 'sold, per rep per day', about: 'Sold deals from Bria and the per-rep daily counts the Sold and PRA numbers come from.' },
  { id: 't-deals', col: 2, kind: 'data', grow: 'deals', title: 'deals', sub: 'installs, cancels, upfront', about: 'The Sequifi deals feed: installed, cancelled, pending, with ISP and market. Also the upfront opt-in list.' },
  { id: 't-teams', col: 2, kind: 'data', title: 'Teams and roster', sub: '__bria_teams__, Sequifi weeks', about: 'Who is on which team each week. Bria blitz groups first, market teams as fallback, Sequifi weeks as history.' },
  { id: 't-slots', col: 2, kind: 'data', title: 'install_slots', sub: 'earliest date per market', about: 'What each ISP\'s calendar offered this morning, per market.' },
  { id: 'exporter', col: 3, kind: 'read', agent: 'exporter', pauseKey: 'isp' },
  { id: 'mapper', col: 3, kind: 'read', agent: 'mapper' },
  { id: 'analyst', col: 3, kind: 'read', agent: 'analyst' },
  { id: 'installs', col: 3, kind: 'read', agent: 'installs' },
  { id: 'chaser', col: 3, kind: 'read', agent: 'chaser' },
  { id: 'isp-reads', col: 3, kind: 'group', title: 'ISP reads', sub: 'i3, SLIC, Lyte, Surf, TDS, Ezee, Omni', members: ['isp-i3', 'isp-slic', 'isp-lyte', 'isp-surf', 'isp-tds', 'isp-ezee', 'isp-omni'], about: 'One morning read per ISP: this week\'s sales against pace, Bria checked against the install report, installs, cancels and why, install rate, booking lag, past-due installs, doors, and whether the lead file and export are fresh.' },
  { id: 'sales-lead', col: 3, kind: 'read', agent: 'sales-lead' },
  { id: 'chief-grow', col: 3, kind: 'read', agent: 'chief-grow' },
  { id: 'runner-grow', col: 3, kind: 'read', agent: 'runner-grow' },
  { id: 'out-dash', col: 4, kind: 'output', title: 'This dashboard', sub: 'knocking, weeks, deals, pay', about: 'Knocking board, Sales by Week, Payroll, Ops and the manager pages all read the tables to the left.' },
  { id: 'out-import', col: 4, kind: 'output', title: 'SalesRabbit import', sub: 'built by the isp-leads skill', about: 'A parked file becomes a SalesRabbit import CSV with the rep assigned and the dupes report on Drive.' },
  { id: 'out-drive', col: 4, kind: 'output', title: 'Drive workbooks', sub: '8 ISP knocking workbooks', about: 'One workbook per ISP on the shared Drive: summary by city, a tab per week, every door worked. The links never change.' },
  { id: 'out-maps', col: 4, kind: 'output', title: 'ISP maps', sub: 'Ops > ISP Maps', go: 'ispmaps', about: 'Sector maps per ISP with doors, knocks and the latest lead drops.' },
  { id: 'out-slots', col: 4, kind: 'output', title: 'Install slots', sub: 'Ops > Install Slots', go: 'installslots', about: 'Earliest install date per market, so managers can steer reps to markets that install soon.' },
  { id: 'out-brief', col: 4, kind: 'output', title: 'Morning brief', sub: 'ranked to-do, wins, roll call', brief: true, about: 'Everything the reads found this morning, ranked, with who owns each item and how long it has been open.' },
];
const SRC_EDGES = [
  ['src-sr', 'crawler'], ['crawler', 't-knocking'], ['src-amplify', 'amplify'], ['amplify', 't-knocking'], ['src-portals', 'rtr'], ['rtr', 't-knocking'],
  ['src-files', 'courier'], ['courier', 't-parked'], ['t-parked', 'out-import'],
  ['src-bria', 'vc-bria'], ['vc-bria', 't-bria'], ['vc-bria', 't-teams'], ['src-sequifi', 'vc-sequifi'], ['vc-sequifi', 't-deals'], ['src-sequifi', 'vc-teams'], ['vc-teams', 't-teams'],
  ['src-sheet', 'sheet'], ['sheet', 't-deals'], ['src-signup', 'slots-tds'], ['src-signup', 'slots-surf'], ['slots-tds', 't-slots'], ['slots-surf', 't-slots'],
  ['t-knocking', 'exporter'], ['exporter', 'out-drive'], ['t-knocking', 'mapper'], ['mapper', 'out-maps'],
  ['t-knocking', 'out-dash'], ['t-bria', 'out-dash'], ['t-deals', 'out-dash'], ['t-teams', 'out-dash'],
  ['t-knocking', 'analyst'], ['t-bria', 'analyst'], ['t-teams', 'analyst'], ['t-bria', 'installs'], ['t-deals', 'installs'], ['t-deals', 'chaser'],
  ['t-knocking', 'isp-reads'], ['t-bria', 'isp-reads'], ['t-deals', 'isp-reads'], ['isp-reads', 'sales-lead'],
  ['analyst', 'chief-grow'], ['installs', 'chief-grow'], ['chaser', 'chief-grow'], ['sales-lead', 'chief-grow'], ['chief-grow', 'out-brief'], ['t-slots', 'out-slots'],
];
const srcById = Object.fromEntries(SRC_NODES.map(n => [n.id, n]));
const SRC = { agents: [], events: [], tasks: [], grow: null, paused: {}, selected: null, status: new Map(), state: new Map(), timer: null };

async function srcLoad() {
  const base = SUPABASE_URL + '/rest/v1/';
  const j = (q) => fetch(base + q, { headers: SB_HEADERS }).then(r => r.ok ? r.json() : []).catch(() => []);
  const since = new Date(Date.now() - 3 * 3600000).toISOString();
  const [agents, recent, snapsLatest, tasks, versions, bria, sequifi, teams, optin, markers] = await Promise.all([
    j('office_agents?select=*&order=sort'),
    j('office_events?select=agent_id,run_id,kind,ok,status,created_at&created_at=gte.' + encodeURIComponent(since) + '&order=created_at.desc&limit=3000'),
    j('office_events?select=agent_id,run_id,kind,ok,status,created_at&kind=neq.heartbeat&order=created_at.desc&limit=400'),
    j('office_tasks?select=*&order=requested_at.desc&limit=40'),
    j('data_versions?select=tbl,v'), j('bria_sync_meta?select=last_run,bria_users&id=eq.1'), j('sequifi_sync_meta?select=last_run,error&id=eq.1'),
    j('sequifi_teams_sync_meta?select=last_run,error,team_count&id=eq.1'), j('upfront_optin_sync_meta?select=last_run,error,rep_count&id=eq.1'),
    j('report_config?select=manager,config&manager=like.__*'),
  ]);
  const seen = new Set(recent.map(e => e.agent_id + '|' + e.run_id + '|' + e.kind + '|' + e.created_at));
  const events = recent.slice();
  for (const e of snapsLatest) { const k = e.agent_id + '|' + e.run_id + '|' + e.kind + '|' + e.created_at; if (!seen.has(k)) { seen.add(k); events.push(e); } }
  const marks = {}; for (const r of markers) marks[String(r.manager).replace(/^__|__$/g, '')] = r.config || {};
  SRC.paused = marks.paused || {};
  SRC.agents = agents; SRC.events = events; SRC.tasks = tasks;
  SRC.grow = { versions: Object.fromEntries(versions.map(v => [v.tbl, v.v])), bria: bria[0] || null, sequifi: sequifi[0] || null, teams: teams[0] || null, optin: optin[0] || null, marks };
  SRC.status.clear();
  for (const a of agents) {
    const n = SRC_NODES.find(x => x.agent === a.id);
    const pk = n && n.pauseKey ? n.pauseKey : 'wo_' + a.id;
    a.paused = !!SRC.paused[pk];
    SRC.status.set(a.id, deriveStatus(a, events));
  }
  for (const n of SRC_NODES) SRC.state.set(n.id, srcStateFor(n));
}
const srcAgentOf = (n) => SRC.agents.find(a => a.id === n.agent);
const srcAgeH = (iso) => iso ? (Date.now() - new Date(iso).getTime()) / 3600000 : null;
function srcStateFor(n) {
  if (n.kind === 'job' || n.kind === 'read') { const s = SRC.status.get(n.agent); return s ? s.state : 'none'; }
  if (n.kind === 'group') return n.members.map(id => (SRC.status.get(id) || {}).state || 'none').reduce((m, s) => (SRC_RANK[s] > SRC_RANK[m] ? s : m), 'idle');
  if (n.kind === 'cron') { const m = SRC.grow && SRC.grow[n.grow]; if (!m) return 'none'; if (m.error) return 'failed'; if (n.manual) return 'manual'; const h = srcAgeH(m.last_run); return h == null ? 'none' : h > (n.cadence / 3600) * 1.3 ? 'stale' : 'idle'; }
  if (n.kind === 'data') { if (n.manual || !n.grow) return 'manual'; const h = srcAgeH(SRC.grow && SRC.grow.versions[n.grow]); return h == null ? 'none' : h > 30 ? 'old' : 'fresh'; }
  return 'none';
}
function srcSubFor(n) {
  if (n.kind === 'job' || n.kind === 'read') { const a = srcAgentOf(n), s = SRC.status.get(n.agent); if (!a) return 'not registered'; if (s && s.state === 'paused') return 'paused'; return s && s.lastAt ? `${SRC_STATE_WORD[s.state] || s.state} · ${ageText(s.lastAt)}` : cadenceText(a.cadence_seconds); }
  if (n.kind === 'group') { const bad = n.members.filter(id => srcHot((SRC.status.get(id) || {}).state) || srcWarm((SRC.status.get(id) || {}).state)).length; return bad ? `${bad} of ${n.members.length} need a look` : `${n.members.length} reads, all fine`; }
  if (n.kind === 'cron') { const m = SRC.grow && SRC.grow[n.grow]; return m && m.last_run ? `${m.error ? 'error · ' : ''}ran ${ageText(m.last_run)}` : n.sub; }
  if (n.kind === 'data') { const v = SRC.grow && SRC.grow.versions[n.grow]; return v ? `updated ${ageText(v)}` : n.sub; }
  return n.sub;
}
const srcTitleFor = (n) => { const a = n.agent && srcAgentOf(n); return a ? a.name : n.title; };
const srcClip = (s, k) => (s && s.length > k ? s.slice(0, k - 1) + '…' : s || '');
function srcLayout() {
  const W = 176, H = 44, PAD = 16, HEAD = 26;
  const GX = 54, GY = 16;
  const cols = SRC_COLS.map(() => []); for (const n of SRC_NODES) cols[n.col].push(n);
  const rows = Math.max(...cols.map(c => c.length)); const pos = {};
  cols.forEach((list, ci) => { const x = PAD + ci * (W + GX), y0 = HEAD + PAD + ((rows - list.length) * (H + GY)) / 2; list.forEach((n, ri) => { pos[n.id] = { x, y: y0 + ri * (H + GY) }; }); });
  return { pos, W, H, PAD, HEAD, GX, width: PAD * 2 + SRC_COLS.length * W + (SRC_COLS.length - 1) * GX, height: HEAD + PAD * 2 + rows * (H + GY) };
}
function srcRenderMap() {
  const host = document.getElementById('srcMap'); if (!host) return;
  const { pos, W, H, PAD, HEAD, GX, width, height } = srcLayout();
  // Selecting a step traces its whole chain: everything that feeds it (upstream, solid)
  // and everything it feeds (downstream, fainter). Anything off the chain is dimmed, so
  // a missing or wrong connection is obvious at a glance.
  const up = new Set(), down = new Set();
  if (SRC.selected) {
    up.add(SRC.selected); down.add(SRC.selected); let grew = true;
    while (grew) { grew = false; for (const [a, b] of SRC_EDGES) { if (up.has(b) && !up.has(a)) { up.add(a); grew = true; } if (down.has(a) && !down.has(b)) { down.add(b); grew = true; } } }
  }
  const onChain = (id) => !SRC.selected || up.has(id) || down.has(id);
  const edges = SRC_EDGES.map(([a, b]) => { const p = pos[a], q = pos[b]; const x1 = p.x + W, y1 = p.y + H / 2, x2 = q.x, y2 = q.y + H / 2, m = (x1 + x2) / 2; const s = SRC.state.get(a);
    const cls = SRC.selected ? (up.has(b) && up.has(a) ? 'lit' : down.has(a) && down.has(b) ? 'lit-down' : 'dim') : (srcHot(s) ? 'hot' : srcWarm(s) ? 'warm' : '');
    return `<path class="src-edge ${cls}" d="M${x1} ${y1} C${m} ${y1} ${m} ${y2} ${x2} ${y2}"/>`; });
  // Draw lit edges last so they sit on top of the dimmed ones.
  edges.sort((a, b) => (a.includes('lit') ? 1 : 0) - (b.includes('lit') ? 1 : 0));
  const edgesHtml = edges.join('');
  const heads = SRC_COLS.map((c, i) => `<text class="src-colhead" x="${PAD + i * (W + GX)}" y="${HEAD - 8}">${c}</text>`).join('');
  const nodes = SRC_NODES.map(n => { const { x, y } = pos[n.id], s = SRC.state.get(n.id); const plain = n.kind === 'source' || n.kind === 'output'; const dot = plain ? '' : `<circle cx="${x + 13}" cy="${y + H / 2}" r="4.5" fill="${SRC_COLOR[s] || SRC_COLOR.none}"/>`; const tx = plain ? x + 12 : x + 26; return `<g class="src-node kind-${n.kind}${SRC.selected === n.id ? ' on' : ''}${onChain(n.id) ? '' : ' dim'}" data-id="${n.id}"><rect class="box" x="${x}" y="${y}" width="${W}" height="${H}" rx="8"/>${dot}<text class="title" x="${tx}" y="${y + 18}">${srcEsc(srcClip(srcTitleFor(n), 24))}</text><text class="sub" x="${tx}" y="${y + 33}">${srcEsc(srcClip(srcSubFor(n), 30))}</text></g>`; }).join('');
  host.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">${heads}${edgesHtml}${nodes}</svg>`;
  host.querySelectorAll('.src-node').forEach(g => g.onclick = () => srcSelect(g.dataset.id));
  srcRenderPills(); if (!SRC.selected) srcRenderHome();
}
function srcRenderPills() {
  const el = document.getElementById('srcPills'); if (!el) return;
  const states = SRC.agents.map(a => (SRC.status.get(a.id) || {}).state); const n = (k) => states.filter(s => s === k).length;
  const cronBad = SRC_NODES.filter(x => x.kind === 'cron' && srcHot(SRC.state.get(x.id))).length;
  const pills = [];
  if (n('failed') + cronBad) pills.push(`<span class="src-pill bad">${n('failed') + cronBad} failed</span>`);
  if (n('blocked')) pills.push(`<span class="src-pill warn">${n('blocked')} need you</span>`);
  if (n('stale')) pills.push(`<span class="src-pill warn">${n('stale')} quiet</span>`);
  if (n('paused')) pills.push(`<span class="src-pill quiet">${n('paused')} paused</span>`);
  if (n('working')) pills.push(`<span class="src-pill good">${n('working')} running</span>`);
  if (!pills.length) pills.push('<span class="src-pill good">all clear</span>');
  el.innerHTML = pills.join('');
}
function srcRenderHome() {
  const el = document.getElementById('srcHome'); if (!el) return;
  const rows = [];
  for (const a of SRC.agents) { const s = SRC.status.get(a.id); const ex = s && srcExplain(a, s); if (ex) rows.push({ id: (SRC_NODES.find(x => x.agent === a.id) || { id: a.id }).id, state: s.state, text: ex.headline, where: a.team || '' }); }
  for (const x of SRC_NODES) if (x.kind === 'cron' && (srcHot(SRC.state.get(x.id)) || srcWarm(SRC.state.get(x.id)))) rows.push({ id: x.id, state: SRC.state.get(x.id), text: `${x.title} ${SRC.state.get(x.id) === 'failed' ? 'reported an error' : 'has not run on time'}`, where: 'Vercel' });
  const order = ['failed', 'blocked', 'stale']; rows.sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));
  const open = SRC.tasks.filter(t => ['queued', 'running', 'waiting'].includes(t.state));
  el.innerHTML = `<h3 style="margin:0 0 8px;font-size:15px;">Needs attention</h3>${rows.length ? rows.map(r => `<button class="src-alert" data-id="${srcEsc(r.id)}"><i style="background:${SRC_COLOR[r.state]}"></i><span><span class="txt">${srcEsc(r.text)}</span><br><span class="where">${srcEsc(r.where)}</span></span></button>`).join('') : '<p class="src-fine">Everything on the pathway is running or fresh.</p>'}
    ${open.length ? `<h4 class="src-h4">In the queue (${open.length})</h4>${open.map(t => `<div class="src-row">${srcEsc(t.kind)} · ${srcEsc(t.agent_id)} <span class="src-muted">${srcEsc(t.state)}</span></div>`).join('')}` : ''}
    <h4 class="src-h4">How to read this</h4><p class="src-muted" style="margin:0">Data enters on the left and leaves on the right. A grey dot is paused or run by hand, amber has gone quiet, red failed. Select a step for what it does, its last word, and the buttons that run or fix it; the Mac picks a queued job up within a minute.</p>`;
  el.querySelectorAll('[data-id]').forEach(b => b.onclick = () => srcSelect(b.dataset.id));
}
function srcExplain(a, s) {
  if (s.state === 'stale') return { headline: `${a.name} has gone quiet`, steps: [s.lastAt ? `It should report ${cadenceText(a.cadence_seconds)}; its last report was ${ageText(s.lastAt)}.` : `It should report ${cadenceText(a.cadence_seconds)} but has never reported.`, 'Usually the Mac was asleep or the job stopped. Run now wakes it; Restart reloads the schedule.'] };
  if (s.state === 'failed') { const code = /exit (\d+)/.exec(s.bubble || ''); const f = SRC_FACTS[a.id] || {}; const hint = code && f.failHints && f.failHints[code[1]]; return { headline: `${a.name}'s last run failed`, steps: [`The last run ended with an error${s.bubble ? `: "${s.bubble}"` : ''}.`, ...(hint ? [hint] : []), `It tries again ${cadenceText(a.cadence_seconds)}.`] }; }
  if (s.state === 'blocked') return { headline: `${a.name} needs you`, steps: [s.bubble ? `It says: "${s.bubble}"` : 'It stopped and is waiting for a decision.', (SRC_FACTS[a.id] || {}).blocked || 'Give it what it asked for and it will carry on.'] };
  return null;
}
function srcSelect(id) {
  SRC.selected = id; srcRenderMap();
  const n = srcById[id]; if (!n) return;
  document.getElementById('srcHome').style.display = 'none'; const d = document.getElementById('srcDetail'); d.style.display = 'block';
  if (n.kind === 'job' || n.kind === 'read') return srcShowAgent(n);
  if (n.kind === 'group') return srcShowGroup(n);
  if (n.brief) return srcShowBrief();
  srcShowPlain(n);
}
function srcClose() { SRC.selected = null; document.getElementById('srcDetail').style.display = 'none'; document.getElementById('srcHome').style.display = 'block'; srcRenderMap(); }
const srcHead = (title, subtitle) => `<div class="src-cardhead"><div><strong>${srcEsc(title)}</strong><br><span class="src-muted">${subtitle}</span></div><button class="src-close" id="srcClose" title="close">×</button></div>`;
function srcWire(d) {
  const c = document.getElementById('srcClose'); if (c) c.onclick = srcClose;
  d.querySelectorAll('[data-open]').forEach(x => x.onclick = (e) => { e.preventDefault(); const id = x.dataset.open; srcSelect(srcById[id] ? id : (SRC_NODES.find(y => y.agent === id) || { id }).id); });
}
function srcList(arr) { return arr.length ? `<ul class="src-list">${arr.map(x => `<li><i style="background:${SRC_COLOR[SRC.state.get(x.id)] || SRC_COLOR.none}"></i><a href="#" data-open="${srcEsc(x.id)}">${srcEsc(srcTitleFor(x))}</a> <span class="src-muted">${srcEsc(srcSubFor(x))}</span></li>`).join('')}</ul>` : '<p class="src-muted">Nothing</p>'; }
function srcShowPlain(n) {
  const s = SRC.state.get(n.id), d = document.getElementById('srcDetail');
  let extra = '';
  if (n.kind === 'cron') { const m = SRC.grow && SRC.grow[n.grow]; if (m) extra = `<div class="src-kv"><b>Last run</b><span>${srcEsc(m.last_run ? new Date(m.last_run).toLocaleString() : 'never')}</span>${m.error ? `<b>Error</b><span style="color:var(--red)">${srcEsc(m.error)}</span>` : ''}${m.bria_users ? `<b>Bria users</b><span>${m.bria_users}</span>` : ''}${m.team_count ? `<b>Teams</b><span>${m.team_count}</span>` : ''}${m.rep_count ? `<b>Reps opted in</b><span>${m.rep_count}</span>` : ''}</div>`; }
  if (n.kind === 'data' && SRC.grow && SRC.grow.versions[n.grow]) extra = `<div class="src-kv"><b>Last change</b><span>${srcEsc(new Date(SRC.grow.versions[n.grow]).toLocaleString())}</span></div>`;
  const link = n.go ? `<button class="src-btn link" onclick="openMoreSection('${n.go}')">Open ${srcEsc(n.title)}</button>` : '';
  const ups = SRC_EDGES.filter(e => e[1] === n.id).map(e => srcById[e[0]]), downs = SRC_EDGES.filter(e => e[0] === n.id).map(e => srcById[e[1]]);
  d.innerHTML = `${srcHead(srcTitleFor(n), `<span class="src-state">${SRC_STATE_WORD[s] || n.kind}</span>`)}<p class="src-about">${srcEsc(n.about || '')}</p>${extra}${link ? `<div class="src-actions">${link}</div>` : ''}<h4 class="src-h4">Fed by</h4>${srcList(ups)}<h4 class="src-h4">Feeds</h4>${srcList(downs)}`;
  srcWire(d);
}
function srcShowGroup(n) {
  const d = document.getElementById('srcDetail');
  const rows = n.members.map(id => { const a = SRC.agents.find(x => x.id === id), s = SRC.status.get(id); return `<tr><td><a href="#" data-open="${srcEsc(id)}">${srcEsc(a ? a.name : id)}</a></td><td style="color:${SRC_COLOR[s ? s.state : 'none']}">${srcEsc(SRC_STATE_WORD[s ? s.state : 'none'] || '')}</td><td class="clip src-muted">${srcEsc(s && s.bubble || '')}</td></tr>`; }).join('');
  d.innerHTML = `${srcHead(n.title, n.sub)}<p class="src-about">${srcEsc(n.about)}</p><table class="ft"><thead><tr><th>Read</th><th>State</th><th>Last word</th></tr></thead><tbody>${rows}</tbody></table>`;
  srcWire(d);
}
async function srcShowBrief() {
  document.getElementById('srcHome').style.display = 'none'; const d = document.getElementById('srcDetail'); d.style.display = 'block';
  d.innerHTML = `${srcHead('Morning brief', 'what the reads found this morning')}<p class="src-muted">Loading…</p>`; srcWire(d);
  const snap = await srcSnapshot('chief-grow');
  d.innerHTML = `${srcHead('Morning brief', snap ? `for ${srcEsc(snap.day)}` : 'no brief yet today')}${snap ? renderFindings('chief-grow', snap) : '<p class="src-muted">The brief runs at 8am after the reads. Select Morning brief on the map and press Run now to build it.</p>'}`;
  srcWire(d);
}
async function srcSnapshot(agent) { try { const r = await fetch(SUPABASE_URL + '/rest/v1/office_snapshots?agent_id=eq.' + encodeURIComponent(agent) + '&order=day.desc&limit=1&select=day,data', { headers: SB_HEADERS }); const rows = r.ok ? await r.json() : []; return rows[0] || null; } catch (e) { return null; } }
async function srcQueue(agent, kind, args, note) {
  const row = { agent_id: agent, floor: 'grow', kind, args: args || {}, state: 'queued', requested_by: 'app', note: note || null, timeout_seconds: kind === 'run' ? 1800 : kind === 'fix' ? 900 : 60 };
  const r = await fetch(SUPABASE_URL + '/rest/v1/office_tasks', { method: 'POST', headers: Object.assign({}, SB_HEADERS, { Prefer: 'return=representation' }), body: JSON.stringify([row]) });
  if (!r.ok) throw new Error('could not queue (' + r.status + ')');
  return (await r.json())[0];
}
async function srcWatchTask(id, el, isLog) {
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, i < 10 ? 4000 : 10000));
    let t = null; try { t = (await (await fetch(SUPABASE_URL + '/rest/v1/office_tasks?id=eq.' + id + '&select=state,result,started_at,finished_at', { headers: SB_HEADERS })).json())[0]; } catch (e) {}
    if (!t || !el.isConnected) return;
    if (t.state === 'queued') el.textContent = 'Queued. The Mac picks it up within a minute…';
    else if (t.state === 'running') el.textContent = 'Running on the Mac…';
    else { el.textContent = (t.state === 'done' ? (isLog ? '' : 'Done. ') : 'Failed. ') + (t.result || ''); el.classList.toggle('src-bad', t.state === 'failed'); srcTick(); return; }
  }
}
function srcShowAgent(n) {
  const a = srcAgentOf(n); if (!a) return;
  const s = SRC.status.get(a.id); const st = s ? s.state : 'idle'; const f = SRC_FACTS[a.id] || {};
  const code = st === 'failed' ? (/exit (\d+)/.exec(s.bubble || '') || [])[1] : null;
  const buttons = [];
  if (code && f.fixes && f.fixes.includes(code)) buttons.push(`<button class="src-btn primary" data-q="fix" data-code="${srcEsc(code)}">Fix it now</button>`);
  else if (f.run) buttons.push(`<button class="src-btn ${['failed', 'stale'].includes(st) ? 'primary' : ''}" data-q="run">Run now</button>`);
  if (f.log) buttons.push(`<button class="src-btn" data-q="log">Show log</button>`);
  if (f.label) buttons.push(`<button class="src-btn" data-q="restart">Restart schedule</button>`);
  const pk = n.pauseKey || 'wo_' + a.id; const paused = st === 'paused';
  const sw = f.label ? `<div class="src-sched${paused ? ' off' : ''}"><button class="src-sw" data-pause="${pk}" data-on="${paused ? '0' : '1'}" title="${paused ? 'Turn back on' : 'Pause the schedule'}"><i></i></button><div><b>${paused ? 'Paused' : 'On schedule'}</b><span>${paused ? 'Not running until you turn it back on' : srcEsc(cadenceText(a.cadence_seconds))}</span></div></div>` : '';
  const ex = s && srcExplain(a, s);
  const d = document.getElementById('srcDetail');
  d.innerHTML = `${srcHead(a.name, `<span class="src-state">${SRC_STATE_WORD[st] || st}</span>${s && s.lastAt ? ` <span class="src-muted">· ${srcEsc(ageText(s.lastAt))}</span>` : ''}`)}
    ${s && s.bubble ? `<p class="src-say">${srcEsc(s.bubble)}</p>` : ''}
    ${ex ? `<div class="src-about">${ex.steps.map(x => `<p style="margin:4px 0">${srcEsc(x)}</p>`).join('')}</div>` : ''}
    ${sw}${buttons.length ? `<div class="src-actions">${buttons.join('')}</div>` : ''}
    <div id="srcTaskOut" class="src-out" hidden></div>
    <p class="src-about">${srcEsc(f.about || `${a.name} runs ${cadenceText(a.cadence_seconds)}.`)}</p>
    ${a.id === 'runner-grow' ? srcQueueTable() : '<button class="src-btn" id="srcReport" hidden>Full report</button><div id="srcFindings" hidden></div>'}`;
  srcWire(d);
  const rb = document.getElementById('srcReport');
  if (rb) { const p = srcSnapshot(a.id); p.then(snap => { if (snap && rb.isConnected) rb.hidden = false; }); rb.onclick = async () => { const box = document.getElementById('srcFindings'); if (!box.hidden) { box.hidden = true; rb.textContent = 'Full report'; return; } box.hidden = false; rb.textContent = 'Hide report'; box.innerHTML = '<p class="src-muted">Loading…</p>'; const snap = await p; box.innerHTML = snap ? renderFindings(a.id, snap) : '<p class="src-muted">No report saved.</p>'; srcWire(box); const c = document.getElementById('srcClose'); if (c) c.onclick = srcClose; }; }
  d.querySelectorAll('[data-pause]').forEach(b => b.onclick = async () => {
    b.disabled = true; try { await srcSetPaused(b.dataset.pause, b.dataset.on === '1'); await srcTick(); srcSelect(SRC.selected); } catch (e) { b.disabled = false; }
  });
  d.querySelectorAll('[data-q]').forEach(b => b.onclick = async () => {
    const out = document.getElementById('srcTaskOut'); out.hidden = false; out.classList.remove('src-bad'); out.textContent = 'Queuing…'; b.disabled = true;
    try { const t = await srcQueue(a.id, b.dataset.q, b.dataset.code ? { code: b.dataset.code } : {}, null); out.textContent = 'Queued. The Mac picks it up within a minute…'; srcWatchTask(t.id, out, b.dataset.q === 'log'); }
    catch (e) { out.textContent = 'Could not queue: ' + e.message; out.classList.add('src-bad'); }
    b.disabled = false;
  });
  d.querySelectorAll('[data-cancel]').forEach(b => b.onclick = async () => { b.disabled = true; await fetch(SUPABASE_URL + '/rest/v1/office_tasks?id=eq.' + b.dataset.cancel + '&state=in.(waiting,queued)', { method: 'PATCH', headers: SB_HEADERS, body: JSON.stringify({ state: 'failed', finished_at: new Date().toISOString(), result: 'cancelled from the app' }) }); await srcTick(); srcSelect(SRC.selected); });
}
function srcQueueTable() {
  const when = (iso) => iso ? srcEsc(iso).slice(5, 16).replace('T', ' ') : '';
  const rows = SRC.tasks.slice(0, 15).map(t => `<tr><td>#${t.id}</td><td>${srcEsc(t.kind)}</td><td><a href="#" data-open="${srcEsc(t.agent_id)}">${srcEsc(t.agent_id)}</a></td><td>${srcEsc(t.state)}</td><td class="src-muted">${when(t.finished_at || t.started_at || t.requested_at)}</td><td>${['waiting', 'queued'].includes(t.state) ? `<button class="src-btn" data-cancel="${t.id}">Cancel</button>` : ''}</td></tr>`).join('');
  return `<h4 class="src-h4">Queue</h4>${rows ? `<table class="ft"><tbody>${rows}</tbody></table>` : '<p class="src-muted">Nothing queued.</p>'}`;
}
async function srcSetPaused(key, on) {
  const u = SUPABASE_URL + '/rest/v1/report_config';
  const cur = await fetch(u + '?select=config&manager=eq.__paused__', { headers: SB_HEADERS }).then(r => r.ok ? r.json() : []);
  const cfg = (cur[0] && cur[0].config) || {};
  if (on) cfg[key] = { at: new Date().toISOString(), by: 'app' }; else delete cfg[key];
  const r = await fetch(u + '?on_conflict=manager', { method: 'POST', headers: Object.assign({}, SB_HEADERS, { Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify([{ manager: '__paused__', config: cfg }]) });
  if (!r.ok) throw new Error('pause write failed');
  try { _syncStatusCache = null; } catch (e) {}
}
async function srcTick() { try { await srcLoad(); srcRenderMap(); } catch (e) { const h = document.getElementById('srcHome'); if (h) h.innerHTML = '<p class="src-muted">Could not load the pathway: ' + srcEsc(e.message) + '</p>'; } }

const SRC_CSS = `
#sourcesContent .src-top{display:flex;align-items:center;gap:12px;margin:0 0 10px}
#sourcesContent .src-pill{white-space:nowrap;font-size:12px;font-weight:600;padding:2px 9px;border-radius:999px;background:var(--panel2,#f3f4f1);border:1px solid var(--line,#e2e5ee);color:var(--ink2,#4b5165);margin-right:4px}
#sourcesContent .src-pill.bad{background:#fbe5e4;color:var(--red)}#sourcesContent .src-pill.warn{background:#fbf0dc;color:var(--amber)}#sourcesContent .src-pill.good{background:#e3f5ec;color:var(--green)}#sourcesContent .src-pill.quiet{background:#eef0f5;color:#8b8f88}
#sourcesContent .src-legend{display:flex;gap:16px;font-size:12px;color:var(--ink3,#7c8398);margin:0 0 8px;flex-wrap:wrap}#sourcesContent .src-legend i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
/* Sources needs the whole window: the app's 1100px column leaves the sides empty. */
.tab-section:has(.more-section[data-more="sources"].active){max-width:none;padding:0 24px}
#sourcesContent .src-grid{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:12px;align-items:start}
#sourcesContent .src-stage{border:1px solid var(--line,#e2e5ee);border-radius:10px;overflow:hidden;padding:8px 12px 12px;background:var(--panel,#fff)}
#sourcesContent #srcMap{width:100%}#sourcesContent #srcMap svg{display:block;width:100%;height:auto;max-height:calc(100vh - 240px);margin:0 auto}
#sourcesContent .src-side{position:sticky;top:12px}#sourcesContent .src-side .src-panel{max-height:calc(100vh - 240px)}
@media (max-width:1100px){#sourcesContent .src-grid{grid-template-columns:1fr}}
#sourcesContent .src-node{cursor:pointer}#sourcesContent .src-node rect.box{fill:var(--panel2,#f6f7f4);stroke:var(--line,#e2e5ee);stroke-width:1}
#sourcesContent .src-node:hover rect.box{stroke:#b9bec9}#sourcesContent .src-node.on rect.box{stroke:var(--blue,#2f5bea);stroke-width:1.5}
#sourcesContent .src-node.kind-source rect.box,#sourcesContent .src-node.kind-output rect.box,#sourcesContent .src-node.kind-data rect.box{fill:var(--panel,#fff)}
#sourcesContent .src-node .title{font-size:12.5px;font-weight:600;fill:var(--ink,#171a22)}#sourcesContent .src-node .sub{font-size:11px;fill:var(--ink3,#7c8398)}
#sourcesContent .src-edge{fill:none;stroke:#c3c9d8;stroke-width:1.2;opacity:.7}#sourcesContent .src-edge.hot{stroke:var(--red);stroke-width:1.8;opacity:1}#sourcesContent .src-edge.warm{stroke:var(--amber);stroke-width:1.6;opacity:1}#sourcesContent .src-edge.lit{stroke:var(--blue,#2f5bea);stroke-width:2.2;opacity:1}#sourcesContent .src-edge.lit-down{stroke:var(--blue,#2f5bea);stroke-width:1.6;opacity:.45;stroke-dasharray:5 4}#sourcesContent .src-edge.dim{opacity:.18}#sourcesContent .src-node.dim{opacity:.3}
#sourcesContent .src-colhead{font-size:11px;font-weight:600;fill:var(--ink3,#7c8398);letter-spacing:.06em;text-transform:uppercase}
#sourcesContent .src-panel{border:1px solid var(--line,#e2e5ee);border-radius:10px;padding:14px;background:var(--panel,#fff);overflow:auto;font-size:13.5px}
#sourcesContent .src-h4{margin:14px 0 6px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink3,#7c8398)}
#sourcesContent .src-muted{color:var(--ink3,#7c8398)}#sourcesContent .src-bad{color:var(--red)}
#sourcesContent .src-cardhead{display:flex;gap:10px;align-items:flex-start}#sourcesContent .src-cardhead strong{font-size:15px}
#sourcesContent .src-close{margin-left:auto;border:1px solid var(--line,#e2e5ee);background:var(--panel2,#f6f7f4);border-radius:8px;width:28px;height:28px;cursor:pointer;flex:none;font:inherit}
#sourcesContent .src-state{display:inline-block;font-weight:600;font-size:12px;padding:1px 8px;border-radius:999px;background:var(--panel2,#f6f7f4);border:1px solid var(--line,#e2e5ee)}
#sourcesContent .src-say{margin:10px 0 4px}#sourcesContent .src-about{margin:10px 0;line-height:1.55;color:var(--ink2,#4b5165)}
#sourcesContent .src-sched{display:flex;align-items:center;gap:10px;margin:10px 0 2px;padding:9px 11px;border:1px solid var(--line,#e2e5ee);border-radius:8px;background:var(--panel2,#f6f7f4)}
#sourcesContent .src-sched b{display:block;font-size:13px;color:var(--green)}#sourcesContent .src-sched span{display:block;font-size:12px;color:var(--ink3,#7c8398)}#sourcesContent .src-sched.off b{color:var(--ink3,#7c8398)}
#sourcesContent .src-sw{flex:none;width:40px;height:22px;border-radius:11px;border:0;padding:0;background:var(--green);position:relative;cursor:pointer}#sourcesContent .src-sw i{position:absolute;top:3px;left:21px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s}
#sourcesContent .src-sched.off .src-sw{background:#c3c9d8}#sourcesContent .src-sched.off .src-sw i{left:3px}
#sourcesContent .src-actions{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}
#sourcesContent .src-btn{font:inherit;font-weight:600;font-size:13px;padding:6px 11px;border:1px solid var(--line,#e2e5ee);border-radius:8px;background:var(--panel2,#f6f7f4);color:var(--ink,#171a22);cursor:pointer}
#sourcesContent .src-btn.primary{background:var(--blue,#2f5bea);color:#fff;border-color:var(--blue,#2f5bea)}#sourcesContent .src-btn.link{color:var(--blue,#2f5bea);border-color:var(--blue,#2f5bea);background:transparent}
#sourcesContent .src-out{margin:8px 0;padding:8px 10px;border-radius:8px;background:var(--panel2,#f6f7f4);white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;font-size:12px;max-height:260px;overflow:auto}
#sourcesContent .src-alert{display:grid;grid-template-columns:8px 1fr;gap:10px;align-items:start;padding:9px 10px;border:1px solid var(--line,#e2e5ee);border-radius:8px;background:var(--panel2,#f6f7f4);cursor:pointer;margin-bottom:6px;text-align:left;width:100%;font:inherit;color:inherit}
#sourcesContent .src-alert i{width:8px;height:8px;border-radius:50%;margin-top:6px;display:block}#sourcesContent .src-alert .txt{font-weight:600}#sourcesContent .src-alert .where{font-size:11.5px;color:var(--ink3,#7c8398)}
#sourcesContent .src-fine{background:#e3f5ec;color:var(--green);border-radius:8px;padding:8px 10px;margin:10px 0;font-weight:600}
#sourcesContent .src-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:13px;margin:8px 0}#sourcesContent .src-kv b{font-weight:600;color:var(--ink3,#7c8398)}
#sourcesContent .src-list{list-style:none;margin:6px 0;padding:0}#sourcesContent .src-list li{padding:6px 0;border-bottom:1px solid var(--line,#e2e5ee);display:flex;gap:8px;align-items:center}#sourcesContent .src-list li i{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none}#sourcesContent .src-list a,#sourcesContent .ft a,#sourcesContent a.deep{color:var(--blue,#2f5bea);text-decoration:none;font-weight:600}
#sourcesContent .src-row{padding:4px 0;border-bottom:1px solid var(--line,#e2e5ee)}
#sourcesContent .ft{width:100%;border-collapse:collapse;font-size:13px}#sourcesContent .ft th{text-align:left;font-weight:600;color:var(--ink3,#7c8398);font-size:11px;letter-spacing:.04em;text-transform:uppercase;padding:4px 6px 4px 0;border-bottom:1px solid var(--line,#e2e5ee)}#sourcesContent .ft td{padding:5px 6px 5px 0;border-bottom:1px solid var(--line,#e2e5ee);vertical-align:top}
#sourcesContent td.clip{max-width:0;width:55%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#sourcesContent .warn{color:var(--amber)}
`;
window.renderSources = function () {
  if (!document.getElementById('srcCss')) { const st = document.createElement('style'); st.id = 'srcCss'; st.textContent = SRC_CSS; document.head.appendChild(st); }
  const host = document.getElementById('sourcesContent'); if (!host) return;
  if (!host.dataset.built) {
    host.dataset.built = '1';
    host.innerHTML = `<div class="src-top"><h2 style="margin:0;font-size:18px;">Sources</h2><span id="srcPills"></span><button class="src-btn primary" id="srcBrief" style="margin-left:auto">Morning brief</button></div>
      <div class="src-legend"><span><i style="background:var(--green)"></i>running or fine</span><span><i style="background:var(--amber)"></i>quiet or needs you</span><span><i style="background:var(--red)"></i>failed</span><span><i style="background:#8b8f88"></i>paused or by hand</span><span style="margin-left:auto">Select a step: solid blue is what feeds it, dashed is what it feeds</span></div>
      <div class="src-grid"><div class="src-stage"><div id="srcMap"></div></div><div class="src-side"><div id="srcHome" class="src-panel"></div><div id="srcDetail" class="src-panel" style="display:none"></div></div></div>`;
    document.getElementById('srcBrief').onclick = () => { SRC.selected = 'out-brief'; srcRenderMap(); srcShowBrief(); };
  }
  srcTick();
  if (!window._srcResizeWired) { window._srcResizeWired = true; let t; window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => { if (SRC.agents.length) srcRenderMap(); }, 150); }); }
  if (SRC.timer) clearInterval(SRC.timer);
  SRC.timer = setInterval(() => { const sec = document.querySelector('.more-section[data-more="sources"]'); if (sec && sec.classList.contains('active')) srcTick(); }, SRC_POLL_MS);
};

})();
