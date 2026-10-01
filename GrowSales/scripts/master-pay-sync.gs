/**
 * Master Manager Pay -> full weekly roster history (report_config.__roster_weeks__).
 *
 * Lives in the REP SALES DATA sheet, alongside rep-sales-sync.gs, and reads the
 * "Sequifi Master" tab — the IMPORTRANGE of the Master Manager Pay grid. Josh
 * pulls it in there so the Master sheet itself never has to be touched.
 *
 * Grid shape (a 1:1 port of scripts/parse-team-assignments.mjs):
 *   row 1 = one column per week ("6/7/2026-6/13/2026", or bare "12/28-1/03")
 *   within a column, a "Blitz #N" cell opens a team: the next name is the
 *   MANAGER, the names below it (until the next "Blitz #N") are their reps.
 *
 * Why this exists: the export was manual, so it stopped happening. The sheet
 * was current and the dashboard was running on a July snapshot — every week
 * after it fell back to deal-derived managers, and the 15 undated columns
 * before 3/29 were never imported at all.
 *
 * Unlike roster-sync.gs (one week, __roster_current__, overwritten weekly),
 * this pushes EVERY week in one row, so a re-run repairs history instead of
 * replacing it. The dashboard treats it as the roster of record for completed
 * weeks; the in-progress week still comes from the Blitz paste, because the
 * Master grid is only filled in as the week runs.
 *
 * Everything here is prefixed mph* / MPH_ on purpose: Apps Script gives every
 * file in a project ONE global scope, so a plain `cleanName` or `SB` here would
 * silently shadow rep-sales-sync.gs (or be shadowed by it) with no error.
 *
 * INSTALL (once):
 *   1. Rep Sales Data sheet -> Extensions -> Apps Script
 *   2. File -> + -> Script, name it "masterPaySync", paste this whole file, save.
 *   3. Add one line to the existing onOpen() in the other file, so both menus
 *      survive (a second onOpen() would quietly replace the first):
 *          .addItem('Roster history: preview', 'mphPreview')
 *          .addItem('Roster history: push now', 'mphPush')
 *   4. Automatic: Triggers (clock icon) -> Add Trigger:
 *      function mphPush · time-driven · week timer · every Monday, 6-7am.
 *      (Monday, not Sunday: the week has to be finished before it is truth.)
 */

var MPH_TAB = 'Sequifi Master';       // IMPORTRANGE of the Master Manager Pay grid
var MPH_SB = 'https://cmkfohwbejcztctrpdnt.supabase.co';
// Fetched from the dashboard so it can never be mistyped in a paste; it is the
// same public key that ships in the dashboard page anyway.
var MPH_ANON = UrlFetchApp.fetch('https://growsales.vercel.app/scripts/anon-key.txt').getContentText().trim();

var MPH_BLITZ = /blitz\s*#?\s*\d+/i;
var MPH_DOW = '(?:sun|mon|tues?|wed|thur?s?|fri|sat)';
// IMPORTRANGE degrades to these when its authorization lapses or while it
// refreshes. Same guard rep-sales-sync.gs uses on the Upfront tab.
var MPH_SHEET_ERR = /^#(REF|N\/A|VALUE|DIV\/0|NAME|NULL|NUM|ERROR)[!?]?$/i;

// Misspellings, then the canonical alias map — a straight port of
// scripts/_name-clean.mjs + api/_name-aliases.js, in that order. It has to be
// this pair and not roster-import.py's: the Blitz importer deliberately keeps
// "Chris Lagrange" to match the deals feed, while the Master history has always
// keyed him as "Christopher Lagrange". Cleaning him differently here would
// split one person into two across the exact weeks this file is meant to fix.
// Keep both files in step when either changes.
var MPH_SPELLING = {
  'syndey turner': 'Sydney Turner', 'chris lagrange': 'Chris Legrange',
  'christopher lagrange': 'Chris Legrange', 'chris legrange': 'Chris Legrange',
  'macee mofatt': 'Macee Moffat', 'calvin astil': 'Calvin Astill',
  'samuel hossfi': 'Samuel Hossfield', 'ethan hendrickson': 'Ethan Hendriksen',
  'gaberiel robbins': 'Gabriel Robbins', 'raihan steed': 'Raihan Steed',
  'krispy rebollar': 'Krispy Rebollar', 'spencer schwieger': 'Spencer Schweiger',
  'ali ai ghazzawi': 'Ali Al Ghazzawi'
};

