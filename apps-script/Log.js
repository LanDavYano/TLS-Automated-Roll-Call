/**
 * `_log` tab: idempotency ledger (SPEC.md §5) and error trail (SPEC.md §6).
 * Created automatically, hidden from normal view.
 */

const LOG_SHEET_NAME = '_log';

function getLogSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    sheet.appendRow(['Timestamp', 'EventKey', 'Status', 'Detail']);
    sheet.hideSheet();
  }
  return sheet;
}

/** §5 — a stable identity for an event, used to detect duplicate sends. */
function buildEventKey_(event) {
  return [event.year, event.month, event.day, event.sport, event.opponent, event.time]
    .join('|')
    .toLowerCase();
}

function hasBeenSent_(eventKey) {
  const sheet = getLogSheet_();
  const rows = sheet.getDataRange().getValues().slice(1);
  return rows.some((row) => row[1] === eventKey && row[2] === 'SENT');
}

function logStatus_(eventKey, status, detail) {
  const sheet = getLogSheet_();
  sheet.appendRow([new Date(), eventKey, status, detail || '']);
}

/** Testing helper: wipe all ledger rows, keeping the header, so a date can be re-sent from scratch. */
function clearLog_() {
  const sheet = getLogSheet_();
  const last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).clearContent();
}
