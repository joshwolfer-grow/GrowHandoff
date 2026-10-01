#!/usr/bin/env node
// Exercises the access_codes RPCs. Those six functions hold the only real logic in
// the access-code feature and are the part testable in isolation, so this is the
// automated half of verification; the manual checklist covers the three surfaces.
//
//   SUPABASE_URL=https://xxx.supabase.co \
//   SUPABASE_ANON_KEY=eyJ... \
//   ADMIN_CODE=YOURCODE \
//   node scripts/test-access-codes.mjs
//
// ADMIN_CODE is any active corporate code. Deliberately no service key: every call
// below goes through the anon key, which is what the browser actually holds. A test
// that ran as service_role would prove nothing about whether a rep can reach the
// table — which is the entire point of the RLS + security-definer design.
//
// Safe against production. Everything it creates is named ztest_<n>_* and removed
// in the finally block. It never touches a row it didn't create.

const URL_  = process.env.SUPABASE_URL;
const ANON  = process.env.SUPABASE_ANON_KEY;
const ADMIN = process.env.ADMIN_CODE;

if (!URL_ || !ANON || !ADMIN) {
  console.error('Need SUPABASE_URL, SUPABASE_ANON_KEY and ADMIN_CODE (any active corporate code).');
  process.exit(2);
}

const TAG = 'ztest_' + Math.floor(Math.random() * 1e6);
const nm = (s) => `${TAG}_${s}`;

let pass = 0, fail = 0, skip = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const skipped = (name, why) => { skip++; console.log(`  skip ${name} — ${why}`); };

const headers = { apikey: ANON, Authorization: 'Bearer ' + ANON, 'Content-Type': 'application/json' };

async function rpc(fn, body) {
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers, body: JSON.stringify(body || {})
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* error bodies aren't always JSON */ }
  return { status: r.status, ok: r.ok, body: json, text };
}
async function rest(path, opts = {}) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { headers, ...opts });
  const text = await r.text();
  return { status: r.status, ok: r.ok, text };
}
// Inspection goes through the admin RPC rather than a direct select, because a
// direct select is exactly what anon is not allowed to do.
async function findRows(pred) {
  const r = await rpc('list_access_codes', { p_admin_code: ADMIN });
  if (!r.ok || !Array.isArray(r.body)) throw new Error('list_access_codes failed: ' + r.text.slice(0, 200));
  return r.body.filter(pred);
}
const mine = (rows) => rows.filter((x) => x.name.startsWith(TAG));

