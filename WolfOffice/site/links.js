// site/links.js — deep links from a finding into the Grow dashboard.
// The dashboard accepts ?go=<area> (weeks, cancels, callbacks, upfront, alldeals,
// knockboard, ops, customreport, markets) and ?rep=<Name> for a rep's own view.
// Nothing here changes the dashboard; when an area cannot be pinned closer than
// its tab (there is no ?isp= filter yet), the link lands on the tab.
export const GROW = 'https://growsales.vercel.app/';
const go = (area, isp) => `${GROW}?go=${encodeURIComponent(area)}${isp ? `&isp=${encodeURIComponent(isp)}` : ''}`;
// ISP names exactly as they appear on deal rows, keyed by the desk code.
export const ISP_NAME = { i3: 'i3 Broadband', slic: 'SLIC', lyte: 'Lyte Fiber', surf: 'Surf', tds: 'TDS', ezee: 'Ezee Fiber', omni: 'Omni Fiber' };
const rep = (name) => `${GROW}?rep=${encodeURIComponent(name)}`;

// A Custom Report opened with the exact setup for a finding.
const CR_COLS = ['sold', 'inst', 'canc', 'pend', 'cir', 'ir', 'book'];
export function report(setup) {
  const st = { range: 'tw', f: {}, group: 'rep', cols: CR_COLS, sort: 'sold', ...setup };
  return `${GROW}?go=customreport&cr=${encodeURIComponent(JSON.stringify(st))}`;
}
const forIsp = (name, more = {}) => report({ ...more, f: { ...(name ? { isp: [name] } : {}), ...(more.f || {}) } });

// Area for a worker's card button: [label, url, buttonText?].
export const AGENT_AREA = {
  // A path (not a full URL) is an office page and opens in the overlay, not the Grow dashboard.
  payaudit: ['Upfront pay', go('upfront')],
  chaser: ['Callbacks', go('callbacks')],
  installs: ['All deals', go('alldeals')],
  analyst: ['Rep cards', go('funnels')],
  crawler: ['Knock board', go('knockboard')],
  amplify: ['Knock board', go('knockboard')],
  rtr: ['Knock board', go('knockboard')],
  courier: ['Lead desk', '/leads.html', 'Open the lead desk'],
  exporter: ['Ops tasks', go('ops')],
  'sales-lead': ['Last 4 weeks by ISP', report({ range: 'l4', group: 'isp', sort: 'sold' })],
};
export function agentArea(id) {
  if (AGENT_AREA[id]) return AGENT_AREA[id];
  if (id.startsWith('isp-')) return ['Last 4 weeks for ' + (ISP_NAME[id.slice(4)] || 'this ISP'), forIsp(ISP_NAME[id.slice(4)], { range: 'l4', group: 'week', sort: 'sold' })];
  if (id.startsWith('slots-')) return ['Install slots', go('installslots')];
  if (id === 'chief-grow') return ['Grow dashboard', GROW];
  return null;
}

// Link for one finding key, e.g. "isp:slic:cancels-up", "chaser:Kyle Camp",
// "payaudit:owe:Ann:2026-09-03", "installs:cancel:D1", "analyst:Eve:leadTimeDays".
export function linkFor(key) {
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
export function ispLink(ispKey, flagKey) { return linkFor(flagKey.startsWith('isp:') ? flagKey : `isp:${flagKey}`); }
export const out = (url, label = 'open ↗') => url ? ` <a class="deep" href="${url}" target="_blank" rel="noopener" title="Open this in the Grow dashboard">${label}</a>` : '';
