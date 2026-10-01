// site/office.js — isometric office: data, rooms, camera, actors, activities, HUD.
import { deriveStatus } from './status.mjs';
import { character, badge } from './chibi.js';
import { TILE_W, TILE_H, WALL_H, toScreen, toGrid, bounds, findPath, nearestFree, key as tkey } from './iso.js';
import { SKINS, FLOOR_ORDER, buildRoom, roomSvg, furnitureSvg } from './room.js';
import { explain, ageText, cadenceText, FACTS, TALK, talkLine, sayStatus } from './help.js';
import { renderFindings } from './findings.js';
import { agentArea, linkFor, out } from './links.js';
import { treeModel, renderTree, renderRadial } from './tree.js';

const FIXTURE = new URLSearchParams(location.search).has('fixture');
const POLL_MS = 30000;
const SCALE = 0.6;          // character box → world units
const SPEED = 2.4;           // tiles per second
const HOP_MS = 900;
const NS = 'http://www.w3.org/2000/svg';
const KIND_LABEL = { run: 'Run', check: 'Check job', restart: 'Restart job', log: 'Show log', fix: 'Fix command' };
const FLOOR_META = Object.fromEntries(Object.entries(SKINS).map(([k, s]) => [k, { title: s.title, accent: s.accent }]));

let floor = (!FIXTURE && localStorage.getItem('office.floor')) || 'grow';
let rooms = {};               // key → room
let agents = [], events = [];
let actors = new Map();
let seenFinish = new Set();
let lastIds = null, quiet = true;
let sound = localStorage.getItem('office.sound') === 'on';
let nightMode = localStorage.getItem('office.night') === 'on';
let layer = {};
const busySpots = new Set();
const building = { floors: [] };   // [{ key, agents }] in FLOOR_ORDER, for the HUD

// ---------- data ----------
async function loadFixture() {
  const j = await (await fetch('fixture.json')).json();
  const now = Date.now();
  j.events.forEach(e => { const m = /^NOW-(\d+)$/.exec(e.created_at); if (m) e.created_at = new Date(now - m[1] * 1000).toISOString(); });
  return j;
}
async function loadLive() {
  const res = await fetch('/api/state?hours=3');
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  return res.json();
}

// ---------- helpers ----------
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const $ = (id) => document.getElementById(id);
const lerp = (a, b, t) => a + (b - a) * t;

let audio = null;
function beep(notes) {
  if (!sound) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    let t = audio.currentTime + 0.01;
    for (const [freq, dur] of notes) {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.06, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(audio.destination); o.start(t); o.stop(t + dur + 0.05);
      t += dur * 0.6;
    }
  } catch {}
}
const CHIME_DONE = [[1046.5, 0.35], [1318.5, 0.5]];
const CHIME_FAIL = [[392, 0.5]];
const CHIME_BLOCKED = [[523.25, 0.3], [392, 0.45]];
const CLICK = [[880, 0.06]];

// ---------- camera ----------
const cam = { x: 0, y: 0, w: 1400, h: 900, follow: null };
const svg = () => $('floor');
const curRoom = () => rooms[floor];
function worldBox() { const r = curRoom(); return r ? bounds(r.cols, r.rows, r.origin) : { x: 0, y: 0, w: 1400, h: 900 }; }
function fitHeight() { const el = svg().getBoundingClientRect(); cam.h = cam.w * (el.height / Math.max(1, el.width)); }
function clampCam() {
  const W = worldBox();
  cam.w = Math.max(420, Math.min(W.w * 1.15, cam.w)); fitHeight();
  cam.x = cam.w >= W.w ? W.x + (W.w - cam.w) / 2 : Math.max(W.x, Math.min(W.x + W.w - cam.w, cam.x));
  cam.y = cam.h >= W.h ? W.y + (W.h - cam.h) / 2 : Math.max(W.y, Math.min(W.y + W.h - cam.h, cam.y));
}
function applyCam() { svg().setAttribute('viewBox', `${cam.x.toFixed(1)} ${cam.y.toFixed(1)} ${cam.w.toFixed(1)} ${cam.h.toFixed(1)}`); }
function overview() {
  cam.follow = null; const W = worldBox();
  const el = svg().getBoundingClientRect(); const aspect = el.width / Math.max(1, el.height);
  cam.w = Math.max(W.w * 1.0, W.h * 1.0 * aspect); fitHeight();
  cam.x = W.x + (W.w - cam.w) / 2; cam.y = W.y + (W.h - cam.h) / 2;
  applyCam(); markFollow();
}
function setupCamera() {
  window.addEventListener('resize', () => { if (!cam.follow) overview(); else { clampCam(); applyCam(); } });
  $('overview').onclick = () => { cam.follow = null; markFollow(); closeCard(); overview(); };
  const el = svg();
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = el.getBoundingClientRect(); const px = cam.x + (e.clientX - r.left) / r.width * cam.w, py = cam.y + (e.clientY - r.top) / r.height * cam.h;
    const k = e.deltaY > 0 ? 1.1 : 0.9; cam.w *= k; fitHeight();
    cam.x = px - (e.clientX - r.left) / r.width * cam.w; cam.y = py - (e.clientY - r.top) / r.height * cam.h;
    cam.follow = null; markFollow(); clampCam(); applyCam();
  }, { passive: false });
  let drag = null;
  el.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false }; });
  window.addEventListener('pointermove', (e) => {
    if (!drag) return; const r = el.getBoundingClientRect();
    const dx = (e.clientX - drag.x) / r.width * cam.w, dy = (e.clientY - drag.y) / r.height * cam.h;
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 10) drag.moved = true;
    if (drag.moved) { cam.follow = null; markFollow(); cam.x = drag.cx - dx; cam.y = drag.cy - dy; clampCam(); applyCam(); }
  });
  window.addEventListener('pointerup', () => { if (drag && drag.moved) suppressUntil = Date.now() + 250; drag = null; });
}
let suppressUntil = 0;
const swallowed = () => Date.now() < suppressUntil;
function markFollow() {
  $('following').textContent = cam.follow ? `Following ${actors.get(cam.follow)?.agent.name || ''}` : '';
}
function closeCard() { $('detail').style.display = 'none'; $('detail-empty').style.display = 'flex'; }

