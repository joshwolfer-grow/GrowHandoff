// Deletes the KC/Raytown doors GFiber pulled off their list (the whole 6/15
// territory plus 129 strays). Targets exact lead ids from the workbook — there
// is no filter or query involved, so nothing outside that list is reachable.
import { readFileSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const A = JSON.parse(readFileSync('data/sr-auth.json', 'utf8'));
const H = { ...A.headers, Accept: 'application/vnd.api+json' };
const DRY = process.argv.includes('--dry');
const LOG = 'data/kc-delete-log.csv';

const ids = JSON.parse(execSync(`python3 -c "
import openpyxl,json
wb=openpyxl.load_workbook('/Users/joshuawolfer/Downloads/GFI-KC (8_11) - delete from SalesRabbit.xlsx',data_only=True,read_only=True)
out=[]
for t in wb.sheetnames:
    rows=list(wb[t].iter_rows(values_only=True)); H=list(rows[0]); I={h:i for i,h in enumerate(H)}
    for r in rows[1:]:
        out.append([r[I['lead_id']], f\\"{r[I['Street']]}, {r[I['City']]} {r[I['Zip']]}\\", r[I['SR stage']]])
print(json.dumps(out))
"`, { encoding: 'utf8', maxBuffer: 1 << 28 }));

console.log(`${ids.length} leads on the delete list`);
const stages = ids.reduce((a, [, , s]) => (a[s] = (a[s] || 0) + 1, a), {});
console.log('stages:', Object.entries(stages).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k} ${v}`).join(', '));
console.log('first 5:'); ids.slice(0,5).forEach(([i,a,s])=>console.log(`   ${i}  ${a}  [${s}]`));
if (DRY) { console.log('\ndry run — nothing deleted'); process.exit(0); }

appendFileSync(LOG, `\n# run ${new Date().toISOString()}\n`);
let gone = 0, already = 0, failed = 0;
for (let i = 0; i < ids.length; i++) {
  const [id, addr, stage] = ids[i];
  const r = await fetch(`https://apis.salesrabbit.com/loci/${id}`, { method: 'DELETE', headers: H });
  if (r.status === 200 || r.status === 204) gone++;
  else if (r.status === 404) already++;
  else { failed++; console.error(`  FAIL ${r.status} ${id} ${addr}`); }
  appendFileSync(LOG, `${id},"${addr}",${stage},${r.status}\n`);
  if ((i + 1) % 200 === 0 || i === ids.length - 1)
    console.log(`  ${i + 1}/${ids.length} — deleted ${gone}, already gone ${already}, failed ${failed}`);
  if (failed > 20) { console.error('too many failures, stopping'); break; }
}
console.log(`\ndone: ${gone} deleted, ${already} already gone, ${failed} failed. log -> ${LOG}`);
