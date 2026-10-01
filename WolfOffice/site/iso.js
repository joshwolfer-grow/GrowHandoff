// site/iso.js — 2:1 isometric projection, depth order, and grid pathfinding.
// Grid coordinates (gx, gy) are tiles; screen coordinates are SVG user units.
export const TILE_W = 64;
export const TILE_H = 32;
export const WALL_H = 170;

// Screen position of a tile's centre. (0,0) is the top corner of the room.
export function toScreen(gx, gy, origin = { x: 0, y: 0 }) {
  return { x: origin.x + (gx - gy) * (TILE_W / 2), y: origin.y + (gx + gy) * (TILE_H / 2) };
}
// Inverse: which tile is under a screen point.
export function toGrid(x, y, origin = { x: 0, y: 0 }) {
  const dx = (x - origin.x) / (TILE_W / 2), dy = (y - origin.y) / (TILE_H / 2);
  return { gx: (dx + dy) / 2, gy: (dy - dx) / 2 };
}
// Painter's order: things further down-right are drawn later (on top).
export function depth(gx, gy) { return gx + gy; }

// The room's bounding box in screen units, including the walls above the floor.
export function bounds(cols, rows, origin) {
  const left = toScreen(0, rows, origin).x - TILE_W / 2;
  const right = toScreen(cols, 0, origin).x + TILE_W / 2;
  const top = toScreen(0, 0, origin).y - WALL_H;
  const bottom = toScreen(cols, rows, origin).y + TILE_H;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

// Diamond path for one tile.
export function tilePath(gx, gy, origin) {
  const c = toScreen(gx + 0.5, gy + 0.5, origin);
  return `M${c.x} ${c.y - TILE_H / 2} L${c.x + TILE_W / 2} ${c.y} L${c.x} ${c.y + TILE_H / 2} L${c.x - TILE_W / 2} ${c.y}Z`;
}

export const key = (gx, gy) => `${gx},${gy}`;

// Breadth-first path over walkable tiles (4-neighbour). Returns tile centres
// from the tile after `from` up to and including `to`, or [] if unreachable.
// `to` may be blocked (a seat inside a desk footprint): it is allowed as the goal.
export function findPath(from, to, { cols, rows, blocked }) {
  const inside = (x, y) => x >= 0 && y >= 0 && x < cols && y < rows;
  const start = key(from.gx, from.gy), goal = key(to.gx, to.gy);
  if (start === goal) return [];
  const prev = new Map([[start, null]]);
  const q = [[from.gx, from.gy]];
  while (q.length) {
    const [x, y] = q.shift();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = key(nx, ny);
      if (!inside(nx, ny) || prev.has(k)) continue;
      if (blocked.has(k) && k !== goal) continue;
      prev.set(k, key(x, y));
      if (k === goal) {
        const out = []; let cur = k;
        while (cur && cur !== start) { const [px, py] = cur.split(',').map(Number); out.unshift({ gx: px, gy: py }); cur = prev.get(cur); }
        return out;
      }
      q.push([nx, ny]);
    }
  }
  return [];
}

// Nearest walkable tile to a target, used when an actor is standing on furniture.
export function nearestFree(t, grid) {
  if (!grid.blocked.has(key(t.gx, t.gy))) return t;
  for (let r = 1; r < 6; r++) for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
    const x = t.gx + dx, y = t.gy + dy;
    if (x < 0 || y < 0 || x >= grid.cols || y >= grid.rows) continue;
    if (!grid.blocked.has(key(x, y))) return { gx: x, gy: y };
  }
  return t;
}
