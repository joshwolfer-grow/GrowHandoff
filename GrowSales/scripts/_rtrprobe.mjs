#!/usr/bin/env node
// Opendoor RTR "Time Track Highlight" report -> `knocking`, tagged with the ISP.
//
//   node scripts/rtr-sync.mjs --login                    # ONE TIME: window opens, you sign in
//   node scripts/rtr-sync.mjs --dry                      # pull + print, write nothing
//   node scripts/rtr-sync.mjs                            # today, default source
//   node scripts/rtr-sync.mjs --source glo               # a different ISP
//   node scripts/rtr-sync.mjs --seal                     # re-pull yesterday and overwrite it
//   node scripts/rtr-sync.mjs --from 8/1/2026 --to 8/5/2026    # explicit range
//   node scripts/rtr-sync.mjs --scheduled                # what launchd runs; headless
//
// MULTIPLE ISPs: several ISPs we sell for report through this same portal,
// differing only in report folder and which supervisor is ours. Each is an entry
// in data/rtr-sources.json (untracked, beside data/amplify-sources.json), and the
// key is the `source` tag on every row it writes — so renaming a key orphans that
// ISP's history. Adding an ISP is a config entry, not a new script.
//
// The default source is `ezee`, which is deliberately the SAME tag the Sheets
// Apps Script used for this crew — the Sheet's "Knocking Data" tab was filled
// from this very report, so one tag is right and two would double-count it.
//
// This script is now the ONLY writer of that tag. It did not used to be. This
// comment used to claim that feed was "dormant since 2026-05-29"; it was not —
// the Apps Script wrote knocking through Aug 5, hourly. Since both sides delete
// on (source, rep, date) with NO method filter, each run deleted the other's
// rows across the whole overlapping range and the board showed whichever wrote
// last. The knocking push was removed from scripts/rep-sales-sync.gs on
// 2026-08-06. Before pointing a second writer at `ezee`, make it delete only
// its own rows (add method to the delete predicate on both sides).
//
// WHY THIS REPORT AND NOT THE DASHBOARD JSON: the hub.realtimeresults.com
// /ezeedashboard endpoint is easier to call, but its `knocks` field is wrong —
// measured 2026-08-05, it disagreed with this report on 8 of 19 reps and
// reported knocks BELOW uniqueKnocks (impossible) for several, e.g. Damion
// Anderson 29 vs 115. uniqueKnocks agreed 18/19, so only the doors total is
// broken. This report is internally consistent, and it is also the exact report
// Opendoor emails over each morning, so its numbers are the ones everyone else
// is already looking at. It additionally carries First/Last Disposition, which
// the dashboard lacks, so `hours` is derivable rather than null.
//
// WHY CADENCE IS LOW: unlike the dashboard, this report takes a date range, so
// history can be re-pulled and a missed run costs nothing — the next one
// corrects it. That removes the only reason to poll every 10 minutes. Rendering
// an SSRS report is expensive on their server and unmistakably a bot at 144
// runs/day; a few pulls a day plus a morning --seal gets the same data.
//
// The login lives in .rtr-profile/ (gitignored). SSO is handed off from another
// origin, so --login opens a window and waits for you to sign in normally.

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { snapshotKnock, stampFresh } from './_rep-fresh.mjs';

const require_ = createRequire(import.meta.url);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOST = 'https://rtrrealtimeportalwebappprod-reporting.azurewebsites.net';
const SB = 'https://cmkfohwbejcztctrpdnt.supabase.co';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const LOGIN = flag('--login'), DRY = flag('--dry'), SCHEDULED = flag('--scheduled'), SEAL = flag('--seal');
// Render every supervisor instead of the one in the config. `--supervisor ""`
// cannot express this: opt() treats an empty value as "use the default".
const ALL_SUPS = flag('--all-supervisors');
const LOGIN_TIMEOUT = +opt('--login-timeout', SCHEDULED ? 45 : 600);
const SOURCE = (opt('--source', 'ezee') || '').trim().toLowerCase();

// The report's date boxes take M/D/YYYY, as shown in its own header.
const mdy = (d) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
const now = new Date();
const yest = new Date(now.getTime() - 864e5);
const FROM = opt('--from', SEAL ? mdy(yest) : mdy(now));
const TO = opt('--to', FROM);

