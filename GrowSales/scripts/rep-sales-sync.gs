// ============================================================
// GROW DASHBOARD — Supabase Sync Script
// ============================================================
// Replaces the v6 web app. Reads Google Sheets and pushes
// processed data to Supabase. Run manually or on a timer.
//
// This script does NOT write `knocking`. scripts/rtr-sync.mjs owns that
// table for source='ezee' — it pulls the same Opendoor Time Track report
// this Sheet's "Knocking Data" tab was filled from, so the two were the
// same data arriving twice.
//
// They were also fighting. Both wrote delete-then-insert keyed on
// (source, rep, date) with NO method filter, so each hourly run deleted
// the other's rows for every overlapping rep/day — Apr 2 through Aug 5 —
// and the board lost whichever writer went first. Do not re-add a
// knocking push here: give a new feed its own source tag instead.
//
// deals + leaderboard remain full-replace (this Sheet is their
// only source). upfront_optin is also full-replace.
// ============================================================

const REP_SALES_ID = '19tYXTotbLPJ3N3678UcPKZTLCIKfQD30FnZI23sUqgE';
const SUPABASE_URL = 'https://cmkfohwbejcztctrpdnt.supabase.co';
const SUPABASE_KEY = 'PASTE_YOUR_EXISTING_SERVICE_ROLE_KEY_HERE';
const UPFRONT_TAB = 'Upfront Sync';   // IMPORTRANGE of 'Upfront Pay Reps'!A:D

// ============================================================
// MAIN SYNC FUNCTION — run this manually or on a trigger
// ============================================================
function syncToSupabase() {
  Logger.log('Starting sync...');
  var ss = SpreadsheetApp.openById(REP_SALES_ID);

  // 1. Read and process deals
  Logger.log('Reading deals...');
  var deals = processDeals(ss);
  Logger.log('Processed ' + deals.length + ' deals');

  // 2. Knocking is NOT read or written here — rtr-sync.mjs owns it. See the
  //    header. The read is skipped too, not just the push: it cost minutes of
  //    the run for rows that were about to be deleted anyway.

  // 3. Read leaderboard
  Logger.log('Reading leaderboard...');
  var leaderboard = processLeaderboard(ss);
  Logger.log('Processed ' + leaderboard.length + ' leaderboard entries');

  // 4. Push to Supabase
  Logger.log('Pushing deals to Supabase...');
  supabaseReplace('deals', deals);

  Logger.log('Pushing leaderboard to Supabase...');
  supabaseReplace('leaderboard', leaderboard);

  // 5. Upfront opt-in roster. Wrapped so a broken IMPORTRANGE can never take
  //    down the deals / leaderboard push above.
  Logger.log('Pushing upfront opt-in to Supabase...');
  try {
    pushUpfrontOptin(processUpfrontOptin(ss));
  } catch (e) {
    Logger.log('Upfront opt-in FAILED: ' + e.message);
    upfrontMeta(null, String(e.message).substring(0, 500));
  }

  // Summary: deals per manager for most recent week
  var weekCounts = {};
  var latestWeek = '';
  deals.forEach(function(d) {
    if (d.week > latestWeek) latestWeek = d.week;
  });
  deals.forEach(function(d) {
    if (d.week !== latestWeek) return;
    var m = d.manager || 'Unassigned';
    if (!weekCounts[m]) weekCounts[m] = {sold: 0, reps: {}};
    weekCounts[m].sold++;
    weekCounts[m].reps[d.rep] = (weekCounts[m].reps[d.rep] || 0) + 1;
  });
  Logger.log('\n=== CURRENT WEEK (' + latestWeek + ') ATTRIBUTION ===');
  Object.keys(weekCounts).sort().forEach(function(m) {
    var c = weekCounts[m];
    Logger.log('  ' + m + ': ' + c.sold + ' deals');
    Object.keys(c.reps).sort(function(a,b){return c.reps[b]-c.reps[a];}).forEach(function(r) {
      Logger.log('    ' + r + ': ' + c.reps[r]);
    });
  });
  Logger.log('Sync complete!');
}

// ============================================================
// SUPABASE API HELPERS
// ============================================================
function supabaseReplace(table, rows) {
  // Delete ALL existing rows - loop until empty
  // (Only used for tables this Sheet fully owns: deals, leaderboard.
  //  NEVER use this for knocking — use supabaseReplaceScoped instead.)
  var deleted = 0;
  for (var attempt = 0; attempt < 20; attempt++) {
    var resp = supabaseFetch(table + '?limit=1', 'GET');
    var check = JSON.parse(resp);
    if (!check || check.length === 0) break;
    supabaseFetch(table + '?id=gt.0', 'DELETE');
    deleted++;
  }
  Logger.log('  ' + table + ': cleared in ' + deleted + ' passes');

  // Insert in batches of 500
  var batchSize = 500;
  for (var i = 0; i < rows.length; i += batchSize) {
    var batch = rows.slice(i, i + batchSize);
    supabaseFetch(table, 'POST', batch);
    Logger.log('  ' + table + ': inserted ' + Math.min(i + batchSize, rows.length) + '/' + rows.length);
  }
  Logger.log('  ' + table + ': done. ' + rows.length + ' rows inserted');
}

