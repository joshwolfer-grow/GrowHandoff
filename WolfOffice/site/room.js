// site/room.js — one isometric office room per floor: layout, blocked tiles,
// named spots, and the static SVG for floor, walls and furniture. Floors share
// the builder; a skin sets materials and set dressing.
import { TILE_W, TILE_H, WALL_H, toScreen, tilePath, depth, key } from './iso.js';

const S = 'stroke="#2B2118" stroke-width="2" stroke-linejoin="round"';
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const SKINS = {
  grow: {
    title: 'Grow', accent: '#2E9C6D', floorA: '#D9B98A', floorB: '#CFAE7E', floorLine: '#B8955F',
    wall: '#EFE3CF', wallLow: '#D9C6A4', trim: '#8B5A2B', deskTop: '#C48A4A', deskSide: '#8B5A2B', deskEdge: '#6B4423',
    screen: '#1E2440', chair: '#3B6D11', rug: '#B5533C', couch: '#2E9C6D', window: 'field', wallArt: 'map', plants: 'leafy',
    boardTitle: 'GROW · today',
  },
};
export const FLOOR_ORDER = ['grow'];   // Grow only since Oct 1 2026; other floors retired

// ---- layout ----
// cols run down-right (along the right wall), rows run down-left (along the left wall).
// Each team gets its own room along the back wall, side by side, separated by
// partition walls with the team plaque on them. The front strip is shared: the
// door and the Runner's desk on the left, the Chief's corner office on the right,
// coffee, couches and the lunch table in between.
export const PER_ROW = 3;
export const BLOCK_W = 13;          // tiles per team room (3 desks wide plus margins)
export const GAP = 1;               // partition wall thickness
export function buildRoom(floorKey, agents) {
  const skin = SKINS[floorKey] || SKINS.grow;
  const raw = agents.filter(a => !a.id.startsWith('runner-') && !a.id.startsWith('chief-'));
  const runner = agents.find(a => a.id.startsWith('runner-')) || null;
  const chief = agents.find(a => a.id.startsWith('chief-')) || null;
  const perRow = PER_ROW;
  const teamOrder = [];
  for (const a of raw.slice().sort((x, y) => (y.lead === true) - (x.lead === true) || (x.sort || 0) - (y.sort || 0))) { const t = a.team || 'Staff'; if (!teamOrder.includes(t)) teamOrder.push(t); }
  const staff = raw.slice().sort((x, y) => teamOrder.indexOf(x.team || 'Staff') - teamOrder.indexOf(y.team || 'Staff') || (y.lead === true) - (x.lead === true) || (x.sort || 0) - (y.sort || 0));
  const teams = teamOrder.map(name => { const members = staff.filter(a => (a.team || 'Staff') === name); return { name, lead: (members.find(a => a.lead) || members[0] || {}).id, members: members.map(a => a.id), firstIndex: staff.indexOf(members[0]), deskRows: Math.max(1, Math.ceil(members.length / perRow)) }; });
  if (!teams.length) teams.push({ name: 'Staff', lead: null, members: [], firstIndex: 0, deskRows: 1 });

  // Team rooms across the back; the deepest room sets the depth of all of them.
  const depth = Math.max(...teams.map(t => t.deskRows * 3 + 1), 4);
  let gx = 1;
  // Room width follows the widest desk row: 1 desk → 5 tiles, 2 → 9, 3 → 13.
  for (const t of teams) { t.gx0 = gx; t.gy0 = 1; t.w = Math.min(perRow, Math.max(1, t.members.length)) * 4 + 1; t.d = depth; gx += t.w + GAP; }
  const cols = Math.max(gx + 1, 18);
  const fy = 1 + depth + 1;            // first row of the shared front strip
  const rows = fy + 7;
  const origin = { x: rows * (TILE_W / 2) + TILE_W, y: WALL_H + TILE_H };
  const blocked = new Set();
  const block = (gx, gy, w = 1, h = 1) => { for (let x = gx; x < gx + w; x++) for (let y = gy; y < gy + h; y++) blocked.add(key(x, y)); };
  const furniture = [];
  const add = (f) => { furniture.push(f); if (f.w || f.h) block(f.gx, f.gy, f.w || 1, f.h || 1); return f; };

  // Desks inside each team room: 2 wide by 1 deep, seat behind (gy-1), facing the viewer.
  const desks = [];
  for (const t of teams) {
    t.members.forEach((id, i) => {
      const a = staff.find(x => x.id === id);
      const dgx = t.gx0 + 1 + (i % perRow) * 4, dgy = t.gy0 + 2 + Math.floor(i / perRow) * 3;
      add({ kind: 'desk', gx: dgx, gy: dgy, w: 2, h: 1, agent: id, name: a.name, lead: !!a.lead });
      desks.push({ agent: id, gx: dgx, gy: dgy, seat: { gx: dgx, gy: dgy - 1 }, team: t.name });
    });
    // A plant in the room's back corner.
    add({ kind: 'plant', gx: t.gx0 + t.w - 1, gy: t.gy0, w: 1, h: 1 });
  }
  // Partition walls between rooms (and closing the last room), one tile thick, rising from the back wall to the front strip.
  const partitions = [];
  for (let i = 0; i < teams.length; i++) {
    const t = teams[i]; const px = t.gx0 + t.w;
    if (px >= cols) continue;
    for (let gy = 0; gy < fy - 1; gy++) { add({ kind: 'wall', gx: px, gy, w: 1, h: 1 }); }
    partitions.push({ gx: px, from: 0, to: fy - 1, team: t.name, last: i === teams.length - 1 });
  }
  // Front strip: Runner by the door, Chief in the corner office, lounge on the right.
  if (runner) { add({ kind: 'desk', gx: 1, gy: fy + 3, w: 2, h: 1, agent: runner.id, name: runner.name, front: true }); desks.push({ agent: runner.id, gx: 1, gy: fy + 3, seat: { gx: 1, gy: fy + 2 }, team: 'Front Desk' }); }
  if (chief) { add({ kind: 'desk', gx: cols - 4, gy: fy + 2, w: 2, h: 1, agent: chief.id, name: chief.name, corner: true, lead: true }); desks.push({ agent: chief.id, gx: cols - 4, gy: fy + 2, seat: { gx: cols - 4, gy: fy + 1 }, team: 'Leadership' }); }
  for (const d of desks) block(d.seat.gx, d.seat.gy);
  const coffee = add({ kind: 'coffee', gx: cols - 2, gy: fy + 4, w: 1, h: 3 });
  const table = add({ kind: 'table', gx: cols - 8, gy: fy + 4, w: 2, h: 2 });
  const couch1 = add({ kind: 'couch', gx: cols - 11, gy: fy + 2, w: 1, h: 2 });
  const couch2 = add({ kind: 'couch', gx: cols - 11, gy: fy + 5, w: 1, h: 2 });
  const cabinet = add({ kind: 'cabinet', gx: cols - 1, gy: fy, w: 1, h: 1 });
  const mailbox = add({ kind: 'mailbox', gx: 0, gy: fy + 1, w: 1, h: 1 });
  const plants = [add({ kind: 'plant', gx: 0, gy: rows - 1, w: 1, h: 1 }), add({ kind: 'plant', gx: cols - 1, gy: rows - 1, w: 1, h: 1 }), add({ kind: 'plant', gx: cols - 6, gy: fy + 1, w: 1, h: 1 })];
  const rug = { kind: 'rug', gx: cols - 12, gy: fy + 1, w: 11, h: 6 };
  const board = { kind: 'board', wall: 'left', at: Math.min(3, fy - 4) };
  const screen = { kind: 'screen', wall: 'right', at: 2 };
  const door = { kind: 'door', wall: 'left', at: rows - 2 };
  const windows = { kind: 'windows', wall: 'right', from: 8, to: cols - 1 };
  const art = { kind: 'art', wall: 'left', at: fy + 1 };

  const corridorX = teams.map(t => t.gx0 + t.w);   // the walkable column just before each partition is inside the room; use front strip for gatherings
  const spots = {
    coffee: { gx: cols - 3, gy: fy + 5 },
    board: { gx: 1, gy: board.at + 1 },
    mailbox: { gx: 1, gy: fy + 1 },
    cabinet: { gx: cols - 2, gy: fy },
    benches: [{ gx: cols - 11, gy: fy + 2 }, { gx: cols - 11, gy: fy + 5 }],
    table: [{ gx: cols - 9, gy: fy + 4 }, { gx: cols - 6, gy: fy + 5 }],
    chats: [[{ gx: 5, gy: fy + 1 }, { gx: 6, gy: fy + 1 }], [{ gx: Math.min(cols - 13, 12), gy: fy + 4 }, { gx: Math.min(cols - 12, 13), gy: fy + 4 }], [{ gx: 8, gy: fy + 5 }, { gx: 9, gy: fy + 5 }]],
    wander: [{ gx: 4, gy: fy + 3 }, { gx: Math.min(cols - 14, 10), gy: fy + 2 }, { gx: 1, gy: rows - 1 }, ...teams.map(t => ({ gx: t.gx0 + 6, gy: fy - 2 }))],
    door: { gx: 1, gy: rows - 2 },
  };
  return { key: floorKey, skin, cols, rows, origin, blocked, desks, furniture, walls: [door, windows, art], rug, spots, staff, runner, chief, teams, perRow, partitions, fy,
    coffee, table, couches: [couch1, couch2], cabinet, mailbox, plants };
}

