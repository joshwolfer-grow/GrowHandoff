#!/usr/bin/env node
// Daily manager report, rendered by the app itself and texted to each manager.
//
// The card is NOT rebuilt here on purpose: this drives the real dashboard in a
// headless Chrome and calls the same buildManagerReportImage() a person gets
// when they tap Text with image mode on. One definition of PRA, one of sold,
// no second copy to drift.
//
//   node scripts/daily-report-text.mjs                     # render only, sends nothing
//   node scripts/daily-report-text.mjs --managers "Will Gabor"
//   node scripts/daily-report-text.mjs --date 2026-09-10
//   node scripts/daily-report-text.mjs --send              # text each group chat
//   node scripts/daily-report-text.mjs --send --to +1385...  # every card to one number, a test
//   node scripts/daily-report-text.mjs --scheduled --send  # the WolfOffice 'mgrcards' worker, 9am
//
// Sign-in: GROW_ACCESS_CODE (a corporate code) from ~/Grow/RepText/.env. It goes
// in as ?code=... which the app redeems and remembers.
//
// Sending: each manager's card goes to a group chat made BY HAND in Messages and
// named exactly "Daily Report: <Manager>". Scripts cannot create groups, and the
// chat list cannot be picked by name, so the members are read from chat.db and
// the group is opened by name through Messages search and the card pasted in
// only if the open conversation's title matches (paste-into-group.applescript). Every send is then CONFIRMED
// against that group in chat.db. A manager with no group is skipped and listed.
// Only managers whose team knocked yesterday get a card.

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const ENV_FILE = path.join(HOME, 'Grow/RepText/.env');
const PASTER = path.join(HOME, 'Grow/RepText/paste-send.applescript');
const GROUP_PASTER = path.join(HOME, 'Grow/RepText/paste-into-group.applescript');
const CHAT_DB = path.join(HOME, 'Library/Messages/chat.db');
const GROUP_PREFIX = 'Daily Report: ';
const OUT_DIR = path.join(HOME, 'Pictures/GrowReports');
const PROFILE = path.join(HOME, '.grow-daily-report-profile');
const APP_URL_DEFAULT = 'https://growsales.vercel.app/';

const args = process.argv.slice(2);
const argVal = (flag, dflt) => { const i = args.indexOf(flag); return i === -1 ? dflt : args[i + 1]; };
const SEND = args.includes('--send');
const SCHEDULED = args.includes('--scheduled');
const DATE = argVal('--date', null);
// --url points at a local copy while a change is being checked.
const APP_URL = argVal('--url', APP_URL_DEFAULT);
const ONLY = (argVal('--managers', '') || '').split(',').map(s => s.trim()).filter(Boolean);

function env(key) {
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] === key) return m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) {}
  return process.env[key] || '';
}

// Pasting into Messages needs macOS Automation + Accessibility permission, and
// macOS grants that per app. Terminal has it; a background job (the 9am launchd
// worker, WolfOffice's Run button) does not and cannot be given it. So a send
// started anywhere but Terminal reruns itself inside Terminal and waits.
if (SEND && process.env.TERM_PROGRAM !== 'Apple_Terminal' && !args.includes('--in-terminal')) {
  const dir = path.join(HOME, 'Pictures/GrowReports/.run');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = Date.now();
  const log = path.join(dir, `${stamp}.log`), done = path.join(dir, `${stamp}.done`);
  const cmdFile = path.join(dir, `${stamp}.command`);
  const q = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
  fs.writeFileSync(cmdFile, `#!/bin/bash
export PATH=${q(process.env.PATH || '')}
${q(process.execPath)} ${q(new URL(import.meta.url).pathname)} ${args.map(q).join(' ')} --in-terminal > ${q(log)} 2>&1
echo $? > ${q(done)}
rm -f ${q(cmdFile)}
exit
`, { mode: 0o755 });
  execFileSync('open', ['-a', 'Terminal', cmdFile]);
  console.log('Sending from Terminal (it has the Messages permission)...');
  let shown = 0;
  const deadline = Date.now() + 40 * 60000;
  while (!fs.existsSync(done)) {
    if (Date.now() > deadline) { console.log('Terminal run did not finish in 40 minutes.'); process.exit(1); }
    execFileSync('sleep', ['2']);
    try { const t = fs.readFileSync(log, 'utf8'); process.stdout.write(t.slice(shown)); shown = t.length; } catch (e) {}
  }
  execFileSync('sleep', ['1']);
  try { const t = fs.readFileSync(log, 'utf8'); process.stdout.write(t.slice(shown)); } catch (e) {}
  const code = parseInt(fs.readFileSync(done, 'utf8'), 10) || 0;
  fs.rmSync(log, { force: true }); fs.rmSync(done, { force: true });
  process.exit(code);
}