// Scoped replace: only clears the exact rep+date rows this Sheet actually has,
// AND only the ones this Sheet wrote (source='ezee'). The source predicate is
// what keeps other writers' rows alive — without it this delete also removed the
// Amplify crawler's row for the same rep/day, every hour, so the crawler's work
// never survived to be read.
// UNUSED — see processKnocking. This is the delete that fought rtr-sync.mjs:
// it clears by (source, rep, date) with no method filter, so it removed that
// script's rows too. Any future use needs the method predicate added first.
var SOURCE_TAG = 'ezee';
function supabaseReplaceScoped(table, rows) {
  var byRep = {};
  rows.forEach(function(r) {
    if (!r.rep || !r.date) return;
    if (!byRep[r.rep]) byRep[r.rep] = {};
    byRep[r.rep][r.date] = true;
  });
  var reps = Object.keys(byRep);
  reps.forEach(function(rep) {
    var dates = Object.keys(byRep[rep]);
    for (var i = 0; i < dates.length; i += 60) {   // chunk to keep URLs short
      var chunk = dates.slice(i, i + 60);
      supabaseFetch(table + '?source=eq.' + SOURCE_TAG + '&rep=eq.' + encodeURIComponent(rep) + '&date=in.(' + chunk.join(',') + ')', 'DELETE');
    }
  });
  Logger.log('  ' + table + ': cleared ' + reps.length + ' reps\' own ' + SOURCE_TAG + ' rows (scoped)');

  // Insert in batches of 500
  var batchSize = 500;
  for (var i = 0; i < rows.length; i += batchSize) {
    var batch = rows.slice(i, i + batchSize);
    supabaseFetch(table, 'POST', batch);
    Logger.log('  ' + table + ': inserted ' + Math.min(i + batchSize, rows.length) + '/' + rows.length);
  }
  Logger.log('  ' + table + ': done. ' + rows.length + ' rows inserted');
}

function supabaseFetch(path, method, body) {
  var options = {
    method: method || 'GET',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=minimal' : ''
    },
    muteHttpExceptions: true
  };
  if (body) options.payload = JSON.stringify(body);

  var url = SUPABASE_URL + '/rest/v1/' + path;
  var resp = UrlFetchApp.fetch(url, options);
  var code = resp.getResponseCode();
  if (code >= 400) {
    Logger.log('ERROR ' + code + ' on ' + method + ' ' + path + ': ' + resp.getContentText().substring(0, 500));
    throw new Error('Supabase error ' + code + ' on ' + path);
  }
  return resp.getContentText();
}

// ============================================================
// NAME / ISP / DATE UTILITIES (same as v6)
// ============================================================
const DISPLAY_FIX = {
  'Will gabor':'Will Gabor', 'Kierfer Neal':'Kiefer Neal', 'Chris LaGrange':'Chris Lagrange',
  'Chris Legrange':'Chris Lagrange', 'Joshua Goodman':'Josh Goodman', 'Anna':'Anna Lower',
  'William Bailey':'Will Bailey', 'Connor Gardner':'Conner Gardner', 'Xavier Lopez':'Xaiver Lopez',
  'Joshua Vander Linden':'Josh Vander Linden', 'Macee Mofatt':'Macee Moffat',
  'Will archer':'Will Archer', 'Syndey Turner':'Sydney Turner', 'Samantha Boyd':'Sammi Boyd',
  'Slone Pots':'Slone Potts', 'Calvin Astil':'Calvin Astill', 'Riley Mullen':'Riley Mullin',
  'Jai Jordan':'Jailen Jordan', 'Hazel Garcia':'Hazael Garcia', 'Danny Dubose':'Daniel DuBose',
  'Conner Byington':'Connor Byington', 'Emma liljenquist':'Emma Liljenquist',
  'Emma Lijenquist':'Emma Liljenquist', 'Camillo Ramierz':'Camilo Ramirez',
  'Caleb N':'Caleb Neal', 'Jacob Van':'Jacob Van Duker', 'Eliza McMillan':'Eliza McMillen', 'Liberty McMillen':'Libby McMillen',
  'Quaid Rasmussenin':'Quaid Rasmussen', 'KEIFER NEAL':'Kiefer Neal', 'Keifer Neal':'Kiefer Neal',
  'JUSTIN TAYLOR':'Justin Taylor', 'SAM EKBLAD':'Sam Ekblad', 'RILEY MULLIN':'Riley Mullin',
  'PAVLO LABA':'Pavlo Laba', 'DANIEL GEE':'Daniel Gee', 'COLTER MAY':'Colter May',
  'Ben ogara':'Ben Ogara', 'ELLIE SIMMONS':'Ellie Simmons', 'GROW MARKETING':'Grow Marketing',
  'NICK ANDERSON':'Nick Anderson', 'joseph Graper':'Joseph Graper',
  'Gerrit Grondel':'Gerritt Grondel', 'GERRIT GRONDEL':'Gerritt Grondel', 'GERRITT GRONDEL':'Gerritt Grondel',
  'Levi grondel':'Levi Grondel', 'Josh Vander':'Josh Vander Linden',
  'Quad Rasmussen':'Quaid Rasmussen', 'Easton almond':'Easton Almond',
  'Michael sperry':'Michael Sperry', 'blake Striegel':'Blake Striegel',
  'ANDY BINGHAM':'Andy Bingham', 'BOSTON UNDERWOOD':'Boston Underwood',
  'CALEB HALES':'Caleb Hales', 'CHASE CANNON':'Chase Cannon',
  'CRUE SEARLE':'Crue Searle', 'ELI FRIDEY':'Eli Fridey',
  'HOLLY CLINTON':'Holly Clinton', 'KAIT CLARK':'Kait Clark',
  'Austin Benson':'Austen Benson', 'AUSTIN BENSON':'Austen Benson', 'AUSTEN BENSON':'Austen Benson',
  'LIBBY MCMILLEN':'Libby McMillen', 'NOAH WEEKS':'Noah Weeks', 'THOMAS BOTTGER':'Thomas Bottger',
};