// May run from a worktree, where data/ and api/ helpers aren't present.
const MAIN = process.env.GROW_SALES_DIR || join(homedir(), 'Grow', 'GrowSales');
const shared = (rel) => [join(ROOT, rel), join(MAIN, rel)].find(existsSync) || null;
// --- per-ISP config. We sell for several ISPs that all report through this same
// Opendoor portal; they differ only in which report folder they live in and which
// supervisor is ours. Everything else — host, auth, columns, write path — is
// shared, so a new ISP is a config entry, not a new script.
const CFG_PATH = shared('data/rtr-sources.json');
const allCfg = CFG_PATH ? JSON.parse(readFileSync(CFG_PATH, 'utf8')) : {};
const cfg = allCfg[SOURCE];
if (!cfg) {
  const known = Object.keys(allCfg).filter((k) => !k.startsWith('_'));
  console.error(`No entry for --source "${SOURCE}" in ${CFG_PATH || 'data/rtr-sources.json'}.`);
  console.error(known.length ? `Configured: ${known.join(', ')}` : 'The config file has no entries yet.');
  process.exit(1);
}
if (!cfg.reportPath) {
  console.error(`Source "${SOURCE}" needs a reportPath in data/rtr-sources.json.`);
  process.exit(1);
}
// Supervisor is optional. Some ISPs' reports carry a Supervisor parameter we use
// to scope the pull to our crew; others are already scoped by the report folder
// itself and have no such parameter. Null means "take every row the report
// returns".
const SUPERVISOR = ALL_SUPS ? null : opt('--supervisor', cfg.supervisor || null);
// Some reports are scoped by CASCADING dropdowns rather than a Supervisor. Omni
// is Company -> Region: Region is empty until Company posts back, so these are
// applied in the order they are listed and each waits for its postback. Left as
// null for the ISPs that use the Division/Team/Supervisor panel.
const DROPDOWNS = Array.isArray(cfg.dropdowns) && cfg.dropdowns.length ? cfg.dropdowns : null;
// What this run is actually scoped to, for the render log. Without it a
// dropdown-scoped source prints "(all rows - no supervisor filter)", which is
// exactly backwards: it IS filtered, just not by a supervisor.
const SCOPE_LABEL = DROPDOWNS
  ? ' for ' + DROPDOWNS.map((d) => `${d.name}=${d.value}`).join(', ')
  : (SUPERVISOR ? ` for ${SUPERVISOR}` : ' (all rows \u2014 no supervisor filter)');
// Some folders are scoped by extra query parameters instead of by a Supervisor
// dropdown — Bluepeak's UserID/ReportByTypeID are what narrow it to our business
// unit. Leaving them off does NOT error: the report renders perfectly and simply
// returns every business unit on the platform, so the rows that come back are
// another company's reps wearing our source tag. Verified 2026-08-18: the bare
// path returned BU_Level_3 "CSG" rows. `query` is appended verbatim.
const REPORT = `${HOST}/?Path=${encodeURIComponent(process.env.RPATH || cfg.reportPath)}${cfg.query ? `&${cfg.query}` : ''}`;
// One Opendoor login usually covers every ISP folder, so the profile is shared by
// default — three logins to keep alive would be three things to break. An ISP that
// genuinely needs its own account sets "profile" in its config entry.
const PROFILE = join(ROOT, cfg.profile || '.rtr-profile');

const aliasPath = shared('api/_name-aliases.js');
const canonicalDisplayName = aliasPath ? require_(aliasPath).canonicalDisplayName : (s) => s;
const indexPath = shared('index.html');
const ANON = indexPath ? (readFileSync(indexPath, 'utf8').match(/eyJ[A-Za-z0-9_.-]{50,}/) || [])[0] : null;
if (!DRY && !ANON) { console.error('Could not read the Supabase anon key from index.html.'); process.exit(1); }

// ReportViewer control ids. These are positional (ctl03/ctl05/... under ctl08)
// and will shift if Opendoor adds or reorders a report parameter — which is the
// most likely way this script breaks. It fails loudly rather than writing a
// partial pull if any of them goes missing.
const P = 'ctl00$MainContent$ReportViewer1$ctl08';
const SEL = {
  start: `input[name="${P}$ctl03$txtValue"]`,
  end: `input[name="${P}$ctl05$txtValue"]`,
  division: `select[name="${P}$ctl07$ddValue"]`,
  team: `select[name="${P}$ctl09$ddValue"]`,
  supervisor: `select[name="${P}$ctl11$ddValue"]`,
  view: `input[name="${P}$ctl00"]`,
};

