/**
 * Sheet access helpers.
 */

/**
 * The tracker spreadsheet.
 *
 * Normally this is the bound container. But a webhook request (doPost) runs in
 * a different execution context than an editor run or a time-driven trigger,
 * and getActiveSpreadsheet() is only *guaranteed* for the bound ones.
 * SPREADSHEET_ID is the escape hatch: set it in Script Properties and every
 * context resolves the same spreadsheet. Unset, behaviour is exactly as before.
 */
function getSpreadsheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) return ss;

  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) {
    throw new Error(
      'No active spreadsheet in this execution context. Set the SPREADSHEET_ID ' +
      'script property to the tracker spreadsheet ID so webhook requests can find it.'
    );
  }
  return SpreadsheetApp.openById(id);
}

function getMonthSheet(monthName) {
  const sheet = getSpreadsheet_().getSheetByName(monthName);
  if (!sheet) throw new Error(`Sheet not found: ${monthName}`);
  return sheet;
}

/**
 * The spreadsheet's own timezone — the reference frame in which time-only
 * cells were stored. parseTime_ needs this (not the script timezone) to
 * format times without the 1899-epoch skew.
 */
function getSpreadsheetTimeZone_() {
  return getSpreadsheet_().getSpreadsheetTimeZone();
}

/** Data rows (row 5 onward, §2.1) of an already-resolved month sheet. */
function readSheetRows_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < FIRST_DATA_ROW) return [];
  return sheet
    .getRange(FIRST_DATA_ROW, 1, lastRow - FIRST_DATA_ROW + 1, sheet.getLastColumn())
    .getValues();
}
