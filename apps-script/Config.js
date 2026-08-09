/**
 * Config tab reader (SPEC.md §2.4). Falls back to sensible defaults so a
 * missing tab or missing row never crashes the script.
 */

const CONFIG_DEFAULTS = {
  SEASON_NUMBER: 88,
  SEASON_START_YEAR: 2025,
  SEASON_START_MONTH: 9,
  DRY_RUN: true,
  LEAD_DAYS: 1,
  SHOW_UNASSIGNED_WARNING: true,
  SUMMARY_MODE: 'ATTENTION',
  // 0-indexed, so 1 = column B: the Date block's position on every tracker
  // built for this bot so far. A sheet without the decorative column A sets
  // DATA_START_COLUMN to A. See LAYOUT in Parser.js.
  DATA_START_COLUMN: 1,
};

/** Recognised SUMMARY_MODE values (§6.1). Anything else falls back to ATTENTION. */
const SUMMARY_MODES = ['ATTENTION', 'ALWAYS', 'NEVER'];

/**
 * Seed values + human descriptions for the Config tab, used by
 * setupConfigTab() (SPEC.md §2.4). Order here is the row order written.
 * Booleans are written as the strings TRUE/FALSE the tab expects.
 */
const CONFIG_KEY_META = [
  ['SEASON_NUMBER', 88, 'UAAP season number, used in every roll call\'s title line ("UAAP Season 88 Fencing Tournament"). UPDATE THIS EACH SEASON.'],
  ['SEASON_START_YEAR', 2025, 'Calendar year the season starts (its Sep–Dec year). UPDATE THIS EACH SEASON.'],
  ['SEASON_START_MONTH', 9, 'Month number the season begins (9 = September). Tabs for months >= this belong to SEASON_START_YEAR; earlier months roll to the next year.'],
  ['DRY_RUN', 'TRUE', 'TRUE = log only, never send to Telegram. Set FALSE to go live; set TRUE to pause the bot.'],
  ['LEAD_DAYS', 1, 'How many days ahead to look. 1 = announce tomorrow\'s games in tonight\'s run.'],
  ['SHOW_UNASSIGNED_WARNING', 'TRUE', 'TRUE = show a "UNASSIGNED" warning line when the Recap or Livetweet staffer cell is blank.'],
  ['SUMMARY_MODE', 'ATTENTION', 'Nightly report to the admin chat. ATTENTION = only when something needs a human (unmapped sport, unassigned staffer, error). ALWAYS = every night. NEVER = errors only.'],
  ['DATA_START_COLUMN', 'B', 'Column letter where the Date block starts on the month tabs — the column holding the day number. B on trackers with a narrow spacer column in A; A on trackers without one. Everything else (Event, Venue, deliverables, staffers) is found relative to it, so this one letter describes the whole layout. Run testLayout() after changing it.'],
];

/**
 * One-time setup helper: populate the Config tab with every key and a
 * description column for a successor. Creates the tab if missing and only
 * ADDS keys that aren't already present — existing values (e.g. a DRY_RUN
 * you've already set) are never overwritten. Safe to re-run.
 *
 * Goes through getSpreadsheet_() like every other tab access, so that setting
 * up a newly pointed-at tracker writes into THAT spreadsheet. Reaching for the
 * container directly would seed the Config tab of the sheet the script happens
 * to be bound to — the one place the difference is silent and wrong.
 */
function setupConfigTab() {
  const ss = getSpreadsheet_();
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
  const sheet = getSpreadsheet_().getSheetByName('Config');
  if (!sheet) return Object.assign({}, CONFIG_DEFAULTS);

  const raw = {};
  const rows = sheet.getDataRange().getValues().slice(1); // skip header row
  for (const row of rows) {
    const key = String(row[0] || '').trim();
    if (!key) continue;
    raw[key] = row[1];
  }

  return {
    SEASON_NUMBER: toInt_(raw.SEASON_NUMBER, CONFIG_DEFAULTS.SEASON_NUMBER),
    SEASON_START_YEAR: toInt_(raw.SEASON_START_YEAR, CONFIG_DEFAULTS.SEASON_START_YEAR),
    SEASON_START_MONTH: toInt_(raw.SEASON_START_MONTH, CONFIG_DEFAULTS.SEASON_START_MONTH),
    DRY_RUN: toBool_(raw.DRY_RUN, CONFIG_DEFAULTS.DRY_RUN),
    LEAD_DAYS: toInt_(raw.LEAD_DAYS, CONFIG_DEFAULTS.LEAD_DAYS),
    SHOW_UNASSIGNED_WARNING: toBool_(raw.SHOW_UNASSIGNED_WARNING, CONFIG_DEFAULTS.SHOW_UNASSIGNED_WARNING),
    SUMMARY_MODE: toEnum_(raw.SUMMARY_MODE, SUMMARY_MODES, CONFIG_DEFAULTS.SUMMARY_MODE),
    DATA_START_COLUMN: toColumnIndex_(raw.DATA_START_COLUMN, CONFIG_DEFAULTS.DATA_START_COLUMN),
  };
}

/**
 * A column letter from the Config tab ("B") as a 0-indexed column number.
 *
 * A letter, not a number, because the person setting this is looking at the
 * column headers in their own spreadsheet — "the day number is in column B" is
 * a fact they can read off the screen, where "1" would ask them to know the
 * indexing is zero-based. A bare number is still accepted and read the way a
 * spreadsheet numbers columns (1 = A), since that's the other thing someone
 * might reasonably type.
 */
function toColumnIndex_(value, fallback) {
  const s = String(value == null ? '' : value).trim().toUpperCase();
  if (s === '') return fallback;

  if (/^[A-Z]+$/.test(s)) {
    let n = 0;
    for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
    return n - 1;
  }

  const n = parseInt(s, 10);
  return Number.isNaN(n) || n < 1 ? fallback : n - 1;
}

/** Inverse of toColumnIndex_: 1 → "B". Used by the diagnostics that name a column. */
function columnLetter_(index) {
  let n = Number(index) + 1;
  let letters = '';
  while (n > 0) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters || '?';
}

/** Uppercased match against an allowed list; a typo falls back rather than crashing. */
function toEnum_(value, allowed, fallback) {
  const s = String(value == null ? '' : value).trim().toUpperCase();
  return allowed.indexOf(s) === -1 ? fallback : s;
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
