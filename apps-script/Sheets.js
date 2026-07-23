/**
 * Sheet access helpers.
 */

function getMonthSheet(monthName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(monthName);
  if (!sheet) throw new Error(`Sheet not found: ${monthName}`);
  return sheet;
}