// One Chrome per profile, enforced HERE rather than in the shell runner.
// run-rtr-sync.sh has a pid lock, but it only stops a second run-rtr-sync.sh —
// it cannot see a manual `node scripts/rtr-sync.mjs`. Running a backfill by hand
// while the hourly agent fired put two Chromes on one user-data-dir, and the
// scheduled one aborted with "Failed to create SingletonLock" after already
// having done nothing. That reads as a mysterious failed sync; it is just a
// collision. Whoever is second now says so and exits 0.
{
  const lockPath = join(PROFILE, '.rtr-sync.lock');
  try { mkdirSync(PROFILE, { recursive: true }); } catch (e) { /* exists */ }
  let holder = null;
  try { holder = +readFileSync(lockPath, 'utf8').trim() || null; } catch (e) { holder = null; }
  if (holder && holder !== process.pid) {
    let alive = false;
    try { process.kill(holder, 0); alive = true; } catch (e) { alive = false; }
    if (alive) {
      console.log(`[${SOURCE}] another rtr-sync (pid ${holder}) already has the Chrome profile. Skipping this run — the report is cumulative, so the next one covers it.`);
      process.exit(0);
    }
  }
  try { writeFileSync(lockPath, String(process.pid)); } catch (e) { /* best effort */ }
  const drop = () => { try { if (+readFileSync(lockPath, 'utf8').trim() === process.pid) unlinkSync(lockPath); } catch (e) {} };
  process.on('exit', drop);
  process.on('SIGINT', () => { drop(); process.exit(130); });
  process.on('SIGTERM', () => { drop(); process.exit(143); });
}

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: SCHEDULED && !LOGIN,
  viewport: { width: 1500, height: 950 },
  acceptDownloads: true,
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto(REPORT, { waitUntil: 'domcontentloaded' }).catch(() => {});

// Logged in == the parameter panel rendered. Anything else means SSO bounced us.
let ready = false;
for (let i = 0; i < LOGIN_TIMEOUT; i++) {
  ready = await page.locator(SEL.view).count().then((n) => n > 0).catch(() => false);
  if (ready) break;
  if (i === 15 && !SCHEDULED) console.log('Waiting for you to finish signing in…');
  await page.waitForTimeout(1000).catch(() => {});
}
if (!ready) {
  await ctx.close();
  if (SCHEDULED) { console.error('Hub reporting session expired. Run: node scripts/rtr-sync.mjs --login'); process.exit(3); }
  console.error(`Report parameters never appeared within ${LOGIN_TIMEOUT}s. Page was: ${page.url()}`);
  process.exit(1);
}
if (LOGIN) { console.log('✓ Signed in. Scheduled runs can go headless now.'); await ctx.close(); process.exit(0); }

// --- set parameters. Each dropdown posts back and rebuilds the panel, so they
// go in order and each one waits for the postback to settle before the next.
const settle = () => page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});

// Order matters, twice over.
//
// Division starts at "<Select a Value>" and cascades into Team, which cascades
// into Supervisor, so the dropdowns must go in that order or the later ones are
// still empty when we reach them.
//
// And EVERY dropdown posts back, which re-renders the whole parameter panel and
// resets the date boxes to their defaults (a prior week). So the dates go LAST,
// after the final postback — filling them earlier silently loses them, which is
// what happened on the first real run: end date came back 8/2 instead of 8/5.
//
// Opening the report with URL parameters instead does NOT work: verified
// 2026-08-05, the wrapper honours only Path and ignores StartDate/EndDate/
// Supervisor, falling back to that same default range.
if (DROPDOWNS) {
  // Config-driven, in order. Each one is read BEFORE it is set: a value that
  // silently fails to match leaves the dropdown on its default, and for a
  // scoping dropdown that default is "All" — which is not an error, it is every
  // other company's reps arriving tagged as ours. Same failure mode bluepeak's
  // query params have, so it fails loudly here and `scope` re-checks the CSV.
  for (const dd of DROPDOWNS) {
    const sel = `select[name="${P}$${dd.ctl}$ddValue"]`;
    const opts = await page.$$eval(sel + ' option', (os) => os.map((o) => o.label.trim()).filter(Boolean)).catch(() => []);
    if (!opts.length) {
      console.error(`[${SOURCE}] dropdown "${dd.name}" (${dd.ctl}) is empty or missing.`);
      console.error('The control ids are positional and shift if the report gains or reorders a parameter.');
      await ctx.close(); process.exit(1);
    }
    // Announce what we are NOT taking, the same way the supervisor path does. A
    // region quietly dropped here is a whole crew missing from the knock data,
    // and nobody finds out until a close rate looks wrong months later.
    if (!/^all$/i.test(dd.value)) {
      const others = opts.filter((o) => o !== dd.value && !/^(all|--|select)/i.test(o));
      if (others.length) console.log(`[${SOURCE}] ${dd.name}: pulling "${dd.value}" only, ${others.length} other(s) not recorded.`);
    }
    await page.selectOption(sel, { label: dd.value }).catch(async () => {
      console.error(`[${SOURCE}] ${dd.name} "${dd.value}" is not in the dropdown. Fix "dropdowns" for source "${SOURCE}" in data/rtr-sources.json — it must match exactly.`);
      console.error(`Available: ${opts.join(' | ')}`);
      await ctx.close(); process.exit(1);
    });
    await settle();
  }
} else {
  await page.selectOption(SEL.division, { label: 'All Divisions' }).catch(() => {});
  await settle();
  await page.selectOption(SEL.team, { label: 'All Teams' }).catch(() => {});
  await settle();
  // Always read the dropdown, even when filtering — a supervisor appearing here
  // that we never pull is a whole crew missing from the knock data, and the only
  // way anyone finds out is a close rate that looks wrong months later.
  const supOptions = await page.$$eval(SEL.supervisor + ' option', (os) => os.map((o) => o.label.trim()).filter(Boolean)).catch(() => []);
  if (supOptions.length) {
    const others = supOptions.filter((o) => o !== SUPERVISOR && !/^(all|--|select)/i.test(o));
    if (SUPERVISOR && others.length) {
      console.log(`[${SOURCE}] supervisors in this report: ${supOptions.join(' | ')}`);
      console.log(`[${SOURCE}] NOTE: pulling "${SUPERVISOR}" only. ${others.length} other supervisor(s) exist and their reps are NOT being recorded. Use --all-supervisors to see them.`);
    }
  }
  if (SUPERVISOR) {
    await page.selectOption(SEL.supervisor, { label: SUPERVISOR }).catch(async () => {
      console.error(`Supervisor "${SUPERVISOR}" not in the dropdown. Fix "supervisor" for source "${SOURCE}" in data/rtr-sources.json — it must match the dropdown exactly.`);
      if (supOptions.length) console.error(`Available: ${supOptions.join(' | ')}`);
      await ctx.close(); process.exit(1);
    });
    await settle();
  }
}