function canonName(name) {
  if (!name) return null;
  var s = String(name).trim();
  if (!s) return null;
  s = s.replace(/\s{2,}/g, ' ');
  // Check DISPLAY_FIX before stripping trailing letters
  if (DISPLAY_FIX[s]) return DISPLAY_FIX[s];
  s = s.replace(/\s+[PN]\s*$/, '').trim();
  if (DISPLAY_FIX[s]) return DISPLAY_FIX[s];
  if (s === s.toUpperCase() && s.length > 3) {
    var titled = s.replace(/\w\S*/g, function(t) { return t.charAt(0).toUpperCase() + t.substr(1).toLowerCase(); });
    if (DISPLAY_FIX[titled]) return DISPLAY_FIX[titled];
    return DISPLAY_FIX[s] || titled;
  }
  return DISPLAY_FIX[s] || s;
}

const ISP_NORM = {
  'Ezee':'Ezee Fiber', 'Ezee IL':'Ezee Fiber', 'Ezee NM':'Ezee Fiber', 'Tachus':'Ezee Fiber',
  'Omni':'Omni Fiber', 'Cityside':'Cityside Fiber', 'Lyte':'Lyte Fiber',
  'Ziply':'Ziply Fiber', 'GLO':'Glo Fiber', 'i3':'i3 Broadband',
  'GBN':'GBN', 'SLIC':'SLIC', 'Bluepeak':'Bluepeak', 'Frontier':'Frontier',
};
function normIsp(raw) { return raw ? (ISP_NORM[String(raw).trim()] || String(raw).trim()) : ''; }

function toISO(v) {
  if (!v) return null;
  if (v instanceof Date) {
    var y = v.getFullYear(), m = String(v.getMonth()+1).padStart(2,'0'), d = String(v.getDate()).padStart(2,'0');
    return y+'-'+m+'-'+d;
  }
  var s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0,10);
  var md = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (md) return md[3]+'-'+String(md[1]).padStart(2,'0')+'-'+String(md[2]).padStart(2,'0');
  return null;
}

function mondayOf(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
  var d = new Date(iso+'T12:00:00Z');
  var dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().substring(0,10);
}

function daysBetween(a, b) {
  return Math.round((new Date(b+'T12:00:00Z') - new Date(a+'T12:00:00Z')) / 86400000);
}

