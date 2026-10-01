/**
 * ONE-TIME BACKFILL — historical Time_Track_Highlight emails
 * ----------------------------------------------------------
 * PASTE AT THE BOTTOM OF THE SAME APPS SCRIPT PROJECT as the daily importer.
 * Reuses its CONFIG and its appendRows_ / fmtDate_ / fmtTime_ / notify_ /
 * getOrCreateLabel_ helpers, so the daily job is unaffected.
 *
 * SETUP (once): Editor -> Services (+) -> add BOTH "Drive API" and "Gmail API".
 * RUN: pick backfillTimeTrackHistory in the function dropdown, press Run.
 *      Re-run until the summary email says "0 emails remaining".
 *
 * Same criteria as the daily importer — Robert Sentipal, however many sections
 * he has that week, whole roster, same RAW DATA layout, Hours Worked formula
 * dragged down — but it sweeps ALL history and keeps only rows dated Apr 1 2026
 * and earlier (live data starts Apr 2, so there is no overlap).
 *
 * Handles both email formats: the newer ones with the .xlsx attached directly,
 * and the older ones (before ~2/22) where it's nested inside the forwarded
 * message. Safe to re-run: it checks rep+date against the sheet and never
 * appends a duplicate.
 */
const BACKFILL = {
  SEARCH: 'subject:"Time_Track_Highlight was executed" has:attachment before:2026/04/11',
  LABEL: 'TTH-Backfilled',
  CUTOFF: new Date(2026, 3, 2),   // keep Date Worked strictly before Apr 2 2026 -> Apr 1 and earlier
  TIME_BUDGET_MS: 5 * 60 * 1000   // stop cleanly before the 6-minute execution cap
};

function backfillTimeTrackHistory() {
  const t0 = Date.now();
  const log = [];
  let appended = 0, processed = 0, remaining = 0;
  try {
    const dest = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName(CONFIG.TAB_NAME);
    if (!dest) throw new Error('Tab "' + CONFIG.TAB_NAME + '" not found in the destination sheet.');

    const seen = existingRepDateKeys_(dest);   // rep+date already in the sheet -> never re-add
    const label = getOrCreateLabel_(BACKFILL.LABEL);
    const threads = GmailApp.search(BACKFILL.SEARCH + ' -label:' + BACKFILL.LABEL);
    remaining = threads.length;

    for (let i = 0; i < threads.length; i++) {
      if (Date.now() - t0 > BACKFILL.TIME_BUDGET_MS) {
        log.push('Stopped early at the time limit — re-run to continue.');
        break;
      }
      const thread = threads[i];
      let appendedThis = false;
      thread.getMessages().forEach(function (msg) {
        getXlsxBlobs_(msg).forEach(function (blob) {   // finds the xlsx even nested in a forwarded email
          const rows = parseBackfill_(blob);            // Sentipal rows dated <= Apr 1
          const fresh = rows.filter(function (r) {
            const key = String(r[0]).trim() + '|' + String(r[3]).trim();   // rep | M/d/yyyy
            if (seen[key]) return false;                // already in the sheet or an earlier email
            seen[key] = true;
            return true;
          });
          if (fresh.length) {
            appendRows_(dest, fresh);                   // same append + Hours-formula drag as daily
            appended += fresh.length;
            appendedThis = true;
            log.push('Appended ' + fresh.length + ' rows from ' + blob.getName());
            Logger.log(log[log.length - 1]);
          }
        });
      });
      if (appendedThis) thread.addLabel(label);   // only mark done if rows actually came out
      processed++;
      remaining--;
    }

    notify_('Time_Track BACKFILL: ' + appended + ' rows added (' + remaining + ' emails remaining)',
      'Historical backfill run complete.\n\n' +
      'Rows appended this run: ' + appended + '\n' +
      'Emails processed this run: ' + processed + '\n' +
      'Emails still to process: ' + remaining + '\n\n' +
      (remaining > 0
        ? 'Run backfillTimeTrackHistory again to keep going.\n\n'
        : 'Backfill finished — every historical email has been processed.\n\n') +
      (log.length ? log.join('\n') : 'No new rows in this batch.'));
    return appended;
  } catch (err) {
    notify_('Time_Track BACKFILL: FAILED',
      'The backfill stopped with an error. Nothing was left half-written for the failing file.\n\n' +
      'Error: ' + err.message + '\n\n' +
      (log.length ? 'Progress before it failed:\n' + log.join('\n') : 'It failed before appending anything.'));
    throw err;
  }
}

