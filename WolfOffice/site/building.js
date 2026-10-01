// site/building.js — one skyscraper. Every floor is the same office interior;
// floors stack vertically in one world. y grows downward, so floor 0 (ground)
// is at the bottom and higher floors sit above it.
export const WORLD_W = 2000;
export const DESK_W = 180;
export const COLS = [520, 860, 1200];
export const CORRIDORS = [420, 760, 1100, 1440];
export const LOBBY_X = 300;                 // elevator lobby is x < LOBBY_X
export const ELEVATOR = { x: 60, w: 150 };  // shaft
const S = 'stroke="#3A2A20" stroke-width="2.5" stroke-linejoin="round"';

export const FLOOR_META = {
  grow:     { title: 'Grow',     accent: '#2E9C6D', deskStyle: 'wood' },
};
export const FLOOR_ORDER = ['grow'];   // ground floor first

// Layout of one floor, given how many desks it needs. All coordinates are
// relative to the floor's top edge (y0). Rooms: lobby | hall | break room.
export function floorLayout(n) {
  const rowCount = Math.max(2, Math.ceil(n / 3));
  const rows = Array.from({ length: rowCount }, (_, i) => 300 + i * 270);
  const hall = { x: 400, y: 220, w: 1080, h: rowCount * 270 + 60 };
  const h = hall.y + hall.h + 200;            // floor height
  const desks = Array.from({ length: n }, (_, i) => ({ x: COLS[i % 3], y: rows[Math.floor(i / 3)] }));
  const hb = hall.y + hall.h;
  const spots = {
    coffee:  { x: 1700, y: 420 },
    board:   { x: 940, y: 170 },
    mailbox: { x: 330, y: 170 },
    cabinet: { x: 1560, y: 200 },
    plants:  [{ x: 1600, y: 700 }, { x: 350, y: hb + 60 }],
    benches: [{ x: 1720, y: 620 }, { x: 700, y: hb + 90 }, { x: 1250, y: hb + 90 }],
    table:   [{ x: 1640, y: 850 }, { x: 1780, y: 850 }],
    chats:   [[{ x: 1560, y: hb + 40 }, { x: 1610, y: hb + 40 }], [{ x: 470, y: hb + 130 }, { x: 520, y: hb + 130 }], [{ x: 1180, y: 160 }, { x: 1230, y: 160 }]],
    wander:  [{ x: 900, y: hb + 130 }, { x: 1400, y: hb + 120 }, { x: 600, y: 160 }, { x: 1700, y: 300 }],
    lobby:   { x: 250, y: 400 },
  };
  return { rows, hall, hb, h, desks, spots, rowBottoms: rows.map(y => y + 130) };
}
export function aisleY(deskY) { return deskY + 170; }

// Stack floors: returns [{ key, y0, L }] with ground floor at the bottom.
export function stack(counts) {
  const layouts = FLOOR_ORDER.map(key => ({ key, L: floorLayout(counts[key] || 0) }));
  const total = layouts.reduce((s, f) => s + f.L.h, 0);
  let y = total;
  const out = [];
  for (const f of layouts) { y -= f.L.h; out.push({ ...f, y0: y }); }
  return { floors: out, worldH: total };
}

