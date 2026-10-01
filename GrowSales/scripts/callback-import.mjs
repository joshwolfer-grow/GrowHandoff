#!/usr/bin/env node
// Import an ISP's cancel list into callback_leads for the Callbacks page.
//
//   node scripts/callback-import.mjs <file.csv> --isp "Lyte Fiber" [--dry]
//
// Every row goes in, ours or not. A row that matches a Grow deal (phone first,
// then street number + street name, checked against zip when both sides have
// one) gets deal_key / grow_rep, so its calls also show on the deal card and it
// is tagged Grow in the queue. Re-running the same file updates rows in place
// (id = '<isp slug>:<order number>'), so a newer export of the same list is safe.
//
// Column names differ per ISP. PROFILES maps the ones we have seen; anything
// else falls back to guessing from the header text, and the dry run prints the
// mapping it used so a wrong guess is visible before anything is written.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SB = html.match(/const SUPABASE_URL='([^']+)'/)[1];
const KEY = process.env.SUPABASE_SERVICE_KEY || html.match(/const SUPABASE_ANON='([^']+)'/)[1];
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--isp');
const isp = (args[args.indexOf('--isp') + 1] || '').trim();
const dry = args.includes('--dry');
if (!file || !isp || args.indexOf('--isp') < 0) {
  console.error('usage: node scripts/callback-import.mjs <file.csv> --isp "Lyte Fiber" [--dry]');
  process.exit(1);
}
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
const PROFILES = {
  lyte: {
    order: 'FSM Order Number', status: 'Status', name: 'Contact Name', email: 'Contact Email',
    phones: ['Phone number', 'Contact Phone'], address: 'Full Address', area: 'Field Area',
    notes: 'Notes', date: 'Completed At',
  },
  // Lyte's "Cancel before install" sheet: no address, reason split over three columns.
  lyte_cbi: {
    order: 'Customer Number', status: 'Status', name: 'Customer Name', phones: ['phone number'],
    area: 'Market', sold: 'Date of Sign Up', notes: ['Disposition', 'Reason', 'Detail:Reason For Cancelation'], date: 'Date of Cancel',
  },
};
// A slug can have several layouts: take the first profile whose order column is in the file.
const profileFor = (head) => Object.entries(PROFILES).find(([k, p]) => (k === slug || k.startsWith(slug + '_')) && head.includes(p.order))?.[1];
function guessProfile(head) {
  const find = (re) => head.find((h) => re.test(h)) || null;
  return {
    order: find(/order|work ?order|account|^id$/i), status: find(/status/i),
    name: find(/customer|contact name|^name$/i), email: find(/e-?mail/i),
    phones: head.filter((h) => /phone|mobile|cell/i.test(h)), address: find(/address|street/i),
    area: find(/area|market|region|city/i), notes: find(/note|reason|comment/i),
    date: find(/cancel.*date|completed|date/i),
  };
}

// ---------- cleaning ----------
const ph10 = (v) => { let d = String(v || '').replace(/\D/g, ''); if (d.length === 11 && d[0] === '1') d = d.slice(1); return d.length === 10 ? d : ''; };
function isoDate(v) {
  const m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const n = String(v || '').match(/^(\d{4}-\d{2}-\d{2})/); return n ? n[1] : null;
}
function splitAddress(full) {
  const parts = String(full || '').split(',').map((s) => s.trim()).filter(Boolean);
  let zip = '', state = '', city = '';
  if (parts.length && /^\d{5}(-\d{4})?$/.test(parts[parts.length - 1])) zip = parts.pop().slice(0, 5);
  if (parts.length > 1) state = parts.pop();
  if (parts.length > 1) city = parts.pop();
  if (/^texas$/i.test(state)) state = 'TX';
  return { street: parts.join(', '), city, state: state.toUpperCase().slice(0, 2), zip };
}
// ISP system text is not a reason: drop it, keep what a person wrote. Update
// stamps become "Aug 12:" and a note repeated by its own update is kept once.
function cleanNotes(raw) {
  let extra = '';
  let t = String(raw || '').replace(/Additional contact info:\s*([()\d\s.+-]{7,})/gi, (_, p) => { extra = extra || p; return ''; });
  t = t.replace(/Created for (Object|Order) \S+?\.(\s|$)/gi, ' ');
  const segs = t.split(/\[New Update - ([A-Za-z]{3} \d{1,2}), \d{4}[^\]]*\]/);
  const out = []; const seen = new Set();
  for (let i = 0; i < segs.length; i++) {
    const isStamp = i % 2 === 1; if (isStamp) continue;
    const body = segs[i].replace(/\s+/g, ' ').trim(); if (!body) continue;
    const k = body.toLowerCase(); if (seen.has(k)) continue; seen.add(k);
    out.push((i > 0 ? segs[i - 1] + ': ' : '') + body);
  }
  return { notes: out.join('\n'), extraPhone: ph10(extra) };
}