// ---------- scene ----------
const spos = (a) => toScreen(a.gx + 0.5, a.gy + 0.5, a.room.origin);   // actor feet in screen units
function buildScene() {
  building.floors = FLOOR_ORDER.map(k => ({ key: k, agents: agents.filter(a => a.floor === k) }));
  rooms = {};
  for (const f of building.floors) rooms[f.key] = buildRoom(f.key, f.agents);
  const next = new Map(); busySpots.clear();
  for (const f of building.floors) {
    const room = rooms[f.key];
    for (const a of f.agents) {
      const desk = room.desks.find(d => d.agent === a.id); if (!desk) continue;
      let actor = actors.get(a.id);
      if (!actor) actor = { id: a.id, gx: desk.seat.gx, gy: desk.seat.gy, frame: rnd(0, 6), facing: 1, pose: 'stand', hopUntil: 0, nextIdeaAt: Date.now() + rnd(3000, 15000), act: null, path: [], lastKey: '', lastExtra: '' };
      if (!actor.act || actor.room !== room) { actor.path = []; actor.act = null; actor.gx = desk.seat.gx; actor.gy = desk.seat.gy; }
      actor.agent = a; actor.room = room; actor.desk = desk; actor.seat = desk.seat; actor.fl = f;
      next.set(a.id, actor);
    }
  }
  actors = next;
  if (!rooms[floor]) floor = FLOOR_ORDER[0];
  renderFloor();
  renderPicker();
}
// Draw the current floor's room and attach this floor's actors to it.
let sceneItems = [];
function renderFloor() {
  const room = curRoom(); if (!room) return;
  const W = worldBox();
  let html = `<rect x="${W.x - 4000}" y="${W.y - 4000}" width="${W.w + 8000}" height="${W.h + 8000}" fill="#0F1220"/>`;
  // Soft glow under the room so it floats on the dark stage.
  html += `<ellipse cx="${W.x + W.w / 2}" cy="${W.y + W.h - 40}" rx="${W.w * 0.55}" ry="${W.h * 0.25}" fill="#1B2140"/>`;
  html += roomSvg(room) + `<g id="scene"></g><g id="labels"></g><g id="effects"></g><rect id="night" x="${W.x - 4000}" y="${W.y - 4000}" width="${W.w + 8000}" height="${W.h + 8000}" fill="#14206A" opacity="0" pointer-events="none"/>`;
  svg().innerHTML = html;
  const scene = $('scene');
  sceneItems = [];
  for (const f of room.furniture) {
    const { depth, svg: s } = furnitureSvg(room, f); if (!s) continue;
    const g = document.createElementNS(NS, 'g'); g.innerHTML = s; scene.appendChild(g);
    sceneItems.push({ depth, node: g, kind: 'furniture' });
  }
  layer = { scene, labels: $('labels'), effects: $('effects'), night: $('night'), lamps: [...document.querySelectorAll('.lamp')] };
  // Desk name plates live on their own layer above the furniture, so a desk in the
  // next row or a partition wall can never cover them.
  document.querySelectorAll('.desk-labels').forEach(g => layer.labels.appendChild(g));
  for (const actor of actors.values()) {
    if (actor.room !== room) { actor.node = null; continue; }
    actor.node = document.createElementNS(NS, 'g'); actor.node.style.cursor = 'pointer';
    actor.node.onclick = (e) => { e.stopPropagation(); if (swallowed()) return; beep(CLICK); cam.follow = actor.id; markFollow(); showCard(actor.id); };
    actor.node.onpointerenter = () => { actor.hover = true; }; actor.node.onpointerleave = () => { actor.hover = false; };
    scene.appendChild(actor.node);
    actor.overlay = document.createElementNS(NS, 'g'); layer.effects.appendChild(actor.overlay);
    actor.screen = document.querySelector(`.screen[data-agent="${CSS.escape(actor.id)}"]`);
    actor.sub = document.querySelector(`[data-sub="${CSS.escape(actor.id)}"]`);
    actor.dots = document.querySelector(`[data-dots="${CSS.escape(actor.id)}"]`);
    actor.lastKey = ''; actor.lastExtra = '';
    sceneItems.push({ depth: 0, node: actor.node, kind: 'actor', actor });
  }
  lastOrder = '';
  document.querySelectorAll('.desk, .desk-labels').forEach(g => g.onclick = (e) => { e.stopPropagation(); if (swallowed()) return; beep(CLICK); cam.follow = g.dataset.agent; markFollow(); showCard(g.dataset.agent); });
  svg().onclick = () => { if (swallowed()) return; if (cam.follow) { cam.follow = null; markFollow(); closeCard(); overview(); } };
  applyStatuses(); paintBoards(); overview();
}
function goFloor(key, then) {
  if (!rooms[key]) return;
  if (key === floor) { if (then) then(); return; }
  const stage = $('stage'); stage.classList.add('fade');
  setTimeout(() => {
    floor = key; localStorage.setItem('office.floor', floor);
    cam.follow = null; closeCard();
    renderFloor(); renderPicker(); paintTree();
    stage.classList.remove('fade');
    if (then) then();
  }, 220);
}

// ---------- routing ----------
function routeTo(actor, to) {
  const grid = { cols: actor.room.cols, rows: actor.room.rows, blocked: actor.room.blocked };
  const from = { gx: Math.round(actor.gx), gy: Math.round(actor.gy) };
  // Standing on a seat: step out first through the nearest free tile.
  const start = actor.room.blocked.has(tkey(from.gx, from.gy)) && !(from.gx === to.gx && from.gy === to.gy) ? nearestFree(from, grid) : from;
  let path = findPath(start, to, grid);
  if (start !== from) path = [start, ...path];
  actor.path = path;
}
function goHome(actor) { routeTo(actor, actor.seat); }

// ---------- activities ----------
function claim(k) { if (busySpots.has(k)) return false; busySpots.add(k); return true; }
function release(actor) { if (actor.act && actor.act.key) busySpots.delete(actor.act.key); }
function startActivity(actor, kind, spot, k, pose, extra = {}) {
  if (k && !claim(k)) return false;
  actor.act = { kind, spot, key: k, pose, until: 0, ...extra };
  routeTo(actor, spot);
  return true;
}
function chooseIdea(actor, others) {
  const r = Math.random(); const S = actor.room.spots; others = others.filter(o => o.room === actor.room);
  const fk = actor.room.key;
  if (r < 0.2) return startActivity(actor, 'coffee', S.coffee, fk + 'coffee', 'stand', { dur: [5000, 10000], line: 'getting coffee', prop: 'mug', face: 1 });
  if (r < 0.32) return startActivity(actor, 'board', S.board, fk + 'board', 'stand', { dur: [5000, 9000], line: 'reading the board', face: -1 });
  if (r < 0.48) { const i = Math.floor(rnd(0, S.benches.length)); return startActivity(actor, 'bench', S.benches[i], fk + 'bench' + i, 'sit', { dur: [12000, 25000], line: 'taking a break', face: -1 }); }
  if (r < 0.58) { const i = Math.floor(rnd(0, actor.room.plants.length)); const p = actor.room.plants[i]; return startActivity(actor, 'plants', nearestFree({ gx: p.gx, gy: p.gy + 1 }, gridOf(actor.room)), fk + 'plants' + i, 'water', { dur: [6000, 10000], line: 'watering the plants', prop: 'can' }); }
  if (r < 0.7) { const i = Math.floor(rnd(0, 2)); return startActivity(actor, 'table', S.table[i], fk + 'table' + i, 'sit', { dur: [10000, 20000], line: 'lunch', face: 1 }); }
  if (r < 0.86) {
    const free = others.filter(o => o !== actor && o.status && o.status.state === 'idle' && !o.act && o.path.length === 0);
    if (free.length) {
      const partner = pick(free); const ci = Math.floor(rnd(0, S.chats.length));
      if (claim(fk + 'chat' + ci)) {
        const [a, b] = S.chats[ci];
        actor.act = { kind: 'chat', spot: a, key: fk + 'chat' + ci, pose: 'stand', until: 0, dur: [8000, 14000], partner: partner.id, line: 'chatting' };
        partner.act = { kind: 'chat', spot: b, key: null, pose: 'stand', until: 0, dur: [8000, 14000], partner: actor.id, line: 'chatting' };
        routeTo(actor, a); routeTo(partner, b); return true;
      }
    }
  }
  return startActivity(actor, 'stroll', pick(S.wander), null, 'stand', { dur: [3000, 7000], line: 'stretching legs' });
}
const gridOf = (room) => ({ cols: room.cols, rows: room.rows, blocked: room.blocked });

