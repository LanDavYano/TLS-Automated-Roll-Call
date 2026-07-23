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

/**
 * Seed values + human descriptions for the Config tab, used by
 * setupConfigTab() (SPEC.md §2.4). Order here is the row order written.
 * Booleans are written as the strings TRUE/FALSE the tab expects.
 */
const CONFIG_KEY_META = [
  ['SEASON_START_YEAR', 2025, 'Calendar year the season starts (its Sep–Dec year). UPDATE THIS EACH SEASON.'],
  ['SEASON_START_MONTH', 9, 'Month number the season begins (9 = September). Tabs for months >= this belong to SEASON_START_YEAR; earlier months roll to the next year.'],
  ['DRY_RUN', 'TRUE', 'TRUE = log only, never send to Telegram. Set FALSE to go live; set TRUE to pause the bot.'],
  ['LEAD_DAYS', 1, 'How many days ahead to look. 1 = announce tomorrow\'s games in tonight\'s run.'],
  ['SHOW_UNASSIGNED_WARNING', 'TRUE', 'TRUE = show a "UNASSIGNED" warning line when the Recap or Livetweet staffer cell is blank.'],
];

/**
 * One-time setup helper: populate the Config tab with every key and a
 * description column for a successor. Creates the tab if missing and only
 * ADDS keys that aren't already present — existing values (e.g. a DRY_RUN
 * you've already set) are never overwritten. Safe to re-run.
 */
function setupConfigTab() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('Config');
  if (!sheet) sheet = ss.insertSheet('Config');

  const firstRow = sheet.getRange(1, 1, 1, 3).getValues()[0];
  if (String(firstRow[0]).trim().toLowerCase() !== 'key') {
    sheet.getRange(1, 1, 1, 3).setValues([['Key', 'Value', 'Description']]).setFontWeight('bold');
  } else if (String(firstRow[2]).trim() === '') {
    sheet.getRange(1, 3).setValue('Description').setFontWeight('bold');
  }

  const existing = {};
  sheet.getDataRange().getValues().slice(1).forEach((row) => {
    const key = String(row[0] || '').trim().toLowerCase();
    if (key) existing[key] = true;
  });

  const added = [];
  CONFIG_KEY_META.forEach(([key, value, description]) => {
    if (!existing[key.toLowerCase()]) {
      sheet.appendRow([key, value, description]);
      added.push(key);
    }
  });

  sheet.autoResizeColumns(1, 3);
  Logger.log(
    added.length
      ? `Config tab: added missing key(s): ${added.join(', ')}`
      : 'Config tab already has every key; nothing changed.'
  );
}

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