// ---- art ----
function plant(x, y) {
  return `<g transform="translate(${x},${y})"><ellipse cx="0" cy="6" rx="26" ry="6" fill="#00000012"/><path d="M-18 0 H18 L14 -30 H-14Z" fill="#C2543A" ${S}/>
    <path d="M0 -30 Q-30 -60 -10 -90 M0 -30 Q30 -62 10 -92 M0 -30 Q0 -70 0 -100 M0 -30 Q-24 -40 -40 -66 M0 -30 Q26 -42 40 -70" stroke="#3B6D11" stroke-width="7" fill="none" stroke-linecap="round"/>
    <path d="M0 -30 Q-30 -60 -10 -90 M0 -30 Q30 -62 10 -92 M0 -30 Q0 -70 0 -100 M0 -30 Q-24 -40 -40 -66 M0 -30 Q26 -42 40 -70" stroke="#639922" stroke-width="3.5" fill="none" stroke-linecap="round"/></g>`;
}
function couch(x, y, c) {
  return `<g transform="translate(${x},${y})"><ellipse cx="0" cy="10" rx="60" ry="8" fill="#00000012"/>
    <rect x="-56" y="-40" width="112" height="44" rx="10" fill="${c}" ${S}/><rect x="-50" y="-14" width="100" height="22" rx="6" fill="#FFFFFF66"/>
    <rect x="-62" y="-30" width="14" height="36" rx="6" fill="${c}" ${S}/><rect x="48" y="-30" width="14" height="36" rx="6" fill="${c}" ${S}/></g>`;
}
function tableSet(x, y) {
  return `<g transform="translate(${x},${y})"><ellipse cx="0" cy="18" rx="92" ry="14" fill="#00000012"/>
    <ellipse cx="0" cy="0" rx="72" ry="26" fill="#E9DCC3" ${S}/><ellipse cx="0" cy="-6" rx="72" ry="26" fill="#FAF0DC" ${S}/>
    ${[-100, 100].map(px => `<ellipse cx="${px}" cy="4" rx="16" ry="8" fill="#8B5A2B" ${S}/>`).join('')}
    <rect x="-8" y="-20" width="16" height="12" rx="3" fill="#FFF" ${S}/><circle cx="18" cy="-14" r="6" fill="#F0997B" ${S}/></g>`;
}
function board(x, y, key) {
  return `<g transform="translate(${x},${y})" class="noticeboard" data-floor="${key}" style="cursor:pointer"><rect x="-150" y="-118" width="300" height="108" rx="4" fill="#C48A4A" ${S}/><rect x="-142" y="-110" width="284" height="92" rx="3" fill="#E9DCC3"/>
    <text x="-134" y="-94" font-size="11" font-weight="700" fill="#3A2A20">NOTICE BOARD · click for the floor report</text>
    ${[0, 1, 2, 3, 4].map(i => `<text x="-134" y="${-78 + i * 14}" font-size="10.5" fill="#3A2A20" data-board-line="${key}:${i}"></text>`).join('')}
    <circle cx="-138" cy="-114" r="4" fill="#E24B4A" stroke="#3A2A20" stroke-width="1.5"/><circle cx="138" cy="-114" r="4" fill="#E24B4A" stroke="#3A2A20" stroke-width="1.5"/></g>`;
}
function mailbox(x, y) {
  return `<g transform="translate(${x},${y})"><rect x="-30" y="-80" width="60" height="80" rx="4" fill="#B4B2A9" ${S}/>
    ${[-70, -46, -22].map(py => `<rect x="-24" y="${py}" width="48" height="18" rx="2" fill="#D3D1C7" ${S}/>`).join('')}
    <rect x="-16" y="-66" width="32" height="8" fill="#FAF0DC" ${S}/>
    <text x="0" y="20" text-anchor="middle" font-size="13" fill="#3A2A20">lead files</text></g>`;
}
function cabinet(x, y) {
  return `<g transform="translate(${x},${y})"><rect x="-30" y="-90" width="60" height="90" rx="4" fill="#B4B2A9" ${S}/>
    ${[-78, -50, -22].map(py => `<rect x="-22" y="${py}" width="44" height="20" rx="2" fill="#D3D1C7" ${S}/><rect x="-6" y="${py + 8}" width="12" height="4" fill="#5F5E5A"/>`).join('')}
    <text x="0" y="18" text-anchor="middle" font-size="13" fill="#3A2A20">files</text></g>`;
}
function coffeeBar(x, y) {
  return `<g transform="translate(${x},${y})"><rect x="-90" y="-40" width="180" height="50" rx="6" fill="#8B5A2B" ${S}/><rect x="-90" y="-46" width="180" height="12" rx="4" fill="#C48A4A" ${S}/>
    <rect x="-60" y="-84" width="36" height="38" rx="4" fill="#2C2C2A" ${S}/><rect x="-52" y="-76" width="20" height="10" fill="#5FA8FF"/><circle cx="-42" cy="-56" r="5" fill="#E24B4A"/>
    <rect x="0" y="-70" width="22" height="24" rx="3" fill="#FFF" ${S}/><rect x="30" y="-70" width="22" height="24" rx="3" fill="#FFF" ${S}/><rect x="60" y="-66" width="18" height="20" rx="3" fill="#F0997B" ${S}/>
    <text x="0" y="30" text-anchor="middle" font-size="13" fill="#3A2A20">coffee</text></g>`;
}
function windows(y0, w, floorIndex, nFloors) {
  // Higher floors see more sky and clouds; the ground floor sees the street.
  const t = nFloors > 1 ? floorIndex / (nFloors - 1) : 1;
  const sky = t > 0.66 ? '#BFE3F2' : t > 0.33 ? '#CFE8F6' : '#DDEFF7';
  let s = '';
  for (let x = 460; x < w - 120; x += 240) {
    s += `<g transform="translate(${x},${y0 + 24})"><rect x="0" y="0" width="160" height="110" rx="6" fill="${sky}" ${S}/>`;
    if (t > 0.4) s += `<ellipse cx="50" cy="40" rx="30" ry="12" fill="#FFF"/><ellipse cx="110" cy="70" rx="24" ry="10" fill="#FFF"/>`;
    else s += `<rect x="10" y="60" width="30" height="50" fill="#B4B2A9"/><rect x="60" y="40" width="40" height="70" fill="#8A8F98"/><rect x="120" y="70" width="30" height="40" fill="#B4B2A9"/>`;
    s += `<path d="M80 0 V110 M0 55 H160" stroke="#3A2A20" stroke-width="2.5"/></g>`;
  }
  return s;
}