var MPH_ALIASES = {
  'samantha boyd': 'Sammi Boyd',
  'mana mcguire': 'Kaimana McGuire',
  'chris': 'Christopher Lagrange',
  'chris lagrange': 'Christopher Lagrange',
  'cristiano mariano': 'Christopher Lagrange',
  'chris legrange': 'Christopher Lagrange',
  'christopher legrange': 'Christopher Lagrange',
  'alli lauriano': 'Allison Lauriano',
  'kierfer neal': 'Kiefer Neal'
};

function mphCleanName(raw) {
  var s = String(raw || '');
  s = s.replace(/\([^)]*\)/g, ' ').replace(/\([^)]*$/g, ' ').replace(/\$\S*/g, ' ');
  s = s.replace(new RegExp('\\b' + MPH_DOW + '\\s*[-\u2013]\\s*' + MPH_DOW + '\\b', 'gi'), ' ');
  s = s.replace(new RegExp('\\b' + MPH_DOW + '\\b', 'gi'), ' ');
  s = s.replace(/[0-9]+/g, ' ');
  s = s.replace(/\b(LT|BNB|IN\s*MARKET|INMARKET|remotely|good|car)\b/gi, ' ');
  s = s.replace(/[-\u2013|].*$/, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/(?:\s+[A-Z])+$/, '').trim();
  if (!s) return '';
  s = MPH_SPELLING[s.toLowerCase()] || s;
  // light title-case: fix all-lowercase tokens, leave interior caps (TJ, JaQuan)
  s = s.split(' ').map(function (w) {
    return (w && w === w.toLowerCase()) ? w.charAt(0).toUpperCase() + w.slice(1) : w;
  }).join(' ');
  return MPH_ALIASES[s.toLowerCase()] || s;
}

function mphHeaderParts(h) {
  var s = String(h || '').replace(/\([^)]*\)/g, '').trim();
  var m = s.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (!m) return null;
  return { mo: +m[1], da: +m[2], yr: m[3] ? +(m[3].length === 2 ? '20' + m[3] : m[3]) : null };
}

