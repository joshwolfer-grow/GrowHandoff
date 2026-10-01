// Pure logic for the chaser worker. No I/O.

const dayMs = 24 * 3600 * 1000;

function isTerminal(stage) {
  if (!stage) return false;
  const s = stage.toLowerCase();
  return ['won', 'lost', 'closed', 'dead', 'install'].some((t) => s.includes(t));
}

// leads: [{ id, isp, grow_rep, grow_manager, cancel_date, grow_status }]
// pipeline: [{ key, stage, call_on, updated_at }]
export function chase(leads, pipeline, todayISO, staleDays = 3) {
  const pipelineByKey = new Map(pipeline.map((p) => [String(p.key), p]));
  const nowMs = Date.parse(`${todayISO}T00:00:00Z`);

  const needs = [];
  const byRep = {};

  for (const lead of leads) {
    const p = pipelineByKey.get(String(lead.id));
    let needsChase = false;

    if (!p) {
      needsChase = true;
    } else if (!isTerminal(p.stage)) {
      const updatedMs = p.updated_at ? Date.parse(p.updated_at) : NaN;
      const ageDays = Number.isFinite(updatedMs) ? (nowMs - updatedMs) / dayMs : Infinity;
      if (ageDays >= staleDays) needsChase = true;
    }

    if (!needsChase) continue;

    const updatedMs = p && p.updated_at ? Date.parse(p.updated_at) : NaN;
    const updatedAgeDays = Number.isFinite(updatedMs) ? (nowMs - updatedMs) / dayMs : null;

    const cancelMs = lead.cancel_date ? Date.parse(lead.cancel_date) : NaN;
    const cancelAgeDays = Number.isFinite(cancelMs) ? (nowMs - cancelMs) / dayMs : null;

    const ages = [updatedAgeDays, cancelAgeDays].filter((a) => typeof a === 'number' && Number.isFinite(a));
    const ageDays = ages.length ? Math.floor(Math.max(...ages)) : null;

    const rep = lead.grow_rep || 'Unassigned';
    needs.push(lead.id);
    if (!byRep[rep]) byRep[rep] = [];
    byRep[rep].push({ id: lead.id, ageDays, isp: lead.isp || null, order: lead.order_no || null, cancelled: lead.cancel_date || null, stage: p ? (p.stage || null) : null });
  }

  return { needs, byRep };
}

export function statusLine({ needs, byRep }, totalLeads) {
  if (!needs.length) return `All ${totalLeads} callbacks are being worked`;

  let topRep = null;
  let topCount = -1;
  let oldest = 0;
  for (const [rep, items] of Object.entries(byRep)) {
    if (items.length > topCount) {
      topCount = items.length;
      topRep = rep;
    }
    for (const it of items) {
      if (typeof it.ageDays === 'number' && it.ageDays > oldest) oldest = it.ageDays;
    }
  }

  return `${needs.length} callbacks need a follow-up · ${topRep} has ${topCount} · oldest ${oldest}d`;
}
