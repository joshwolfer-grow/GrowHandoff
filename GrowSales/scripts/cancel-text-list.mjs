#!/usr/bin/env node
// Build a texting list of cancelled customers for ~/Grow/RepText/send_test.py.
//
//   node scripts/cancel-text-list.mjs --isp Surf [--since 2026-10-01] [--out ~/Grow/RepText/surf-cancels.csv]
//
// Cancelled deals (deals feed) joined to Bria phones by customer name. Drops
// anyone the Callbacks queue already logged as not_interested, bad_number or
// text, and anyone already in RepText/sent-log.csv. Prints who was dropped and
// why so a missing person is explainable.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SB = html.match(/const SUPABASE_URL='([^']+)'/)[1];
const KEY = html.match(/const SUPABASE_ANON='([^']+)'/)[1];
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const isp = opt('--isp'); if (!isp) { console.error('usage: --isp Surf [--since YYYY-MM-DD] [--out file.csv]'); process.exit(1); }
const since = opt('--since', '2000-01-01');
const out = opt('--out', path.join(os.homedir(), 'Grow/RepText', `${isp.toLowerCase().replace(/\W+/g, '-')}-cancels.csv`));

const get = async (q) => { const r = await fetch(`${SB}/rest/v1/${q}`, { headers: H }); if (!r.ok) throw new Error(q + ' ' + r.status); return r.json(); };
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z]/g, '');
const ph10 = (p) => { const d = (p || '').replace(/\D/g, ''); return d.length === 11 && d[0] === '1' ? d.slice(1) : d.length === 10 ? d : ''; };
const titleCase = (s) => (s || '').trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

const deals = await get(`deals?select=customer,rep,sale_date,cancel_date,city,state&isp=ilike.*${encodeURIComponent(isp)}*&status=ilike.*cancel*&cancel_date=gte.${since}&order=cancel_date.desc&limit=5000`);
const bria = await get(`bria_deals?select=customer,phone,sale_date&isp=ilike.*${encodeURIComponent(isp)}*&phone=not.is.null&limit=10000`);
const calls = await get(`cancel_callbacks?select=customer,phone,outcome&isp=ilike.*${encodeURIComponent(isp)}*&outcome=in.(not_interested,bad_number,text)&limit=10000`);

const phones = new Map(); for (const b of bria) { const p = ph10(b.phone); if (p && !phones.has(norm(b.customer))) phones.set(norm(b.customer), p); }
const blocked = new Map(); for (const c of calls) { blocked.set(norm(c.customer), c.outcome); if (ph10(c.phone)) blocked.set(ph10(c.phone), c.outcome); }
const sentLog = path.join(os.homedir(), 'Grow/RepText/sent-log.csv');
const already = new Set(fs.existsSync(sentLog) ? fs.readFileSync(sentLog, 'utf8').split('\n').map((l) => ph10(l.split(',')[2])).filter(Boolean) : []);

const rows = [], dropped = {}; const seen = new Set();
const drop = (why, r) => { (dropped[why] ||= []).push(r.customer); };
for (const d of deals) {
  const k = norm(d.customer); if (seen.has(k)) continue; seen.add(k);
  const p = phones.get(k);
  if (!p) { drop('no phone in Bria', d); continue; }
  if (blocked.has(k) || blocked.has(p)) { drop('callbacks: ' + (blocked.get(k) || blocked.get(p)), d); continue; }
  if (already.has(p)) { drop('already in sent-log', d); continue; }
  rows.push({ name: titleCase(d.customer), phone: p, rep: d.rep || '', cancel_date: d.cancel_date || '', city: d.city || '' });
}
const csv = ['name,phone,rep,cancel_date,city', ...rows.map((r) => [r.name, r.phone, r.rep, r.cancel_date, r.city].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n') + '\n';
fs.writeFileSync(out, csv);
console.log(`${deals.length} ${isp} cancels since ${since} -> ${rows.length} textable, written to ${out}`);
for (const [why, names] of Object.entries(dropped)) console.log(`  dropped ${names.length} (${why}): ${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''}`);
console.log(`\nPreview:\n  python3 ~/Grow/RepText/send_test.py "${out}" "Hey {first}, Josh with Surf Internet here. Saw the install got cancelled, no worries at all. Mind if I ask what happened? Always trying to get better at this, and happy to help if there's anything I can do." --sms\nAdd --send to send.`);
