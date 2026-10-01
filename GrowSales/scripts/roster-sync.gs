/**
 * Blitz Sign Up -> live weekly roster (report_config.__roster_current__).
 *
 * Runs INSIDE the Blitz Sign Up Google Sheet as you — no service account, no
 * keys, nothing a Workspace org policy can block. Same pattern as the existing
 * rep-sales-sync.gs. Logic is a 1:1 port of scripts/roster-import.py:
 *   row 1 = Sunday date per column · column A = region anchors
 *   blocks separated by labels/blanks · first kept name in a block = manager
 *   fill #ff00ff (magenta) = subcontractor -> "Subs" bucket
 *   fill #ff0000 (red)     = bailed        -> dropped
 *
 * INSTALL (once):
 *   1. Open the Blitz Sign Up sheet -> Extensions -> Apps Script
 *   2. Paste this whole file, save.
 *   3. Reload the sheet — a "Grow Roster" menu appears.
 *      "Preview this week's parse" shows everything before anything saves.
 *      "Push roster now" writes it live.
 *   4. Automatic: in Apps Script -> Triggers (clock icon) -> Add Trigger:
 *      function pushRoster · time-driven · week timer · every Sunday, 6-7pm.
 *      (Add a second one for Monday 6-7am to catch late edits if you like.)
 */

var SB = 'https://cmkfohwbejcztctrpdnt.supabase.co';
// Fetched from the dashboard so it can never be mistyped in a paste; it is the
// same public key that ships in the dashboard page anyway.
var ANON = UrlFetchApp.fetch('https://growsales.vercel.app/scripts/anon-key.txt').getContentText().trim();

var SUB_FILL = '#ff00ff';
var BAIL_FILL = '#ff0000';
var STATUS_RE = /^(summer|blitz|closed)\b/i;
var LABELISH = /\b(paying|rent|lyte|fiber|route|tbd|need|house|housing)\b/i;
var DOW = '(?:sun|mon|tues?|wed|thur?s?|fri|sat)';

// Deals-feed spellings win (Lagrange, not Legrange) — keep in step with
// scripts/roster-import.py, which this file mirrors.
var SPELLING = {
  'syndey turner': 'Sydney Turner', 'chris lagrange': 'Chris Lagrange',
  'christopher lagrange': 'Chris Lagrange', 'chris legrange': 'Chris Lagrange',
  'macee mofatt': 'Macee Moffat', 'calvin astil': 'Calvin Astill',
  'samuel hossfi': 'Samuel Hossfield', 'ethan hendrickson': 'Ethan Hendriksen',
  'gaberiel robbins': 'Gabriel Robbins', 'spencer schwieger': 'Spencer Schweiger',
  'ali ai ghazzawi': 'Ali Al Ghazzawi'
};

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Grow Roster')
    .addItem("Preview this week's parse", 'previewRoster')
    .addItem('Push roster now', 'pushRoster')
    .addToUi();
}

function cleanName(raw) {
  var s = String(raw || '');
  s = s.replace(/\([^)]*\)/g, ' ').replace(/\([^)]*$/g, ' ').replace(/\$\S*/g, ' ');
  s = s.replace(new RegExp('\\b' + DOW + '\\s*[-\u2013]\\s*' + DOW + '\\b', 'gi'), ' ');
  s = s.replace(new RegExp('\\b' + DOW + '\\b', 'gi'), ' ');
  s = s.replace(/[0-9]+/g, ' ');
  s = s.replace(/\b(LT|BNB|IN\s*MARKET|INMARKET|remotely|good|car)\b/gi, ' ');
  s = s.replace(/[-\u2013|].*$/, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/(?:\s+[A-Z])+$/, '').trim();
  if (!s) return '';
  s = SPELLING[s.toLowerCase()] || s;
  return s.split(' ').map(function (w) {
    return (w && w === w.toLowerCase()) ? w.charAt(0).toUpperCase() + w.slice(1) : w;
  }).join(' ');
}

function currentSunday() {
  var t = new Date();
  t.setDate(t.getDate() - t.getDay());
  return new Date(t.getFullYear(), t.getMonth(), t.getDate());
}

