/**
 * Sheet access helpers.
 */

/**
 * Resolved once per execution. getSpreadsheet_() is called on every tab access —
 * once per Config/Staffers/Groups read and once per idempotency check — and
 * openById is a fetch, unlike the free getActiveSpreadsheet() it replaces. An
 * Apps Script global lives exactly one execution, which is the right lifetime:
 * a mid-run change of the property should never take effect half way through.
 */
let cachedSpreadsheet_ = null;

/**
 * The tracker spreadsheet.
 *
 * SPREADSHEET_ID (Script Properties) decides which one, and takes precedence
 * over the bound container. Set it to a spreadsheet's URL or ID and every
 * context — editor run, nightly trigger, webhook — reads that file instead.
 * That is what lets ONE script project serve a different season's tracker, or
 * last season's for a demo, without copying the code to a second project.
 * Unset, behaviour is exactly as before: the bound container.
 *
 * The override is checked FIRST, deliberately. It began as a fallback for the
 * null getActiveSpreadsheet() a webhook request sees, but a bound script's
 * editor runs and triggers always return the container — so as a fallback it
 * could never actually redirect anything, only rescue the webhook case.
 */
function getSpreadsheet_() {
  if (cachedSpreadsheet_) return cachedSpreadsheet_;

  const target = readSpreadsheetTarget_();
  if (target) {
    const id = extractSpreadsheetId_(target);
    try {
      cachedSpreadsheet_ = SpreadsheetApp.openById(id);
    } catch (err) {
      // Naming both what was set and what it resolved to: the usual cause is a
      // pasted URL whose id came through fine but which this account can't open.
      throw new Error(
        `SPREADSHEET_ID is set to "${target}" (id "${id}") but that spreadsheet ` +
        `could not be opened: ${(err && err.message) || err}. Check the link, and ` +
        'that the account running the script has access to it. Clear the property ' +
        'to go back to reading the sheet this script is bound to.'
      );
    }
    return cachedSpreadsheet_;
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error(
      'No active spreadsheet in this execution context. Set the SPREADSHEET_ID ' +
      'script property to the tracker spreadsheet URL (or ID) so webhook requests ' +
      'can find it.'
    );
  }

  cachedSpreadsheet_ = ss;
  return cachedSpreadsheet_;
}

/** The SPREADSHEET_ID property, trimmed; '' when unset. */
function readSpreadsheetTarget_() {
  return String(
    PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || ''
  ).trim();
}

/**
 * The id out of whatever a human pasted.
 *
 * A successor pointing the bot at next season's tracker has a browser tab open,
 * not an id — so accept the whole URL and dig the id out, rather than making the
 * one annual task depend on selecting the correct 44 characters out of the
 * address bar. A bare id passes through untouched.
 */
function extractSpreadsheetId_(value) {
  const match = String(value).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : String(value).trim();
}

/**
 * Which tracker the bot is reading, for /whereami (§12).
 *
 * A SPREADSHEET_ID left pointing at last season's sheet after a demo is
 * otherwise invisible: the nightly run reads the wrong tabs, finds no games for
 * tomorrow, and posts nothing at all. Naming the file in the one command that
 * reports bot status makes that a five-second check from inside Telegram.
 *
 * Reports how it resolved rather than warning about the override, because with
 * one script serving each season in turn, the override IS the steady state — a
 * permanent warning would just be noise to scroll past.
 */
function describeActiveSpreadsheet_() {
  const redirected = Boolean(readSpreadsheetTarget_());
  try {
    return `${getSpreadsheet_().getName()} (${redirected ? 'via SPREADSHEET_ID' : 'bound sheet'})`;
  } catch (err) {
    return `could not be opened — ${(err && err.message) || err}`;
  }
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