function applyStatuses() {
  const now = Date.now();
  const liveKeys = new Set(events.filter(e => e.kind === 'finish').map(e => e.run_id + ':finish'));
  seenFinish = quiet ? new Set(liveKeys) : new Set([...seenFinish].filter(k => liveKeys.has(k)));
  const problems = [];
  for (const actor of actors.values()) {
    const s = deriveStatus(actor.agent, events, now);
    const prev = actor.status; actor.status = s;
    if (!quiet) {
      for (const e of events) {
        if (e.agent_id !== actor.id || e.kind !== 'finish') continue;
        const k = e.run_id + ':finish'; if (seenFinish.has(k)) continue; seenFinish.add(k);
        if (e.ok) { actor.hopUntil = now + HOP_MS; if (actor.node) dropChest(actor); beep(CHIME_DONE); } else beep(CHIME_FAIL);
      }
      if (prev && prev.state !== 'blocked' && s.state === 'blocked') beep(CHIME_BLOCKED);
    }
    if (s.state !== 'idle' && actor.act && actor.act.kind !== 'task' && actor.act.kind !== 'mailbox') { endActivity(actor); goHome(actor); }
    if (s.state === 'blocked' && actor.id === 'courier' && !actor.act && (!prev || prev.state !== 'blocked')) startActivity(actor, 'mailbox', actor.room.spots.mailbox, null, 'stand', { dur: [8000, 12000], line: 'checking the mailbox', face: -1 });
    if (actor.screen) actor.screen.setAttribute('fill', s.state === 'working' ? '#85B7EB' : '#444441');
    if (actor.sub) {
      actor.sub.textContent = s.state === 'working' ? 'working now' : s.state === 'idle' ? `ok · ${ageText(s.lastAt)}` : s.state === 'offduty' ? 'off duty' : s.state === 'stale' ? (s.lastAt ? `quiet since ${ageText(s.lastAt)}` : 'no reports yet') : s.state === 'failed' ? 'last run failed' : 'needs you';
      actor.sub.setAttribute('class', `sub st-${s.state}`);
    }
    if (actor.dots) actor.dots.innerHTML = s.history.map((ok, k) => `<circle cx="${k * 9}" cy="0" r="3" fill="${ok ? '#2E9C6D' : '#D85A30'}" stroke="#2B2118" stroke-width="1"/>`).join('');
    const ex = explain(actor.agent, s);
    if (ex) { const ar = agentArea(actor.id); problems.push({ id: actor.id, floor: actor.fl.key, team: actor.agent.team || '', state: s.state, headline: ex.headline, link: ar ? ar[1] : null }); }
  }
  quiet = false;
  const counts = { working: 0, blocked: 0, failed: 0, stale: 0 };
  for (const a of actors.values()) if (a.fl.key === floor && a.status.state in counts) counts[a.status.state]++;
  $('stats').innerHTML = `<span class="pill st-working">${counts.working} working</span><span class="pill st-blocked">${counts.blocked} blocked</span><span class="pill st-failed">${counts.failed} failed</span><span class="pill st-stale">${counts.stale} stale</span>`;
  const alerts = $('alerts');
  alerts.innerHTML = `<div class="hud-title">Needs attention</div>` + (problems.length ? problems.map(p => `<button class="alert st-${p.state}" data-agent="${esc(p.id)}"><span class="ico">${p.state === 'blocked' ? '✋' : p.state === 'failed' ? '✗' : '💤'}</span><span class="txt">${esc(p.headline)}${p.link ? ` <a class="deep" href="${p.link}" target="_blank" rel="noopener" onclick="event.stopPropagation()">↗</a>` : ''}</span><span class="where">${esc(FLOOR_META[p.floor].title)}${p.team ? ' · ' + esc(p.team) : ''}</span></button>`).join('')
    : `<div class="allgood">Everyone in the building is fine.</div>`);
  alerts.querySelectorAll('button').forEach(b => b.onclick = () => { const a = actors.get(b.dataset.agent); if (!a) return; goFloor(a.fl.key, () => { cam.follow = b.dataset.agent; markFollow(); showCard(b.dataset.agent); }); });
}
function endActivity(actor) { release(actor); if (actor.act && actor.act.partner) { const p = actors.get(actor.act.partner); if (p && p.act && p.act.kind === 'chat') { release(p); p.act = null; goHome(p); } } actor.act = null; }

function dropChest(actor) {
  const g = document.createElementNS(NS, 'g');
  const p = spos(actor); const x = p.x + 30, y = p.y - 60;
  g.innerHTML = `<rect x="${x}" y="${y}" width="26" height="19" rx="3" fill="#C48A4A" stroke="#2B2118" stroke-width="2"/><rect x="${x}" y="${y}" width="26" height="7" rx="3" fill="#8B5A2B" stroke="#2B2118" stroke-width="2"/><rect x="${x + 10}" y="${y + 5}" width="6" height="6" fill="#E9B44C" stroke="#2B2118" stroke-width="1.2"/><text x="${x + 13}" y="${y - 6}" text-anchor="middle" font-size="13" font-weight="800" fill="#5DCAA5">+1</text>`;
  g.style.transition = 'opacity 1s'; layer.effects.appendChild(g);
  setTimeout(() => { g.style.opacity = '0'; }, 3500); setTimeout(() => g.remove(), 4600);
}

