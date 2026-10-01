// node scripts/sr-area-create.mjs <ISP> <sector prefix> [--apply]  creates SR areas from data/sectors/<ISP>-cut.json (dry run without --apply; skips titles that exist; ids logged to data/sectors/sr-areas-created.log)
import { readFileSync, appendFileSync } from 'fs';
const [isp, prefix] = process.argv.slice(2), apply = process.argv.includes('--apply');
const R = process.env.HOME + '/Grow/GrowSales/data/';
const H = JSON.parse(readFileSync(R + 'sr-auth.json', 'utf8')).headers;
const HEAD = { ...H, 'content-type': 'application/vnd.api+json', accept: 'application/vnd.api+json' };
const cut = JSON.parse(readFileSync(R + `sectors/${isp}-cut.json`, 'utf8'));
const TENANT = 'ea339b66-e93a-432d-bdfc-f59bacb33ec4', GROUP = '26487a33-1850-4a75-b449-ff597fa37132';
const PAL = ['f5222d', '1677ff', '52c41a', 'fa8c16', '722ed1', '13c2c2', 'eb2f96', 'faad14'];
let have = new Set();
for (let o = 0; ; o += 500) {
  const j = await (await fetch(`https://apis.salesrabbit.com/areas?page[limit]=500&page[offset]=${o}`, { headers: H })).json();
  j.data.forEach(a => have.add((a.attributes.title || '').trim().toUpperCase()));
  if (j.data.length < 500) break;
}
let i = 0;
for (const [name, s] of Object.entries(cut.sectors)) {
  if (!name.startsWith(prefix)) continue;
  if (have.has(name.toUpperCase())) { console.log('exists, skip', name); continue; }
  const ring = s.poly[0][0].map(p => [p[0], p[1]]);
  const [f, l] = [ring[0], ring[ring.length - 1]]; if (f[0] !== l[0] || f[1] !== l[1]) ring.push(f);
  const body = { data: { type: 'area', attributes: { title: name, color: PAL[i++ % PAL.length], tenant_id: TENANT, group_id: GROUP,
    coordinates: { type: 'Polygon', coordinates: [ring, ...s.poly[0].slice(1)] } } } };
  if (!apply) { console.log('would create', name, ring.length, 'pts'); continue; }
  const r = await fetch('https://apis.salesrabbit.com/areas', { method: 'POST', headers: HEAD, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) { console.log('FAIL', name, r.status, JSON.stringify(j).slice(0, 300)); continue; }
  console.log('created', name, j.data.id, 'homes', j.data.attributes.homes);
  appendFileSync(R + 'sectors/sr-areas-created.log', `${new Date().toISOString()}\t${isp}\t${name}\t${j.data.id}\n`);
}