// An inverted range renders the roster with every activity column blank — that
// reads as a quiet day, not as a bug. Refuse it up front.
const asDate = (s) => { const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? new Date(+m[3], +m[1] - 1, +m[2]) : null; };
if (asDate(FROM) && asDate(TO) && asDate(FROM) > asDate(TO)) {
  console.error(`Start ${FROM} is after end ${TO}. That renders an empty report, not an error.`);
  await ctx.close(); process.exit(1);
}

// Dates last — but "last" isn't enough on its own. The parameter panel posts back
// asynchronously, and a postback that lands AFTER we type rebuilds the boxes from
// server state, silently reverting End Date to its default. Observed directly: the
// box showed 8/5 and then flipped back to 8/2. An inverted range renders the full
// roster with every activity column blank, which reads as a quiet day rather than
// a failure — so this is worth being stubborn about.
//
// A fixed sleep would only improve the odds of winning that race. Instead: write,
// read back, and rewrite if something moved it. Do NOT blur or fire change here —
// that triggers the very postback we're racing.
let datesHeld = false;
for (let attempt = 1; attempt <= 4 && !datesHeld; attempt++) {
  await page.fill(SEL.start, FROM);
  await page.fill(SEL.end, TO);
  await page.waitForTimeout(1200);              // let any in-flight postback land
  const got = { start: await page.inputValue(SEL.start).catch(() => null), end: await page.inputValue(SEL.end).catch(() => null) };
  datesHeld = got.start === FROM && got.end === TO;
  if (!datesHeld && attempt < 4) console.log(`  dates reverted (start=${got.start}, end=${got.end}) — retrying ${attempt + 1}/4`);
}

if (!datesHeld) {
  const got = { start: await page.inputValue(SEL.start).catch(() => null), end: await page.inputValue(SEL.end).catch(() => null) };
  console.error(`Date boxes would not hold after 4 attempts: wanted ${FROM}..${TO}, boxes show ${got.start}..${got.end}.`);
  console.error('Rendering anyway would produce an empty report that looks like a slow day, so stopping here.');
  await ctx.close(); process.exit(1);
}

console.log(`[${SOURCE}] Rendering ${FROM}${TO !== FROM ? ' .. ' + TO : ''}${SCOPE_LABEL}…`);
await page.click(SEL.view);

// Wait for the report to state OUR range back to us, not merely to finish.
//
// Two earlier failures both looked like "a quiet day" rather than an error, and
// neither was catchable by reading the input boxes — those hold whatever we just
// typed, which says nothing about what the server used:
//   - the range rendered inverted (start after end), returning the roster with
//     every activity column blank;
//   - the footer stamp is present in the OLD render too, so waiting for it can
//     fall through while the previous report is still on screen.
// The printed "Date Range:" line is the server's own account of what it ran, so
// it is the only honest signal that this render is the one we asked for.
const wantRange = `${FROM} to ${TO}`;
const rendered = await page
  .waitForFunction((want) => document.body.innerText.includes(`Date Range: ${want}`), wantRange, { timeout: 120000 })
  .then(() => true)
  .catch(() => false);
if (!rendered) {
  const saw = await page.evaluate(() => (document.body.innerText.match(/Date Range:[^\n]*/) || ['(no Date Range line — the report may not have rendered)'])[0]).catch(() => '(unreadable)');
  console.error(`Report did not render the requested range within 120s.`);
  console.error(`  wanted: Date Range: ${wantRange}`);
  console.error(`  report says: ${saw}`);
  await ctx.close();
  process.exit(4);
}

