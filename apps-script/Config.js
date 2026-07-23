/**
 * Config tab reader (SPEC.md §2.4). Falls back to sensible defaults so a
 * missing tab or missing row never crashes the script.
 */

const CONFIG_DEFAULTS = {
  SEASON_START_YEAR: 2025,
  SEASON_START_MONTH: 9,
  DRY_RUN: true,
  LEAD_DAYS: 1,
  SHOW_UNASSIGNED_WARNING: true,
};

function getConfig() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Config');
  if (!sheet) return Object.assign({}, CONFIG_DEFAULTS);

  const raw = {};
  const rows = sheet.getDataRange().getValues().slice(1); // skip header row
  for (const row of rows) {
    const key = String(row[0] || '').trim();
    if (!key) continue;
    raw[key] = row[1];
  }

  return {
    SEASON_START_YEAR: toInt_(raw.SEASON_START_YEAR, CONFIG_DEFAULTS.SEASON_START_YEAR),
    SEASON_START_MONTH: toInt_(raw.SEASON_START_MONTH, CONFIG_DEFAULTS.SEASON_START_MONTH),
    DRY_RUN: toBool_(raw.DRY_RUN, CONFIG_DEFAULTS.DRY_RUN),
    LEAD_DAYS: toInt_(raw.LEAD_DAYS, CONFIG_DEFAULTS.LEAD_DAYS),
    SHOW_UNASSIGNED_WARNING: toBool_(raw.SHOW_UNASSIGNED_WARNING, CONFIG_DEFAULTS.SHOW_UNASSIGNED_WARNING),
  };
}

function toInt_(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
}

function toBool_(value, fallback) {
  if (value === '' || value === null || value === undefined) return fallback;
  const s = String(value).trim().toUpperCase();
  if (s === 'TRUE') return true;
  if (s === 'FALSE') return false;
  return fallback;
}