// ---------- matching against Grow deals ----------
const STREET_WORDS = new Set(['st', 'street', 'dr', 'drive', 'ave', 'avenue', 'rd', 'road', 'ln', 'lane', 'blvd', 'ct', 'court', 'trl', 'trail', 'loop', 'way', 'cir', 'circle', 'pl', 'hwy', 'n', 's', 'e', 'w']);
function addrKey(street) {
  const m = String(street || '').toLowerCase().match(/^\s*(\d+)\s+(.+)$/); if (!m) return '';
  const w = m[2].replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((x) => x && !STREET_WORDS.has(x));
  return w.length ? `${m[1]} ${w[0]}` : '';
}
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
  if (!P.order) throw new Error('no order / account number column found, cannot build stable ids');

  const word = isp.split(/\s+/)[0];
  const deals = [];
  for (let off = 0; ; off += 5000) {
    const pg = await sb(`deals?select=customer,sale_date,isp,rep,manager,status,address,zip,phone&isp=ilike.*${encodeURIComponent(word)}*&order=id&limit=5000&offset=${off}`);
    deals.push(...pg); if (pg.length < 5000) break;
  }
  const byPhone = new Map(), byAddr = new Map(), byName = new Map();
  const nameKey = (v) => String(v || '').toLowerCase().replace(/[^a-z]/g, '');
  const newer = (a, b) => (!a || (b.sale_date || '') > (a.sale_date || '')) ? b : a;   // a re-sold door: newest sale wins
  for (const d of deals) {
    const p = ph10(d.phone); if (p) byPhone.set(p, newer(byPhone.get(p), d));
    const k = addrKey(d.address); if (k) byAddr.set(k, newer(byAddr.get(k), d));
    const n = nameKey(d.customer); if (n) byName.set(n, [...(byName.get(n) || []), d]);
  }
  // Last resort for files with neither a phone we hold nor an address (Lyte's deals
  // feed has no phones): same customer name AND sale date within a week of sign-up.
  const byNameDate = (name, sold) => {
    const t = Date.parse(sold || ''); if (!t) return null;
    return (byName.get(nameKey(name)) || []).find((d) => Math.abs(Date.parse(d.sale_date) - t) <= 7 * 864e5) || null;
  };

  const out = []; const stats = { rows: rows.length, grow: 0, byPhone: 0, byAddr: 0, noPhone: 0, dnc: 0, reason: 0, dupes: 0 };
  const ids = new Set();
  for (const r of rows) {
    const order = r[P.order]; if (!order) continue;
    const id = `${slug}:${order}`; if (ids.has(id)) { stats.dupes++; continue; } ids.add(id);
    const a = splitAddress(P.address ? r[P.address] : '');
    const rawNotes = Array.isArray(P.notes) ? [...new Set(P.notes.map((h) => r[h]).filter((v) => v && !/^#(N\/A|REF!)$/.test(v)))].join(' · ') : r[P.notes];
    const { notes, extraPhone } = cleanNotes(rawNotes);
    const phones = [...new Set([...P.phones.map((h) => ph10(r[h])), extraPhone].filter(Boolean))];
    let d = phones.map((p) => byPhone.get(p)).find(Boolean);
    if (d) stats.byPhone++;
    else {
      d = byAddr.get(addrKey(a.street));
      if (d && d.zip && a.zip && String(d.zip).slice(0, 5) !== a.zip) d = null;   // same street number, different town
      if (d) stats.byAddr++;
    }
    if (!d && P.sold) { d = byNameDate(r[P.name], isoDate(r[P.sold])); if (d) stats.byName = (stats.byName || 0) + 1; }
    if (d) stats.grow++;
    if (!phones.length) stats.noPhone++;
    const dnc = /do not call/i.test(notes); if (dnc) stats.dnc++;
    if (notes) stats.reason++;
    out.push({
      id, isp, order_no: order, isp_status: (r[P.status] && !/^#(N\/A|REF!)$/.test(r[P.status]) ? r[P.status] : null),
      customer: r[P.name] || (d && d.customer) || null,
      phone: phones[0] || null, phone2: phones[1] || null, email: (P.email && r[P.email]) || null,
      address: a.street || null, city: a.city || null, state: a.state || null, zip: a.zip || null,
      area: (P.area && r[P.area]) || null, isp_notes: notes || null, cancel_date: isoDate(r[P.date]), dnc,
      deal_key: d ? dealKey(d) : null, grow_rep: d ? d.rep : null, grow_manager: d ? d.manager : null, grow_status: d ? d.status : null,
      batch: path.basename(file), updated_at: new Date().toISOString(),
    });
  }
  const existing = new Set((await sb(`callback_leads?select=id&isp=eq.${encodeURIComponent(isp)}`)).map((x) => x.id));
  const fresh = out.filter((x) => !existing.has(x.id)).length;
  console.log(`${stats.rows} rows · ${out.length} leads (${fresh} new, ${out.length - fresh} already imported) · Grow ${stats.grow} (phone ${stats.byPhone}, address ${stats.byAddr}, name+date ${stats.byName || 0}) · not Grow ${out.length - stats.grow}`);
  console.log(`with a cancel note ${stats.reason} · no phone ${stats.noPhone} · DO NOT CALL ${stats.dnc}${stats.dupes ? ` · duplicate order numbers skipped ${stats.dupes}` : ''}`);
  // The ISP has these as cancelled. Anything our feed still calls Pending or
  // Serviced is a status our sheet never caught up on.
  const gs = {}; out.forEach((x) => { if (x.grow_status) gs[x.grow_status] = (gs[x.grow_status] || 0) + 1; });
  console.log('our deals feed says:', JSON.stringify(gs));
  if (dry) { console.log('dry run, nothing written. sample:', JSON.stringify(out.slice(0, 2), null, 1)); return; }
  for (let i = 0; i < out.length; i += 500) {
    await sb('callback_leads?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(out.slice(i, i + 500)) });
  }
  console.log(`written: ${out.length}`);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