// ---------- animation loop ----------
let last = performance.now(), lastOrder = '';
function frame(t) {
  const dt = Math.min(0.05, (t - last) / 1000); last = t;
  const now = Date.now();
  const list = [...actors.values()];
  for (const actor of list) {
    const st = actor.status ? actor.status.state : 'idle';
    const atRest = actor.path.length === 0;
    if (atRest) {
      if (actor.act) {
        if (actor.act.hold) { /* ends when the task ends, see applyRunnerTasks */ }
        else if (!actor.act.until) actor.act.until = now + rnd(...actor.act.dur);
        else if (now > actor.act.until) { endActivity(actor); goHome(actor); actor.nextIdeaAt = now + rnd(10000, 40000); }
      }
      // Nobody wanders. People leave their desk only for a job: the Runner walks
      // to the desk he is running a task for, the Courier checks the mailbox when
      // a lead file is parked. Everyone else stays put and is easy to click.
    }
    let pose;
    if (now < actor.hopUntil) pose = 'hop';
    else if (actor.path.length) {
      const p = actor.path[0];
      const dx = p.gx - actor.gx, dy = p.gy - actor.gy, dist = Math.hypot(dx, dy);
      const step = Math.min(dist, SPEED * dt);
      if (dist > 0) { actor.gx += dx / dist * step; actor.gy += dy / dist * step; }
      const sdx = (dx - dy);   // screen x direction of travel
      if (Math.abs(sdx) > 0.01) actor.facing = sdx < 0 ? -1 : 1;
      if (dist - step <= 0.01) { actor.gx = p.gx; actor.gy = p.gy; actor.path.shift(); }
      pose = actor.act && actor.act.kind === 'errand' ? 'carrywalk' : 'walk';
    } else if (actor.act) {
      pose = actor.act.pose;
      if (actor.act.kind === 'chat') { const p = actors.get(actor.act.partner); if (p) actor.facing = (p.gx - p.gy) < (actor.gx - actor.gy) ? -1 : 1; }
      else if (actor.act.face) actor.facing = actor.act.face;
    } else {
      const atSeat = Math.abs(actor.gx - actor.seat.gx) < 0.1 && Math.abs(actor.gy - actor.seat.gy) < 0.1;
      pose = st === 'working' ? 'type' : st === 'failed' ? 'slump' : st === 'stale' || st === 'offduty' ? 'sleep' : atSeat ? 'sit' : 'stand';
      actor.facing = 1;
    }
    actor.pose = pose;
    actor.frame += dt * (pose === 'walk' || pose === 'carrywalk' ? 11 : pose === 'hop' ? (Math.PI / (HOP_MS / 1000)) : 4);
  }
  // Draw this floor's actors.
  for (const actor of list) {
    if (!actor.node) continue;
    const st = actor.status ? actor.status.state : 'idle';
    const prop = actor.act && actor.act.prop && actor.path.length === 0 ? actor.act.prop : (actor.act && actor.act.prop && actor.act.kind === 'errand') ? actor.act.prop : (actor.agent.sprite || {}).prop || (actor.id.startsWith('chief-') ? 'clipboard' : '');
    const k = `${actor.pose}|${st}|${prop}|${Math.round(actor.frame * 5)}`;
    if (k !== actor.lastKey) { actor.lastKey = k; actor.node.innerHTML = character({ id: actor.id, sprite: actor.agent.sprite || {}, state: st, frame: actor.frame, pose: actor.pose, prop }); }
    const p = spos(actor); const lift = actor.hover ? 4 : 0;
    actor.node.setAttribute('transform', `translate(${p.x.toFixed(1)},${(p.y - lift).toFixed(1)}) scale(${actor.facing * SCALE},${SCALE}) translate(-50,-118)`);
    let extra = '';
    const headY = p.y - 118 * SCALE;
    const line = actor.act && actor.path.length === 0 ? actor.act.line : (actor.status && actor.status.bubble && actor.pose !== 'walk' && actor.pose !== 'carrywalk' && (actor.hover || cam.follow === actor.id) ? sayStatus(actor.agent, actor.status, nameMap()) : '');
    if (line) {
      const txt = line.slice(0, 40); const w = Math.min(300, 24 + txt.length * 7.2);
      extra += `<g><rect x="${(p.x - w / 2).toFixed(0)}" y="${(headY - 34).toFixed(0)}" width="${w.toFixed(0)}" height="22" rx="11" fill="#FFFFFFF2" stroke="#2B2118" stroke-width="1.5"/><path d="M${p.x - 5} ${headY - 12} L${p.x} ${headY - 5} L${p.x + 5} ${headY - 12}Z" fill="#FFFFFFF2"/><text x="${p.x.toFixed(0)}" y="${(headY - 19).toFixed(0)}" text-anchor="middle" class="bubble">${esc(txt)}</text></g>`;
    }
    const b = badge(st); if (b && !line) extra += `<g transform="translate(${(p.x + 14).toFixed(0)},${(headY - 8 + Math.sin(actor.frame) * 2).toFixed(1)})">${b}</g>`;
    if (actor.act && actor.act.kind === 'chat' && actor.path.length === 0) extra += `<text x="${(p.x + 16).toFixed(0)}" y="${(headY - 4).toFixed(0)}" font-size="16" fill="#2B2118" opacity="${(0.4 + Math.abs(Math.sin(actor.frame)) * 0.6).toFixed(2)}">…</text>`;
    if ((st === 'stale' || st === 'offduty') && !actor.act) extra += `<text x="${(p.x + 18).toFixed(0)}" y="${(headY - 6 - (actor.frame % 3) * 7).toFixed(0)}" font-size="14" font-weight="700" fill="#FFF" opacity="${(1 - (actor.frame % 3) / 3).toFixed(2)}">z</text>`;
    if (actor.hover || cam.follow === actor.id) {
      const tw = 14 + actor.agent.name.length * 7;
      extra += `<g><rect x="${(p.x - tw / 2).toFixed(0)}" y="${(p.y + 6).toFixed(0)}" width="${tw.toFixed(0)}" height="17" rx="8" fill="#1B2140F0" stroke="#5FA8FF" stroke-width="1"/><text x="${p.x.toFixed(0)}" y="${(p.y + 18.5).toFixed(0)}" text-anchor="middle" class="tag" fill="#F1E9DA">${esc(actor.agent.name)}</text></g>`;
    }
    if (cam.follow === actor.id) extra += `<ellipse cx="${p.x.toFixed(0)}" cy="${(p.y + 2).toFixed(0)}" rx="26" ry="10" fill="none" stroke="#FFF" stroke-width="2" stroke-dasharray="6 4" opacity="0.9"/>`;
    if (extra !== actor.lastExtra) { actor.lastExtra = extra; actor.overlay.innerHTML = extra; }
  }
  for (const l of layer.lamps || []) {
    const a = actors.get(l.dataset.agent);
    l.setAttribute('fill', a && a.status && a.status.state === 'failed' && Math.floor(now / 500) % 2 ? '#E24B4A' : a && a.status && a.status.state === 'working' ? '#FFE27A' : '#444441');
  }
  // Depth sort: furniture and actors interleave by (gx + gy).
  for (const it of sceneItems) if (it.kind === 'actor') it.depth = it.actor.gx + it.actor.gy + 1.01;
  const order = sceneItems.slice().sort((a, b) => a.depth - b.depth);
  const sig = order.map(o => o.kind === 'actor' ? o.actor.id : o.depth).join('|');
  if (sig !== lastOrder) { lastOrder = sig; for (const o of order) layer.scene.appendChild(o.node); }
  // Camera follow.
  if (cam.follow && actors.has(cam.follow)) {
    const a = actors.get(cam.follow); const p = spos(a);
    cam.w = lerp(cam.w, 620, 0.1); fitHeight();
    cam.x = lerp(cam.x, p.x - cam.w / 2, 0.1); cam.y = lerp(cam.y, p.y - cam.h / 2 - 20, 0.1); clampCam(); applyCam();
  }
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  const max = nightMode ? 0.18 : 0;
  const night = h < 6 ? max : h < 8 ? max * (8 - h) / 2 : h < 18 ? 0 : h < 21 ? max * (h - 18) / 3 : max;
  if (layer.night) layer.night.setAttribute('opacity', night.toFixed(2));
  requestAnimationFrame(frame);
}