// ---- art ----
function floorSvg(r) {
  const { skin, cols, rows, origin } = r;
  let s = '';
  for (let gx = 0; gx < cols; gx++) for (let gy = 0; gy < rows; gy++) {
    const rugHit = gx >= r.rug.gx && gx < r.rug.gx + r.rug.w && gy >= r.rug.gy && gy < r.rug.gy + r.rug.h;
    const fill = rugHit ? skin.rug : ((gx + gy) % 2 ? skin.floorA : skin.floorB);
    s += `<path d="${tilePath(gx, gy, origin)}" fill="${fill}" stroke="${rugHit ? skin.rug : skin.floorLine}" stroke-width="1"/>`;
  }
  // Rug border.
  const a = toScreen(r.rug.gx, r.rug.gy, origin), b = toScreen(r.rug.gx + r.rug.w, r.rug.gy, origin), c = toScreen(r.rug.gx + r.rug.w, r.rug.gy + r.rug.h, origin), d = toScreen(r.rug.gx, r.rug.gy + r.rug.h, origin);
  s += `<path d="M${a.x} ${a.y} L${b.x} ${b.y} L${c.x} ${c.y} L${d.x} ${d.y}Z" fill="none" stroke="#FFFFFF66" stroke-width="3" stroke-dasharray="8 6"/>`;
  // Window light falling across the floor.
  s += `<path d="M${toScreen(8, 0, origin).x} ${toScreen(8, 0, origin).y} L${toScreen(cols, 0, origin).x} ${toScreen(cols, 0, origin).y} L${toScreen(cols, 5, origin).x} ${toScreen(cols, 5, origin).y} L${toScreen(8, 5, origin).x} ${toScreen(8, 5, origin).y}Z" fill="url(#winlight)" pointer-events="none"/>`;
  return s;
}

