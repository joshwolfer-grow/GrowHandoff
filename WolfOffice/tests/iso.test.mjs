import { describe, it, expect } from 'vitest';
import { toScreen, toGrid, depth, findPath, nearestFree, bounds, TILE_W, TILE_H, WALL_H } from '../site/iso.js';
import { buildRoom, roomSvg, furnitureSvg } from '../site/room.js';

describe('projection', () => {
  it('maps the grid to 2:1 iso and back', () => {
    expect(toScreen(0, 0)).toEqual({ x: 0, y: 0 });
    expect(toScreen(1, 0)).toEqual({ x: TILE_W / 2, y: TILE_H / 2 });
    expect(toScreen(0, 1)).toEqual({ x: -TILE_W / 2, y: TILE_H / 2 });
    const p = toScreen(3, 5, { x: 100, y: 50 }); const g = toGrid(p.x, p.y, { x: 100, y: 50 });
    expect(g.gx).toBeCloseTo(3); expect(g.gy).toBeCloseTo(5);
  });
  it('orders depth down-right', () => { expect(depth(2, 3)).toBeLessThan(depth(3, 3)); expect(depth(2, 3)).toBeLessThan(depth(2, 4)); });
  it('bounds cover walls and floor', () => { const b = bounds(4, 4, { x: 0, y: 0 }); expect(b.y).toBe(-WALL_H); expect(b.w).toBe(4 * TILE_W + TILE_W); });
});

describe('findPath', () => {
  const grid = { cols: 5, rows: 5, blocked: new Set(['2,0', '2,1', '2,2', '2,3']) };
  it('routes around a wall of blocked tiles', () => {
    const p = findPath({ gx: 0, gy: 0 }, { gx: 4, gy: 0 }, grid);
    expect(p[p.length - 1]).toEqual({ gx: 4, gy: 0 });
    expect(p.some(t => t.gx === 2 && t.gy === 4)).toBe(true);
    expect(p.every(t => !grid.blocked.has(`${t.gx},${t.gy}`))).toBe(true);
  });
  it('allows a blocked goal (a seat) and returns [] when already there or unreachable', () => {
    expect(findPath({ gx: 0, gy: 0 }, { gx: 2, gy: 0 }, grid).pop()).toEqual({ gx: 2, gy: 0 });
    expect(findPath({ gx: 1, gy: 1 }, { gx: 1, gy: 1 }, grid)).toEqual([]);
    const boxed = { cols: 3, rows: 3, blocked: new Set(['1,0', '0,1', '1,1']) };
    expect(findPath({ gx: 0, gy: 0 }, { gx: 2, gy: 2 }, boxed)).toEqual([]);
  });
  it('finds the nearest free tile', () => expect(nearestFree({ gx: 2, gy: 1 }, grid)).toEqual({ gx: 1, gy: 0 }));
});

describe('buildRoom', () => {
  const agents = [
    ...['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map(id => ({ id, name: id.toUpperCase(), floor: 'grow' })),
    { id: 'runner-grow', name: 'Runner', floor: 'grow' }, { id: 'chief-grow', name: 'Chief', floor: 'grow' },
  ];
  const r = buildRoom('grow', agents);
  it('gives every worker a desk with a seat behind it', () => {
    expect(r.desks.length).toBe(11);
    for (const d of r.desks) { expect(d.seat.gy).toBe(d.gy - 1); expect(r.blocked.has(`${d.gx},${d.gy}`)).toBe(true); }
    expect(r.desks.find(d => d.agent === 'runner-grow').gx).toBe(1);
    expect(r.desks.find(d => d.agent === 'chief-grow').gx).toBe(r.cols - 4);
  });
  it('keeps every seat and spot reachable from the door', () => {
    const grid = { cols: r.cols, rows: r.rows, blocked: r.blocked };
    for (const d of r.desks) expect(findPath(r.spots.door, d.seat, grid).length).toBeGreaterThan(0);
    for (const k of ['coffee', 'board', 'mailbox', 'cabinet']) expect(r.blocked.has(`${r.spots[k].gx},${r.spots[k].gy}`)).toBe(false);
    for (const k of ['coffee', 'board', 'mailbox', 'cabinet']) expect(findPath(r.spots.door, r.spots[k], grid).length).toBeGreaterThan(0);
    for (const s of [...r.spots.benches, ...r.spots.table, ...r.spots.wander, ...r.spots.chats.flat()]) expect(findPath(r.spots.door, s, grid).length).toBeGreaterThan(0);
  });
  it('grows the room with more staff and never overlaps furniture with desks', () => {
    const big = buildRoom('grow', [...agents, { id: 'j', name: 'J' }, { id: 'k', name: 'K' }, { id: 'l', name: 'L' }]);
    expect(big.rows).toBeGreaterThan(r.rows);
    const seen = new Set();
    for (const f of big.furniture) for (let x = f.gx; x < f.gx + (f.w || 1); x++) for (let y = f.gy; y < f.gy + (f.h || 1); y++) { const k = `${x},${y}`; expect(seen.has(k)).toBe(false); seen.add(k); }
  });
  it('renders svg for the room and each piece', () => {
    expect(roomSvg(r)).not.toContain('noticeboard');
    for (const f of r.furniture) { const out = furnitureSvg(r, f); expect(typeof out.depth).toBe('number'); expect(out.svg.length).toBeGreaterThan(20); }
  });
});
