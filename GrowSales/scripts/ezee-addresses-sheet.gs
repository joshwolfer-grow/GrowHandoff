// ============================================================
// EZEE ADDRESSES — Google Sheet refresh (Apps Script, bound to the Sheet)
// ============================================================
// Pulls public.ezee_addresses from Supabase and rewrites the "Addresses" tab.
// The table is filled daily by scripts/ezee-addresses-sync.mjs on Josh's Mac
// from Ezee's own Activity_Detail report, so every address here is spelled the
// way Ezee spells it. New doors are added every day; old ones are never removed.
//
// INSTALLED Oct 21 2026 as the standalone Apps Script project "Ezee Addresses"
// (script.google.com, josh.wolfer@growmarketing.biz). installTrigger() was run
// once; it refreshes every hour. Re-paste here if the script is ever lost.
// The key below is the public anon key (read-only here); it is the same one
// the dashboard ships in index.html.

var SUPABASE_URL = 'https://cmkfohwbejcztctrpdnt.supabase.co';
var SUPABASE_KEY = 'PASTE_ANON_KEY_FROM_INDEX_HTML';
var SHEET_ID = '1c6OwiQADyL_jnDQQP9L_Eq9tcoRnwHd-Y4db3vRHNFk';   // the Ezee Addresses Sheet (standalone script, not bound)
var TAB = 'Addresses';

var COLS = [
  ['customer_nbr', 'Ezee Customer #'], ['address', 'Address'], ['unit', 'Unit'], ['city', 'City'], ['state', 'State'], ['zip', 'Zip'],
  ['customer_name', 'Customer Name'], ['sold', 'Sold'], ['sold_date', 'Sold Date'], ['sold_rep', 'Sold By'],
  ['first_seen', 'First Knocked'], ['last_seen', 'Last Knocked'], ['knocks', 'Knocks'], ['last_disposition', 'Last Disposition'], ['last_rep', 'Last Rep'],
  ['team', 'Team'], ['area', 'Ezee Area'], ['segment', 'Segment'], ['property_type', 'Property Type']
];

function refreshAddresses() {
  var rows = [], page = 1000;
  for (var off = 0; ; off += page) {
    var url = SUPABASE_URL + '/rest/v1/ezee_addresses?select=' + COLS.map(function (c) { return c[0]; }).join(',') +
      '&order=last_seen.desc,address.asc&limit=' + page + '&offset=' + off;
    var res = UrlFetchApp.fetch(url, { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('Supabase ' + res.getResponseCode() + ': ' + res.getContentText().substring(0, 200));
    var batch = JSON.parse(res.getContentText());
    rows = rows.concat(batch);
    if (batch.length < page) break;
  }
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(TAB) || ss.insertSheet(TAB, 0);
  var values = [COLS.map(function (c) { return c[1]; })].concat(rows.map(function (r) {
    return COLS.map(function (c) { var v = r[c[0]]; return v === null || v === undefined ? '' : (v === true ? 'Yes' : v === false ? '' : v); });
  }));
  sh.clearContents();
  sh.getRange(1, 1, values.length, COLS.length).setValues(values);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, COLS.length).setFontWeight('bold');
  var about = ss.getSheetByName('About') || ss.insertSheet('About');
  about.getRange('A1:B3').setValues([
    ['Updated', new Date()],
    ['Addresses', rows.length],
    ['Source', 'Ezee Activity_Detail report, pulled daily by GrowSales. Spelling is Ezee\'s, use it as-is when matching deals.']
  ]);
  Logger.log('refreshed ' + rows.length + ' addresses');
}

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'refreshAddresses') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('refreshAddresses').timeBased().everyHours(1).create();
  refreshAddresses();
}
