/**
 * Entry point + build-order test helpers (SPEC.md §9). Each `test...`
 * function corresponds to one row of the build order table and should be
 * run from the Apps Script editor to verify that step before moving on.
 */

/** Real nightly entry point. Bound to the time-driven trigger (step 11). */
function main() {
  try {
    runRollCall_();
  } catch (err) {
    logStatus_('N/A', 'ERROR', String((err && err.stack) || err));
    notifyError_(`⚠️ Roll call bot error: ${(err && err.message) || err}`);
  }
}

function runRollCall_() {
  const config = getConfig();
  sendMatchingEvents_(computeTargetDate_(config), config);
}

/**
 * Shared send loop for a resolved {year, month, day}: parse the month tab,
 * filter to that date, and run each matching event through the real send
 * path (idempotency + Telegram + _log). Used by both the nightly run and
 * the testSend() helper so they behave identically.
 */
function sendMatchingEvents_(targetDate, config) {
  const stafferMap = getStafferMap();
  const monthName = MONTH_NAMES[targetDate.month - 1];

  const events = parseMonthEvents(readMonthRows_(monthName), monthName, config, getSpreadsheetTimeZone_());
  const matching = filterEventsForDate_(events, targetDate);

  Logger.log(
    `${matching.length} event(s) matched for ${targetDate.year}-${targetDate.month}-${targetDate.day} (DRY_RUN=${config.DRY_RUN})`
  );

  matching.forEach((event) => {
    try {
      sendEventRollCall_(event, stafferMap, config);
    } catch (err) {
      // §6 — guard individually so one bad event doesn't kill the whole run.
      logStatus_(buildEventKey_(event), 'ERROR', String(err));
      notifyError_(`⚠️ Roll call bot error (${event.sport || 'event'}, ${event.opponent} vs DLSU): ${err}`);
    }
  });
}

function sendEventRollCall_(event, stafferMap, config) {
  const eventKey = buildEventKey_(event);
  if (hasBeenSent_(eventKey)) {
    logStatus_(eventKey, 'SKIPPED_DUPLICATE');
    Logger.log(`SKIPPED_DUPLICATE: ${eventKey}`);
    return;
  }

  const message = renderMessage_(event, stafferMap, config);

  // A dry run must NOT record SENT — that would poison the idempotency
  // ledger (§5) and make a later real send skip the event as a duplicate.
  // Log a distinct DRY_RUN status, which hasBeenSent_ does not count.
  if (config.DRY_RUN) {
    Logger.log(`[DRY RUN] Would send:\n${message}`);
    logStatus_(eventKey, 'DRY_RUN');
    return;
  }

  sendTelegramMessage_(message, { parseMode: 'HTML' });
  logStatus_(eventKey, 'SENT');
  Logger.log(`SENT: ${eventKey}`);
}

/** §7 — "tomorrow" (or LEAD_DAYS ahead) computed in Asia/Manila, never the runtime default. */
function computeTargetDate_(config) {
  const todayStr = Utilities.formatDate(new Date(), 'Asia/Manila', 'yyyy-MM-dd');
  const [y, m, d] = todayStr.split('-').map((n) => parseInt(n, 10));
  const target = new Date(y, m - 1, d + config.LEAD_DAYS);
  return { year: target.getFullYear(), month: target.getMonth() + 1, day: target.getDate() };
}

function readMonthRows_(monthName) {
  const sheet = getMonthSheet(monthName);
  const lastRow = sheet.getLastRow();
  if (lastRow < FIRST_DATA_ROW) return [];
  return sheet
    .getRange(FIRST_DATA_ROW, 1, lastRow - FIRST_DATA_ROW + 1, sheet.getLastColumn())
    .getValues();
}

/** §11 — daily 7-8 PM Asia/Manila trigger. Run this once by hand to install it. */
function createDailyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'main')
    .forEach((t) => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('main')
    .timeBased()
    .everyDays(1)
    .atHour(19)
    .nearMinute(0)
    .inTimezone('Asia/Manila')
    .create();
}

// ---------------------------------------------------------------------
// Build-order test helpers (SPEC.md §9)
// ---------------------------------------------------------------------
//
// TEST_MONTH/TEST_DATE point at whichever tab currently holds sample game
// data for manual verification in the Apps Script editor. Change these two
// lines (and re-push) to point the test helpers at a different month —
// nothing else below needs to change.

const TEST_MONTH = 'July';
const TEST_DATE = '2026-07-25';

/** Step 1: log first 20 rows of the TEST_MONTH tab as-is. */
function testRead() {
  const sheet = getMonthSheet(TEST_MONTH);
  const range = sheet.getRange(1, 1, 20, sheet.getLastColumn());
  const values = range.getValues();

  values.forEach((row, i) => {
    Logger.log(`Row ${i + 1}: ${JSON.stringify(row)}`);
  });
}

