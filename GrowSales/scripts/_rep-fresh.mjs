// Per-rep "last pulled new data" stamps for the Knocking board.
//
// Every knocking sync rewrites its rep/days wholesale (delete then insert), so
// created_at on a knocking row says when the row was last REWRITTEN, not when
// anything in it changed. The only way to know a rep got new doors is to compare
// what was there before the write with what is being written. So:
//
//   const prev = await snapshotKnock(SB, H, 'tds', recs);   // BEFORE the delete
//   ... delete + insert ...
//   await stampFresh(SB, H, 'tds', prev, recs);             // AFTER it succeeds
//
// A rep is stamped when any of their rep/days is new or has different doors,
// contacts or sold. Stamps live in report_config under __knock_fresh_<source>__
// as {rep: iso}, one row per source so three syncs never overwrite each other's
// JSON. The app already loads every report_config row, so no fetch and no schema.
//
// Never throws: a missed stamp is cosmetic, the knocking write is what counts.

const KEEP_DAYS = 14;
const sig = (r) => `${r.doors || 0}|${r.contacts || 0}|${r.sold || 0}`;

// `extra` narrows the read to the rows this sync owns (grow: &method=eq.sr_activity).
export async function snapshotKnock(SB, H, source, rows, extra = '') {
  try {
    if (!rows || !rows.length) return null;
    const from = rows.reduce((m, r) => (r.date < m ? r.date : m), rows[0].date);
    const out = new Map();
    for (let off = 0; ; off += 1000) {
      const r = await fetch(`${SB}/rest/v1/knocking?select=rep,date,doors,contacts,sold&source=eq.${encodeURIComponent(source)}&date=gte.${from}${extra}&order=date,rep&limit=1000&offset=${off}`,
        { headers: { apikey: H.apikey, Authorization: H.Authorization } });
      if (!r.ok) return null;
      const j = await r.json();
      // One rep can hold several rows on a day (grow's sr_activity + sr_frozen_kc),
      // so sum them, the same way the incoming rows are summed below.
      for (const x of j) {
        const k = x.rep + '|' + x.date, e = out.get(k) || { doors: 0, contacts: 0, sold: 0 };
        e.doors += x.doors || 0; e.contacts += x.contacts || 0; e.sold += x.sold || 0;
        out.set(k, e);
      }
      if (j.length < 1000) break;
    }
    return out;
  } catch { return null; }
}

export async function stampFresh(SB, H, source, prev, rows) {
  try {
    if (!prev || !rows || !rows.length) return 0;
    const next = new Map();
    for (const x of rows) {
      const k = x.rep + '|' + x.date, e = next.get(k) || { doors: 0, contacts: 0, sold: 0 };
      e.doors += x.doors || 0; e.contacts += x.contacts || 0; e.sold += x.sold || 0;
      next.set(k, e);
    }
    const changed = new Set();
    for (const [k, e] of next) {
      if (!(e.doors || e.contacts || e.sold)) continue;       // an empty row is not news
      const p = prev.get(k);
      if (!p || sig(p) !== sig(e)) changed.add(k.split('|')[0]);
    }
    if (!changed.size) return 0;

    const key = `__knock_fresh_${source}__`;
    const r = await fetch(`${SB}/rest/v1/report_config?select=config&manager=eq.${key}&limit=1`,
      { headers: { apikey: H.apikey, Authorization: H.Authorization } });
    const cur = r.ok ? (((await r.json())[0] || {}).config || {}) : {};
    const now = new Date().toISOString();
    const cut = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString();
    const cfg = {};
    for (const [rep, at] of Object.entries(cur)) if (typeof at === 'string' && at >= cut) cfg[rep] = at;
    for (const rep of changed) cfg[rep] = now;
    await fetch(`${SB}/rest/v1/report_config?on_conflict=manager`, {
      method: 'POST',
      headers: { apikey: H.apikey, Authorization: H.Authorization, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ manager: key, config: cfg }]),
    });
    console.log(`  fresh: stamped ${changed.size} rep${changed.size === 1 ? '' : 's'} with new data`);
    return changed.size;
  } catch { return 0; }
}
