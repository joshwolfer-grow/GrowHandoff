// Install-time desks: pure helpers. One desk per ISP that GrowSales'
// scripts/install-slots.mjs has an adapter for.

// Desk code -> the name on the card. Add an ISP here once install-slots.mjs has its adapter.
export const NAME = { tds: 'TDS', surf: 'Surf' };
// Earliest install this many days out or more is worth a flag.
export const FAR_OUT = 7;

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const day = (ymd) => (ymd ? `${MON[+ymd.slice(5, 7) - 1]} ${+ymd.slice(8, 10)}` : '–');

// rows: install-slots.jsonl rows from this run. The newest read per market wins.
export function summarize(isp, rows) {
  const by = new Map();
  for (const r of rows || []) {
    if (r.isp !== isp || !r.market) continue;
    const p = by.get(r.market);
    if (!p || String(r.checked_at) >= String(p.checked_at)) by.set(r.market, r);
  }
  const markets = [...by.values()].map((r) => ({
    market: r.market, address: r.address, checked_at: r.checked_at, ok: !!r.ok,
    earliest_date: r.ok ? r.earliest_date || null : null,
    days_out: r.ok && r.days_out != null ? r.days_out : null,
    windows_first_day: r.ok ? r.windows_first_day || 0 : null,
    windows_next_7d: r.ok ? r.windows_next_7d || 0 : null,
    error: r.ok ? null : String(r.error || 'unknown error').split('\n')[0].slice(0, 200),
  })).sort((a, b) => (b.ok - a.ok) || ((a.days_out ?? 999) - (b.days_out ?? 999)) || a.market.localeCompare(b.market));

  const flags = [];
  // One flag for unread doors, however many: a portal outage is one problem, not seven.
  const failed = markets.filter((m) => !m.ok);
  if (failed.length === 1) flags.push({ key: `slots:${isp}:failed`, text: `${failed[0].market}: could not read the install calendar (${failed[0].error})`, severity: 2 });
  else if (failed.length) flags.push({ key: `slots:${isp}:failed`, text: `${failed.length} markets could not be read (${failed.map((m) => m.market).join(', ')}): ${failed[0].error}`, n: failed.length, severity: 2 });
  for (const m of markets) {
    if (!m.ok) continue;
    if (!m.earliest_date) flags.push({ key: `slots:${isp}:none:${m.market}`, text: `${m.market}: no install dates offered`, severity: 3 });
    else if (m.days_out >= FAR_OUT) flags.push({ key: `slots:${isp}:far:${m.market}`, text: `${m.market}: earliest install is ${m.days_out} days out (${day(m.earliest_date)})`, n: m.days_out, severity: 2 });
  }
  return { isp, name: `${NAME[isp] || isp} install times`, markets, flags };
}

export function statusLine(s) {
  const read = s.markets.filter((m) => m.ok && m.earliest_date);
  const failed = s.markets.filter((m) => !m.ok).length;
  const label = NAME[s.isp] || s.isp;
  if (!s.markets.length) return `${label}: no markets read`;
  if (!read.length) return `${label}: no install dates read (${failed} of ${s.markets.length} markets failed)`;
  const first = read[0], last = read[read.length - 1];
  const span = read.length === 1 ? `earliest ${day(first.earliest_date)} in ${first.market} (${first.days_out}d)`
    : `soonest ${day(first.earliest_date)} in ${first.market} (${first.days_out}d), latest ${day(last.earliest_date)} in ${last.market} (${last.days_out}d)`;
  return `${label}: ${span} · ${read.length}/${s.markets.length} markets${failed ? `, ${failed} failed` : ''}`;
}