// ---------- the Runner at work ----------
// While a task is running, the floor's Runner walks to that worker's desk and
// stands there until it finishes. This is the only movement on a quiet floor.
let tasksByFloor = {};
async function loadTasks() {
  if (FIXTURE) return;
  for (const fl of building.floors) {
    try { tasksByFloor[fl.key] = await (await fetch(`/api/tasks?floor=${fl.key}`)).json(); } catch { tasksByFloor[fl.key] = tasksByFloor[fl.key] || []; }
  }
  applyRunnerTasks();
}
function applyRunnerTasks() {
  for (const actor of actors.values()) {
    if (!actor.id.startsWith('runner-')) continue;
    const running = (tasksByFloor[actor.fl.key] || []).find(t => t.state === 'running');
    const cur = actor.act && actor.act.kind === 'task' ? actor.act : null;
    if (running) {
      if (cur && cur.taskId === running.id) continue;
      const target = actor.room.desks.find(d => d.agent === running.agent_id);
      if (!target) continue;
      if (cur) release(actor);
      const spot = nearestFree({ gx: target.gx, gy: target.gy + 1 }, gridOf(actor.room));
      const who = (agents.find(a => a.id === running.agent_id) || {}).name || running.agent_id;
      actor.act = { kind: 'task', spot, key: null, pose: 'stand', until: 0, hold: true, taskId: running.id, line: `running ${KIND_LABEL[running.kind] || running.kind} for ${who}`, prop: 'clipboard', face: -1 };
      routeTo(actor, spot);
    } else if (cur) { endActivity(actor); goHome(actor); }
  }
}

// ---------- boards ----------
const boards = {};
async function loadBoards() {
  if (FIXTURE) return;
  for (const fl of building.floors) {
    try { boards[fl.key] = await (await fetch(`/api/board?floor=${fl.key}`)).json(); } catch { boards[fl.key] = null; }
  }
  paintBoards();
}
// The notice board and the scoreboard hang flat above the room (straight on, not on an angled wall).
function paintBoards() {
  const el = $('wallboards'); if (!el) return;
  const fl = building.floors.find(f => f.key === floor); const skin = SKINS[floor];
  if (!fl || !skin) { el.innerHTML = ''; return; }
  const b = boards[floor];
  const lines = [];
  for (const a of actors.values()) {
    if (a.fl !== fl || !a.status) continue;
    const ex = explain(a.agent, a.status);
    if (ex) lines.push({ text: ex.headline, warn: true });
  }
  for (const a of actors.values()) {
    if (a.fl !== fl || !a.status || !a.status.bubble || lines.length >= 4) continue;
    lines.push({ text: `${a.agent.name}: ${sayStatus(a.agent, a.status, nameMap())}` });
  }
  const shown = lines.slice(0, 4), more = lines.length - shown.length;
  const tiles = (b && b.tiles || []).slice(0, 8);
  const html = `<button class="wb wb-notice" id="wb-notice"><div class="wb-title"><span>Notice board</span><span>${more > 0 ? `+${more} more · ` : ''}open floor report</span></div>
      <ul>${shown.length ? shown.map(l => `<li class="${l.warn ? 'warn' : ''}" title="${esc(l.text)}">${l.warn ? '! ' : ''}${esc(l.text)}</li>`).join('') : '<li class="none">Nothing to report</li>'}</ul></button>
    <button class="wb wb-score" id="wb-score"><div class="wb-title"><span>${esc(skin.boardTitle)}</span></div>
      <div class="wb-tiles">${tiles.length ? tiles.map(t => `<div title="${esc(t.label)}: ${esc(t.value)}"><div class="tl">${esc(t.label)}</div><div class="tv tone-${esc(t.tone || '')}">${esc(t.value)}</div></div>`).join('') : '<div><div class="tl">Board</div><div class="tv">loading…</div></div>'}</div></button>`;
  if (el.dataset.html === html) return;
  const before = el.offsetHeight;
  el.dataset.html = html; el.innerHTML = html;
  $('wb-notice').onclick = () => showBoardPanel(floor);
  $('wb-score').onclick = () => { const bb = boards[floor]; if (bb && bb.dashboard) openOverlay(bb.dashboard, bb.dashboardTitle || 'dashboard'); else showBoardPanel(floor); };
  if (el.offsetHeight !== before) { if (!cam.follow) overview(); else { fitHeight(); applyCam(); } }
}
function showBoardPanel(k) {
  const fl = building.floors.find(f => f.key === k); const b = boards[k];
  const rows = [];
  for (const a of actors.values()) if (a.fl === fl && a.status) rows.push(a);
  const d = $('detail'); d.style.display = 'block'; $('detail-empty').style.display = 'none';
  d.innerHTML = `<div class="card-head"><div><strong>${esc(FLOOR_META[k].title)} floor report</strong><br><span class="muted">everything on this floor, right now</span></div><button id="detail-close" title="close">×</button></div>
    ${b && b.tiles ? `<div class="tiles">${b.tiles.map(t => `<div class="tile tone-${esc(t.tone || '')}"><div class="tl">${esc(t.label)}</div><div class="tv">${esc(t.value)}</div></div>`).join('')}</div>` : ''}
    ${b && b.dashboard ? `<div class="actions"><button id="open-dash">Open the ${esc((b.dashboardTitle || 'dashboard').toLowerCase())}</button></div>` : ''}
    ${b && b.accounts && b.accounts.length ? `<h4>Active evals</h4><table class="ft"><thead><tr><th>Account</th><th>Firm</th><th>Net</th><th>Progress</th><th>Drawdown used</th><th>Trades</th></tr></thead><tbody>${b.accounts.map(a => `<tr><td>${esc(a.id)}</td><td>${esc(a.firm || '')}</td><td>${a.net}</td><td>${a.progress == null ? '–' : Math.round(a.progress * 100) + '%'}</td><td>${a.ddUsed == null ? '–' : Math.round(a.ddUsed * 100) + '%'}</td><td>${a.trades}</td></tr>`).join('')}</tbody></table>` : ''}
    <h4>Workers</h4><table class="ft"><thead><tr><th>Worker</th><th>State</th><th>Last word</th></tr></thead><tbody>${rows.map(a => `<tr><td><a href="#" data-open="${esc(a.id)}">${esc(a.agent.name)}</a></td><td class="st-${a.status.state}">${esc(a.status.state)}</td><td>${esc(a.status.bubble || '')}</td></tr>`).join('')}</tbody></table>`;
  $('detail-close').onclick = () => closeCard();
  d.querySelectorAll('[data-open]').forEach(a => a.onclick = (e) => { e.preventDefault(); cam.follow = a.dataset.open; markFollow(); showCard(a.dataset.open); });
  const od = $('open-dash'); if (od) od.onclick = () => openOverlay(b.dashboard, b.dashboardTitle || 'dashboard');
}
// The whole company on one card: each floor's Chief brief, then each lead's roll-up line.
async function showBrief() {
  const d = $('detail'); d.style.display = 'block'; $('detail-empty').style.display = 'none';
  d.innerHTML = `<div class="card-head"><div><strong>Today's brief</strong><br><span class="muted">what the Chiefs and leads found this morning</span></div><button id="detail-close" title="close">×</button></div><p class="muted">Loading…</p>`;
  $('detail-close').onclick = () => closeCard();
  const parts = [];
  for (const fl of building.floors) {
    let snap = null; try { snap = await (await fetch(`/api/snapshot?agent=chief-${fl.key}`)).json(); } catch {}
    const leads = fl.agents.filter(a => a.lead && !a.id.startsWith('chief-')).map(a => { const s = actors.get(a.id)?.status; return `<tr><td><a href="#" data-open="${esc(a.id)}">${esc(a.name)}</a> <span class="muted">${esc(a.team || '')}</span></td><td class="st-${s ? s.state : 'idle'}">${esc(s ? s.state : '')}</td><td>${esc(s && s.bubble ? s.bubble : '')}</td></tr>`; }).join('');
    parts.push(`<h3 style="margin:16px 0 4px;color:${FLOOR_META[fl.key].accent}">${esc(FLOOR_META[fl.key].title)}</h3>${snap ? renderFindings('chief-' + fl.key, snap) : '<p class="muted">No brief yet today.</p>'}${leads ? `<h4>Leads</h4><table class="ft"><tbody>${leads}</tbody></table>` : ''}`);
  }
  d.innerHTML = `<div class="card-head"><div><strong>Today's brief</strong><br><span class="muted">what the Chiefs and leads found this morning</span></div><button id="detail-close" title="close">×</button></div>${parts.join('')}`;
  $('detail-close').onclick = () => closeCard();
  d.querySelectorAll('[data-open]').forEach(x => x.onclick = (e) => { e.preventDefault(); const a = agents.find(y => y.id === x.dataset.open); if (a) goFloor(a.floor, () => { cam.follow = a.id; markFollow(); showCard(a.id); }); });
}
function openOverlay(src, title) {
  const o = $('overlay'); o.hidden = false;
  o.innerHTML = `<div class="overlay-head"><strong>${esc(title)}</strong><a href="${esc(src)}" target="_blank" rel="noopener">open in a tab</a><button id="overlay-close">×</button></div><iframe src="${esc(src)}"></iframe>`;
  $('overlay-close').onclick = () => { o.hidden = true; o.innerHTML = ''; };
}

