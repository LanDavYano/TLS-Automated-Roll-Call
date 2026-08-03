/**
 * Staffers tab reader (SPEC.md §2.3). Keys are stored lower-cased and
 * trimmed since matching against columns Q/R is case-insensitive and
 * whitespace-trimmed.
 */

function getStafferMap() {
  const sheet = getSpreadsheet_().getSheetByName('Staffers');
  if (!sheet) return {};

  const map = {};
  const rows = sheet.getDataRange().getValues().slice(1); // skip header row
  for (const row of rows) {
    const name = String(row[0] || '').trim();
    const handle = String(row[1] || '').trim();
    if (!name) continue;
    map[name.toLowerCase()] = handle;
  }
  return map;
}
