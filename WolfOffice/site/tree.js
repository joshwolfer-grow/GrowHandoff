// site/tree.js — the floor as an org tree: Chief -> teams -> lead -> workers.
// Same data as the room (office_agents.team / .lead and each worker's derived state),
// drawn so a problem lights its whole branch up to the Chief. Pure: office.js hands in
// the agents and a state lookup and wires the clicks. Tested in tests/tree.test.mjs.

// Work still done by hand that has a desk planned. Drawn dashed under its team.
export const PLANNED = {
  grow: {
    Ops: [
      { name: 'Stats clerk', note: 'Quick lookups and records, asked from the office' },
      { name: 'Meeting prep', note: 'Monday numbers for the manager deck' },
      { name: 'Support scribe', note: 'ISP support chats into guide updates' },
    ],
  },
};

const RANK = { failed: 4, blocked: 3, stale: 2, working: 1, idle: 0, offduty: 0 };
const COLOR = { failed: '#F09595', blocked: '#FAC775', stale: '#7E8399', working: '#5DCAA5', idle: '#A5ABC0', offduty: '#6F7896' };
const WORD = { working: 'working', idle: 'all good', failed: 'broken', blocked: 'needs you', stale: 'quiet', offduty: 'off' };
const hot = (s) => s === 'failed' || s === 'blocked';
export const worst = (states) => states.reduce((m, s) => ((RANK[s] || 0) > (RANK[m] || 0) ? s : m), 'idle');

// { chief, desk: [front desk workers], teams: [{ name, lead, members, planned, state }], state }
export function treeModel(agents, floor, stateOf, planned = PLANNED) {
  const mine = agents.filter(a => a.floor === floor).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  const st = (a) => (a ? stateOf(a.id) || 'idle' : 'idle');
  const chief = mine.find(a => a.id === `chief-${floor}`) || null;
  const desk = mine.filter(a => a.id.startsWith('runner-'));
  const groups = new Map();
  for (const a of mine) {
    if (a === chief || desk.includes(a)) continue;
    const name = a.team || 'Other';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(a);
  }
  for (const name of Object.keys((planned && planned[floor]) || {})) if (!groups.has(name)) groups.set(name, []);
  const teams = [...groups].map(([name, list]) => {
    const lead = list.find(a => a.lead) || null;
    const members = list.filter(a => a !== lead);
    return { name, lead, members, planned: ((planned && planned[floor]) || {})[name] || [], state: worst(list.map(st)) };
  });
  return { floor, chief, desk, teams, state: worst([...teams.map(t => t.state), ...desk.map(st), st(chief)]) };
}