// --- export CSV. Going through the toolbar rather than a hand-built
// Reserved.ReportViewerWebControl.axd URL: the export needs a live ReportSession
// and ControlID that only the page knows, and letting it build its own link
// means a session refresh doesn't silently 404 us.
// WE NO LONGER LET CHROME DOWNLOAD THE FILE. Chrome 152.0.7977.65 (auto-installed
// 2026-08-31 23:09) crashes the whole browser process the instant a
// Playwright-driven download starts — EXC_BREAKPOINT in the browser process, every
// page in the context dies with it, and the run surfaces as
// "download.path: Target page, context or browser has been closed". It killed all
// three ISPs from the 2026-09-01 08:10 tick onward and is NOT fixed by upgrading
// Playwright (tried 1.62.1) or by running headed.
//
// So instead of clicking the toolbar link and catching a download, we ask the page
// for the URL that link WOULD have opened and fetch it ourselves. exportReport()
// hands its URL to window.open, so stubbing window.open for the duration of the
// call captures it without any navigation, popup, or download happening at all.
// ctx.request shares the context's cookies, so the ReportSession is still ours.
//
// This is also why the URL is still taken FROM THE PAGE rather than hand-built:
// it carries the live ReportSession and ControlID, which only the rendered page
// knows, so a session refresh still can't silently 404 us.
const exportUrl = await page.evaluate(() => {
  const a = [...document.querySelectorAll('a')].find((x) => /^CSV \(comma/i.test((x.innerText || '').trim()));
  if (!a) throw new Error('CSV export link not found in the toolbar');
  let captured = null;
  const origOpen = window.open;
  // Return a stub so exportReport()'s own bookkeeping doesn't throw on a null handle.
  window.open = (u) => { captured = u; return { focus() {}, close() {} }; };
  try { $find('ctl00_MainContent_ReportViewer1').exportReport('CSV'); }
  finally { window.open = origOpen; }
  return captured ? new URL(captured, location.href).href : null;
}).catch((e) => { console.error('CSV export failed:', e.message); return null; });

if (!exportUrl) {
  console.error('Could not capture the CSV export URL from the report toolbar.');
  await ctx.close(); process.exit(4);
}
const res = await ctx.request.get(exportUrl, { timeout: 120000 }).catch((e) => {
  console.error('CSV export request failed:', e.message); return null;
});
if (!res || !res.ok()) {
  console.error(`CSV export request returned ${res ? res.status() + ' ' + res.statusText() : 'no response'}.`);
  await ctx.close(); process.exit(4);
}
const csv = await res.text();
await ctx.close();

// --- parse. Minimal RFC4180: quoted fields, doubled quotes, embedded commas.
const parseCsv = (text) => {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { f += '"'; i++; }
      else if (c === '"') q = false;
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim()));
};
const rows = parseCsv(csv);
if (process.env.RTR_DUMP) writeFileSync(process.env.RTR_DUMP, csv);
if (!rows.length) { console.error('Export was empty.'); process.exit(4); }

// SSRS names CSV columns after the report's internal textboxes, NOT the labels on
// screen — "Doors Knocked" exports as AllAttempts, "First Disposition" as
// StartTime1, and the trailing Textbox## columns are group headers and subtotals.
// Actual header row, captured 2026-08-05:
//   Textbox69 | Supervisor | D2D_Rep | RecordDate1 | AllAttempts |
//   UniqueDispositions | Contact | Sales1 | StartTime1 | EndTime1 | Textbox57 | …
// The real name comes first in each list, with looser fallbacks after it so a
// sibling ISP's copy of this report still maps even if its textboxes are numbered
// differently. Order matters: 'sales' must be tried before 'sold' or the Sales2 /
// Sales3 subtotal columns can win.
const head = rows[0].map((h) => String(h).toLowerCase().replace(/[^a-z]/g, ''));
const norm1 = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');
// A per-ISP "columns" block in the config wins outright — each ISP builds its
// report a little differently, and guessing is only safe until it isn't. Values
// are exact CSV header names. Anything not overridden falls back to the fuzzy
// list below, which is what makes a same-shaped report work with no config.
const override = cfg.columns || {};
const col = (key, ...alts) => {
  if (override[key]) {
    const want = norm1(override[key]);
    const i = head.findIndex((h) => h === want);
    return i >= 0 ? i : -2;                     // -2: named but absent — a typo, not a guess
  }
  for (const a of alts) { const i = head.findIndex((h) => h.includes(a)); if (i >= 0) return i; }
  return -1;
};
// Exact, un-normalised header lookup. norm1() strips digits, so every "Textbox##"
// column collapses to the same key "textbox" and an override naming one of them
// silently matches whichever came first. Columns addressed by textbox number have
// to be matched on the raw header text instead.
const rawHead = rows[0].map((h) => String(h).replace(/^\uFEFF/, '').trim());
const exactCol = (name) => rawHead.indexOf(String(name).trim());

