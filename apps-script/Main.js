/**
 * Build order step 1 (SPEC.md §9): log the first 20 rows of the September
 * tab as-is, to see how Sheets typed each cell before any parsing is written.
 */
function testRead() {
  const sheet = getMonthSheet('September');
  const range = sheet.getRange(1, 1, 20, sheet.getLastColumn());
  const values = range.getValues();

  values.forEach((row, i) => {
    Logger.log(`Row ${i + 1}: ${JSON.stringify(row)}`);
  });
}

/**
 * Build order step 2 (SPEC.md §9): log the parsed Config object and the
 * Staffers name->handle map.
 */
function testConfigAndStaffers() {
  const config = getConfig();
  Logger.log(`Config: ${JSON.stringify(config)}`);

  const staffers = getStafferMap();
  Logger.log(`Staffers: ${JSON.stringify(staffers)}`);
}