function wallsSvg(r) {
  const { skin, cols, rows, origin } = r;
  const T = toScreen(0, 0, origin), L = toScreen(0, rows, origin), R = toScreen(cols, 0, origin);
  let s = `<defs><linearGradient id="winlight" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFF8D6" stop-opacity="0.45"/><stop offset="1" stop-color="#FFF8D6" stop-opacity="0"/></linearGradient>
    <linearGradient id="wallL" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${skin.wall}"/><stop offset="1" stop-color="${skin.wallLow}"/></linearGradient>
    <linearGradient id="wallR" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${skin.wallLow}"/><stop offset="1" stop-color="${skin.wall}"/></linearGradient></defs>`;
  // Left wall (along gx=0, from top corner down-left) and right wall (along gy=0, down-right).
  s += `<path d="M${T.x} ${T.y - WALL_H} L${T.x} ${T.y} L${L.x} ${L.y} L${L.x} ${L.y - WALL_H}Z" fill="url(#wallL)" ${S}/>`;
  s += `<path d="M${T.x} ${T.y - WALL_H} L${T.x} ${T.y} L${R.x} ${R.y} L${R.x} ${R.y - WALL_H}Z" fill="url(#wallR)" ${S}/>`;
  // Baseboards.
  s += `<path d="M${T.x} ${T.y} L${L.x} ${L.y}" stroke="${skin.trim}" stroke-width="8"/><path d="M${T.x} ${T.y} L${R.x} ${R.y}" stroke="${skin.trim}" stroke-width="8"/>`;
  // Wall items.
  for (const w of r.walls) s += wallItem(r, w);
  return s;
}
// A rectangle flat against a wall. `at` is the tile index along the wall; h is height above the floor.
function wallRect(r, wall, at, len, bottom, height) {
  const p0 = wall === 'left' ? toScreen(0, at, r.origin) : toScreen(at, 0, r.origin);
  const p1 = wall === 'left' ? toScreen(0, at + len, r.origin) : toScreen(at + len, 0, r.origin);
  return `M${p0.x} ${p0.y - bottom} L${p1.x} ${p1.y - bottom} L${p1.x} ${p1.y - bottom - height} L${p0.x} ${p0.y - bottom - height}Z`;
}
function wallItem(r, w) {
  const { skin } = r;
  if (w.kind === 'windows') {
    let s = '';
    for (let at = w.from; at < w.to - 1; at += 3) {
      const view = skin.window === 'sea' ? '#8FD3E8' : skin.window === 'city' ? '#22304A' : '#BFE3F2';
      s += `<path d="${wallRect(r, 'right', at, 2, 60, 80)}" fill="${view}" ${S}/>`;
      const p = toScreen(at, 0, r.origin), q = toScreen(at + 2, 0, r.origin);
      if (skin.window === 'sea') s += `<path d="${wallRect(r, 'right', at, 2, 60, 34)}" fill="#3FA7C9" stroke="none"/><circle cx="${(p.x + q.x) / 2}" cy="${(p.y + q.y) / 2 - 118}" r="9" fill="#FFE27A"/>`;
      else if (skin.window === 'city') s += `<path d="${wallRect(r, 'right', at + 0.3, 0.5, 60, 46)}" fill="#3A4560" stroke="none"/><path d="${wallRect(r, 'right', at + 1.1, 0.6, 60, 62)}" fill="#3A4560" stroke="none"/><circle cx="${(p.x + q.x) / 2 + 20}" cy="${(p.y + q.y) / 2 - 122}" r="6" fill="#FFF3B0"/>`;
      else s += `<path d="${wallRect(r, 'right', at, 2, 60, 30)}" fill="#7DBB57" stroke="none"/><ellipse cx="${(p.x + q.x) / 2 - 10}" cy="${(p.y + q.y) / 2 - 116}" rx="16" ry="7" fill="#FFF"/>`;
      s += `<path d="${wallRect(r, 'right', at + 1, 0.04, 60, 80)}" stroke="#2B2118" stroke-width="2"/>`;
    }
    return s;
  }
  if (w.kind === 'door') {
    const s = `<path d="${wallRect(r, 'left', w.at, 1.4, 4, 110)}" fill="#2B2118" ${S}/><path d="${wallRect(r, 'left', w.at + 0.1, 1.2, 4, 104)}" fill="${skin.trim}" stroke="none"/>`;
    const p = toScreen(0, w.at + 0.7, r.origin);
    return s + `<rect x="${p.x - 22}" y="${p.y - 140}" width="44" height="16" rx="4" fill="#2C2C2A" ${S}/><text x="${p.x}" y="${p.y - 128}" text-anchor="middle" font-size="10" fill="#5DCAA5" font-family="ui-monospace,Menlo,monospace">EXIT</text>`;
  }
  if (w.kind === 'board') {
    const p = toScreen(0, w.at + 1.5, r.origin);
    return `<g class="noticeboard" data-floor="${r.key}" style="cursor:pointer"><path d="${wallRect(r, 'left', w.at, 3, 62, 78)}" fill="#8B5A2B" ${S}/><path d="${wallRect(r, 'left', w.at + 0.15, 2.7, 68, 66)}" fill="#E9DCC3" stroke="none"/>
      <g transform="translate(${p.x},${p.y - 128}) skewY(-26.57)"><text x="-70" y="0" font-size="9" font-weight="800" fill="#2B2118">NOTICE BOARD · click to open</text>${[0, 1, 2, 3].map(i => `<text x="-70" y="${13 + i * 12}" font-size="8.5" font-weight="700" fill="#2B2118" data-board-line="${r.key}:${i}"></text>`).join('')}</g></g>`;
  }
  if (w.kind === 'screen') {
    const p = toScreen(w.at + 2.5, 0, r.origin);
    return `<g class="scoreboard" data-floor="${r.key}" style="cursor:pointer"><path d="${wallRect(r, 'right', w.at, 5, 58, 88)}" fill="#1E2440" ${S}/><path d="${wallRect(r, 'right', w.at + 0.12, 4.76, 63, 78)}" fill="#0F1430" stroke="none"/>
      <g transform="translate(${p.x},${p.y - 138}) skewY(26.57)"><text x="-74" y="0" font-size="8" font-weight="700" fill="#8FC4FF" font-family="ui-monospace,Menlo,monospace">${esc(skin.boardTitle)}</text>
      ${Array.from({ length: 8 }, (_, i) => { const cx = -74 + (i % 2) * 76, cy = 12 + Math.floor(i / 2) * 15; return `<text x="${cx}" y="${cy}" font-size="6.5" font-weight="700" fill="#AAB8D8" font-family="ui-monospace,Menlo,monospace" data-tile-label="${r.key}:${i}"></text><text x="${cx}" y="${cy + 6.5}" font-size="8.5" font-weight="800" fill="#FFFFFF" font-family="ui-monospace,Menlo,monospace" data-tile-value="${r.key}:${i}"></text>`; }).join('')}</g></g>`;
  }
  if (w.kind === 'art') {
    if (skin.wallArt === 'map') return `<path d="${wallRect(r, 'left', w.at, 2.4, 70, 60)}" fill="#DCE9D3" ${S}/><path d="${wallRect(r, 'left', w.at + 0.4, 1.4, 84, 30)}" fill="#7DBB57" stroke="none" opacity="0.8"/><path d="${wallRect(r, 'left', w.at + 1.2, 0.9, 76, 22)}" fill="#3FA7C9" stroke="none" opacity="0.7"/>`;
    if (skin.wallArt === 'ticker') return `<path d="${wallRect(r, 'left', w.at, 3, 96, 22)}" fill="#0A0E24" ${S}/><path d="${wallRect(r, 'left', w.at + 0.2, 0.5, 102, 10)}" fill="#5DCAA5" stroke="none"/><path d="${wallRect(r, 'left', w.at + 0.9, 0.7, 102, 10)}" fill="#F09595" stroke="none"/><path d="${wallRect(r, 'left', w.at + 1.8, 1.0, 102, 10)}" fill="#5DCAA5" stroke="none"/>`;
    return [0, 1, 2].map(i => `<path d="${wallRect(r, 'left', w.at + i * 0.9, 0.7, 76 - (i % 2) * 8, 26)}" fill="${['#F4A4BE', '#7FC8C0', '#FFE27A'][i]}" ${S}/>`).join('');
  }
  return '';
}