// Contacts may be DERIVED rather than read. Bluepeak's report carries no raw
// contact count, only "Contact as % of Valid Leads" — but the CSV holds that
// percentage at full float precision, so pct x base recovers the original integer
// exactly (verified 2026-08-18: 0.419753086419753 x 81 = 34 and
// 0.440677966101695 x 59 = 26). Worth doing rather than storing 0: the dashboard
// sums contacts across sources and divides sold by them, so a zero here would not
// read as "unknown", it would quietly inflate every blended close rate.
const PCT = override.contactsPct ? exactCol(override.contactsPct) : -1;
const BASE = override.contactsBase ? exactCol(override.contactsBase) : -1;
const DERIVE = !!(override.contactsPct || override.contactsBase);
if (DERIVE && (PCT < 0 || BASE < 0)) {
  console.error(`Source "${SOURCE}" derives contacts but names a column that is not in the CSV:`);
  if (PCT < 0) console.error(`  contactsPct  -> "${override.contactsPct}"`);
  if (BASE < 0) console.error(`  contactsBase -> "${override.contactsBase}"`);
  console.error(`\nHeaders were:\n  ${rawHead.join(' | ')}`);
  process.exit(4);
}

// A second, independent guard on scope. `query` above is what SHOULD limit the
// report to us, but it is a URL parameter on someone else's portal — if it ever
// stops being honoured the report still renders, just with everyone in it. When
// `scope` is set, rows are checked against a column of the CSV itself, so the
// import cannot quietly widen.
const SCOPE = cfg.scope || null;
const SCOPE_IDX = SCOPE ? exactCol(SCOPE.column) : -1;
if (SCOPE && SCOPE_IDX < 0) {
  console.error(`Source "${SOURCE}" sets scope.column "${SCOPE.column}", which is not in the CSV.`);
  console.error(`\nHeaders were:\n  ${rawHead.join(' | ')}`);
  process.exit(4);
}

const C = {
  rep: col('rep', 'ddrep', 'rep', 'name'),
  date: col('date', 'recorddate', 'dateworked', 'date'),
  doors: col('doors', 'allattempts', 'doorsknocked', 'doors', 'attempts'),
  uniq: col('uniq', 'uniquedispositions', 'uniquedoors', 'unique'),
  contacts: DERIVE ? -1 : col('contacts', 'contact'),
  sold: col('sold', 'sales', 'sold'),
  first: col('first', 'starttime', 'firstdisposition', 'first'),
  last: col('last', 'endtime', 'lastdisposition', 'last'),
};
const bad = Object.entries(C).filter(([k, v]) => v < 0 && !(k === 'contacts' && DERIVE));
if (bad.length) {
  const typos = bad.filter(([, v]) => v === -2).map(([k]) => `${k} -> "${override[k]}"`);
  if (typos.length) console.error(`Configured column names not present in the CSV: ${typos.join(', ')}`);
  const guessed = bad.filter(([, v]) => v === -1).map(([k]) => k);
  if (guessed.length) console.error(`Could not guess columns: ${guessed.join(', ')}`);
  console.error(`\nHeaders were:\n  ${rows[0].join(' | ')}`);
  console.error(`\nFix: add a "columns" block to "${SOURCE}" in data/rtr-sources.json mapping each of`);
  console.error(`rep, date, doors, uniq, contacts, sold, first, last to the exact header names above.`);
  process.exit(4);
}

const iso = (s) => { // "8/5/2026" -> "2026-08-05"
  const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
};
const num = (v) => { const n = parseInt(String(v).replace(/[^0-9-]/g, ''), 10); return Number.isFinite(n) ? n : 0; };
// Rounded, because a float product lands on 33.999999999 as readily as on 34.
const derivedContacts = (r) => {
  const pct = parseFloat(String(r[PCT]).replace(/[^0-9.eE-]/g, ''));
  const base = num(r[BASE]);
  if (!Number.isFinite(pct) || !base) return 0;
  return Math.round(pct * base);
};