// ---------- floor picker + top bar ----------
function renderPicker() {
  const el = $('lift');
  el.innerHTML = `<div class="hud-title">Floors</div>` + building.floors.map((f, i) => {
    const bad = [...actors.values()].filter(a => a.fl.key === f.key && a.status && ['failed', 'blocked', 'stale'].includes(a.status.state)).length;
    return `<button data-floor="${f.key}" class="${f.key === floor ? 'on' : ''}" style="--accent:${FLOOR_META[f.key].accent}"><span class="num">${i + 1}</span><span class="name">${esc(FLOOR_META[f.key].title)}</span><span class="count">${f.agents.length}${bad ? ` <b class="bad">${bad}</b>` : ''}</span></button>`;
  }).reverse().join('');
  el.querySelectorAll('button').forEach(b => b.onclick = () => { beep(CLICK); goFloor(b.dataset.floor); });
}
function renderTabs() {
  const tabs = $('tabs');
  tabs.innerHTML = `<button id="briefbtn" title="every floor's brief in one place">📋 Today's brief</button><button id="soundbtn" class="icon" title="chimes on finish and blocked">${sound ? '🔔' : '🔕'}</button><button id="nightbtn" class="icon" title="dim the office in the evening">${nightMode ? '🌙' : '☀️'}</button>`;
  $('briefbtn').onclick = () => showBrief();
  $('soundbtn').onclick = () => { sound = !sound; localStorage.setItem('office.sound', sound ? 'on' : 'off'); renderTabs(); };
  $('nightbtn').onclick = () => { nightMode = !nightMode; localStorage.setItem('office.night', nightMode ? 'on' : 'off'); renderTabs(); };
}

