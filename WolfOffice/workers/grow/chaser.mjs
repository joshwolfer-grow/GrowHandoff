#!/usr/bin/env node
// Chaser: flags callback leads that have gone stale without follow-up.
import { growGet } from '../../lib/growdb.mjs';
import { writeSnapshot, today } from '../../lib/db.mjs';
import { chase, statusLine } from './chaser.logic.mjs';

function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('en-CA');
}

async function main() {
  const since = daysAgoISO(45);
  const day = today();

  const [leads, pipeline] = await Promise.all([
    growGet(
      `callback_leads?select=id,isp,grow_rep,grow_manager,cancel_date,grow_status&dnc=is.false&cancel_date=gte.${since}`
    ),
    growGet('callback_pipeline?select=key,stage,call_on,updated_at'),
  ]);

  const result = chase(leads, pipeline, day, 3);
  await writeSnapshot('chaser', day, { needs: result.needs, byRep: result.byRep });
  console.log(statusLine(result, leads.length));
}

main().catch((err) => {
  console.log(`error: ${err.message}`);
  process.exit(1);
});