// The interior of one floor. y0 is the floor's top edge in world space.
export function interior(f, index, nFloors) {
  const { L, y0, key } = f; const M = FLOOR_META[key]; const H = L.h;
  const hall = L.hall, sp = L.spots;
  return `<g transform="translate(0,${y0})">
    <rect x="0" y="0" width="${WORLD_W}" height="${H}" fill="#F1E9DA"/>
    <rect x="0" y="0" width="${WORLD_W}" height="150" fill="#E6DCC8"/>
    <path d="M0 150 H${WORLD_W}" stroke="#3A2A20" stroke-width="3"/>
    ${windows(0, WORLD_W, index, nFloors)}
    <g class="scoreboard" data-floor="${key}" style="cursor:pointer" transform="translate(1180,18)">
      <rect x="0" y="0" width="780" height="118" rx="8" fill="#1E2440" stroke="#3A2A20" stroke-width="3"/>
      <rect x="6" y="6" width="768" height="106" rx="5" fill="#0F1430"/>
      <text x="16" y="24" font-size="12" fill="#5FA8FF" font-family="ui-monospace,Menlo,monospace" class="sb-title">GROW · today</text>
      ${Array.from({ length: 8 }, (_, i) => { const cx = 16 + (i % 4) * 190, cy = 40 + Math.floor(i / 4) * 40; return `<text x="${cx}" y="${cy}" font-size="11" fill="#8FA3C8" font-family="ui-monospace,Menlo,monospace" data-tile-label="${key}:${i}"></text><text x="${cx}" y="${cy + 18}" font-size="17" font-weight="700" fill="#F1E9DA" font-family="ui-monospace,Menlo,monospace" data-tile-value="${key}:${i}"></text>`; }).join('')}
    </g>
    <rect x="0" y="150" width="${WORLD_W}" height="${H - 150}" fill="#EFE6D3"/>
    ${Array.from({ length: Math.ceil((H - 150) / 80) }, (_, i) => `<path d="M0 ${150 + i * 80} H${WORLD_W}" stroke="#E2D6BE" stroke-width="1.5"/>`).join('')}
    ${Array.from({ length: 25 }, (_, i) => `<path d="M${i * 80} 150 V${H}" stroke="#E2D6BE" stroke-width="1.5"/>`).join('')}
    <!-- lobby -->
    <rect x="0" y="150" width="${LOBBY_X}" height="${H - 150}" fill="#E4DAC6"/>
    <path d="M${LOBBY_X} 150 V${H}" stroke="#3A2A20" stroke-width="3" stroke-dasharray="14 10" opacity="0.4"/>
    <g transform="translate(${ELEVATOR.x},170)"><rect x="0" y="0" width="${ELEVATOR.w}" height="220" rx="6" fill="#B4B2A9" ${S}/>
      <rect x="10" y="10" width="${ELEVATOR.w - 20}" height="200" fill="#8A8F98" ${S}/>
      <g class="doors" data-floor="${key}"><rect class="doorL" x="10" y="10" width="${ELEVATOR.w / 2 - 10}" height="200" fill="#D3D1C7" ${S}/><rect class="doorR" x="${ELEVATOR.w / 2}" y="10" width="${ELEVATOR.w / 2 - 10}" height="200" fill="#D3D1C7" ${S}/></g>
      <rect x="${ELEVATOR.w / 2 - 30}" y="-40" width="60" height="26" rx="4" fill="#2C2C2A" ${S}/><text x="${ELEVATOR.w / 2}" y="-22" text-anchor="middle" font-size="14" fill="#5DCAA5" font-family="monospace">${index + 1}</text></g>
    <g transform="translate(${ELEVATOR.x + ELEVATOR.w + 40},200)"><rect x="0" y="0" width="60" height="120" rx="4" fill="#E9DCC3" ${S}/>
      <rect x="6" y="6" width="48" height="108" rx="3" fill="${M.accent}" opacity="0.35"/>
      <text x="30" y="70" text-anchor="middle" font-size="26" font-weight="700" fill="#3A2A20">${index + 1}</text></g>
    <rect x="20" y="40" width="260" height="70" rx="8" fill="#FFF" ${S}/><rect x="28" y="48" width="10" height="54" rx="3" fill="${M.accent}"/><text x="150" y="86" text-anchor="middle" font-size="26" font-weight="700" fill="#3A2A20">Floor ${index + 1} · ${M.title}</text>
    ${plant(260, 560)}${plant(sp.plants[0].x - 60, sp.plants[0].y)}${plant(sp.plants[1].x - 60, sp.plants[1].y)}
    <!-- hall -->
    <rect x="${hall.x}" y="${hall.y}" width="${hall.w}" height="${hall.h}" rx="14" fill="#D9C7A0" stroke="${M.accent}" stroke-width="5"/>
    ${Array.from({ length: 12 }, (_, i) => `<path d="M${hall.x + i * 100} ${hall.y} V${hall.y + hall.h}" stroke="#B49A6A" stroke-width="1.5" opacity="0.5"/>`).join('')}
    ${board(sp.board.x, sp.board.y, key)}${mailbox(sp.mailbox.x, sp.mailbox.y - 10)}${cabinet(sp.cabinet.x, sp.cabinet.y)}
    <!-- break room -->
    <rect x="1500" y="${hall.y}" width="480" height="${hall.h}" rx="14" fill="#EAD9C8" stroke="#3A2A20" stroke-width="2.5" opacity="0.9"/>
    <text x="1740" y="${hall.y + 26}" text-anchor="middle" font-size="14" fill="#7A7870">break room</text>
    ${coffeeBar(sp.coffee.x, sp.coffee.y - 20)}${couch(sp.benches[0].x, sp.benches[0].y - 30, M.accent)}${tableSet(1710, 860)}
    ${couch(sp.benches[1].x, sp.benches[1].y - 30, '#8A8F98')}${couch(sp.benches[2].x, sp.benches[2].y - 30, '#8A8F98')}
    <rect x="0" y="${H - 6}" width="${WORLD_W}" height="12" fill="#3A2A20"/>
  </g>`;
}
