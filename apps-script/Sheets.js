/**
 * Sheet access helpers.
 */

function getMonthSheet(monthName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(monthName);
  if (!sheet) throw new Error(`Sheet not found: ${monthName}`);
  return sheet;
}

/**
 * The spreadsheet's own timezone — the reference frame in which time-only
 * cells were stored. parseTime_ needs this (not the script timezone) to
 * format times without the 1899-epoch skew.
 */
function getSpreadsheetTimeZone_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
}