const STATE_WORD = { working: 'Working', idle: 'All good', failed: 'Broken', blocked: 'Needs you', stale: 'Quiet', offduty: 'Off' };
const nameMap = () => Object.fromEntries(agents.map(x => [x.id, x.name]));
// The whole card: who, how they're doing in one sentence, and the one or two buttons that matter.
function showCard(id) {
  const a = agents.find(x => x.id === id); if (!a) return;
  const actor = actors.get(id); const s = actor ? actor.status : null;
  const st = s ? s.state : 'idle';
  const f = FACTS[a.id] || {};
  const code = st === 'failed' ? (/exit (\d+)/.exec(s.bubble || '') || [])[1] : null;
  const buttons = [];
  if (code && f.failCommands && f.failCommands[code]) buttons.push(`<button class="primary" data-run="fix" data-code="${esc(code)}" data-agent="${esc(a.id)}">Fix it now</button>`);
  else if (f.run) buttons.push(`<button class="${['failed', 'stale'].includes(st) ? 'primary' : ''}" data-run="run" data-agent="${esc(a.id)}">${f.observed ? 'Check again' : 'Run now'}</button>`);
  const area = agentArea(a.id);
  if (area) buttons.push(area[1].startsWith('/')
    ? `<button class="btn-link" data-overlay="${esc(area[1])}" data-overlay-title="${esc(area[0])}">${esc(area[2] || area[0])}</button>`
    : `<a class="btn-link" href="${area[1]}" target="_blank" rel="noopener">${esc(area[2] || 'Open in Grow ↗')}</a>`);
  if (!FIXTURE && !a.id.startsWith('runner-')) buttons.push(`<button id="report-btn" hidden>Full report</button>`);
  buttons.push(`<button id="job-btn">What I do</button>`);
  const d = $('detail'); d.style.display = 'block'; $('detail-empty').style.display = 'none';
  d.innerHTML = `<div class="card-head"><svg viewBox="0 0 100 130" width="48" height="62" class="portrait">${character({ id: a.id, sprite: a.sprite || {}, state: st, frame: 0, pose: 'stand', prop: (a.sprite || {}).prop || (a.id.startsWith('chief-') ? 'clipboard' : '') })}</svg>
      <div><strong>${esc(a.name)}</strong>${a.lead ? ' <span class="lead">Lead</span>' : ''}<br><span class="state st-${st}">${STATE_WORD[st] || st}</span></div>
      <button id="detail-close" title="close">×</button></div>
    <p class="say say-${st}">${esc(s ? sayStatus(a, s, nameMap()) : '')}</p>
    ${buttons.length ? `<div class="actions">${buttons.join('')}</div>` : ''}
    <p class="about" id="job" hidden>${esc(about(a))}</p>
    <ol class="talk" id="talk" hidden></ol>
    ${teamRollup(a)}
    <div id="queue"></div>
    <div id="findings" hidden></div>`;
  $('detail-close').onclick = () => { closeCard(); cam.follow = null; markFollow(); overview(); };
  const wireOpen = (root) => root.querySelectorAll('[data-open]').forEach(x => x.onclick = (e) => { e.preventDefault(); cam.follow = x.dataset.open; markFollow(); showCard(x.dataset.open); });
  wireOpen(d);
  d.querySelectorAll('[data-overlay]').forEach(x => x.onclick = () => openOverlay(x.dataset.overlay, x.dataset.overlayTitle));
  if (!FIXTURE && a.id.startsWith('runner-')) loadQueue(a.floor);
  $('job-btn').onclick = () => { const j = $('job'); j.hidden = !j.hidden; $('job-btn').textContent = j.hidden ? 'What I do' : 'Hide'; };
  const rb = $('report-btn');
  let snapP = null;
  // Only workers that saved a report get the button; the report itself stays folded until asked for.
  if (rb) { snapP = fetch(`/api/snapshot?agent=${encodeURIComponent(id)}`).then(r => r.json()).catch(() => null); snapP.then(snap => { if (snap && rb.isConnected) rb.hidden = false; }); }
  if (rb) rb.onclick = async () => {
    const box = $('findings');
    if (!box.hidden) { box.hidden = true; rb.textContent = 'Full report'; return; }
    box.hidden = false; rb.textContent = 'Hide report'; box.innerHTML = '<p class="muted">Loading…</p>';
    try { const snap = await snapP; box.innerHTML = renderFindings(id, snap); wireOpen(box); }
    catch { box.innerHTML = '<p class="muted">Could not load the report.</p>'; }
  };
  d.querySelectorAll('[data-run]').forEach(b => b.onclick = async () => {
    const talk = $('talk'); talk.hidden = false; talk.innerHTML = '';
    let last = '';
    const say = (t, cls = '') => { if (!t || t === last) return; last = t; talk.querySelectorAll('li.now').forEach(li => li.classList.remove('now')); const li = document.createElement('li'); li.textContent = t; li.className = cls || 'now'; talk.appendChild(li); };
    say(b.dataset.run === 'fix' ? "I'm fixing it now" : "I'm on it");
    b.disabled = true;
    let all = '', partial = '';
    try {
      const r = await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: b.dataset.agent, action: b.dataset.run, code: b.dataset.code }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || r.status); }
      // The raw output is only read, never shown: each line that means something becomes one plain sentence.
      const reader = r.body.getReader(), dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        const t = dec.decode(value, { stream: true }); all += t;
        const parts = (partial + t).split(/\r?\n|\r/); partial = parts.pop();
        for (const line of parts) say(talkLine(a.id, line));
      }
      if (partial) say(talkLine(a.id, partial));
      const exit = (/\[exit (\S+)\]\s*$/.exec(all) || [])[1];
      if (exit === '0') {
        // Workers without their own phrases print one summary line at the end; that line is the result.
        const result = !TALK[a.id] && all.split('\n').map(x => x.trim()).filter(x => x && !/^\[exit/.test(x) && !/^\$ |^\/|Traceback|Warning/.test(x)).pop();
        say(result && result.length < 200 ? `Done. ${result}` : 'Done', 'done');
      } else {
        const hint = exit && f.failHints && f.failHints[exit];
        say(hint || (exit === 'killed' ? 'That took too long, so I stopped' : "That didn't work"), 'bad');
      }
      setTimeout(tick, 1500);
    } catch (e) { say("I couldn't start: " + e.message, 'bad'); }
    b.disabled = false;
  });
}

