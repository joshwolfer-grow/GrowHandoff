// site/findings.js — renders a worker's latest snapshot as a complete, readable list.
import { linkFor, ispLink, out } from './links.js';
// Every item the worker found is shown; the speech bubble only had room for a summary.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n1 = (v, d = 1) => (typeof v === 'number' && isFinite(v) ? v.toFixed(d) : '–');
const pct = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 100) + '%' : '–');
const money = (v) => (typeof v === 'number' && isFinite(v) ? (v < 0 ? '-' : '') + '$' + Math.abs(Math.round(v)).toLocaleString() : '–');
const table = (head, rows) => rows.length ? `<table class="ft"><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '<p class="muted">Nothing to list.</p>';
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
      return [esc(f.rep), esc(f.team || ''), esc(name), `<strong>${fmt(f.value)}</strong>`, `${fmt(f.teamMedian)} <span class="muted">(${fmt(f.teamP10)}–${fmt(f.teamP90)}, ${band})</span>`, f.direction === 'high' ? '▲ high' : '▼ low'];
    });

    const teamRows = teams
      .slice()
      .sort((a, b) => (b.deals || 0) - (a.deals || 0))
      .map(t => [esc(t.team), t.reps, t.deals, n1(t.leadTimeDays) + 'd', n1(t.soldPerDay, 2), pct(t.installRate), n1(t.doorsPerDay, 0), flaggedTeams.has(t.team) ? '⚑' : '']);

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
        .map(r => [flagged.has(r.rep) ? `<strong>${esc(r.rep)}</strong> ⚑` : esc(r.rep), r.deals, n1(r.leadTimeDays) + 'd', n1(r.soldPerDay, 2), pct(r.installRate), n1(r.doorsPerDay, 0)]);
      return `<h5>${esc(team)}</h5>${table(['Rep', 'Deals', 'Lead time', 'Sold/day', 'Install rate', 'Doors/day'], rows)}`;
    }).join('');

    return `<h4>${flags.length} flag${flags.length === 1 ? '' : 's'} this fortnight</h4>${table(['Rep', 'Team', 'Metric', 'Theirs', 'Compare (band)', ''], flagRows)}
      <h4>Teams</h4>${table(['Team', 'Reps', 'Deals', 'Lead time', 'Sold/day', 'Install rate', 'Doors/day', ''], teamRows)}
      <h4>Every rep, last 14 days, by team</h4><p class="muted">Reps with fewer than 5 deals are listed but not compared.</p>${repSections}`;
  },
  installs(d) {
    const x = d.diff || {};
    if (d.first || !d.diff) return `<p>First snapshot taken. Changes will be listed from the next run.</p>${table(['Rep', 'Deal', 'Days out'], (x.farOut || []).map(p => [esc(p.rep), esc(p.id), p.days]))}`;
    const sec = (title, rows, head) => `<h4>${title} (${rows.length})</h4>${table(head, rows)}`;
    return sec('Pushed out', (x.pushed || []).sort((a, b) => b.days - a.days).map(p => [esc(p.rep), esc(p.id), '+' + p.days + 'd']), ['Rep', 'Deal', 'Moved'])
      + sec('Cancelled', (x.cancelled || []).map(p => [esc(p.rep), esc(p.id)]), ['Rep', 'Deal'])
      + sec('Booked 10+ days out', (x.farOut || []).sort((a, b) => b.days - a.days).map(p => [esc(p.rep), esc(p.id), p.days + 'd']), ['Rep', 'Deal', 'Days out'])
      + sec('Pulled in', (x.pulledIn || []).map(p => [esc(p.rep), esc(p.id), '-' + p.days + 'd']), ['Rep', 'Deal', 'Moved'])
      + sec('Newly booked', (x.newlyBooked || []).map(p => [esc(p.rep), esc(p.id)]), ['Rep', 'Deal']);
  },
  slots(d) {
    const ms = d.markets || [], fl = d.flags || [];
    const when = (s) => { if (!s) return '–'; const [y, m, dd] = s.split('-'); return new Date(Date.UTC(+y, m - 1, +dd)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }); };
    const rows = ms.map(m => m.ok
      ? [esc(m.market), `<strong>${when(m.earliest_date)}</strong>`, m.days_out == null ? '–' : m.days_out + 'd', m.windows_first_day ?? '–', m.windows_next_7d ?? '–', '']
      : [esc(m.market), '–', '–', '–', '–', `<span class="warn">${esc(m.error)}</span>`]);
    const at = d.ranAt ? new Date(d.ranAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
    return `<h4>Earliest install by market${at ? ` <span class="muted">(read ${esc(at)})</span>` : ''}</h4>${table(['Market', 'Earliest', 'Days out', 'Windows that day', 'Windows next 7 days', ''], rows)}`
      + (fl.length ? `<h4>Flags (${fl.length})</h4><ul>${fl.map(f => `<li>${esc(f.text)}${out(linkFor(f.key))}</li>`).join('')}</ul>` : '')
      + `<p class="muted">Read from ${esc(d.name ? d.name.replace(/ install times$/, '') : 'the ISP')}'s own signup flow at one real door per market; nothing is ever submitted.</p>`;
  },
  chaser(d) {
    const byRep = d.byRep || {};
    const reps = Object.keys(byRep).sort((a, b) => byRep[b].length - byRep[a].length);
    return reps.map(rep => `<h4>${esc(rep)} · ${byRep[rep].length}${out(linkFor('chaser:' + rep))}</h4>${table(['Callback', 'ISP', 'Cancelled', 'Stage', 'Untouched'], byRep[rep].sort((a, b) => b.ageDays - a.ageDays).map(l => [esc(l.order || l.id), esc(l.isp), esc(l.cancelled), esc(l.stage || 'no pipeline row'), Math.round(l.ageDays) + 'd']))}`).join('') || '<p>All callbacks are being worked.</p>';
  },
  payaudit(d) {
    const c = d.current || { rows: [] }, adj = d.adjustments || { owe: [], recover: [] }, diff = d.diff, drift = d.drift || [];
    const tierTxt = (st) => st === 'green' ? 'On' : st === 'yellow' ? 'Grace' : st === 'red' ? 'Off' : esc(st || '');
    let h = `<h4>Pay week ${esc(c.start || '')} to ${esc(c.end || '')} · ${money(c.total)} net (${money(c.pay)} pay, ${money(c.claw)} clawback)</h4>`;
    h += table(['Rep', 'Tier', 'Deals', 'Pay', 'Claw', 'Net', 'Rate'], (c.rows || []).slice().sort((a, b) => b.net - a.net).map(r => [esc(r.rep), tierTxt(r.st) + (r.cbNew ? ` <span class="warn">chargeback ${money(r.cb)}</span>` : ''), r.payCount, money(r.pay), r.claw ? money(-r.claw) : '', `<strong>${money(r.net)}</strong>`, r.rate == null ? '–' : r.rate + '%']));
    const adjRows = [...adj.owe.map(a => [esc(a.rep), esc(a.week), 'Owe rep', `<strong>${money(a.amount)}</strong>`]), ...adj.recover.map(a => [esc(a.rep), esc(a.week), 'Recover', `<strong>${money(-a.amount)}</strong>`])];
    h += `<h4>Adjustments (${adjRows.length})${adjRows.length ? ` · net ${money(adj.net)}` : ''}${out(linkFor('payaudit'), 'open Upfront pay ↗')}</h4>` + (adjRows.length ? table(['Rep', 'Pay week', 'Direction', 'Amount'], adjRows) : '<p>Every closed week matches what was paid.</p>');
    if (diff) {
      const rows = [...diff.changed.map(x => [esc(x.rep), 'Net changed', `${money(x.from)} → ${money(x.to)}`]), ...diff.tier.map(x => [esc(x.rep), 'Tier', `${tierTxt(x.from)} → ${tierTxt(x.to)}`]), ...diff.added.map(x => [esc(x.rep), 'New on run', money(x.net)]), ...diff.dropped.map(x => [esc(x.rep), 'Dropped off run', money(x.net)])];
      h += `<h4>Since last audit (${esc(diff.prevDay || '')})</h4>` + (rows.length ? table(['Rep', 'Change', 'Detail'], rows) : '<p>No changes.</p>');
    } else h += '<p class="muted">First audit. Week-over-week changes start next Thursday.</p>';
    if (drift.length) h += '<h4>Closed weeks</h4>' + table(['Pay week', 'Owed now', 'Paid at close', 'Mismatches', ''], drift.map(w => [esc(w.start), money(w.owed), money(w.paid), w.rows.length, w.settledByAudit ? '<span class="muted">settled in Sep audit</span>' : '']));
    if (d.rosterSynced === false) h += '<p class="warn">The upfront roster sheet did not load; this run used the built-in fallback list.</p>';
    return h;
  },
  chief(d) {
    const roll = d.roll || { rows: [], missed: [] }, items = d.items || [], closed = d.closed || [], queued = d.queued || [];
    const sev = (s) => s >= 3 ? '<span class="warn">high</span>' : s === 2 ? 'medium' : '<span class="muted">low</span>';
    let h = `<h4>To-do (${items.length})</h4>` + (items.length ? table(['', 'Item', 'Owner', 'Open'], items.map(i => [sev(i.severity), esc(i.title) + out(linkFor(i.key)), `<a href="#" data-open="${esc(i.owner)}">${esc(i.owner)}</a>`, i.carried ? `${i.daysOpen}d` : '<span class="muted">new</span>'])) : '<p>Nothing on the list.</p>');
    if (d.minor) h += `<p class="muted">Plus ${d.minor} minor flag${d.minor === 1 ? '' : 's'} not listed (${Object.entries(d.minorByOwner || {}).map(([k, v]) => `${esc(k)} ${v}`).join(', ')}).</p>`;
    if (d.wins && d.wins.length) h += `<h4>Wins to share (${d.wins.length})</h4>` + table(['Highlight'], d.wins.map(w => [esc(w.text)]));
    if (closed.length) h += `<h4>Closed since last brief (${closed.length})</h4>` + table(['Item', 'Owner', 'Was open'], closed.map(c => [esc(c.title), esc(c.owner), `${c.daysOpen}d`]));
    h += `<h4>Roll call · ${roll.present}/${roll.total} present</h4>`;
    const byTeam = {}; for (const r of roll.rows || []) (byTeam[r.team || 'Staff'] ||= []).push(r);
    for (const [team, rows] of Object.entries(byTeam)) {
      const bad = rows.filter(r => ['failed', 'blocked', 'stale'].includes(r.state)).length;
      h += `<p><strong>${esc(team)}</strong> <span class="muted">· ${rows.length} · ${bad ? `<span class="warn">${bad} need attention</span>` : 'all present'}</span></p>` + table(['Worker', 'State', 'Last word'], rows.sort((a, b) => (b.lead === true) - (a.lead === true)).map(r => [`<a href="#" data-open="${esc(r.id)}">${esc(r.name)}</a>${r.lead ? ' <span class="muted">lead</span>' : ''}`, `<span class="st-${esc(r.state)}">${esc(r.state)}</span>${r.hint ? `<br><span class="muted">${esc(r.hint)}</span>` : ''}`, esc(r.bubble || '')]));
    }
    if (queued.length) h += `<h4>Handed to the Runner</h4>` + table(['Task', 'For', 'State', 'Why'], queued.map(q => [esc(q.kind), esc(q.agent), esc(q.state), esc(q.note || '')]));
    return h;
  },
  isp(d) {
    const s = d || {}; const flags = s.flags || [], wins = s.wins || [], weeks = s.weeks || [];
    const sev = (x) => x >= 3 ? '<span class="warn">high</span>' : 'medium';
    const trend = s.soldAvg ? `${s.soldPace >= s.soldAvg ? '▲' : '▼'} pace ${s.soldPace}/wk vs ${s.soldAvg} avg` : '';
    let h = `<h4>This week (${esc(s.week || '')}, day ${s.daysIn || '?'})${s.soldFrom ? ` · sales from ${esc(s.soldFrom)}` : ''}</h4>` + table(['Sold', 'Installed', 'Cancelled', 'Doors', 'Sold/100 doors', 'Reps'], [[`<strong>${s.sold ?? 0}</strong> <span class="muted">${esc(trend)}</span>`, s.installed ?? 0, (s.cancelled ?? 0) + (s.clawback ? ` <span class="warn">+${s.clawback} clawback</span>` : ''), s.doors ?? 0, s.soldPer100 ?? '–', s.reps ?? 0]]);
    h += table(['Install rate (8 wk)', 'Booking lag', 'Pending', 'Past due'], [[`${s.installRate ?? '–'}%${s.installRatePrev != null ? ` <span class="muted">was ${s.installRatePrev}%</span>` : ''}`, `${s.lag ?? '–'}d${s.lagPrev != null ? ` <span class="muted">was ${s.lagPrev}d</span>` : ''}`, s.pending ?? 0, s.pastDue ? `<span class="warn">${s.pastDue}</span>` : 0]]);
    h += `<h4>Flags (${flags.length})</h4>` + (flags.length ? table(['', 'What'], flags.map(x => [sev(x.severity), esc(x.text) + out(ispLink(s.isp, x.key))])) : '<p>Nothing out of the ordinary.</p>');
    h += `<h4>Wins (${wins.length})</h4>` + (wins.length ? table(['Share this'], wins.map(x => [esc(x.text) + out(ispLink(s.isp, x.key))])) : '<p class="muted">Nothing to shout about yet this week.</p>');
    if (s.recon) {
      const r = s.recon;
      h += `<h4>Bria vs the install report (since ${esc(r.from)})</h4><p>${r.matched} of ${r.bria} Bria sales are on the report. The report covers sales through ${esc(r.through || '–')}${r.awaiting ? `; ${r.awaiting} newer sale${r.awaiting === 1 ? ' is' : 's are'} still waiting on it` : ''}${r.cantMatch ? `; ${r.cantMatch} can't be matched (no full name in Bria)` : ''}.</p>`;
      h += `<h4>In Bria, not on the report (${r.notOnReportN ?? r.notOnReport.length})</h4>` + (r.notOnReport.length ? table(['Customer', 'Rep', 'Sold'], r.notOnReport.map(x => [esc(x.customer), esc(x.rep), esc(x.sale_date)])) : '<p>None. Every Bria sale made it onto the report.</p>');
      h += `<h4>On the report, not in Bria (${r.reportOnlyN ?? r.reportOnly.length})</h4>` + (r.reportOnly.length ? table(['Customer', 'Rep', 'Sold', 'Status'], r.reportOnly.map(x => [esc(x.customer), esc(x.rep), esc(x.sale_date), esc(x.status)])) : '<p>None.</p>');
    }
    if (s.reasons && s.reasons.length) h += `<h4>Cancel reasons this week</h4>` + table(['Reason', 'Count'], s.reasons.map(r => [esc(r[0]), r[1]]));
    h += `<h4>Last 12 weeks</h4>` + table(['Week', 'Sold', 'Installed', 'Cancelled', 'Doors', 'Reps'], weeks.map(w => [esc(w.week), w.sold, w.installed, w.cancelled + (w.clawback ? `+${w.clawback}` : ''), w.doors, w.reps]));
    return h;
  },
  'sales-lead'(d) {
    const r = d || {}; const isps = r.isps || [], flags = r.flags || [], wins = r.wins || [];
    let h = `<h4>Company this week (${esc(r.week || '')})</h4>` + table(['Sold', 'Installed', 'Cancelled', 'Doors', 'Pending', 'Past due'], [[`<strong>${r.sold ?? 0}</strong>`, r.installed ?? 0, r.cancelled ?? 0, r.doors ?? 0, r.pending ?? 0, r.pastDue ? `<span class="warn">${r.pastDue}</span>` : 0]]);
    h += `<h4>By ISP</h4>` + table(['ISP', 'Sold (Bria)', 'Pace vs avg', 'Installed', 'Cancelled', 'Install rate', 'Lag', 'Bria not on report', 'Report not in Bria', 'Doors', 'Reps', 'Flags'], isps.map(i => [`<a href="#" data-open="isp-${esc(i.isp)}">${esc(i.name)}</a>`, `<strong>${i.sold}</strong>`, i.soldAvg ? `${i.soldPace} / ${i.soldAvg}` : '–', i.installed, i.cancelled, i.installRate == null ? '–' : i.installRate + '%', i.lag == null ? '–' : i.lag + 'd', i.notOnReport ?? '–', i.reportOnly ?? '–', i.doors, i.reps, i.flags ? `<span class="warn">${i.flags}</span>` : '']));
    h += `<h4>Wins to share (${wins.length})</h4>` + (wins.length ? table(['ISP', 'Highlight'], wins.map(w => [esc(w.isp), esc(w.text) + out(linkFor('isp:' + w.key))])) : '<p class="muted">No highlights yet this week.</p>');
    h += `<h4>Flags across ISPs (${flags.length})</h4>` + (flags.length ? table(['ISP', '', 'What'], flags.map(x => [esc(x.isp), x.severity >= 3 ? '<span class="warn">high</span>' : 'medium', esc(x.text) + out(linkFor('isp:' + x.key))])) : '<p>Nothing out of the ordinary anywhere.</p>');
    return h;
  },
  subs(list) {
    const rows = (Array.isArray(list) ? list : []).map(s => [esc(s.displayName || s.merchant || s.name), esc(s.cadence), money(s.latest ?? s.latestAmount), money(s.monthlyEquivalent), s.priceIncrease ? `▲ from ${money(s.previous ?? s.previousAmount)}` : '', s.possiblyLapsed ? 'maybe lapsed' : esc(s.expectedNext || '')]);
    return table(['Merchant', 'Cadence', 'Last charge', 'Per month', 'Change', 'Next expected'], rows);
  },
  evaltrack(d) {
    const acc = d.accounts || d.rows || [];
    const rules = (a) => a.hasRules === false ? '<span class="warn">set in hub</span>' : null;
    return table(['Account', 'Firm', 'Trades', 'Net since start', 'Worst drop', 'Progress', 'Drawdown used', 'Days left'], acc.map(a => [esc(a.account_id || a.id), esc(a.firm), a.trades ?? '–', money(a.net), money(a.maxDd), rules(a) || pct(a.progress), rules(a) || pct(a.ddUsed), a.daysLeft ?? '–'])) + (d.warnings && d.warnings.length ? `<p class="warn">Warnings: ${esc(d.warnings.join(', '))}</p>` : '');
  },
  journal(d) {
    if (!d || !d.n) return '<p>No trades that day.</p>';
    return table(['Stat', 'Value'], [['Trades today', d.copiedTo > 1 ? `${d.n} (copied to ${d.copiedTo} accounts, ${d.fills} rows)` : d.accounts > 1 ? `${d.n} (${d.accounts} accounts)` : d.n], ['Wins / losses', `${d.wins} / ${d.losses}`], ['Win rate', pct((d.winRate || 0) / 100)], ['Net', money(d.netTotal)], ['Average', money(d.avgNet)], ['Best hour', esc(d.bestHour)], ['Worst hour', esc(d.worstHour)], ['Biggest win', money(d.biggestWin?.net ?? d.biggestWin)], ['Biggest loss', money(d.biggestLoss?.net ?? d.biggestLoss)], ['Longest loss streak', d.lossStreak ?? d.longestLossStreak ?? '–']]);
  },
  trainer(d) {
    return table(['Item', 'Value'], [['Workouts this week', `${d.done ?? d.thisWeek ?? '–'} of ${d.planned ?? '–'}`], ['Missed so far', d.missed ?? d.missedSoFar ?? 0], ['PRs this week', d.prsThisWeek ?? d.prs ?? 0], ['Stalled lifts', esc((d.stalled || []).join(', ') || 'none')]]);
  },
  debt(d) {
    return table(['Debt', 'Balance', 'APR', 'Minimum'], (d.debts || []).map(x => [esc(x.name), money(x.balance ?? x.current_balance), pct(x.apr > 1 ? x.apr / 100 : x.apr), money(x.minimum ?? x.minimum_payment)])) + (d.plan ? `<p>Payoff estimate: <strong>${esc(d.plan.label || d.plan.payoffLabel || '')}</strong> · interest ${money(d.plan.totalInterest)} · paid this month ${money(d.paid30)}</p>` : '');
  },
};

export function renderFindings(agentId, snap) {
  if (!snap) return '<p class="muted">No findings saved yet. Run it once.</p>';
  const key = agentId.startsWith('chief-') ? 'chief' : agentId.startsWith('isp-') ? 'isp' : agentId.startsWith('slots-') ? 'slots' : agentId;
  const body = R[key] ? R[key](snap.data) : `<pre class="raw">${esc(JSON.stringify(snap.data, null, 1)).slice(0, 4000)}</pre>`;
  return `<div class="findings"><div class="muted">Findings from ${esc(snap.day)}</div>${body}</div>`;
}