// ============================================================
// UPFRONT OPT-IN (roster of reps on upfront pay)
// ============================================================
// Source of truth is the "Upfront Pay Reps" tab of the Upfront sheet, pulled in
// here via an IMPORTRANGE on the "Upfront Sync" tab:
//   =IMPORTRANGE("1S8O5zZjl67mJ4IGiDJCxjhczIyNalM9v--9c-Vris8M","'Upfront Pay Reps'!A:D")
// Columns are positional: A = rep name, B = email, C = active date, D = end date.
//
// Names go through canonName(), the SAME function deals/leaderboard use, so the
// roster joins to deal data correctly ("TREY NEAL" -> "Trey Neal") without
// mangling intercapped names like "JaQuan Batts".
function processUpfrontOptin(ss) {
  var sheet = ss.getSheetByName(UPFRONT_TAB);
  if (!sheet) { Logger.log('No "' + UPFRONT_TAB + '" tab — skipping upfront opt-in'); return []; }
  var vals = sheet.getDataRange().getValues();

  var seenName = {}, seenEmail = {}, rows = [];
  for (var i = 0; i < vals.length; i++) {
    var raw = String(vals[i][0] || '').trim();
    if (!raw) continue;
    if (/^(rep name|name|rep|total|totals)$/i.test(raw)) continue;   // header / footer line

    // IMPORTRANGE degrades to these when its authorization lapses or while it
    // resolves. Writing them would replace the roster with junk, so stop instead.
    if (/^(#REF!|#N\/A|#ERROR!|#VALUE!|Loading\.\.\.)$/i.test(raw)) {
      throw new Error('Upfront tab shows "' + raw + '" — IMPORTRANGE needs re-authorizing');
    }

    var name = canonName(raw);
    if (!name) continue;
    // Sheet-side spellings that don't match the deal data. Fixed here rather
    // than trusting the sheet to stay clean: "Trey/Richard Neal" is Trey Neal's
    // re-enrollment row and would otherwise land as a phantom rep who matches
    // nothing. Keyed on the canonical name so casing in the sheet doesn't matter.
    var UPFRONT_NAME_FIX = { 'Trey/richard Neal': 'Trey Neal', 'Trey/Richard Neal': 'Trey Neal' };
    if (UPFRONT_NAME_FIX[name]) name = UPFRONT_NAME_FIX[name];
    var email = String(vals[i][1] || '').trim();
    var emailKey = email.toLowerCase();
    var activeIso = toISO(vals[i][2]) || '';

    // The same rep appears more than once ON PURPOSE when they left upfront and
    // came back after their install rate recovered — each row is one enrollment
    // period, told apart by its active date. So dedupe on (name, active date),
    // not name alone: name-only kept the FIRST row and silently threw away every
    // re-enrollment (2026-08-05: 33 sheet rows synced as 29 reps this way).
    if (seenName[name + '|' + activeIso]) continue;
    // Same person entered twice under different spellings ("Alli Lauriano" and
    // "Allison Lauriano" share one address). Keep the first — it is the spelling
    // the deal data uses; the second would show as a phantom rep stuck at n/a.
    // Scoped to the same active date so a re-enrollment period under a variant
    // spelling still lands rather than vanishing.
    if (emailKey && seenEmail[emailKey + '|' + activeIso]) continue;

    seenName[name + '|' + activeIso] = true;
    if (emailKey) seenEmail[emailKey + '|' + activeIso] = true;
    rows.push({
      name: name,
      email: email || null,
      active_date: activeIso || '1970-01-01',   // PK is (name, active_date) now — never null
      end_date: toISO(vals[i][3]),
      updated_at: new Date().toISOString(),
    });
  }
  return rows;
}

// Full replace, so reps removed from the sheet disappear here too. Refuses to
// write an empty set: that would silently drop everyone off upfront pay.
// upfront_optin is keyed on name (no id column), so the delete filter differs
// from supabaseReplace's ?id=gt.0.
function pushUpfrontOptin(rows) {
  if (!rows || !rows.length) {
    Logger.log('  upfront_optin: 0 reps parsed — kept the existing list');
    upfrontMeta(null, 'Sheet parsed to 0 reps — kept the previous list');
    return;
  }
  supabaseFetch('upfront_optin?name=not.is.null', 'DELETE');
  supabaseFetch('upfront_optin', 'POST', rows);
  upfrontMeta(rows.length, null);
  Logger.log('  upfront_optin: ' + rows.length + ' reps written');
}

// Heartbeat row the dashboard shows ("synced Xh ago") and api/sync-watchdog.js
// checks for staleness. Delete-then-insert because supabaseFetch() does not send
// a merge-duplicates Prefer header.
function upfrontMeta(count, err) {
  try {
    supabaseFetch('upfront_optin_sync_meta?id=eq.1', 'DELETE');
    supabaseFetch('upfront_optin_sync_meta', 'POST', [{
      id: 1,
      last_run: count == null ? null : new Date().toISOString(),
      rep_count: count,
      error: err,
    }]);
  } catch (e) {
    Logger.log('  upfront_optin_sync_meta write failed: ' + e.message);
  }
}

// ============================================================
// CLEAN SEQUIFI NAME ANNOTATIONS
// ============================================================
function cleanSeqName(raw) {
  var s = raw;
  // Strip all parenthetical content
  s = s.replace(/\([^)]*\)/g, '');
  // Clean up whitespace
  s = s.replace(/\s+/g, ' ').trim();
  // Take only first two words (first name + last name)
  var parts = s.split(' ');
  if (parts.length >= 2) return parts[0] + ' ' + parts[1];
  return parts[0] || '';
}