/** Every .xlsx on a message — attached directly (newer emails) or nested inside the forward (older). */
function getXlsxBlobs_(msg) {
  const direct = msg.getAttachments().filter(function (a) { return /\.xlsx$/i.test(a.getName()); });
  if (direct.length) return direct.map(function (a) { return a.copyBlob(); });

  // Older format: the report sits inside the forwarded message. Walk the full
  // MIME tree with the Gmail Advanced Service and pull the nested .xlsx.
  const ids = [];
  findXlsxAttachmentIds_(Gmail.Users.Messages.get('me', msg.getId(), { format: 'full' }).payload, ids);
  return ids.map(function (attId) {
    const att = Gmail.Users.Messages.Attachments.get('me', msg.getId(), attId);
    return Utilities.newBlob(
      Utilities.base64DecodeWebSafe(att.data),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'report.xlsx'
    );
  });
}

/** Recurse the Gmail part tree, collecting attachmentIds of any .xlsx part. */
function findXlsxAttachmentIds_(part, out) {
  if (!part) return;
  if (/\.xlsx$/i.test(part.filename || '') && part.body && part.body.attachmentId) {
    out.push(part.body.attachmentId);
  }
  if (part.parts) part.parts.forEach(function (p) { findXlsxAttachmentIds_(p, out); });
}

/** rep+date keys ("Name|M/d/yyyy") already present in the RAW DATA tab. */
function existingRepDateKeys_(sheet) {
  const seen = {};
  const values = sheet.getDataRange().getValues();
  for (let i = 0; i < values.length; i++) {
    const rep = String(values[i][0] || '').trim();     // col A = Rep
    const dateCell = values[i][3];                      // col D = Date Worked
    if (!rep || dateCell === '' || dateCell === null) continue;
    seen[rep + '|' + dateKey_(dateCell)] = true;
  }
  return seen;
}

/** Normalize a sheet date cell (string or Date) to the "M/d/yyyy" the rows use. */
function dateKey_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v)) {
    return Utilities.formatDate(v, CONFIG.REPORT_TZ, 'M/d/yyyy');
  }
  return String(v).trim();
}

/** Convert the .xlsx to a temp Google Sheet, extract the backfill rows, delete temp. */
function parseBackfill_(xlsxBlob) {
  const temp = Drive.Files.create(
    { name: 'TMP_TTH_BF_' + Date.now(), mimeType: MimeType.GOOGLE_SHEETS },
    xlsxBlob
  );
  try {
    const ss = SpreadsheetApp.openById(temp.id);
    ss.setSpreadsheetTimeZone(CONFIG.REPORT_TZ);
    return extractBackfillRows_(ss.getSheets()[0].getDataRange().getValues());
  } finally {
    Drive.Files.remove(temp.id);
  }
}

/**
 * Same supervisor walk as the daily extractor (tracks the Supervisor column,
 * keeps only CONFIG.SUPERVISOR, however many sections he has, columns located by
 * header name), with two differences for the one-time fill: it DROPS no-activity
 * (blank Date Worked) roster rows, and keeps only rows whose Date Worked is
 * strictly before BACKFILL.CUTOFF (Apr 2 2026).
 */
function extractBackfillRows_(data) {
  let hdr = -1;
  for (let i = 0; i < data.length; i++) {
    const r = data[i].map(String);
    if (r.indexOf('Supervisor') > -1 && r.indexOf('Rep') > -1) { hdr = i; break; }
  }
  if (hdr === -1) throw new Error('Header row (Supervisor/Rep) not found — report format may have changed.');

  const H = data[hdr].map(function (v) { return String(v).trim(); });
  const idx = function (name) { return H.indexOf(name); };
  const c = {
    sup:   idx('Supervisor'),
    rep:   idx('Rep'),
    date:  idx('Date Worked'),
    doors: idx('Doors Knocked'),
    uniq:  idx('Unique Doors Knocked'),
    cont:  idx('Contacts'),
    sold:  idx('Sold'),
    first: idx('First Disposition'),
    last:  idx('Last Disposition')
  };
  Object.keys(c).forEach(function (k) {
    if (c[k] < 0) throw new Error('Expected column "' + k + '" missing from report header.');
  });

  const out = [];
  let currentSup = '';
  for (let i = hdr + 1; i < data.length; i++) {
    const row = data[i];
    const sup = String(row[c.sup]).trim();
    if (sup && sup !== 'Supervisor') currentSup = sup;

    const rep = String(row[c.rep]).trim();
    if (!rep || rep === 'Total' || rep === 'Average') continue;
    if (currentSup !== CONFIG.SUPERVISOR) continue;

    const d = toDate_(row[c.date]);
    if (!d || d >= BACKFILL.CUTOFF) continue;   // skip no-activity rows and anything Apr 2 or later

    out.push([
      rep, '', '',
      fmtDate_(row[c.date]),
      row[c.doors], row[c.uniq], '',
      row[c.cont], row[c.sold],
      fmtTime_(row[c.first]), '',
      fmtTime_(row[c.last]),
      ''  // Hours Worked left blank; appendRows_ drags the formula down
    ]);
  }
  return out;
}

/** Coerce a Date Worked cell (Date or "M/d/yyyy" string) to a Date, or null. */
function toDate_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v)) return v;
  const m = String(v).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? new Date(+m[3], +m[1] - 1, +m[2]) : null;
}
