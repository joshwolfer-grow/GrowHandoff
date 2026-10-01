// Deletes the extra copies of exact duplicate doors (same coordinates AND same
// address) listed in data/dedupe-backup-2026-09-17/remove-list.csv. Targets
// exact lead ids only. Right before each delete it re-reads the copy and its
// keeper from SalesRabbit and skips the pair unless the copy is still on the stage the list recorded,
// the keeper still exists, and address + coordinates still match.
//
//   node scripts/dedupe-delete.mjs          # dry run, deletes nothing
//   node scripts/dedupe-delete.mjs --go     # really delete
//   --list <csv>  use another remove list;  --near  accept pins within 60 m instead of identicalimport { readFileSync, appendFileSync } from 'node:fs';

const li = process.argv.indexOf('--list');
const LIST = li > 0 ? process.argv[li + 1] : 'data/dedupe-backup-2026-09-17/remove-list.csv';
const NEAR = process.argv.includes('--near'); // same address, pins within 60 m (Uvalde Jul 29 pairs)
const LOG = 'data/dedupe-delete-log.csv';
const GO = process.argv.includes('--go');
const A = JSON.parse(readFileSync('data/sr-auth.json', 'utf8'));
const H = { ...A.headers, Accept: 'application/vnd.api+json' };
const API = 'https://apis.salesrabbit.com/loci/';
const stages = JSON.parse(readFileSync('data/sr-lookups.json', 'utf8')).stages;

const rows = readFileSync(LIST, 'utf8').trim().split('\n').slice(1).map((l) => {
  const m = l.match(/^([^,]+),([^,]+),("(?:[^"]|"")*"|[^,]*),([^,]*),/);
  return { remove: m[1], keep: m[2], addr: m[3].replace(/^"|"$/g, ''), stage: m[4] };
});
console.log(`${rows.length} copies on the remove list${GO ? '' : '  (dry run, pass --go to delete)'}`);

const sp = (s) => (s || '').toUpperCase().trim().replace(/\s+/g, ' ');
const metres = (a, b) => {
  if (!a || !b) return Infinity;
  const [lo1, la1] = a, [lo2, la2] = b;
  return Math.hypot((la1 - la2) * 111000, (lo1 - lo2) * 111000 * Math.cos((la1 * Math.PI) / 180));
};
const get = async (id) => {
  const r = await fetch(`${API}${id}?fields=stage_id,street1,street2,coordinates`, { headers: H });
  return r.status === 200 ? (await r.json()).data?.attributes : null;
};

if (GO) appendFileSync(LOG, `\n# run ${new Date().toISOString()}\n`);
let gone = 0, skipped = 0, failed = 0;
for (let i = 0; i < rows.length; i++) {
  const { remove, keep, addr, stage } = rows[i];
  const [r, k] = await Promise.all([get(remove), get(keep)]);
  const safe = r && k && stages[r.stage_id] === stage && sp(r.street1) === sp(k.street1) && sp(r.street2) === sp(k.street2)
    && (NEAR ? metres(r.coordinates?.coordinates, k.coordinates?.coordinates) <= 60
             : JSON.stringify(r.coordinates?.coordinates) === JSON.stringify(k.coordinates?.coordinates));
  let status = 'skip';
  if (!safe && r && k) console.log(`  skip ${addr}: copy "${r.street1}|${r.street2}" ${stages[r.stage_id]}, keep "${k.street1}|${k.street2}", `
    + `${Math.round(metres(r.coordinates?.coordinates, k.coordinates?.coordinates))} m apart`);
  if (!safe) skipped++;
  else if (!GO) { status = 'would delete'; gone++; }
  else {
    const d = await fetch(API + remove, { method: 'DELETE', headers: H });
    status = String(d.status);
    if (d.status === 200 || d.status === 204) gone++;
    else { failed++; console.error(`  FAIL ${d.status} ${remove} ${addr}`); }
  }
  if (GO) appendFileSync(LOG, `${remove},${keep},"${addr}",${status}\n`);
  if ((i + 1) % 100 === 0 || i === rows.length - 1)
    console.log(`  ${i + 1}/${rows.length}  ${GO ? 'deleted' : 'would delete'} ${gone}, skipped ${skipped}, failed ${failed}`);
  if (failed > 20) { console.error('too many failures, stopping'); break; }
}
console.log(`\ndone: ${GO ? 'deleted' : 'would delete'} ${gone}, skipped ${skipped}, failed ${failed}${GO ? `. log -> ${LOG}` : ''}`);