// The disposition columns export as FULL datetimes ("08/05/2026 11:18:04"), not
// the bare times the report shows on screen — and some report builds add AM/PM.
// Pull just the clock out and normalise to 24h "HH:MM:SS", so it can be pinned to
// the row's own date rather than whatever date the timestamp carries.
const timeOf = (v) => {
  const m = String(v || '').match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])?[Mm]?/);
  if (!m) return null;
  let h = +m[1];
  const ap = (m[4] || '').toLowerCase();
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${m[2]}:${m[3] || '00'}`;
};

// first_disp/last_disp must be "12:19 PM" — the dashboard parses them with a
// strict /^(\d{1,2}):(\d{2})\s*(AM|PM)$/ and silently renders nothing on a miss.
// An ISO timestamp is the obvious thing to store and the wrong thing here: the
// numbers still appear, so it looks like the times merely weren't collected.
// `hours` is computed from the full HH:MM:SS before this drops the seconds.
const clock = (t) => {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};

const recs = [];
let outOfScope = 0;
for (const r of rows.slice(1)) {
  const rep = canonicalDisplayName(String(r[C.rep] || '').replace(/\s+/g, ' ').trim());
  const date = iso(r[C.date]);
  // Reps with no activity appear as name-only rows (that's how the emailed copy
  // shows the full roster). No date means no workday to record.
  if (!rep || !date) continue;
  if (SCOPE && String(r[SCOPE_IDX] || '').trim() !== SCOPE.value) { outOfScope++; continue; }
  const first = timeOf(r[C.first]);
  const last = timeOf(r[C.last]);
  const hours = first && last
    ? +(Math.max(0, (new Date(`${date}T${last}`) - new Date(`${date}T${first}`)) / 36e5).toFixed(2))
    : null;
  recs.push({
    rep, date,
    doors: num(r[C.doors]), unique_doors: num(r[C.uniq]),
    contacts: DERIVE ? derivedContacts(r) : num(r[C.contacts]), sold: num(r[C.sold]),
    first_disp: clock(first), last_disp: clock(last),
    // Raw 24h "HH:MM" kept only for the merge below; stripped before the insert.
    // clock() renders "1:39 PM", and comparing THOSE as strings puts 1 PM before
    // 11 AM, so the merge has to order on these instead.
    _f: first, _l: last,
    // method MUST be set. These are Time Track rows, and they overlap
    // sr_activity on the same rep/day — CLAUDE.md: "anything reading that table
    // must filter on method or it double counts." Writing NULL here meant every
    // reader either dropped these rows or added them on top of sr_activity, which
    // roughly tripled this week's door and contact averages in the manager text.
    hours, source: SOURCE, method: 'timetrack',
  });
}

// Collapse to ONE row per (rep, date). The report can emit a rep more than once
// for the same day — a separate line per territory worked — and the knocking
// table has a unique index on (rep, date, source, method). A single-day pull
// happened to come back pre-grouped, so this only ever showed up on a range:
// every multi-day backfill died on a 23505 duplicate-key AFTER its deletes had
// already run, which is the worst possible order to fail in.
//
// Doors, contacts and sold add up across the day. The day starts at the earliest
// first knock and ends at the latest last knock, and hours are recomputed from
// that span rather than summed — two territories worked back to back is one
// stretch of time out, not two.
{
  const byKey = new Map();
  for (const r of recs) {
    const k = `${r.rep}|${r.date}`;
    const cur = byKey.get(k);
    if (!cur) { byKey.set(k, { ...r }); continue; }
    cur.doors += r.doors; cur.unique_doors += r.unique_doors;
    cur.contacts += r.contacts; cur.sold += r.sold;
    if (r._f && (!cur._f || r._f < cur._f)) cur._f = r._f;
    if (r._l && (!cur._l || r._l > cur._l)) cur._l = r._l;
  }
  const merged = [...byKey.values()].map((r) => {
    r.first_disp = clock(r._f); r.last_disp = clock(r._l);
    r.hours = (r._f && r._l)
      ? +Math.max(0, (new Date(`${r.date}T${r._l}`) - new Date(`${r.date}T${r._f}`)) / 36e5).toFixed(2)
      : null;
    delete r._f; delete r._l;   // not columns on `knocking`
    return r;
  });
  if (merged.length !== recs.length) {
    console.log(`[${SOURCE}] collapsed ${recs.length} report rows -> ${merged.length} rep/day rows (a rep can appear once per territory)`);
  }
  recs.length = 0; recs.push(...merged);
}

console.log(`[${SOURCE}] ${rows.length - 1} CSV rows -> ${recs.length} rep/day rows with activity`);
if (SCOPE) console.log(`[${SOURCE}] scope ${SCOPE.column}="${SCOPE.value}" kept ${recs.length}, dropped ${outOfScope} row(s) belonging to another business unit`);
// A derived contacts column is addressed by textbox NUMBER, which is the most
// fragile thing in this script — a report redesign renumbers them and the value
// silently becomes some other percentage. Contacts above doors is impossible, so
// it is a cheap tripwire for exactly that, and it is worth stopping over: a wrong
// contacts figure is invisible on the board and wrong close rates get believed.
if (DERIVE) {
  const impossible = recs.filter((r) => r.contacts > r.doors);
  if (impossible.length) {
    console.error(`[${SOURCE}] ${impossible.length} row(s) derived MORE contacts than doors, which cannot happen.`);
    console.error(`  "${override.contactsPct}" is probably no longer the contact rate — the report's textbox numbers move when it is redesigned.`);
    for (const r of impossible.slice(0, 5)) console.error(`  ${r.rep} ${r.date}: contacts=${r.contacts} doors=${r.doors}`);
    process.exit(4);
  }
}
if (!recs.length) {
  // Rows came back but none survived. That is almost always a column pointing at
  // the wrong field, and "Nothing to write" alone makes it look like a quiet day —
  // so show what was actually read rather than leaving it to guesswork.
  console.log('\nNo rows survived. Resolved columns:');
  for (const [k, i] of Object.entries(C)) console.log(`  ${k.padEnd(9)} -> [${i}] ${JSON.stringify(rows[0][i])}`);
  console.log('\nFirst 3 data rows at those columns:');
  for (const r of rows.slice(1, 4)) {
    console.log('  ' + Object.entries(C).map(([k, i]) => `${k}=${JSON.stringify(r[i])}`).join('  '));
  }
  console.log('\nRows are dropped when rep or date is empty. A date must look like M/D/YYYY.');
  process.exit(0);
}