// ============================================================
// SEQUIFI MASTER READER (manager assignments)
// Column-based parser: each column = one week
// Row 0 = date range headers
// Within each column: Blitz #N → Manager → Reps
// ============================================================
function readSequifiMaster(ss) {
  var sheet = ss.getSheetByName('Sequifi Master');
  if (!sheet) { Logger.log('Sequifi Master tab not found'); return { lookup: {}, repToLatest: {} }; }
  var vals = sheet.getDataRange().getValues();
  if (vals.length < 3) return { lookup: {}, repToLatest: {} };

  var lookup = {};
  var repToLatest = {};
  var roster = {};

  // Step 1: Parse date headers from row 0 — determine week monday for each column
  var colWeeks = [];
  var anchorYear = null;

  // First pass: find columns with explicit years to anchor year inference
  for (var c = 0; c < vals[0].length; c++) {
    var cell = vals[0][c] ? String(vals[0][c]).trim() : '';
    var ym = cell.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (ym) { anchorYear = parseInt(ym[3], 10); }
  }
  if (!anchorYear) anchorYear = new Date().getFullYear();

  // Second pass: parse all date headers
  for (var c = 0; c < vals[0].length; c++) {
    var cell = vals[0][c] ? String(vals[0][c]).trim() : '';
    if (!cell) { colWeeks[c] = null; continue; }

    // Try to match date pattern (first date in the range)
    var m = cell.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
    if (!m) { colWeeks[c] = null; continue; }

    var month = parseInt(m[1], 10);
    var day = parseInt(m[2], 10);
    var year;
    if (m[3]) {
      year = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
    } else {
      // Infer year: Dec = anchorYear-1, everything else = anchorYear
      year = (month >= 11) ? anchorYear - 1 : anchorYear;
    }

    // Add 1 day to start date to handle ranges that start on Sunday
    // e.g. "6/14-6/20" where 6/14 is Sunday — we want Monday 6/15
    var startDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    var iso = startDate.toISOString().substring(0, 10);
    colWeeks[c] = mondayOf(iso);
  }

  // Build date ranges for week matching
  var colWeekRanges = [];
  for (var c = 0; c < vals[0].length; c++) {
    if (!colWeeks[c]) continue;
    var cell = vals[0][c] ? String(vals[0][c]).trim() : '';
    // Parse both start and end dates from range like "6/14/2026-6/20/2026"
    var parts = cell.split('-');
    if (parts.length >= 2) {
      var startM = parts[0].match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
      var endM = parts[parts.length-1].match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
      if (startM && endM) {
        var sMonth = parseInt(startM[1],10), sDay = parseInt(startM[2],10);
        var eMonth = parseInt(endM[1],10), eDay = parseInt(endM[2],10);
        var sYear = startM[3] ? (startM[3].length===2?2000+parseInt(startM[3],10):parseInt(startM[3],10)) : (sMonth>=11?anchorYear-1:anchorYear);
        var eYear = endM[3] ? (endM[3].length===2?2000+parseInt(endM[3],10):parseInt(endM[3],10)) : (eMonth>=11?anchorYear-1:anchorYear);
        // Handle year rollover (Dec-Jan)
        if (sMonth > eMonth && !endM[3]) eYear = sYear + 1;
        var rangeStart = sYear+'-'+String(sMonth).padStart(2,'0')+'-'+String(sDay).padStart(2,'0');
        var rangeEnd = eYear+'-'+String(eMonth).padStart(2,'0')+'-'+String(eDay).padStart(2,'0');
        colWeekRanges.push({ start: rangeStart, end: rangeEnd, monday: colWeeks[c], label: cell });
      }
    }
  }
  colWeekRanges.sort(function(a,b){ return a.start < b.start ? -1 : 1; });
  Logger.log('Sequifi Master: ' + colWeeks.filter(Boolean).length + ' columns with dates, ' + colWeekRanges.length + ' date ranges');

  // Step 2: Process each column independently (column = week)
  for (var c = 0; c < colWeeks.length; c++) {
    var week = colWeeks[c];
    if (!week) continue;

    var currentMgr = null;
    var waitingForMgr = false;

    for (var r = 1; r < vals.length; r++) {
      var cell = vals[r][c] ? String(vals[r][c]).trim() : '';

      if (!cell) {
        // Empty cell ends current manager group
        if (currentMgr) currentMgr = null;
        waitingForMgr = false;
        continue;
      }

      // Blitz marker
      if (/blitz/i.test(cell)) {
        waitingForMgr = true;
        currentMgr = null;
        continue;
      }

      // First name after Blitz = Manager
      if (waitingForMgr) {
        var cleaned = cleanSeqName(cell);
        var name = canonName(cleaned);
        if (name) {
          currentMgr = name;
          waitingForMgr = false;
          // Self-attribute: manager's own deals go under themselves
          var selfKey = name + '|' + week;
          lookup[selfKey] = name;
          continue;
        }
      }

      // Subsequent names = Reps under this manager
      if (currentMgr) {
        var cleaned = cleanSeqName(cell);
        var name = canonName(cleaned);
        if (name && name !== currentMgr) {
          var key = name + '|' + week;
          lookup[key] = currentMgr;
          // Track roster
          var rk = currentMgr + '|' + week;
          if (!roster[rk]) roster[rk] = [];
          roster[rk].push(name);
          // Track latest manager for fallback
          if (!repToLatest[name] || week > repToLatest[name].week) {
            repToLatest[name] = { mgr: currentMgr, week: week };
          }
        }
      }
    }
  }

  Logger.log('Sequifi Master: ' + Object.keys(lookup).length + ' lookup entries, ' + Object.keys(repToLatest).length + ' reps with latest mgr');
  var sampleKeys = Object.keys(lookup).slice(0, 5);
  sampleKeys.forEach(function(k) { Logger.log('  Lookup: ' + k + ' => ' + lookup[k]); });

  return { lookup: lookup, repToLatest: repToLatest, weekRanges: colWeekRanges };
}

// ============================================================
// BLITZ SIGN UP READER
// ============================================================
function readBlitzSignUp(ss) {
  var sheet = ss.getSheetByName('Blitz Sign Up');
  if (!sheet) return { lookup: {}, currentWeek: '' };
  var vals = sheet.getDataRange().getValues();
  var lookup = {};
  var currentWeek = '';
  for (var r = 0; r < vals.length; r++) {
    var row = vals[r];
    var dateCell = row[0] ? String(row[0]).trim() : '';
    var weekMatch = dateCell.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (weekMatch) {
      var yr = weekMatch[3].length === 2 ? '20' + weekMatch[3] : weekMatch[3];
      currentWeek = yr + '-' + String(weekMatch[1]).padStart(2,'0') + '-' + String(weekMatch[2]).padStart(2,'0');
      currentWeek = mondayOf(currentWeek) || currentWeek;
    }
    var mgr = row[1] ? canonName(String(row[1]).trim()) : '';
    var rep = row[2] ? canonName(String(row[2]).trim()) : '';
    if (mgr && rep && currentWeek) {
      lookup[rep + '|' + currentWeek] = mgr;
    }
  }
  return { lookup: lookup, currentWeek: currentWeek };
}

// ============================================================
// PROCESS DEALS (read All Data + assign managers)
// ============================================================
var SHEET_ERR = /^#(REF|N\/A|VALUE|DIV\/0|NAME|NULL|NUM|ERROR)[!?]?$/i;