function parseWeek(target) {
  var ss = SpreadsheetApp.getActive();
  var sheets = ss.getSheets();
  var ws = null, col = -1;
  for (var si = 0; si < sheets.length; si++) {
    var head = sheets[si].getRange(1, 1, 1, sheets[si].getLastColumn()).getValues()[0];
    for (var c = 1; c < head.length; c++) {
      var v = head[c];
      if (v instanceof Date &&
          v.getFullYear() === target.getFullYear() &&
          v.getMonth() === target.getMonth() &&
          v.getDate() === target.getDate()) { ws = sheets[si]; col = c + 1; break; }
    }
    if (ws) break;
  }
  if (!ws) throw new Error('No column headed ' + target.toDateString() + ' found in any tab.');

  var rows = ws.getLastRow();
  var vals = ws.getRange(2, col, rows - 1, 1).getValues();
  var fills = ws.getRange(2, col, rows - 1, 1).getBackgrounds();
  var regions = ws.getRange(2, 1, rows - 1, 1).getValues();

  var teams = {}, order = [], subs = [], bailed = [];
  var currentMgr = null, inBlock = false;
  for (var i = 0; i < vals.length; i++) {
    var txt = String(vals[i][0] == null ? '' : vals[i][0]).trim();
    var region = String(regions[i][0] == null ? '' : regions[i][0]).trim();
    if (region || !txt) { inBlock = false; continue; }
    if (STATUS_RE.test(txt) || LABELISH.test(txt)) { inBlock = false; continue; }
    var fl = String(fills[i][0] || '').toLowerCase();
    var name = cleanName(txt);
    if (fl === BAIL_FILL) { if (name) bailed.push(name); continue; } // bailed row keeps the block open
    // People are TitleCase on this sheet; a fully-lowercase word ("Sherwood
    // park") marks a place label, not a person.
    var stripped = txt.replace(/\([^)]*\)?/g, ' ')
      .replace(new RegExp('\\b' + DOW + '\\s*[-\u2013]\\s*' + DOW + '\\b|\\b' + DOW + '\\b', 'gi'), ' ')
      .replace(/\b(LT|BNB)\b|[A-Z]$/g, ' ');
    var lower = /\b[a-z]{3,}\b/.test(stripped);
    if (name.split(' ').length < 2 || txt.indexOf('/') >= 0 || lower) { inBlock = false; continue; }
    if (fl === SUB_FILL) { subs.push(name); continue; }               // subs never lead a team
    if (!inBlock) {
      currentMgr = name; inBlock = true;
      if (!teams[currentMgr]) { teams[currentMgr] = []; order.push(currentMgr); }
    } else if (name !== currentMgr) {
      teams[currentMgr].push(name);
    }
  }
  if (subs.length) {
    var seen = {};
    teams['Subs'] = subs.filter(function (n) { if (seen[n]) return false; seen[n] = 1; return true; }).sort();
  }
  return { tab: ws.getName(), teams: teams, order: order, bailed: bailed };
}

function summaryText(week, P) {
  var lines = ['Week ' + week + ' (tab "' + P.tab + '") — ' + P.order.length + ' teams', ''];
  P.order.forEach(function (m) { lines.push(m + ' (' + P.teams[m].length + '): ' + (P.teams[m].join(', ') || '\u2014')); });
  if (P.teams['Subs']) lines.push('Subs (' + P.teams['Subs'].length + '): ' + P.teams['Subs'].join(', '));
  if (P.bailed.length) lines.push('', 'Bailed, dropped: ' + P.bailed.join(', '));
  return lines.join('\n');
}

function previewRoster() {
  var sun = currentSunday();
  var week = Utilities.formatDate(sun, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var P = parseWeek(sun);
  SpreadsheetApp.getUi().alert(summaryText(week, P) + '\n\nNothing saved. Use "Push roster now" to go live.');
}

function pushRoster() {
  var sun = currentSunday();
  var week = Utilities.formatDate(sun, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var P = parseWeek(sun);
  // Refuse an obviously broken parse rather than blank the live roster.
  if (P.order.length < 3) throw new Error('Parse looks wrong (' + P.order.length + ' teams) — not saving. Run Preview.');
  var body = {
    manager: '__roster_current__',
    config: { week: week, teams: P.teams,
              saved_at: new Date().toISOString(), source: 'roster-sync.gs' }
  };
  var resp = UrlFetchApp.fetch(SB + '/rest/v1/report_config?on_conflict=manager', {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: ANON, Authorization: 'Bearer ' + ANON, Prefer: 'resolution=merge-duplicates' },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code >= 300) throw new Error('Supabase write failed: ' + code + ' ' + resp.getContentText().slice(0, 200));
  try { SpreadsheetApp.getUi().alert('Roster pushed live for ' + week + ' \u2014 ' + P.order.length + ' teams.'); } catch (e) { /* trigger run: no UI */ }
}