const CODE = env('GROW_ACCESS_CODE');
// Where a scheduled run reports its own failures.
const ALERT_PHONE = env('ALERT_PHONE');
if (!CODE) {
  console.error(`No GROW_ACCESS_CODE. Put a corporate access code in ${ENV_FILE} as:\n  GROW_ACCESS_CODE=XXXXXX`);
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: true,
  viewport: { width: 1280, height: 1200 },
  deviceScaleFactor: 2,             // a retina card stays readable in Messages
});
const page = ctx.pages()[0] || await ctx.newPage();
page.setDefaultTimeout(60000);

await page.goto(APP_URL + '?code=' + encodeURIComponent(CODE), { waitUntil: 'domcontentloaded' });
// The app redeems the code, drops it from the URL and reloads itself.
await page.waitForFunction(() => !!(window._grow && window._grow.data && window._grow.data() &&
  window._grow.data().deals && window._grow.data().deals.length), null, { timeout: 90000 })
  .catch(() => { throw new Error('Signed in but no data loaded. Is the access code corporate?'); });

// Managers to report on, and their phone numbers, both straight out of the app
// (manager_contacts). A manager with no number is reported, never skipped quietly.
const { managers, phones, ccPhones } = await page.evaluate((dateArg) => {
  const D = window._grow.data();
  const out = new Set();
  const y = new Date(); y.setDate(y.getDate() - 1);
  const day = dateArg || (y.getFullYear() + '-' + String(y.getMonth() + 1).padStart(2, '0') + '-' + String(y.getDate()).padStart(2, '0'));
  (D._knockingDailyRecords || []).forEach(r => {
    if (r.mgr && r.mgr !== 'Unassigned' && r.date === day && (r.doors || 0) > 0) out.add(r.mgr);
  });
  const phones = {}, ccPhones = [];
  (D._contacts || []).forEach(c => {
    if (!c || !c.phone) return;
    if (String(c.name || '').indexOf('_cc:') === 0) ccPhones.push(c.phone);
    else phones[c.name] = c.phone;
  });
  return { managers: [...out].sort(), phones, ccPhones };
}, DATE);

const TEST_TO_EARLY = argVal('--to', '');
const sql = (q) => execFileSync('sqlite3', ['-readonly', '-separator', '\t', CHAT_DB, q], { encoding: 'utf8' });

// "Daily Report: <Manager>" groups, with their members, straight from chat.db.
function reportGroups() {
  let out;
  try {
    out = sql(`select c.guid, c.display_name, group_concat(h.id, ',') from chat c
      join chat_handle_join j on j.chat_id=c.ROWID join handle h on h.ROWID=j.handle_id
      where c.display_name like '${GROUP_PREFIX}%' group by c.ROWID;`);
  } catch (e) {
    throw new Error('Cannot read Messages (chat.db). Give Full Disk Access to node and sqlite3 in System Settings, Privacy.');
  }
  const groups = {};
  for (const line of out.split('\n').filter(Boolean)) {
    const [guid, name, members] = line.split('\t');
    const mgr = name.slice(GROUP_PREFIX.length).trim().toLowerCase();
    groups[mgr] = { guid, name, members: [...new Set(members.split(','))] };
  }
  return groups;
}
const GROUPS = SEND && !TEST_TO_EARLY ? reportGroups() : {};

let targets = ONLY.length ? ONLY : managers;
const noGroup = [];
if (SEND && !TEST_TO_EARLY) {
  targets.forEach(m => { if (!GROUPS[m.toLowerCase()]) noGroup.push(m); });
  targets = targets.filter(m => GROUPS[m.toLowerCase()]);
}
console.log(`${targets.length} managers: ${targets.join(', ')}`);
if (noGroup.length) console.log(`No "${GROUP_PREFIX}<name>" group yet, skipped: ${noGroup.join(', ')}`);

const results = [];
for (const mgr of targets) {
  const dataUrl = await page.evaluate(async ([m, d]) => {
    return await new Promise(resolve => {
      try {
        window._buildMgrCard(m, blob => {
          if (!blob) return resolve(null);
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);
          fr.onerror = () => resolve(null);
          fr.readAsDataURL(blob);
        }, d || undefined);
      } catch (e) { resolve('ERR:' + e.message); }
    });
  }, [mgr, DATE]);

  if (!dataUrl || String(dataUrl).startsWith('ERR:')) {
    console.log(`  ${mgr}: no card (${dataUrl || 'null'})`);
    results.push({ mgr, ok: false });
    continue;
  }
  const file = path.join(OUT_DIR, mgr.replace(/[^\w]+/g, '-').toLowerCase() + '.png');
  fs.writeFileSync(file, Buffer.from(String(dataUrl).split(',')[1], 'base64'));
  console.log(`  ${mgr}: ${file}`);
  results.push({ mgr, ok: true, file });
}
await ctx.close();