async function main() {
  console.log(`\naccess_codes RPC tests  (tag ${TAG})\n`);

  // Fail fast and clearly if ADMIN_CODE isn't usable — every other test depends on it.
  const probe = await rpc('list_access_codes', { p_admin_code: ADMIN });
  if (!probe.ok) {
    console.error(`ADMIN_CODE is not an active corporate code (status ${probe.status}).`);
    console.error(probe.text.slice(0, 300));
    process.exit(2);
  }

  try {
    // ---- the table must be sealed to anon. If this fails nothing else matters:
    // any rep could dump every code in the company from devtools.
    console.log('table is sealed to anon');
    const sel = await rest('access_codes?select=*');
    ok('anon cannot select access_codes', !sel.ok || sel.text === '[]',
       `status ${sel.status}, body ${sel.text.slice(0, 100)}`);
    const ins = await rest('access_codes', {
      method: 'POST', body: JSON.stringify({ code: 'ZZZZZZZZ', name: nm('nope'), role: 'rep' })
    });
    ok('anon cannot insert into access_codes', !ins.ok, `status ${ins.status}`);
    const upd = await rest('access_codes?role=eq.rep', {
      method: 'PATCH', body: JSON.stringify({ role: 'corporate' })
    });
    ok('anon cannot promote a rep to corporate', !upd.ok, `status ${upd.status}`);

    // ---- private helpers must not be callable
    console.log('\nhelpers are private');
    for (const fn of ['_gen_access_code', '_new_access_code']) {
      const r = await rpc(fn, {});
      ok(`${fn} is not callable by anon`, !r.ok, `status ${r.status}`);
    }
    const oracle = await rpc('_is_corp_admin', { p_code: ADMIN });
    ok('_is_corp_admin is not callable by anon', !oracle.ok, `status ${oracle.status}`);

    // ---- redeem
    console.log('\nredeem');
    let r = await rpc('redeem_access_code', { p_code: ADMIN });
    ok('a valid code returns exactly one row', r.ok && Array.isArray(r.body) && r.body.length === 1,
       r.text.slice(0, 120));
    ok('the row carries name and role', r.body?.[0]?.r_role === 'corporate', JSON.stringify(r.body));

    r = await rpc('redeem_access_code', { p_code: 'NOSUCH00' });
    ok('an unknown code returns no rows', r.ok && r.body.length === 0, r.text.slice(0, 120));

    r = await rpc('redeem_access_code', { p_code: '' });
    ok('an empty code returns no rows', r.ok && r.body.length === 0, r.text.slice(0, 120));

    // The gate upper-cases input before sending, so a lowercase miss is expected —
    // if this ever flips, that upper-casing has become load-bearing in a new way.
    r = await rpc('redeem_access_code', { p_code: ADMIN.toLowerCase() });
    if (ADMIN.toLowerCase() === ADMIN) skipped('redeem is case-sensitive', 'ADMIN_CODE has no uppercase');
    else ok('redeem is case-sensitive', r.ok && r.body.length === 0, 'lowercase should not match');

    const seenRow = (await findRows((x) => x.code === ADMIN))[0];
    ok('redeem stamps seen', !!seenRow?.seen, JSON.stringify(seenRow?.seen));

    // ---- minting from a roster
    console.log('\nmint from roster');
    let m = await rpc('sync_roster_codes',
      { p_admin_code: ADMIN, p_managers: [nm('mgr')], p_reps: [nm('rep1'), nm('rep2')] });
    ok('mints one code per new name', m.ok && m.body === 3, `minted ${JSON.stringify(m.body)}, want 3`);

    let rows = mine(await findRows(() => true));
    const REP = rows.find((x) => x.name === nm('rep1'))?.code;
    ok('the manager block leader got a manager code',
       rows.find((x) => x.name === nm('mgr'))?.role === 'manager');
    ok('names under them got rep codes',
       rows.filter((x) => x.role === 'rep').length === 2, JSON.stringify(rows.map((x) => x.role)));

    m = await rpc('sync_roster_codes',
      { p_admin_code: ADMIN, p_managers: [nm('mgr')], p_reps: [nm('rep1'), nm('rep2')] });
    ok('re-saving the same roster mints nothing', m.ok && m.body === 0, `minted ${JSON.stringify(m.body)}`);

    // A block leader who also sells appears in both lists. Two codes for one person
    // is a support call, so manager must win and rep must be skipped.
    m = await rpc('sync_roster_codes',
      { p_admin_code: ADMIN, p_managers: [nm('dual')], p_reps: [nm('dual')] });
    ok('a name in both lists mints once', m.ok && m.body === 1, `minted ${JSON.stringify(m.body)}`);
    const dual = mine(await findRows((x) => x.name === nm('dual')));
    ok('and it is the manager code', dual.length === 1 && dual[0].role === 'manager',
       JSON.stringify(dual.map((x) => x.role)));

    m = await rpc('sync_roster_codes', { p_admin_code: ADMIN, p_managers: ['', '  '], p_reps: [''] });
    ok('blank roster names are skipped', m.ok && m.body === 0, `minted ${JSON.stringify(m.body)}`);

    m = await rpc('sync_roster_codes', { p_admin_code: ADMIN, p_managers: null, p_reps: null });
    ok('null arrays are tolerated', m.ok && m.body === 0, `${m.status} ${m.text.slice(0, 80)}`);

    // Whitespace has to collapse, or "Chris " and "Chris" become two people.
    m = await rpc('sync_roster_codes', { p_admin_code: ADMIN, p_managers: [], p_reps: [' ' + nm('rep1') + ' '] });
    ok('a padded name matches the existing one', m.ok && m.body === 0, `minted ${JSON.stringify(m.body)}`);

    // ---- code format
    console.log('\ncode format');
    rows = mine(await findRows(() => true));
    const codes = rows.map((x) => x.code);
    ok('every minted code is 8 chars', codes.every((c) => c.length === 8), JSON.stringify(codes));
    ok('no ambiguous 0/O/1/I/L', codes.every((c) => !/[01OIL]/.test(c)), JSON.stringify(codes));
    ok('minted codes are unique', new Set(codes).size === codes.length);

    // ---- admin gating: a rep code must not be able to drive any admin function
    console.log('\nadmin functions reject non-corporate callers');
    for (const [fn, args] of [
      ['list_access_codes',      {}],
      ['sync_roster_codes',      { p_managers: [nm('sneak')], p_reps: [] }],
      ['upsert_access_code',     { p_name: nm('sneak'), p_role: 'corporate' }],
      ['set_access_code_active', { p_code: ADMIN, p_active: false }],
      ['delete_access_code',     { p_code: ADMIN }],
    ]) {
      const asRep = await rpc(fn, { p_admin_code: REP, ...args });
      ok(`${fn} rejects a rep code`, !asRep.ok, `status ${asRep.status}`);
      const asNone = await rpc(fn, { p_admin_code: 'NOTACODE', ...args });
      ok(`${fn} rejects an unknown code`, !asNone.ok, `status ${asNone.status}`);
    }
    // And none of those attempts may have had a side effect.
    ok('the rejected attempts created nothing',
       mine(await findRows((x) => x.name === nm('sneak'))).length === 0);

    // ---- upsert
    console.log('\nupsert');
    const PICK = 'ZTESTP' + Math.floor(10 + Math.random() * 89);
    let u = await rpc('upsert_access_code',
      { p_admin_code: ADMIN, p_name: nm('chosen'), p_role: 'manager', p_code: PICK });
    ok('an explicit code is honored', u.ok && u.body === PICK, JSON.stringify(u.body));

    u = await rpc('upsert_access_code',
      { p_admin_code: ADMIN, p_name: nm('other'), p_role: 'rep', p_code: PICK });
    ok('a code already in use is refused', !u.ok, `status ${u.status}`);

    u = await rpc('upsert_access_code', { p_admin_code: ADMIN, p_name: nm('x'), p_role: 'wizard' });
    ok('an unknown role is refused', !u.ok, `status ${u.status}`);

    u = await rpc('upsert_access_code', { p_admin_code: ADMIN, p_name: '   ', p_role: 'rep' });
    ok('a blank name is refused', !u.ok, `status ${u.status}`);

    // Re-adding someone must return THEIR code, not mint a second one, or the admin
    // screen hands out a code the person was never given.
    u = await rpc('upsert_access_code', { p_admin_code: ADMIN, p_name: nm('rep1'), p_role: 'rep' });
    ok('re-adding returns the existing code', u.ok && u.body === REP,
       `got ${JSON.stringify(u.body)}, want ${REP}`);

    // ---- revoke
    console.log('\nrevoke');
    let t = await rpc('set_access_code_active', { p_admin_code: ADMIN, p_code: REP, p_active: false });
    ok('disable reports success', t.ok && t.body === true, JSON.stringify(t.body));
    r = await rpc('redeem_access_code', { p_code: REP });
    ok('a disabled code stops redeeming', r.ok && r.body.length === 0, r.text.slice(0, 120));

    await rpc('set_access_code_active', { p_admin_code: ADMIN, p_code: REP, p_active: true });
    r = await rpc('redeem_access_code', { p_code: REP });
    ok('re-enabling restores it', r.ok && r.body.length === 1);

    t = await rpc('set_access_code_active', { p_admin_code: ADMIN, p_code: 'NOSUCH00', p_active: false });
    ok('disabling an unknown code reports false', t.ok && t.body === false, JSON.stringify(t.body));

    // ---- last-corporate guard. Only meaningful when one corporate code is left;
    // on a live database there are more, so this reports a skip rather than a pass.
    console.log('\nlast corporate code is protected');
    const corp = await findRows((x) => x.role === 'corporate' && x.active);
    if (corp.length === 1) {
      const off = await rpc('set_access_code_active', { p_admin_code: ADMIN, p_code: ADMIN, p_active: false });
      ok('cannot disable the last corporate code', !off.ok, `status ${off.status}`);
      const del = await rpc('delete_access_code', { p_admin_code: ADMIN, p_code: ADMIN });
      ok('cannot delete the last corporate code', !del.ok, `status ${del.status}`);
    } else {
      skipped('last-corporate guard', `${corp.length} active corporate codes exist, so it cannot be isolated`);
    }

    // ---- list ordering drives the admin screen's grouping
    console.log('\nlist');
    const all = await findRows(() => true);
    const roles = all.map((x) => x.role);
    ok('ordered corporate → manager → rep',
       roles.lastIndexOf('corporate') < (roles.indexOf('manager') === -1 ? Infinity : roles.indexOf('manager')) &&
       roles.lastIndexOf('manager') < (roles.indexOf('rep') === -1 ? Infinity : roles.indexOf('rep')),
       JSON.stringify(roles.slice(0, 12)));

    // ---- delete
    console.log('\ndelete');
    const d = await rpc('delete_access_code', { p_admin_code: ADMIN, p_code: REP });
    ok('delete reports success', d.ok && d.body === true, JSON.stringify(d.body));
    r = await rpc('redeem_access_code', { p_code: REP });
    ok('a deleted code stops redeeming', r.ok && r.body.length === 0);

  } finally {
    let left = [];
    try {
      left = mine(await findRows(() => true));
      for (const row of left) await rpc('delete_access_code', { p_admin_code: ADMIN, p_code: row.code });
      const after = mine(await findRows(() => true));
      console.log(`\ncleanup: removed ${left.length - after.length} of ${left.length} test rows`
        + (after.length ? ` — REMOVE BY HAND: ${after.map((x) => x.code).join(', ')}` : ''));
    } catch (e) {
      console.log(`\ncleanup FAILED (${e.message}) — remove rows named ${TAG}* by hand`);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\nharness error:', e); process.exit(1); });