/** Step 2: log parsed Config object and Staffers name->handle map. */
function testConfigAndStaffers() {
  const config = getConfig();
  Logger.log(`Config: ${JSON.stringify(config)}`);

  const staffers = getStafferMap();
  Logger.log(`Staffers: ${JSON.stringify(staffers)}`);
}

/** Step 3: log the resolved (forward-filled) date and venue per row. */
function testDateResolver() {
  const config = getConfig();
  const resolved = resolveRows_(readMonthRows_(TEST_MONTH), TEST_MONTH, config);
  resolved.forEach((r) => Logger.log(`Row ${r.sheetRow}: day=${r.day} venue=${r.venue}`));
}

/**
 * Step 4: log rows matching "tomorrow" (or an arbitrary test date) that also
 * resolve to an identifiable opponent (SPEC.md §3.3 — Game day is not used).
 * Defaults to TEST_DATE since the editor's Run button can't pass arguments —
 * pass an explicit dateString to try another date without editing the code.
 */
function testEventFilter(dateString) {
  dateString = dateString || TEST_DATE;
  const config = getConfig();
  const targetDate = parseTargetDateString_(dateString);
  const monthName = MONTH_NAMES[targetDate.month - 1];
  const events = parseMonthEvents(readMonthRows_(monthName), monthName, config, getSpreadsheetTimeZone_());
  const matching = filterEventsForDate_(events, targetDate);

  Logger.log(`Matched ${matching.length} event(s) for ${dateString}:`);
  matching.forEach((e) => Logger.log(JSON.stringify(e)));
}

/** Step 5: log the sport/opponent split for every TEST_MONTH row, filtered or not. */
function testEventNameParser() {
  const rows = readMonthRows_(TEST_MONTH);
  rows.forEach((row, i) => {
    const parsed = parseEventName_(row[COL.EVENT]);
    Logger.log(
      `Row ${FIRST_DATA_ROW + i}: sport="${parsed.sport}" opponent="${parsed.opponent}" reversed=${parsed.reversed}`
    );
  });
}

/** Step 6: log full event objects (deliverables + resolved staffer handles) for a test date. */
function testFullEventBuild(dateString) {
  dateString = dateString || TEST_DATE;
  const config = getConfig();
  const stafferMap = getStafferMap();
  const targetDate = parseTargetDateString_(dateString);
  const monthName = MONTH_NAMES[targetDate.month - 1];
  const events = parseMonthEvents(readMonthRows_(monthName), monthName, config, getSpreadsheetTimeZone_());
  const matching = filterEventsForDate_(events, targetDate);

  matching.forEach((e) => {
    const withHandles = Object.assign({}, e, {
      recapHandles: resolveStafferHandles_(e.recapNames, stafferMap),
      livetweetHandles: resolveStafferHandles_(e.livetweetNames, stafferMap),
    });
    Logger.log(JSON.stringify(withHandles, null, 2));
  });
}

/** Step 7: log the exact message string(s) that would be sent for a test date. */
function testMessageRender(dateString) {
  dateString = dateString || TEST_DATE;
  const config = getConfig();
  const stafferMap = getStafferMap();
  const targetDate = parseTargetDateString_(dateString);
  const monthName = MONTH_NAMES[targetDate.month - 1];
  const events = parseMonthEvents(readMonthRows_(monthName), monthName, config, getSpreadsheetTimeZone_());
  const matching = filterEventsForDate_(events, targetDate);

  matching.forEach((e) => Logger.log(renderMessage_(e, stafferMap, config)));
}

/**
 * Steps 8-9: run the REAL send path (idempotency check → Telegram → _log)
 * for an explicit date, so the live send and the duplicate-skip can be
 * verified against the fixture tab without waiting for the calendar to
 * reach "tomorrow". Honors DRY_RUN — set it FALSE in the Config tab to
 * actually post. Run once to send; run again to confirm the second run
 * logs SKIPPED_DUPLICATE instead of double-posting.
 */
function testSend(dateString) {
  dateString = dateString || TEST_DATE;
  sendMatchingEvents_(parseTargetDateString_(dateString), getConfig());
}

/** Testing helper: clear the _log ledger so a date can be re-sent from scratch. */
function resetLog() {
  clearLog_();
  Logger.log('_log cleared — every date can now be sent fresh.');
}

/**
 * Step 10: force an exception through the same path a real failure would
 * take, to confirm both the `_log` entry and the Telegram alert arrive.
 */
function testErrorHandling() {
  try {
    throw new Error('Forced test exception from testErrorHandling()');
  } catch (err) {
    logStatus_('TEST', 'ERROR', String(err));
    notifyError_(`⚠️ Roll call bot error: ${err.message}`);
  }
  Logger.log('Forced-error test complete; check the Telegram chat and the _log tab.');
}