if (DRY) {
  console.log(`\nHeaders: ${rows[0].join(' | ')}\n`);
  console.log('  rep                        doors  uniq  cont  sold   hrs  first     last');
  for (const r of [...recs].sort((a, b) => b.doors - a.doors)) {
    console.log(`  ${r.rep.padEnd(26)}${String(r.doors).padStart(5)}${String(r.unique_doors).padStart(6)}${String(r.contacts).padStart(6)}${String(r.sold).padStart(6)}${String(r.hours ?? '-').padStart(6)}  ${String(r.first_disp || '-').padEnd(9)} ${r.last_disp || '-'}`);
  }
  const t = recs.reduce((a, r) => ({ d: a.d + r.doors, u: a.u + r.unique_doors, c: a.c + r.contacts, s: a.s + r.sold }), { d: 0, u: 0, c: 0, s: 0 });
  console.log(`\n  TOTAL${' '.repeat(21)}${String(t.d).padStart(5)}${String(t.u).padStart(6)}${String(t.c).padStart(6)}${String(t.s).padStart(6)}`);
  console.log('\n--dry: nothing written.');
  process.exit(0);
}

// --- write, scoped by source so grow's and tds's rows are never touched.
//
// UPSERT, not delete-then-insert. The old order deleted every rep/day it was
// about to write and only then inserted, so any failure in between — a duplicate
// key, a dropped connection, a 500 — left those days with NOTHING. That is not
// theoretical: a backfill that died on a unique-violation silently wiped
// 2026-05-30 and did not put it back, and nothing in the logs said so, because
// the deletes had already returned 204.
//
// The unique index on this table is not one PostgREST's on_conflict can target
// (it rejects every column list with 42P10), so this stays delete-then-insert —
// but INTERLEAVED, one chunk at a time. A failure now costs the chunk it was on
// instead of every day in the run, and the dedupe above removes the only cause
// we have actually seen.
const H = { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' };
const del = async (rep, date) => {
  const r = await fetch(`${SB}/rest/v1/knocking?source=eq.${SOURCE}&rep=eq.${encodeURIComponent(rep)}&date=eq.${date}`, { method: 'DELETE', headers: H });
  if (!r.ok && r.status !== 204) throw new Error(`delete ${rep} ${date}: ${r.status}`);
};
const prev = await snapshotKnock(SB, H, SOURCE, recs);
for (let i = 0; i < recs.length; i += 200) {
  const chunk = recs.slice(i, i + 200);
  for (let j = 0; j < chunk.length; j += 25) await Promise.all(chunk.slice(j, j + 25).map((r) => del(r.rep, r.date)));
  const r = await fetch(`${SB}/rest/v1/knocking`, { method: 'POST', headers: H, body: JSON.stringify(chunk) });
  if (!r.ok) {
    console.error('insert failed:', r.status, (await r.text()).slice(0, 200));
    console.error(`STOPPED after ${i} of ${recs.length} rows. The days in this chunk were deleted and not rewritten — re-run this same range to restore them.`);
    process.exit(4);
  }
}
const t = recs.reduce((a, r) => ({ d: a.d + r.doors, s: a.s + r.sold }), { d: 0, s: 0 });
console.log(`✓ [${SOURCE}] Wrote ${recs.length} rep/day rows (${t.d} doors, ${t.s} sold) for ${FROM}${TO !== FROM ? ' .. ' + TO : ''}`);
await stampFresh(SB, H, SOURCE, prev, recs);