// One piece of furniture, drawn at its tile origin. Every piece returns { depth, svg }.
export function furnitureSvg(r, f) {
  const { skin } = r;
  const o = toScreen(f.gx + (f.w || 1) / 2, f.gy + (f.h || 1) / 2, r.origin);   // footprint centre
  const d = depth(f.gx + (f.w || 1) - 1, f.gy + (f.h || 1) - 1) + 0.5;
  const shadow = (rx, ry) => `<ellipse cx="${o.x}" cy="${o.y + 4}" rx="${rx}" ry="${ry}" fill="#00000022"/>`;
  if (f.kind === 'desk') {
    // Top face is the 2x1 footprint lifted by 34; sides drop to the floor.
    const h = 34;
    const A = toScreen(f.gx, f.gy, r.origin), B = toScreen(f.gx + 2, f.gy, r.origin), C = toScreen(f.gx + 2, f.gy + 1, r.origin), D = toScreen(f.gx, f.gy + 1, r.origin);
    const id = esc(f.agent);
    const mon = toScreen(f.gx + 1, f.gy + 0.35, r.origin);
    const lamp = toScreen(f.gx + 1.75, f.gy + 0.3, r.origin);
    const label = toScreen(f.gx + 1, f.gy + 1.15, r.origin);
    return { depth: d, svg: `<g class="desk" data-agent="${id}" style="cursor:pointer">
      ${shadow(78, 26)}
      <path d="M${D.x} ${D.y} L${C.x} ${C.y} L${C.x} ${C.y - h} L${D.x} ${D.y - h}Z" fill="${skin.deskSide}" ${S}/>
      <path d="M${C.x} ${C.y} L${B.x} ${B.y} L${B.x} ${B.y - h} L${C.x} ${C.y - h}Z" fill="${skin.deskEdge}" ${S}/>
      <path d="M${A.x} ${A.y - h} L${B.x} ${B.y - h} L${C.x} ${C.y - h} L${D.x} ${D.y - h}Z" fill="${skin.deskTop}" ${S}/>
      <g transform="translate(${mon.x},${mon.y - h})"><path d="M-3 0 H3 V-6 H-3Z" fill="#5F5E5A"/><path d="M-22 -6 L22 -6 L22 -34 L-22 -34Z" fill="#2C2C2A" ${S}/><path d="M-19 -9 L19 -9 L19 -31 L-19 -31Z" class="screen" data-agent="${id}" fill="#444441"/></g>
      <g transform="translate(${lamp.x},${lamp.y - h})"><path d="M0 0 V-22" stroke="#5F5E5A" stroke-width="3"/><path d="M-9 -22 L9 -22 L5 -32 L-5 -32Z" fill="#E9B44C" ${S}/><circle cx="0" cy="-20" r="4" class="lamp" data-agent="${id}" fill="#444441"/></g>
      <g transform="translate(${A.x + 18},${A.y - h + 2})"><path d="M0 0 L14 7 L14 3 L0 -4Z" fill="#FAF0DC" ${S}/></g>
      <g class="desk-labels" data-agent="${id}" style="cursor:pointer">
        <text x="${label.x}" y="${label.y + 2}" text-anchor="middle" class="desk-label">${esc(f.name)}</text>
        <text x="${label.x}" y="${label.y + 14}" text-anchor="middle" class="sub" data-sub="${id}"></text>
        <g data-dots="${id}" transform="translate(${label.x - 26},${label.y + 22})"></g>
      </g>
    </g>` };
  }
  if (f.kind === 'coffee') {
    const A = toScreen(f.gx, f.gy, r.origin), B = toScreen(f.gx + 1, f.gy, r.origin), C = toScreen(f.gx + 1, f.gy + 3, r.origin), D = toScreen(f.gx, f.gy + 3, r.origin); const h = 38;
    const m = toScreen(f.gx + 0.5, f.gy + 0.8, r.origin), c1 = toScreen(f.gx + 0.5, f.gy + 1.7, r.origin), c2 = toScreen(f.gx + 0.5, f.gy + 2.4, r.origin);
    return { depth: d, svg: `<g>${shadow(40, 60)}<path d="M${D.x} ${D.y} L${C.x} ${C.y} L${C.x} ${C.y - h} L${D.x} ${D.y - h}Z" fill="${skin.deskSide}" ${S}/><path d="M${C.x} ${C.y} L${B.x} ${B.y} L${B.x} ${B.y - h} L${C.x} ${C.y - h}Z" fill="${skin.deskEdge}" ${S}/><path d="M${A.x} ${A.y - h} L${B.x} ${B.y - h} L${C.x} ${C.y - h} L${D.x} ${D.y - h}Z" fill="${skin.deskTop}" ${S}/>
      <g transform="translate(${m.x},${m.y - h})"><rect x="-12" y="-34" width="24" height="34" rx="3" fill="#2C2C2A" ${S}/><rect x="-8" y="-28" width="16" height="8" fill="#5FA8FF"/><circle cx="6" cy="-10" r="3" fill="#E24B4A"/></g>
      <g transform="translate(${c1.x},${c1.y - h})"><rect x="-7" y="-14" width="14" height="14" rx="2" fill="#FFF" ${S}/></g><g transform="translate(${c2.x},${c2.y - h})"><rect x="-7" y="-14" width="14" height="14" rx="2" fill="#FFF" ${S}/><path d="M-4 -18 Q0 -26 4 -18" stroke="#B4B2A9" stroke-width="1.5" fill="none"/></g>
      <text x="${c2.x}" y="${c2.y + 20}" text-anchor="middle" class="sub">coffee</text></g>` };
  }
  if (f.kind === 'table') {
    return { depth: d, svg: `<g>${shadow(58, 30)}<ellipse cx="${o.x}" cy="${o.y - 10}" rx="52" ry="24" fill="${skin.deskSide}" ${S}/><ellipse cx="${o.x}" cy="${o.y - 26}" rx="52" ry="24" fill="${skin.deskTop}" ${S}/><path d="M${o.x - 52} ${o.y - 26} V${o.y - 10} M${o.x + 52} ${o.y - 26} V${o.y - 10}" stroke="#2B2118" stroke-width="2"/>
      <rect x="${o.x - 8}" y="${o.y - 42}" width="16" height="10" rx="2" fill="#FFF" ${S}/><circle cx="${o.x + 18}" cy="${o.y - 34}" r="5" fill="#F0997B" ${S}/><text x="${o.x}" y="${o.y + 22}" text-anchor="middle" class="sub">lunch</text></g>` };
  }
  if (f.kind === 'couch') {
    const A = toScreen(f.gx, f.gy, r.origin), B = toScreen(f.gx + 1, f.gy, r.origin), C = toScreen(f.gx + 1, f.gy + 2, r.origin), D = toScreen(f.gx, f.gy + 2, r.origin);
    const back = 40, seat = 18;
    return { depth: d, svg: `<g>${shadow(30, 44)}<path d="M${A.x} ${A.y - back} L${D.x} ${D.y - back} L${D.x} ${D.y} L${A.x} ${A.y}Z" fill="${skin.couch}" ${S}/>
      <path d="M${A.x} ${A.y - seat} L${B.x} ${B.y - seat} L${C.x} ${C.y - seat} L${D.x} ${D.y - seat}Z" fill="${skin.couch}" ${S}/><path d="M${D.x} ${D.y - seat} L${C.x} ${C.y - seat} L${C.x} ${C.y} L${D.x} ${D.y}Z" fill="${skin.couch}" ${S}/><path d="M${C.x} ${C.y - seat} L${B.x} ${B.y - seat} L${B.x} ${B.y} L${C.x} ${C.y}Z" fill="#00000030" stroke="none"/>
      <path d="M${A.x + 6} ${A.y - seat - 4} L${B.x - 4} ${B.y - seat - 4} L${C.x - 4} ${C.y - seat - 4} L${D.x + 6} ${D.y - seat - 4}Z" fill="#FFFFFF55" stroke="none"/></g>` };
  }
  if (f.kind === 'cabinet') {
    const A = toScreen(f.gx, f.gy, r.origin), B = toScreen(f.gx + 1, f.gy, r.origin), C = toScreen(f.gx + 1, f.gy + 1, r.origin), D = toScreen(f.gx, f.gy + 1, r.origin); const h = 84;
    return { depth: d, svg: `<g>${shadow(28, 14)}<path d="M${D.x} ${D.y} L${C.x} ${C.y} L${C.x} ${C.y - h} L${D.x} ${D.y - h}Z" fill="#B4B2A9" ${S}/><path d="M${C.x} ${C.y} L${B.x} ${B.y} L${B.x} ${B.y - h} L${C.x} ${C.y - h}Z" fill="#8A8F98" ${S}/><path d="M${A.x} ${A.y - h} L${B.x} ${B.y - h} L${C.x} ${C.y - h} L${D.x} ${D.y - h}Z" fill="#D3D1C7" ${S}/>
      ${[16, 40, 64].map(y => `<path d="M${D.x + 4} ${D.y - y - 2} L${C.x - 4} ${C.y - y - 2} L${C.x - 4} ${C.y - y - 18} L${D.x + 4} ${D.y - y - 18}Z" fill="#D3D1C7" ${S}/>`).join('')}<text x="${o.x}" y="${o.y + 20}" text-anchor="middle" class="sub">files</text></g>` };
  }
  if (f.kind === 'mailbox') {
    const A = toScreen(f.gx, f.gy, r.origin), B = toScreen(f.gx + 1, f.gy, r.origin), C = toScreen(f.gx + 1, f.gy + 1, r.origin), D = toScreen(f.gx, f.gy + 1, r.origin); const h = 70;
    return { depth: d, svg: `<g>${shadow(28, 14)}<path d="M${D.x} ${D.y} L${C.x} ${C.y} L${C.x} ${C.y - h} L${D.x} ${D.y - h}Z" fill="#B4B2A9" ${S}/><path d="M${C.x} ${C.y} L${B.x} ${B.y} L${B.x} ${B.y - h} L${C.x} ${C.y - h}Z" fill="#8A8F98" ${S}/><path d="M${A.x} ${A.y - h} L${B.x} ${B.y - h} L${C.x} ${C.y - h} L${D.x} ${D.y - h}Z" fill="#D3D1C7" ${S}/>
      ${[14, 34, 54].map(y => `<path d="M${C.x + 4} ${C.y - y - 2} L${B.x - 4} ${B.y - y - 2} L${B.x - 4} ${B.y - y - 14} L${C.x + 4} ${C.y - y - 14}Z" fill="#FAF0DC" ${S}/>`).join('')}<text x="${o.x}" y="${o.y + 20}" text-anchor="middle" class="sub">lead files</text></g>` };
  }
  if (f.kind === 'wall') {
    // One tile of partition: a panel along the tile's left edge (constant gx), so rooms
    // to the left sit behind it and rooms to the right in front.
    const A = toScreen(f.gx, f.gy, r.origin), B = toScreen(f.gx, f.gy + 1, r.origin), h = 96;
    const top = toScreen(f.gx + 0.35, f.gy, r.origin), topB = toScreen(f.gx + 0.35, f.gy + 1, r.origin);
    return { depth: depth(f.gx, f.gy) + 1, svg: `<g pointer-events="none"><path d="M${A.x} ${A.y} L${B.x} ${B.y} L${B.x} ${B.y - h} L${A.x} ${A.y - h}Z" fill="${skin.wallLow}" ${S}/><path d="M${A.x} ${A.y - h} L${B.x} ${B.y - h} L${topB.x} ${topB.y - h} L${top.x} ${top.y - h}Z" fill="${skin.wall}" ${S}/><path d="M${A.x} ${A.y - 10} L${B.x} ${B.y - 10}" stroke="${skin.trim}" stroke-width="5"/></g>` };
  }
  if (f.kind === 'plant') {
    const leaf = skin.plants === 'palm' ? '#3FA36B' : skin.plants === 'spiky' ? '#4C8C6A' : '#639922';
    const fronds = skin.plants === 'spiky'
      ? `<path d="M0 -30 L-18 -80 M0 -30 L0 -90 M0 -30 L18 -80 M0 -30 L-30 -60 M0 -30 L30 -60" stroke="${leaf}" stroke-width="5" stroke-linecap="round"/>`
      : `<path d="M0 -30 Q-30 -60 -10 -90 M0 -30 Q30 -62 10 -92 M0 -30 Q0 -70 0 -100 M0 -30 Q-24 -40 -40 -66 M0 -30 Q26 -42 40 -70" stroke="#2B2118" stroke-width="8" fill="none" stroke-linecap="round"/><path d="M0 -30 Q-30 -60 -10 -90 M0 -30 Q30 -62 10 -92 M0 -30 Q0 -70 0 -100 M0 -30 Q-24 -40 -40 -66 M0 -30 Q26 -42 40 -70" stroke="${leaf}" stroke-width="4.5" fill="none" stroke-linecap="round"/>`;
    return { depth: d, svg: `<g transform="translate(${o.x},${o.y})">${shadow(0, 0)}<ellipse cx="0" cy="4" rx="24" ry="9" fill="#00000022"/><path d="M-16 0 H16 L12 -28 H-12Z" fill="#C2543A" ${S}/>${fronds}</g>` };
  }
  return { depth: d, svg: '' };
}

// Team plaques: a sign above each room's entrance, on the front edge of the room.
function plaquesSvg(r) {
  let s = '';
  for (const t of r.teams || []) {
    const p = toScreen(t.gx0 + t.w / 2, t.gy0 + t.d + 0.5, r.origin);
    const w = 22 + t.name.length * 8;
    s += `<g class="plaque" pointer-events="none" transform="translate(${p.x},${p.y - 96})"><path d="M0 0 L0 22" stroke="#2B2118" stroke-width="3"/><path d="M${-w / 2} 0 L${w / 2} 0 L${w / 2} -24 L${-w / 2} -24Z" rx="4" fill="${r.skin.accent}" ${S}/><text x="0" y="-7" text-anchor="middle" font-size="14" font-weight="800" fill="#1B1408">${esc(t.name.toUpperCase())}</text></g>`;
  }
  return s;
}
export function roomSvg(r) {
  return `<g class="room">${wallsSvg(r)}${floorSvg(r)}${plaquesSvg(r)}</g>`;
}