export function coverage(model) {
  const staffed = model.teams.reduce((n, t) => n + t.members.length + (t.lead ? 1 : 0), 0) + model.desk.length + (model.chief ? 1 : 0);
  const planned = model.teams.reduce((n, t) => n + t.planned.length, 0);
  return { staffed, planned };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ROW = 27, X = { chief: 16, team: 196, lead: 336, leaf: 516 }, W = { chief: 150, team: 112, lead: 150, leaf: 236 };
// Every view is one svg that scales to fit its box; office.js zooms and pans by rewriting viewBox from data-box.
const fit = (w, h) => `viewBox="0 0 ${w} ${h}" data-box="0 0 ${w} ${h}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg"`;

function link(x1, y1, x2, y2, s) {
  const m = (x1 + x2) / 2;
  return `<path d="M${x1} ${y1} C${m} ${y1} ${m} ${y2} ${x2} ${y2}" fill="none" stroke="${hot(s) ? COLOR[s] : '#2C3350'}" stroke-width="${hot(s) ? 2 : 1.25}"/>`;
}
// pageOf(id) -> [title, path, label] when the worker has an office page of its own (the Lead desk), else null.
function node(x, y, w, a, s, pageOf) {
  const page = a && pageOf ? pageOf(a.id) : null;
  const open = page ? `<g class="tree-open" data-overlay="${esc(page[1])}" data-overlay-title="${esc(page[0])}"><rect x="${x + w - 54}" y="${y - 8}" width="48" height="16" rx="8" fill="#283050" stroke="#5FA8FF"/><text x="${x + w - 30}" y="${y + 3.5}" text-anchor="middle" font-size="10.5" font-weight="700" fill="#5FA8FF">open</text></g>` : '';
  return `<g class="tree-node" data-open="${esc(a.id)}"><title>${esc(a.name)}: ${esc(WORD[s] || s)}</title>
    <rect x="${x}" y="${y - 11}" width="${w}" height="22" rx="8" fill="#1F2436" stroke="${hot(s) ? COLOR[s] : '#2C3350'}" stroke-width="${hot(s) ? 2 : 1}"/>
    <circle cx="${x + 14}" cy="${y}" r="4.5" fill="${COLOR[s] || COLOR.idle}"/>
    <text x="${x + 26}" y="${y + 4.5}" font-size="13" font-weight="700" fill="#F1E9DA">${esc(a.name)}</text></g>${open}`;
}
function ghost(x, y, w, p) {
  return `<g class="tree-ghost"><title>${esc(p.note || 'planned')}</title>
    <rect x="${x}" y="${y - 11}" width="${w}" height="22" rx="8" fill="none" stroke="#6F7896" stroke-dasharray="5 4"/>
    <text x="${x + 14}" y="${y + 4.5}" font-size="13" fill="#A5ABC0">${esc(p.name)}</text>
    <text x="${x + w - 10}" y="${y + 4}" text-anchor="end" font-size="11" fill="#6F7896">planned</text></g>`;
}
function label(x, y, w, text, s) {
  return `<g><rect x="${x}" y="${y - 11}" width="${w}" height="22" rx="8" fill="#171B2B" stroke="${hot(s) ? COLOR[s] : '#2C3350'}" stroke-width="${hot(s) ? 2 : 1}"/>
    <text x="${x + w / 2}" y="${y + 4.5}" text-anchor="middle" font-size="12" font-weight="800" letter-spacing=".04em" fill="${hot(s) ? COLOR[s] : '#D3CDBF'}">${esc(text.toUpperCase())}</text></g>`;
}

export function renderTree(model, stateOf, pageOf) {
  const st = (a) => stateOf(a.id) || 'idle';
  let y = 20, links = '', nodes = '';
  const mids = [];
  const branches = [...(model.desk.length ? [{ name: 'Front desk', lead: null, members: model.desk, planned: [], state: worst(model.desk.map(st)) }] : []), ...model.teams];
  for (const t of branches) {
    const leaves = [...t.members.map(a => ({ a })), ...t.planned.map(p => ({ p }))];
    const rows = Math.max(leaves.length, 1), top = y, mid = top + (rows - 1) * ROW / 2;
    mids.push([mid, t.state]);
    nodes += label(X.team, mid, W.team, t.name, t.state);
    const from = t.lead ? X.lead + W.lead : X.team + W.team;
    if (t.lead) { links += link(X.team + W.team, mid, X.lead, mid, t.state); nodes += node(X.lead, mid, W.lead, t.lead, st(t.lead), pageOf); }
    leaves.forEach((l, i) => {
      const ly = top + i * ROW;
      links += link(from, mid, X.leaf, ly, l.a ? st(l.a) : 'idle');
      nodes += l.a ? node(X.leaf, ly, W.leaf, l.a, st(l.a), pageOf) : ghost(X.leaf, ly, W.leaf, l.p);
    });
    y += rows * ROW + 12;
  }
  const H = Math.max(y, 80), cy = mids.length ? (mids[0][0] + mids[mids.length - 1][0]) / 2 : 40;
  for (const [m, s] of mids) links += link(X.chief + W.chief, cy, X.team, m, s);
  const chief = model.chief ? node(X.chief, cy, W.chief, model.chief, hot(model.state) ? model.state : st(model.chief), pageOf) : label(X.chief, cy, W.chief, model.floor, model.state);
  return `${legendHtml(coverage(model))}<svg ${fit(770, H)}>${links}${chief}${nodes}</svg>`;
}

function legendHtml(c) {
  return `<div class="tree-legend">${['working', 'blocked', 'failed', 'stale', 'idle'].map(s => `<span><i style="background:${COLOR[s]}"></i>${WORD[s]}</span>`).join('')}`
    + `<span class="tree-cov">${c.staffed} staffed${c.planned ? ` · ${c.planned} planned` : ''} · scroll to zoom, drag to move</span></div>`;
}

// Everything at once: you in the middle, one floor per direction, teams then workers fanning outward.
// An ellipse, because the stage is wider than it is tall. models = treeModel() per floor, in building order;
// the first floor sits due north and the rest go clockwise, each taking a slice as wide as its headcount.
export function renderRadial(models, stateOf, pageOf, titles = {}) {
  const BW = 1500, BH = 1010, CX = BW / 2, CY = BH / 2, RX = [200, 370, 575], RY = [125, 225, 345], GAP = 5;
  const st = (a) => stateOf(a.id) || 'idle';
  const at = (ring, deg) => { const r = deg * Math.PI / 180; return [CX + RX[ring] * Math.cos(r), CY + RY[ring] * Math.sin(r)]; };
  const line = (p, q, s) => `<path d="M${p[0].toFixed(1)} ${p[1].toFixed(1)} L${q[0].toFixed(1)} ${q[1].toFixed(1)}" stroke="${hot(s) ? COLOR[s] : '#2C3350'}" stroke-width="${hot(s) ? 2 : 1.1}" fill="none"/>`;
  const floors = models.map(m => {
    const branches = [...(m.desk.length ? [{ name: 'Front desk', lead: null, members: m.desk, planned: [], state: worst(m.desk.map(st)) }] : []), ...m.teams]
      .map(t => ({ ...t, leaves: [...(t.lead ? [{ a: t.lead, lead: true }] : []), ...t.members.map(a => ({ a })), ...t.planned.map(p => ({ p }))] }));
    return { m, branches, weight: Math.max(branches.reduce((n, b) => n + b.leaves.length, 0), 7) };
  });
  const unit = (360 - GAP * floors.length) / Math.max(1, floors.reduce((n, f) => n + f.weight, 0));
  let deg = -90 - (floors.length ? floors[0].weight * unit / 2 : 0), links = '', nodes = '';
  const total = { staffed: 0, planned: 0 };
  for (const f of floors) {
    const span = f.weight * unit, mid = deg + span / 2, fp = at(0, mid), c = coverage(f.m);
    total.staffed += c.staffed; total.planned += c.planned;
    links += line([CX, CY], fp, f.m.state);
    const count = f.branches.reduce((n, b) => n + b.leaves.length, 0);
    let slot = deg + (span - count * unit) / 2;
    for (const b of f.branches) {
      const bmid = slot + b.leaves.length * unit / 2, bp = at(1, bmid);
      links += line(fp, bp, b.state);
      b.leaves.forEach((l, i) => {
        const d = slot + (i + 0.5) * unit, lp = at(2, d), s = l.a ? st(l.a) : 'idle';
        links += line(bp, lp, s);
        const left = Math.cos(d * Math.PI / 180) < 0, rot = left ? d + 180 : d, dir = left ? -1 : 1, anchor = left ? 'end' : 'start';
        const page = l.a && pageOf ? pageOf(l.a.id) : null;
        const chip = page ? `<text class="tree-open" data-overlay="${esc(page[1])}" data-overlay-title="${esc(page[0])}" x="${dir * 12}" y="5" text-anchor="${anchor}" font-size="15" font-weight="800" fill="#5FA8FF">open</text>` : '';
        const tx = dir * (page ? 56 : 12);
        nodes += l.a
          ? `<g transform="translate(${lp[0].toFixed(1)} ${lp[1].toFixed(1)}) rotate(${rot.toFixed(1)})"><g class="tree-node" data-open="${esc(l.a.id)}"><title>${esc(l.a.name)}: ${esc(WORD[s] || s)}</title><circle r="${hot(s) ? 8 : 6}" fill="${COLOR[s] || COLOR.idle}"/><text x="${tx}" y="5" text-anchor="${anchor}" font-size="15.5" font-weight="${l.lead ? 800 : 600}" fill="${hot(s) ? COLOR[s] : '#F1E9DA'}">${esc(l.a.name)}</text></g>${chip}</g>`
          : `<g class="tree-ghost" transform="translate(${lp[0].toFixed(1)} ${lp[1].toFixed(1)}) rotate(${rot.toFixed(1)})"><title>${esc(l.p.note || 'planned')}</title><circle r="5" fill="none" stroke="#6F7896" stroke-dasharray="3 2"/><text x="${tx}" y="5" text-anchor="${anchor}" font-size="15.5" fill="#8A91A8">${esc(l.p.name)} (planned)</text></g>`;
      });
      nodes += `<text x="${bp[0].toFixed(1)}" y="${(bp[1] + 4).toFixed(1)}" text-anchor="middle" font-size="13.5" font-weight="800" letter-spacing=".05em" fill="${hot(b.state) ? COLOR[b.state] : '#D3CDBF'}" stroke="#0F1220" stroke-width="5" paint-order="stroke">${esc(b.name.toUpperCase())}</text>`;
      slot += b.leaves.length * unit;
    }
    const name = titles[f.m.floor] || f.m.floor;
    nodes += `<g class="tree-node" data-floor="${esc(f.m.floor)}"><title>Open the ${esc(name)} tree</title><rect x="${(fp[0] - 75).toFixed(1)}" y="${(fp[1] - 19).toFixed(1)}" width="150" height="38" rx="14" fill="#1F2436" stroke="${hot(f.m.state) ? COLOR[f.m.state] : '#5FA8FF'}" stroke-width="${hot(f.m.state) ? 2.5 : 1.5}"/>`
      + `<text x="${fp[0].toFixed(1)}" y="${(fp[1] + 6).toFixed(1)}" text-anchor="middle" font-size="18" font-weight="800" fill="#F1E9DA">${esc(name)} · ${c.staffed}</text></g>`;
    deg += span + GAP;
  }
  const all = worst(models.map(m => m.state));
  const hub = `<circle cx="${CX}" cy="${CY}" r="52" fill="#171B2B" stroke="${hot(all) ? COLOR[all] : '#E9B44C'}" stroke-width="2.5"/><text x="${CX}" y="${CY - 2}" text-anchor="middle" font-size="21" font-weight="800" fill="#F1E9DA">You</text><text x="${CX}" y="${CY + 19}" text-anchor="middle" font-size="13" fill="#A5ABC0">${hot(all) ? WORD[all] : 'all good'}</text>`;
  return `${legendHtml(total)}<svg ${fit(BW, BH)}>${links}${hub}${nodes}</svg>`;
}