if (SEND && !results.length) {
  console.log(`No cards to send. ${noGroup.length} active managers have no "${GROUP_PREFIX}<name>" group yet.`);
  process.exit(0);
}
if (!SEND) {
  console.log('\nRendered only. Add --send to text them.');
  process.exit(0);
}

const digits = p => String(p || '').replace(/[^+\d]/g, '').replace(/^(\d{10})$/, '+1$1').replace(/^1(\d{10})$/, '+1$1');

// Did an attachment actually leave? The paste path cannot report failure, so
// every send is confirmed against the Messages database before moving on.
function attachmentLanded(phone, sinceUnix) {
  const appleSince = (sinceUnix - 978307200) * 1000000000;
  const sql = `select count(*) from message m
    join message_attachment_join j on j.message_id=m.ROWID
    join attachment a on a.ROWID=j.attachment_id
    join handle h on m.handle_id=h.ROWID
    where h.id like '%${phone.replace(/\D/g, '').slice(-10)}%'
      and m.is_from_me=1 and m.error=0 and m.date > ${appleSince};`;
  try {
    const out = execFileSync('sqlite3', ['-readonly',
      path.join(HOME, 'Library/Messages/chat.db'), sql], { encoding: 'utf8' });
    return parseInt(out.trim(), 10) > 0;
  } catch (e) { return false; }
}

function pasteSend(phone, file, msg) {
  const since = Math.floor(Date.now() / 1000) - 2;
  execFileSync('osascript', [PASTER, phone, file, msg || ''], { encoding: 'utf8', timeout: 90000 });
  // Messages needs a moment to hand the attachment off.
  execFileSync('sleep', ['4']);
  return attachmentLanded(phone, since);
}

const problems = [];
let sent = 0;
// --to sends every card to one number instead of to the managers, so the whole
// pipeline can be tested without texting anybody's team.
const TEST_TO = digits(TEST_TO_EARLY);
if (TEST_TO) console.log(`TEST MODE: everything goes to ${TEST_TO}. No manager is texted.`);

function groupGotAttachment(guid, sinceUnix) {
  const appleSince = (sinceUnix - 978307200) * 1000000000;
  try {
    const out = sql(`select count(*) from message m
      join chat_message_join cm on cm.message_id=m.ROWID join chat c on c.ROWID=cm.chat_id
      join message_attachment_join j on j.message_id=m.ROWID
      where c.guid='${guid}' and m.is_from_me=1 and m.error=0 and m.date > ${appleSince};`);
    return parseInt(out.trim(), 10) > 0;
  } catch (e) { return false; }
}

function pasteGroup(group, file, msg) {
  const since = Math.floor(Date.now() / 1000) - 2;
  execFileSync('osascript', [GROUP_PASTER, group.name, file], { encoding: 'utf8', timeout: 120000 });
  execFileSync('sleep', ['5']);
  return groupGotAttachment(group.guid, since);
}

for (const r of results.filter(r => r.ok)) {
  if (TEST_TO) {
    try {
      if (pasteSend(TEST_TO, r.file, r.mgr)) { sent++; console.log(`  sent ${r.mgr} to ${TEST_TO}`); }
      else problems.push(`${r.mgr}: image did not send`);
    } catch (e) {
      // A permission error fails every card the same way, so stop at the first.
      problems.push(`${r.mgr}: ${String(e.stderr || e.message).trim().split('\n')[0]}`);
      break;
    }
    continue;
  }
  const g = GROUPS[r.mgr.toLowerCase()];
  let landed = false;
  try {
    landed = pasteGroup(g, r.file, '');
  } catch (e) { problems.push(`${r.mgr}: ${String(e.stderr || e.message).trim().split('\n')[0]}`); if (/-1743|-1719|not allowed assistive|Not authorized/i.test(String(e.stderr || e.message))) break; }
  if (landed) { sent++; console.log(`  sent to ${g.name}`); }
  else { if (!problems.some(p => p.startsWith(r.mgr))) problems.push(`${r.mgr}: card did not land in "${g.name}"`); console.log(`  FAILED ${r.mgr}`); }
  execFileSync('sleep', ['8']);
}

console.log(`\nSent ${sent}/${results.filter(r => r.ok).length} manager cards.` + (noGroup.length ? ` ${noGroup.length} active managers have no group yet.` : ''));
if (problems.length) {
  problems.forEach(p => console.log('  ' + p));
  // Nobody reads a 7am log. A silent failure here looks like a quiet day.
  if (SCHEDULED && ALERT_PHONE) {
    const note = 'Daily report: ' + sent + ' sent. Problems: ' + problems.join('; ');
    try {
      execFileSync('osascript', [path.join(HOME, 'Grow/RepText/send-text.applescript'),
                                 ALERT_PHONE, note.slice(0, 900)], { encoding: 'utf8' });
    } catch (e) { console.log('could not send the alert text: ' + e.message); }
  }
  process.exit(1);
}