function processDeals(ss) {
  var skippedErrRows = 0;
  // Read Rep IDs for email→name mapping
  var emailToName = {};
  try {
    var idsSheet = ss.getSheetByName('Rep IDs');
    if (idsSheet) {
      var idsVals = idsSheet.getDataRange().getValues();
      for (var i = 1; i < idsVals.length; i++) {
        var name = canonName(String(idsVals[i][0] || '').trim());
        var email = String(idsVals[i][1] || '').trim().toLowerCase();
        if (name && email && !emailToName[email]) emailToName[email] = name;
      }
    }
  } catch (e) {}

  // Read All Data
  var allDataSheet = ss.getSheetByName('All Data');
  if (!allDataSheet) throw new Error('"All Data" not found');
  var allVals = allDataSheet.getDataRange().getValues();
  var headers = allVals[0];
  var colMap = {};
  for (var c = 0; c < headers.length; c++) { if (headers[c]) colMap[String(headers[c]).trim()] = c; }

  var COL = {
    type: colMap['product_id'] != null ? colMap['product_id'] : 1,
    rep: colMap['closer1_id'] != null ? colMap['closer1_id'] : 2,
    status: colMap['job_status'] != null ? colMap['job_status'] : 3,
    isp: colMap['install_partner'] != null ? colMap['install_partner'] : 4,
    pkg: colMap['package_size'] != null ? colMap['package_size'] : 5,
    cust: colMap['customer_name'] != null ? colMap['customer_name'] : 7,
    phone: colMap['customer_phone'] != null ? colMap['customer_phone'] : 8,
    addr: colMap['customer_address'] != null ? colMap['customer_address'] : (colMap['customer_street'] != null ? colMap['customer_street'] : -1),
    city: colMap['customer_city'] != null ? colMap['customer_city'] : 12,
    state: colMap['customer_state'] != null ? colMap['customer_state'] : 13,
    zip: colMap['customer_zip'] != null ? colMap['customer_zip'] : 14,
    sd: colMap['customer_signoff'] != null ? colMap['customer_signoff'] : 15,
    id: colMap['date_installed'] != null ? colMap['date_installed'] : 16,
    cd: colMap['date_cancelled'] != null ? colMap['date_cancelled'] : 17,
    pd: colMap['planned_install_date'] != null ? colMap['planned_install_date'] : 20,
    ad: colMap['adders_description'] != null ? colMap['adders_description'] : -1,
  };

  var todayISO = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');

  // Read Sequifi Master for manager assignments
  var seq = readSequifiMaster(ss);
  var lookup = seq.lookup;
  var repToLatest = seq.repToLatest;
  var weekRanges = seq.weekRanges || [];
  Logger.log('Sequifi Master: ' + Object.keys(lookup).length + ' lookup entries, ' + Object.keys(repToLatest).length + ' reps with latest mgr');
  // Log some sample entries
  var sampleKeys = Object.keys(lookup).slice(0, 5);
  sampleKeys.forEach(function(k) { Logger.log('  Lookup: ' + k + ' => ' + lookup[k]); });

  // Read Blitz Sign Up
  var blitz = readBlitzSignUp(ss);
  var blitzLookup = blitz.lookup;
  var blitzWeek = blitz.currentWeek;
  Logger.log('Blitz Sign Up: ' + Object.keys(blitzLookup).length + ' entries, week: ' + blitzWeek);

  // Fuzzy matching setup
  function normKey(name) { return name.toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim(); }
  var normLookup = {};
  for (var lk in lookup) { var parts = lk.split('|'); normLookup[normKey(parts[0]) + '|' + parts[1]] = lookup[lk]; }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    var m = a.length, n = b.length;
    if (Math.abs(m - n) > 2) return 99;
    var prev = [], curr = [];
    for (var j = 0; j <= n; j++) prev[j] = j;
    for (var i = 1; i <= m; i++) {
      curr[0] = i;
      for (var j = 1; j <= n; j++) {
        var cost = a.charAt(i-1) === b.charAt(j-1) ? 0 : 1;
        curr[j] = Math.min(prev[j] + 1, curr[j-1] + 1, prev[j-1] + cost);
      }
      var tmp = prev; prev = curr; curr = tmp;
    }
    return prev[n];
  }

  var weekNames = {};
  for (var lk in lookup) {
    var parts = lk.split('|');
    if (!weekNames[parts[1]]) weekNames[parts[1]] = [];
    var already = false;
    for (var wi = 0; wi < weekNames[parts[1]].length; wi++) { if (weekNames[parts[1]][wi].name === parts[0]) { already = true; break; } }
    if (!already) weekNames[parts[1]].push({ name: parts[0], norm: normKey(parts[0]) });
  }

  // Parse deals
  var rawDeals = [];
  for (var r = 1; r < allVals.length; r++) {
    var row = allVals[r];
    var repRaw = row[COL.rep]; if (!repRaw) continue;
    var repStr = String(repRaw).trim(); if (!repStr) continue;

    var rep;
    if (repStr.indexOf('@') > -1) {
      var email = repStr.toLowerCase();
      rep = emailToName[email];
      if (!rep) { var parts = email.split('@')[0].split('.'); if (parts.length >= 2) rep = canonName(parts.map(function(p){return p.charAt(0).toUpperCase()+p.substr(1).toLowerCase();}).join(' ')); }
      if (!rep) rep = repStr;
    } else { rep = canonName(repStr); }
    // Spreadsheet error values are not people. This used to compare against the
    // literal '#REF!' and missed the '#Ref!' the Sheet actually produced, so 108
    // real Lyte Fiber deals rode into `deals` with an error string as their rep
    // and showed up as a rep on every leaderboard. Match ALL Sheets errors, any
    // case. A hit means a formula upstream is broken: the deals are real and stay
    // missing until it is fixed, so the count is logged rather than swallowed.
    if (!rep || SHEET_ERR.test(String(rep).trim())) { skippedErrRows++; continue; }

    var statusRaw = row[COL.status]; if (!statusRaw) continue;
    var status = String(statusRaw).trim(); if (!status || status === 'None') continue;
    var s = status;
    if (/cancel/i.test(status)) s = 'Cancelled';
    else if (/serviced|install/i.test(status)) s = 'Serviced';
    else if (/pending/i.test(status)) s = 'Pending';
    else if (/clawback/i.test(status)) s = 'Clawback';
    else continue;

    var sd = toISO(row[COL.sd]);
    var id = toISO(row[COL.id]);
    var cd = toISO(row[COL.cd]);
    var pd = toISO(row[COL.pd]);
    // Match sale date to Sequifi Master date range for consistent week bucketing
    var w = null;
    if (sd && weekRanges.length) {
      for (var wr = 0; wr < weekRanges.length; wr++) {
        if (sd >= weekRanges[wr].start && sd <= weekRanges[wr].end) {
          w = weekRanges[wr].monday;
          break;
        }
      }
    }
    if (!w) w = mondayOf(sd);  // fallback for dates outside any range
    // Case/space-insensitive: the sheet has "presale" lowercase, so an exact
    // === 'Presale' check silently turned every one of them into Standard.
    var typeStr = row[COL.type] ? String(row[COL.type]).trim().toLowerCase() : '';
    var t = typeStr === 'presale' ? 'Presale' : 'Standard';
    var pdue = (s === 'Pending' && pd && pd < todayISO);
    var dsc = (s === 'Cancelled' && cd) ? Math.max(0, daysBetween(cd, todayISO)) : null;

    rawDeals.push({
      rep: rep, manager: 'Unassigned', status: s,
      isp: normIsp(row[COL.isp]),
      package: row[COL.pkg] ? String(row[COL.pkg]).trim() : '',
      customer: row[COL.cust] ? String(row[COL.cust]).trim() : '',
      city: row[COL.city] ? String(row[COL.city]).trim() : '',
      state: row[COL.state] ? String(row[COL.state]).trim() : '',
      sale_date: sd, install_date: id, cancel_date: cd,
      cancel_reason: '',
      week: w, zip: row[COL.zip] ? String(row[COL.zip]).substring(0,5) : '',
      planned_install: pd, past_due: pdue || false,
      phone: row[COL.phone] ? String(row[COL.phone]).replace(/\D/g,'') : '',
      days_since_cancel: dsc,
      deal_type: t,
      adders: (COL.ad >= 0 && row[COL.ad]) ? String(row[COL.ad]).trim() : '',
      address: (COL.addr >= 0 && row[COL.addr]) ? String(row[COL.addr]).trim() : '',
    });
  }

  // === MANAGER ATTRIBUTION (same 4-tier logic) ===
  var _fuzzyCache = {};
  for (var i = 0; i < rawDeals.length; i++) {
    var d = rawDeals[i];
    var key = d.rep + '|' + d.week;

    // Tier 1: exact
    if (lookup[key]) { d.manager = lookup[key]; continue; }
    // Tier 2: normalized
    var nk = normKey(d.rep) + '|' + d.week;
    if (normLookup[nk]) { d.manager = normLookup[nk]; continue; }
    // Tier 3: Levenshtein
    if (_fuzzyCache[key] !== undefined) {
      if (_fuzzyCache[key]) d.manager = _fuzzyCache[key];
      continue;
    }
    var repNorm = normKey(d.rep);
    var candidates = weekNames[d.week] || [];
    var bestDist = 99, bestName = null;
    for (var ci = 0; ci < candidates.length; ci++) {
      var dist = levenshtein(repNorm, candidates[ci].norm);
      if (dist < bestDist) { bestDist = dist; bestName = candidates[ci].name; }
    }
    if (bestDist <= 2 && bestName && lookup[bestName + '|' + d.week]) {
      d.manager = lookup[bestName + '|' + d.week];
      _fuzzyCache[key] = d.manager;
    } else { _fuzzyCache[key] = null; }
  }

  // Tier 4: Blitz Sign Up only (NO latest-manager fallback)
  for (var i = 0; i < rawDeals.length; i++) {
    var d = rawDeals[i];
    if (d.manager !== 'Unassigned') continue;
    if (d.week === blitzWeek && blitzLookup[d.rep + '|' + d.week]) {
      d.manager = blitzLookup[d.rep + '|' + d.week];
    }
  }

  // Log attribution results
  var assigned = 0, unassigned = 0;
  var mgrCounts = {};
  rawDeals.forEach(function(d) {
    if (d.manager === 'Unassigned') unassigned++;
    else { assigned++; mgrCounts[d.manager] = (mgrCounts[d.manager] || 0) + 1; }
  });
  Logger.log('Attribution: ' + assigned + ' assigned, ' + unassigned + ' unassigned out of ' + rawDeals.length);
  Object.keys(mgrCounts).sort().forEach(function(m) { Logger.log('  ' + m + ': ' + mgrCounts[m]); });

  if (skippedErrRows > 0) {
    Logger.log('WARNING: ' + skippedErrRows + ' deal row(s) skipped because closer1_id held a spreadsheet '
      + 'error (#REF! and friends). These are REAL deals and they stay missing from the dashboard until the '
      + 'formula in "All Data" is fixed. Do not ignore this line.');
  }

  return rawDeals;
}