function mphToSunday(yr, mo, da) {
  var d = new Date(yr, mo - 1, da);
  if (isNaN(d.getTime())) return null;
  d.setDate(d.getDate() - d.getDay());                    // weeks are Sunday-anchored
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

// The Master grid only started writing the year in the header around
// 03/29/2026; the columns before it are bare "12/28-1/03". Columns run left to
// right in date order, so the year is recoverable: walk right to left from the
// first dated column and roll the year back whenever a date would otherwise
// land after the column to its right (a December -> January boundary).
function mphResolveWeeks(header) {
  var parts = [];
  for (var i = 0; i < header.length; i++) {
    var p = mphHeaderParts(header[i]);
    if (p) parts.push({ p: p, col: i + 1 });              // 1-based sheet column
  }
  var out = [], nextYr = null, nextMo = null, nextDa = null;
  for (var j = parts.length - 1; j >= 0; j--) {
    var p2 = parts[j].p, yr = p2.yr;
    if (!yr) {
      if (nextYr === null) continue;                      // no dated column to anchor from
      yr = nextYr;
      if (p2.mo > nextMo || (p2.mo === nextMo && p2.da > nextDa)) yr--;
    }
    var week = mphToSunday(yr, p2.mo, p2.da);
    if (!week) continue;
    out.push({ week: week, col: parts[j].col, inferred: !p2.yr });
    nextYr = yr; nextMo = p2.mo; nextDa = p2.da;
  }
  return out.reverse();
}

function mphGrid() {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(MPH_TAB);
  if (!sheet) throw new Error('No "' + MPH_TAB + '" tab in this workbook.');
  var values = sheet.getDataRange().getValues();
  if (!values.length) throw new Error('"' + MPH_TAB + '" is empty.');
  // A lapsed IMPORTRANGE leaves a single #REF! where the grid should be. Catch
  // it by name rather than letting it parse to a plausible-looking 0-week push.
  var a1 = String(values[0][0] || '').trim();
  if (MPH_SHEET_ERR.test(a1)) throw new Error('"' + MPH_TAB + '" shows "' + a1 + '" — the IMPORTRANGE needs re-authorizing.');
  return values;
}

function mphParseAll() {
  var values = mphGrid();
  var weekCols = mphResolveWeeks(values[0]);
  if (!weekCols.length) throw new Error('No week columns found in row 1 of "' + MPH_TAB + '".');
  var assignments = {}, anomalies = [], empty = [], inferred = [];

  for (var i = 0; i < weekCols.length; i++) {
    var week = weekCols[i].week, col = weekCols[i].col - 1;
    var mgr = null, expect = false, teams = {}, order = [], repSeen = {};
    for (var r = 1; r < values.length; r++) {
      var cell = String(values[r][col] === undefined ? '' : values[r][col]).trim();
      if (!cell || MPH_SHEET_ERR.test(cell)) continue;
      if (MPH_BLITZ.test(cell)) { mgr = null; expect = true; continue; }
      var nm = mphCleanName(cell);
      if (!nm) continue;
      if (expect) {
        mgr = nm; expect = false;
        if (!teams[mgr]) { teams[mgr] = []; order.push(mgr); }
      } else if (mgr) {
        // A rep listed under two leaders in one week is a sheet error. Report
        // it and still file them under the LAST leader, matching
        // parse-team-assignments.mjs — dropping them instead would make the
        // person vanish from the week entirely.
        if (repSeen[nm] && repSeen[nm] !== mgr) anomalies.push(week + ': ' + nm + ' under both ' + repSeen[nm] + ' and ' + mgr);
        repSeen[nm] = mgr;
        teams[mgr].push(nm);
      }
    }
    if (order.length) {
      assignments[week] = teams;
      if (weekCols[i].inferred) inferred.push(week);
    } else {
      empty.push(week);                                   // column exists, nobody in it yet
    }
  }

  var weeks = Object.keys(assignments).sort();
  // A Sunday with no roster inside the covered range leaves the dashboard
  // carrying a rep's last-known manager forward — that is how attribution
  // silently drifts, so surface it rather than let it pass.
  var gaps = [];
  if (weeks.length) {
    var d = new Date(+weeks[0].slice(0, 4), +weeks[0].slice(5, 7) - 1, +weeks[0].slice(8, 10));
    var last = weeks[weeks.length - 1];
    while (Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd') < last) {
      var iso = Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      if (!assignments[iso]) gaps.push(iso);
      d.setDate(d.getDate() + 7);
    }
  }
  return { assignments: assignments, weeks: weeks, gaps: gaps,
           empty: empty, inferred: inferred, anomalies: anomalies };
}

function mphSummary(P) {
  var L = ['"' + MPH_TAB + '" — ' + P.weeks.length + ' weeks: ' + P.weeks[0] + ' .. ' + P.weeks[P.weeks.length - 1], ''];
  var recent = P.weeks.slice(-3);
  for (var i = 0; i < recent.length; i++) {
    var w = recent[i], t = P.assignments[w], mgrs = Object.keys(t), n = 0;
    for (var j = 0; j < mgrs.length; j++) n += t[mgrs[j]].length;
    L.push(w + ': ' + mgrs.length + ' teams, ' + (mgrs.length + n) + ' people');
  }
  L.push('');
  if (P.empty.length) L.push('Dated columns still empty (not pushed): ' + P.empty.join(', '));
  L.push(P.gaps.length ? 'GAPS inside the range: ' + P.gaps.join(', ') : 'No gaps in the covered range.');
  if (P.inferred.length) L.push('Year inferred from column order: ' + P.inferred.length + ' undated weeks');
  if (P.anomalies.length) L.push('', 'Listed under two leaders:', P.anomalies.slice(0, 12).join('\n'));
  return L.join('\n');
}

// Run from the sheet menu you get a popup; run from the Apps Script editor
// there is no UI to pop up, so fall back to the execution log rather than
// throwing after a parse that already succeeded.
function mphReport(text) {
  try { SpreadsheetApp.getUi().alert(text); } catch (e) { Logger.log(text); }
}

function mphPreview() {
  mphReport(mphSummary(mphParseAll()) + '\n\nNothing saved. Use "Roster history: push now" to go live.');
}

function mphPush() {
  var P = mphParseAll();
  // Refuse an obviously broken parse rather than blank the history. This row is
  // the roster of record for every completed week — a bad write re-attributes
  // months of sales at once.
  if (P.weeks.length < 10) throw new Error('Parse looks wrong (' + P.weeks.length + ' weeks) — not saving. Run the preview.');
  var body = {
    manager: '__roster_weeks__',
    config: { weeks: P.assignments, saved_at: new Date().toISOString(), source: 'master-pay-sync.gs' }
  };
  var resp = UrlFetchApp.fetch(MPH_SB + '/rest/v1/report_config?on_conflict=manager', {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: MPH_ANON, Authorization: 'Bearer ' + MPH_ANON, Prefer: 'resolution=merge-duplicates' },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code >= 300) throw new Error('Supabase write failed: ' + code + ' ' + resp.getContentText().slice(0, 200));
  mphReport('Pushed ' + P.weeks.length + ' weeks (through ' + P.weeks[P.weeks.length - 1] + ').\n\n' + mphSummary(P));
}
