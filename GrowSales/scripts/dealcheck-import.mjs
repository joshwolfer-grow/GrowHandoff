#!/usr/bin/env node
// Import an ISP's deal list into dealcheck_leads for the Deal Check page.
//
//   node scripts/dealcheck-import.mjs <file.csv> --isp "Ezee Fiber" [--list "Oct 7 audit"] [--dry]
//
// Every row goes in. A row that matches a Grow deal (phone first, then street
// number + street name, checked against zip when both sides have one) carries
// deal_key / grow_rep, so the card can say which rep sold it. Re-running the
// same file updates rows in place: the id is '<isp slug>:<order number>' when the
// list has one, otherwise the phone, otherwise the street address.
//
// Column names differ per list. PROFILES maps the ones we have seen; anything
// else is guessed from the header text, and the dry run prints the mapping it
// used so a wrong guess is visible before anything is written.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SB = html.match(/const SUPABASE_URL='([^']+)'/)[1];
const KEY = process.env.SUPABASE_SERVICE_KEY || html.match(/const SUPABASE_ANON='([^']+)'/)[1];
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

const args = process.argv.slice(2);
const opt = (k) => (args.indexOf(k) >= 0 ? (args[args.indexOf(k) + 1] || '').trim() : '');
const file = args.find((a, i) => !a.startsWith('--') && !['--isp', '--list'].includes(args[i - 1]));
const isp = opt('--isp');
const dry = args.includes('--dry');
if (!file || !isp) {
  console.error('usage: node scripts/dealcheck-import.mjs <file.csv> --isp "Ezee Fiber" [--list "name"] [--dry]');
  process.exit(1);
}
const list = opt('--list') || path.basename(file).replace(/\.[^.]+$/, '');
const slug = isp.toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9]/g, '');

// ---------- CSV (quoted fields may hold commas and newlines) ----------
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { f += '"'; i++; }
      else if (c === '"') q = false;
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f); f = ''; if (row.some((x) => x !== '')) rows.push(row); row = [];
    } else f += c;
  }
  row.push(f); if (row.some((x) => x !== '')) rows.push(row);
  const head = rows.shift().map((h) => h.trim());
  return { head, rows: rows.map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()]))) };
}