// ============================================================
// PROCESS KNOCKING DATA
// ============================================================
// UNUSED — kept only as a record of how the Knocking Data tab was shaped.
// Nothing calls this, and syncToSupabase must not: rtr-sync.mjs owns `knocking`.
function processKnocking(ss) {
  var sheet = ss.getSheetByName('Knocking Data');
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  var results = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var repRaw = (row[0] || '').toString().trim();
    if (!repRaw) continue;
    var rep = canonName(repRaw);
    if (!rep) continue;

    var dateVal = row[3];
    var dateStr = '';
    if (dateVal instanceof Date) {
      dateStr = Utilities.formatDate(dateVal, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    } else if (dateVal) {
      dateStr = toISO(dateVal) || '';
    }
    if (!dateStr) continue;

    var firstDisp = '';
    if (row[9] instanceof Date) {
      firstDisp = Utilities.formatDate(row[9], Session.getScriptTimeZone(), 'h:mm a');
    } else if (row[9]) {
      var fs = String(row[9]).trim();
      var fm = fs.match(/(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)/i);
      firstDisp = fm ? fm[1] : fs;
    }

    var lastDisp = '';
    if (row[11] instanceof Date) {
      lastDisp = Utilities.formatDate(row[11], Session.getScriptTimeZone(), 'h:mm a');
    } else if (row[11]) {
      var ls = String(row[11]).trim();
      var lm = ls.match(/(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)/i);
      lastDisp = lm ? lm[1] : ls;
    }

    results.push({
      rep: rep,
      date: dateStr,
      doors: parseInt(row[4], 10) || 0,
      unique_doors: parseInt(row[5], 10) || 0,
      contacts: parseInt(row[7], 10) || 0,
      sold: parseInt(row[8], 10) || 0,
      first_disp: firstDisp,
      last_disp: lastDisp,
      hours: parseFloat(row[12]) || 0,
      // Tag every row with where it came from. Without this the rows default to
      // 'grow' and are indistinguishable from the Amplify crawler's, so the two
      // sources silently overwrite each other on the same rep/day.
      source: 'ezee',
    });
  }
  return results;
}