// ---------- the Runner's queue ----------
async function loadQueue(fl) {
  const q = $('queue'); if (!q) return;
  let rows = [];
  try { rows = await (await fetch(`/api/tasks?floor=${fl}`)).json(); } catch { q.innerHTML = '<p class="muted">Could not load the queue.</p>'; return; }
  const open = rows.filter(t => t.state === 'waiting' || t.state === 'queued' || t.state === 'running');
  const recent = rows.filter(t => t.state === 'done' || t.state === 'failed').slice(0, 8);
  const when = (iso) => iso ? esc(iso).slice(5, 16).replace('T', ' ') : '';
  const line = (t) => `<tr><td>#${t.id}</td><td>${esc(KIND_LABEL[t.kind] || t.kind)}${t.args && t.args.code ? ` (exit ${esc(t.args.code)})` : ''}</td><td><a href="#" data-open="${esc(t.agent_id)}">${esc(t.agent_id)}</a></td><td class="st-${esc(t.state)}">${esc(t.state)}</td><td>${esc(t.note || t.result || '')}</td><td>${t.state === 'waiting' ? `<button data-approve="${t.id}">Approve</button> ` : ''}${t.state === 'waiting' || t.state === 'queued' ? `<button data-cancel="${t.id}">Cancel</button>` : when(t.finished_at || t.started_at || t.requested_at)}</td></tr>`;
  q.innerHTML = open.length ? `<h4>Waiting on you (${open.length})</h4><table class="ft"><tbody>${open.map(line).join('')}</tbody></table>` : '';
  q.querySelectorAll('[data-approve]').forEach(b => b.onclick = async () => { b.disabled = true; await fetch('/api/task/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: Number(b.dataset.approve) }) }); loadQueue(fl); });
  q.querySelectorAll('[data-cancel]').forEach(b => b.onclick = async () => { b.disabled = true; await fetch('/api/task/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: Number(b.dataset.cancel) }) }); loadQueue(fl); });
  q.querySelectorAll('[data-open]').forEach(x => x.onclick = (e) => { e.preventDefault(); cam.follow = x.dataset.open; markFollow(); showCard(x.dataset.open); });
}
// A lead's card lists the team: state and last word for each member, click to open.
function teamRollup(a) {
  if (!a.lead || !a.team || a.team === 'Leadership') return '';
  const members = [...actors.values()].filter(x => x.agent.team === a.team && x.fl.key === a.floor && x.id !== a.id);
  if (!members.length) return '';
  const bad = members.filter(m => m.status && ['failed', 'blocked', 'stale'].includes(m.status.state)).length;
  return `<h4>${esc(a.team)} team${bad ? ` · <span class="warn">${bad} need you</span>` : ' · all good'}</h4><table class="ft"><tbody>${members.map(m => `<tr><td><a href="#" data-open="${esc(m.id)}">${esc(m.agent.name)}</a></td><td class="muted clip" title="${esc(m.status ? sayStatus(m.agent, m.status, nameMap()) : '')}">${esc(m.status ? sayStatus(m.agent, m.status, nameMap()) : '')}</td></tr>`).join('')}</tbody></table>`;
}
function about(a) {
  const f = FACTS[a.id];
  if (f && f.about) return f.about;
  return `${a.name} handles ${a.role.toLowerCase()} and runs ${cadenceText(a.cadence_seconds)}.`;
}

// ---------- org tree view (site/tree.js) ----------
// Same floor, same workers, drawn as Chief -> teams -> workers. The room keeps running underneath.
let view = (!FIXTURE && localStorage.getItem('office.view')) || 'room';   // room | tree (this floor) | all (every floor around you)
const treeCam = { k: 1, x: 0, y: 0, key: '', dragged: false };
function setView(v) { view = v; localStorage.setItem('office.view', v); paintTree(); }
function treeBox() { const s = $('tree').querySelector('svg'); return s ? [s, ...s.dataset.box.split(' ').map(Number)] : null; }
function applyTreeCam() {
  const b = treeBox(); if (!b) return; const [s, , , W, H] = b, w = W / treeCam.k, h = H / treeCam.k;
  treeCam.x = Math.max(0, Math.min(W - w, treeCam.x)); treeCam.y = Math.max(0, Math.min(H - h, treeCam.y));
  s.setAttribute('viewBox', `${treeCam.x.toFixed(1)} ${treeCam.y.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`);
  s.style.cursor = treeCam.k > 1 ? 'grab' : '';
}
function setupTreeCam() {
  const t = $('tree'); let drag = null;
  t.addEventListener('wheel', (e) => {
    const b = treeBox(); if (!b) return; e.preventDefault();
    const [s, , , W, H] = b, r = s.getBoundingClientRect(), k0 = treeCam.k, k1 = Math.max(1, Math.min(6, k0 * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    treeCam.x += ((e.clientX - r.left) / r.width) * (W / k0 - W / k1); treeCam.y += ((e.clientY - r.top) / r.height) * (H / k0 - H / k1);
    treeCam.k = k1; applyTreeCam();
  }, { passive: false });
  t.addEventListener('pointerdown', (e) => { treeCam.dragged = false; if (treeCam.k > 1) drag = { x: e.clientX, y: e.clientY, cx: treeCam.x, cy: treeCam.y }; });
  window.addEventListener('pointermove', (e) => {
    if (!drag) return; const b = treeBox(); if (!b) return; const [s, , , W] = b, per = (W / treeCam.k) / s.getBoundingClientRect().width;
    if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) treeCam.dragged = true;
    treeCam.x = drag.cx - (e.clientX - drag.x) * per; treeCam.y = drag.cy - (e.clientY - drag.y) * per; applyTreeCam();
  });
  window.addEventListener('pointerup', () => { drag = null; });
  // A drag that ends on a node is not a click on it.
  t.addEventListener('click', (e) => { if (treeCam.dragged) { e.stopPropagation(); treeCam.dragged = false; } }, true);
}
function paintTree() {
  const t = $('tree'); if (!t) return;
  const on = view !== 'room';
  document.querySelectorAll('#views button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  t.hidden = !on; svg().style.visibility = on ? 'hidden' : ''; $('overview').hidden = on;
  if (!on) return;
  const key = view + ':' + (view === 'all' ? '' : floor);
  if (key !== treeCam.key) { treeCam.key = key; treeCam.k = 1; treeCam.x = treeCam.y = 0; }
  const stateOf = (id) => { const a = actors.get(id); return a && a.status ? a.status.state : 'idle'; };
  const pageOf = (id) => { const ar = agentArea(id); return ar && ar[1].startsWith('/') ? ar : null; };
  t.innerHTML = view === 'all'
    ? renderRadial(building.floors.map(f => treeModel(agents, f.key, stateOf)), stateOf, pageOf, Object.fromEntries(Object.entries(FLOOR_META).map(([k, m]) => [k, m.title])))
    : renderTree(treeModel(agents, floor, stateOf), stateOf, pageOf);
  applyTreeCam();
  t.querySelectorAll('[data-overlay]').forEach(x => x.onclick = (e) => { e.stopPropagation(); openOverlay(x.dataset.overlay, x.dataset.overlayTitle); });
  t.querySelectorAll('[data-open]').forEach(x => x.onclick = () => { const id = x.dataset.open, a = agents.find(z => z.id === id); if (a && a.floor !== floor) goFloor(a.floor, () => showCard(id)); else showCard(id); });
  t.querySelectorAll('[data-floor]').forEach(x => x.onclick = () => goFloor(x.dataset.floor, () => setView('tree')));
}

async function tick() {
  try {
    const d = FIXTURE ? await loadFixture() : await loadLive();
    agents = d.agents; events = d.events;
    const ids = agents.map(a => a.floor + ':' + a.id).join('|');
    if (ids !== lastIds) { lastIds = ids; buildScene(); } else renderPicker();
    applyStatuses(); paintBoards(); paintTree();
    if (!boards._at || Date.now() - boards._at > 60000) { boards._at = Date.now(); loadBoards(); }
    loadTasks();
  } catch (e) { $('stats').textContent = 'load failed: ' + e.message; }
}

function fixtureStory() {
  let i = 0;
  setInterval(() => {
    const ids = agents.map(a => a.id); if (!ids.length) return;
    const id = ids[i++ % ids.length], run = 'story-' + i;
    events.unshift({ agent_id: id, run_id: run, kind: 'start', ok: null, status: '', created_at: new Date().toISOString() });
    applyStatuses();
    setTimeout(() => {
      const ok = Math.random() > 0.2;
      events.unshift({ agent_id: id, run_id: run, kind: 'finish', ok, status: ok ? `Synced ${Math.floor(rnd(5, 300))} rows` : 'exit 1', created_at: new Date().toISOString() });
      events = events.slice(0, 300); applyStatuses();
    }, 6000);
  }, 15000);
}

async function main() {
  renderTabs();
  document.querySelectorAll('#views button').forEach(b => b.onclick = () => setView(b.dataset.view));
  setupTreeCam();
  await tick();
  setupCamera(); overview(); markFollow();
  requestAnimationFrame(frame);
  if (FIXTURE) fixtureStory(); else setInterval(tick, POLL_MS);
}
main().catch(e => { $('stats').textContent = 'failed to start: ' + e.message; });
