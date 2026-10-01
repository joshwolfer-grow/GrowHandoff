// Pure logic for the installs worker. No I/O.

const dayMs = 24 * 3600 * 1000;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / dayMs);

// prevMap / curMap: { [bria_id]: { install_date, install_time, rep, isp, sale_date } }
export function diff(prevMap, curMap, todayISO) {
  const pushed = [];
  const pulledIn = [];
  const cancelled = [];
  const newlyBooked = [];
  const pendingPastWindow = [];
  const farOut = [];

  const ids = new Set([...Object.keys(prevMap || {}), ...Object.keys(curMap || {})]);

  for (const id of ids) {
    const prev = prevMap ? prevMap[id] : undefined;
    const cur = curMap ? curMap[id] : undefined;
    if (!cur) continue; // deal disappeared entirely; nothing to report here

    const prevDate = prev ? prev.install_date : undefined;
    const curDate = cur.install_date;

    if (prevDate && curDate && curDate !== prevDate) {
      const delta = daysBetween(prevDate, curDate);
      if (delta > 0) pushed.push({ id, rep: cur.rep, days: delta });
      else if (delta < 0) pulledIn.push({ id, rep: cur.rep, days: -delta });
    } else if (prevDate && !curDate) {
      cancelled.push({ id, rep: cur.rep });
    } else if (!prevDate && curDate) {
      newlyBooked.push({ id, rep: cur.rep });
    }

    if (curDate && curDate < todayISO) {
      pendingPastWindow.push({ id, rep: cur.rep, install_date: curDate });
    }

    if (curDate && cur.sale_date) {
      const outDays = daysBetween(cur.sale_date, curDate);
      if (outDays > 10) farOut.push({ id, rep: cur.rep, days: outDays });
    }
  }

  const worstPush = pushed.reduce((w, p) => (!w || p.days > w.days ? p : w), null);
  const worstFarOut = farOut.reduce((w, p) => (!w || p.days > w.days ? p : w), null);

  return {
    pushed,
    pulledIn,
    cancelled,
    newlyBooked,
    pendingPastWindow,
    farOut,
    worstPush,
    worstFarOut,
  };
}

export function statusLine(result, isFirstRun, totalDeals) {
  if (isFirstRun) {
    return `First snapshot: ${totalDeals} deals tracked, ${result.farOut.length} booked 10+ days out`;
  }
  const pushPart = result.worstPush
    ? `${result.pushed.length} pushed (${result.worstPush.rep} +${result.worstPush.days}d)`
    : `${result.pushed.length} pushed`;
  return `${pushPart} · ${result.cancelled.length} cancelled · ${result.farOut.length} booked 10+ days out · ${result.newlyBooked.length} newly booked`;
}