// ============================================================
// PROCESS LEADERBOARD
// ============================================================
function processLeaderboard(ss) {
  var sheet = ss.getSheetByName('Leaderboard');
  if (!sheet) return [];
  var vals = sheet.getDataRange().getValues();
  var results = [];
  for (var i = 1; i < vals.length; i++) {
    var rep = vals[i][0] ? String(vals[i][0]).trim() : '';
    if (!rep) continue;
    var deals = parseInt(vals[i][1], 10) || 0;
    results.push({ rep: canonName(rep) || rep, deals: deals });
  }
  return results;
}

// ============================================================
// WEB APP ENTRY — the dashboard's "Sync now" button
// ============================================================
// Deploy > New deployment > Web app
//   Execute as:      Me
//   Who has access:  Anyone
// Then set the /exec URL as SHEET_SYNC_URL in Vercel and this key as
// SHEET_SYNC_KEY. The key is the only thing standing between the open web
// and a full sheet-to-Supabase rewrite, so make it long and random.
//
// Redeploy (new version) after any edit to this file, or the web app keeps
// serving the old code.
// ============================================================
var WEB_TRIGGER_KEY = 'PASTE_A_LONG_RANDOM_STRING_HERE';

function doPost(e) { return runWebSync(e); }
function doGet(e) { return runWebSync(e); }

function runWebSync(e) {
  var key = (e && e.parameter && e.parameter.key) || '';
  if (!WEB_TRIGGER_KEY || WEB_TRIGGER_KEY.indexOf('PASTE_') === 0 || key !== WEB_TRIGGER_KEY) {
    return jsonOut({ ok: false, error: 'unauthorized' });
  }
  // A second caller landing mid-sync would double the delete/insert churn against
  // Supabase, so a concurrent press reports "already running" instead of racing.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) return jsonOut({ ok: false, running: true, error: 'A sync is already running' });
  try {
    syncToSupabase();
    return jsonOut({ ok: true, finished_at: new Date().toISOString() });
  } catch (err) {
    return jsonOut({ ok: false, error: String((err && err.message) || err).substring(0, 400) });
  } finally {
    lock.releaseLock();
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// OPTIONAL: Set up a time-based trigger to auto-sync
// Run this once to create a trigger that syncs every 2 hours
// ============================================================
function setupAutoSync() {
  // Remove existing triggers
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'syncToSupabase') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  // Create new trigger — every 2 hours
  ScriptApp.newTrigger('syncToSupabase')
    .timeBased()
    .everyHours(2)
    .create();
  Logger.log('Auto-sync trigger created — runs every 2 hours');
}


// ========== SHEET UI ==========

// Adds a "Grow" menu to the sheet toolbar
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Grow Dashboard')
    .addItem('Sync Now', 'syncToSupabase')
    .addItem('Setup Hourly Sync', 'setupHourlySync')
    .addToUi();
}

function setupHourlySync() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'syncToSupabase') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncToSupabase')
    .timeBased()
    .everyHours(1)
    .create();
  SpreadsheetApp.getUi().alert('Hourly sync enabled. Dashboard will auto-update every hour.');
}