// ---------- column mapping ----------
// Add a profile per ISP once its layout is known. Keys: order, name, first, last,
// email, phones (array, best first), address (street, or a full address with
// city/state/zip after commas), city, state, zip, package, sold, notes, rep.
const PROFILES = {};
const profileFor = (head) => Object.entries(PROFILES).find(([k, p]) => (k === slug || k.startsWith(slug + '_')) && head.includes(p.order || p.name))?.[1];
function guessProfile(head) {
  const find = (re, not) => head.find((h) => re.test(h) && !(not && not.test(h))) || null;
  return {
    order: find(/order|work ?order|account|customer ?(id|number|#)|^id$/i, /phone|date/i),
    name: find(/customer ?name|contact ?name|full ?name|^name$|^customer$/i),
    first: find(/first ?name/i), last: find(/last ?name/i), email: find(/e-?mail/i),
    phones: head.filter((h) => /phone|mobile|cell|tel/i.test(h)),
    address: find(/address|street/i, /e-?mail|city|state|zip/i), city: find(/city|town/i), state: find(/^state$|^st$|province/i), zip: find(/zip|postal/i),
    package: find(/package|plan|speed|product|tier/i), sold: find(/sale ?date|sold|signed|sign ?up|order ?date|date/i),
    notes: find(/note|comment|reason|status/i), rep: find(/rep|agent|salesperson|sales ?person/i, /report/i),
  };
}

// ---------- cleaning ----------
const ph10 = (v) => { let d = String(v || '').replace(/\D/g, ''); if (d.length === 11 && d[0] === '1') d = d.slice(1); return d.length === 10 ? d : ''; };
function isoDate(v) {
  const m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const n = String(v || '').match(/^(\d{4}-\d{2}-\d{2})/); return n ? n[1] : null;
}
function splitAddress(full) {
  const parts = String(full || '').split(',').map((s) => s.trim()).filter(Boolean);
  let zip = '', state = '', city = '';
  if (parts.length && /^\d{5}(-\d{4})?$/.test(parts[parts.length - 1])) zip = parts.pop().slice(0, 5);
  else if (parts.length > 1) { const m = parts[parts.length - 1].match(/^([A-Za-z ]+?)\s+(\d{5})(-\d{4})?$/); if (m) { parts[parts.length - 1] = m[1]; zip = m[2]; } }
  if (parts.length > 1) state = parts.pop();
  if (parts.length > 1) city = parts.pop();
  if (/^texas$/i.test(state)) state = 'TX';
  return { street: parts.join(', '), city, state: state.toUpperCase().slice(0, 2), zip };
}
const STREET_WORDS = new Set(['st', 'street', 'dr', 'drive', 'ave', 'avenue', 'rd', 'road', 'ln', 'lane', 'blvd', 'ct', 'court', 'trl', 'trail', 'loop', 'way', 'cir', 'circle', 'pl', 'hwy', 'n', 's', 'e', 'w']);
function addrKey(street) {
  const m = String(street || '').toLowerCase().match(/^\s*(\d+)\s+(.+)$/); if (!m) return '';
  const w = m[2].replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((x) => x && !STREET_WORDS.has(x));
  return w.length ? `${m[1]} ${w[0]}` : '';
}
// Same shape as _cbKeyOf in index.html; the Deal Check card uses it to find the Grow deal.
const dealKey = (d) => [String(d.customer || '').toLowerCase().replace(/[^a-z0-9]+/g, ''), d.sale_date || '', String(d.isp || '').toLowerCase()].join('|');

async function sb(pathQ, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${pathQ}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`${r.status} ${pathQ.slice(0, 80)}: ${(await r.text()).slice(0, 300)}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}

async function main() {
  const { head, rows } = parseCsv(fs.readFileSync(file, 'utf8'));
  const P = profileFor(head) || guessProfile(head);
  console.log('columns used:', JSON.stringify(P));
  if (!P.name && !P.first && !P.phones.length) throw new Error('no name or phone column found; add a profile for this layout');

  const word = isp.split(/\s+/)[0];
  const deals = [];
  for (let off = 0; ; off += 5000) {
    const pg = await sb(`deals?select=customer,sale_date,isp,rep,manager,status,address,zip,phone,package&isp=ilike.*${encodeURIComponent(word)}*&order=id&limit=5000&offset=${off}`);
    deals.push(...pg); if (pg.length < 5000) break;
  }
  const byPhone = new Map(), byAddr = new Map();
  const newer = (a, b) => (!a || (b.sale_date || '') > (a.sale_date || '')) ? b : a;   // a re-sold door: newest sale wins
  for (const d of deals) {
    const p = ph10(d.phone); if (p) byPhone.set(p, newer(byPhone.get(p), d));
    const k = addrKey(d.address); if (k) byAddr.set(k, newer(byAddr.get(k), d));
  }

  const out = []; const stats = { rows: rows.length, grow: 0, byPhone: 0, byAddr: 0, noPhone: 0, dupes: 0 };
  const ids = new Set();
  rows.forEach((r, i) => {
    const a = splitAddress(P.address ? r[P.address] : '');
    const city = (P.city && r[P.city]) || a.city || null, state = ((P.state && r[P.state]) || a.state || '').toUpperCase().slice(0, 2) || null;
    const zip = String((P.zip && r[P.zip]) || a.zip || '').slice(0, 5) || null;
    const phones = [...new Set(P.phones.map((h) => ph10(r[h])).filter(Boolean))];
    const name = (P.name && r[P.name]) || [P.first && r[P.first], P.last && r[P.last]].filter(Boolean).join(' ') || '';
    const order = (P.order && r[P.order]) || '';
    const idTail = order || phones[0] || (a.street && addrKey(a.street)) || crypto.createHash('sha1').update(name + '|' + a.street).digest('hex').slice(0, 10);
    const id = `${slug}:${idTail}`;
    if (ids.has(id)) { stats.dupes++; return; } ids.add(id);
    let d = phones.map((p) => byPhone.get(p)).find(Boolean);
    if (d) stats.byPhone++;
    else {
      d = byAddr.get(addrKey(a.street));
      if (d && d.zip && zip && String(d.zip).slice(0, 5) !== zip) d = null;   // same street number, different town
      if (d) stats.byAddr++;
    }
    if (d) stats.grow++;
    if (!phones.length) stats.noPhone++;
    out.push({
      id, isp, list, row_no: i + 1, order_no: order || null,
      customer: name || (d && d.customer) || null,
      phone: phones[0] || null, phone2: phones[1] || null, email: (P.email && r[P.email]) || null,
      address: a.street || null, city, state, zip,
      package: (P.package && r[P.package]) || (d && d.package) || null,
      list_notes: [P.notes && r[P.notes], P.rep && r[P.rep] && 'Rep on list: ' + r[P.rep]].filter(Boolean).join('\n') || null,
      sale_date: isoDate(P.sold && r[P.sold]) || (d && d.sale_date) || null,
      deal_key: d ? dealKey(d) : null, grow_rep: d ? d.rep : null, grow_manager: d ? d.manager : null, grow_status: d ? d.status : null,
      updated_at: new Date().toISOString(),
    });
  });
  const existing = new Set((await sb(`dealcheck_leads?select=id&isp=eq.${encodeURIComponent(isp)}`)).map((x) => x.id));
  const fresh = out.filter((x) => !existing.has(x.id)).length;
  console.log(`list "${list}": ${stats.rows} rows · ${out.length} leads (${fresh} new, ${out.length - fresh} already imported) · Grow match ${stats.grow} (phone ${stats.byPhone}, address ${stats.byAddr}) · no match ${out.length - stats.grow}`);
  console.log(`no phone ${stats.noPhone}${stats.dupes ? ` · duplicate rows skipped ${stats.dupes}` : ''}`);
  const gs = {}; out.forEach((x) => { if (x.grow_status) gs[x.grow_status] = (gs[x.grow_status] || 0) + 1; });
  if (Object.keys(gs).length) console.log('our deals feed says:', JSON.stringify(gs));
  if (dry) { console.log('dry run, nothing written. sample:', JSON.stringify(out.slice(0, 2), null, 1)); return; }
  for (let i = 0; i < out.length; i += 500) {
    await sb('dealcheck_leads?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(out.slice(i, i + 500)) });
  }
  console.log(`written: ${out.length}`);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
