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
 * filter to that date, collate the events into messages (§4.5), and run each
 * one through the real send path (idempotency + Telegram + _log). Used by both
 * the nightly run and the testSend() helper so they behave identically.
 *
 * Returns one outcome per MESSAGE, not per row — a session-mode sport posts one
 * roll call covering several rows. reportRun_ turns these into the admin summary.
 */
function sendMatchingEvents_(targetDate, config) {
  const stafferMap = getStafferMap();
  const groupMap = getGroupMap();
  const adminChatId = getAdminChatId_();
  const monthName = MONTH_NAMES[targetDate.month - 1];

  const events = parseMonthEvents(readMonthRows_(monthName), monthName, config, getSpreadsheetTimeZone_());
  const matching = filterEventsForDate_(events, targetDate);
  const groups = groupEventsForSending_(matching, groupMap, adminChatId);

  Logger.log(
    `${matching.length} event(s) → ${groups.length} message(s) for ` +
    `${targetDate.year}-${targetDate.month}-${targetDate.day} (DRY_RUN=${config.DRY_RUN})`
  );

  const outcomes = [];
  groups.forEach((group) => {
    try {
      outcomes.push(sendGroupRollCall_(group, stafferMap, config));
    } catch (err) {
      // §6 — guard individually so one bad message doesn't kill the whole run.
      logStatus_(buildGroupKey_(group), 'ERROR', String(err));
      notifyError_(`⚠️ Roll call bot error (${describeGroup_(group)}): ${err}`);
      outcomes.push({ group, status: 'ERROR', matched: false, detail: String(err), unassigned: [] });
    }
  });

  reportRun_(targetDate, outcomes, config);
  return outcomes;
}

function sendGroupRollCall_(group, stafferMap, config) {
  // Assignment is judged across the whole message: one staffer named on any row
  // of a fencing day covers that day's roll call, and warning otherwise would
  // cry wolf on every session that lists its staffers on the first row only.
  const unassigned = [];
  if (!unionStafferNames_(group.events, 'recapNames').length) unassigned.push('Recap');
  if (!unionStafferNames_(group.events, 'livetweetNames').length) unassigned.push('Livetweet');

  const groupKey = buildGroupKey_(group);
  const prior = findPriorSend_(group);
  if (prior) {
    const status = prior.sameMode ? 'SKIPPED_DUPLICATE' : 'SKIPPED_MODE_CHANGED';
    logStatus_(groupKey, status, prior.sameMode ? '' : `already sent under the other mode as ${prior.key}`);
    Logger.log(`${status}: ${groupKey}`);
    return { group, status, matched: true, dest: '', unassigned: [], detail: prior.key };
  }

  // Routing already happened in groupEventsForSending_ — it has to, since the
  // rule's mode is what decides whether these rows are one message or several.
  const target = group.target;
  let message = renderDigest_(group, stafferMap, config);
  if (!target.matched) {
    message += `\n\n(⚠️ No Groups mapping for "${group.events[0].rawName}" — posted to the admin chat. Run /rollsetup in the right GC, or add a row in the Groups tab.)`;
  }
  const dest = target.chatId + (target.threadId ? '/' + target.threadId : '');

  // A dry run must NOT record SENT — that would poison the idempotency
  // ledger (§5) and make a later real send skip the message as a duplicate.
  // Log a distinct DRY_RUN status, which hasBeenSent_ does not count.
  if (config.DRY_RUN) {
    Logger.log(`[DRY RUN] → ${dest} (matched=${target.matched})\n${message}`);
    logStatus_(groupKey, 'DRY_RUN', dest);
    return { group, status: 'DRY_RUN', matched: target.matched, dest, unassigned };
  }

  sendTelegramMessage_(message, { parseMode: 'HTML', chatId: target.chatId, threadId: target.threadId });
  logStatus_(groupKey, 'SENT', dest);
  Logger.log(`SENT: ${groupKey} → ${dest}`);
  return { group, status: 'SENT', matched: target.matched, dest, unassigned };
}

/**
 * §6.1 — post-run report to the admin chat.
 *
 * Defaults to ATTENTION: silent on a clean night, so a message arriving means
 * something rather than becoming one more notification to swipe away. The
 * things worth waking someone for are a sport with no GC (its roll call went to
 * the admin chat instead of the staffers), a blank staffer cell (nobody is
 * assigned to a game tomorrow), and an event that failed outright.
 */
function reportRun_(targetDate, outcomes, config) {
  const mode = config.SUMMARY_MODE || 'ATTENTION';
  if (mode === 'NEVER') return;

  const problems = [];
  outcomes.forEach((o) => {
    const who = describeGroup_(o.group);
    if (o.status === 'ERROR') problems.push(`• ${who}: FAILED — ${o.detail}`);
    else if (o.status === 'SKIPPED_MODE_CHANGED') {
      problems.push(
        `• ${who}: nothing sent — this sport's mode changed after part of this day was already announced. ` +
        'Check the GC, then /rollcall force if the roll call is genuinely missing.'
      );
    } else if (!o.matched) problems.push(`• ${who}: no GC mapped — went to this chat instead. Run /rollsetup in its GC.`);
    if (o.unassigned.length) problems.push(`• ${who}: ${o.unassigned.join(' and ')} unassigned in the tracker`);
  });

  if (mode === 'ATTENTION' && !problems.length) return;

  const dateLabel = `${MONTH_NAMES[targetDate.month - 1]} ${targetDate.day}`;
  const lines = [`Roll call run for ${dateLabel}: ${outcomes.length} message(s).`];

  if (config.DRY_RUN) lines.push('DRY_RUN is TRUE — nothing was actually sent.');

  outcomes.forEach((o) => {
    lines.push(`${statusIcon_(o.status)} ${describeGroup_(o.group)} → ${o.dest || 'n/a'}`);
  });

  if (problems.length) lines.push('', 'Needs a human:', ...problems);

  notifyAdmin_(lines.join('\n'));
}

function statusIcon_(status) {
  if (status === 'SENT') return '✅';
  if (status === 'SKIPPED_DUPLICATE') return '⏭️';
  if (status === 'SKIPPED_MODE_CHANGED') return '⚠️';
  if (status === 'DRY_RUN') return '🌵';
  return '❌';
}

/** §7 — "tomorrow" (or LEAD_DAYS ahead) computed in Asia/Manila, never the runtime default. */
function computeTargetDate_(config) {
  const today = todayInManila_();
  const target = new Date(today.year, today.month - 1, today.day + config.LEAD_DAYS);
  return { year: target.getFullYear(), month: target.getMonth() + 1, day: target.getDate() };
}

function readMonthRows_(monthName) {
  return readSheetRows_(getMonthSheet(monthName));
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

/** Verification helper: log every installed project trigger. */
function listTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  Logger.log(`${triggers.length} trigger(s) installed:`);
  triggers.forEach((t) => {
    Logger.log(`- handler=${t.getHandlerFunction()} eventType=${t.getEventType()} source=${t.getTriggerSource()}`);
  });
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

/**
 * Step 5: log the name split for every TEST_MONTH row, filtered or not.
 *
 * `family` is the one to check when a roll call collates wrongly: rows that
 * should share a message must show the same family, and rows that shouldn't —
 * Basketball vs 3x3 Basketball, Chess vs Blitz Chess — must differ.
 */
function testEventNameParser() {
  const rows = readMonthRows_(TEST_MONTH);
  rows.forEach((row, i) => {
    const p = parseEventName_(row[COL.EVENT]);
    Logger.log(
      `Row ${FIRST_DATA_ROW + i}: family="${p.family}" category="${p.category}" ` +
      `opponent="${p.hasOpponent ? p.opponent : '(none)'}" detail="${p.detail}"`
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

/**
 * Step 7: log the exact message string(s) that would be sent for a test date.
 * One entry per MESSAGE, so this is also how you confirm a session-mode sport
 * really is collating into a single roll call.
 */
function testMessageRender(dateString) {
  dateString = dateString || TEST_DATE;
  const config = getConfig();
  const stafferMap = getStafferMap();

  groupsForDate_(dateString, config).forEach((g) => {
    Logger.log(`--- ${describeGroup_(g)} (${g.mode}, ${g.events.length} row(s)) ---`);
    Logger.log(renderDigest_(g, stafferMap, config));
  });
}

/**
 * Verify per-sport routing and collation for a date WITHOUT sending: logs the
 * group + topic each message would post to, its mode, and which rows it covers.
 */
function testRouting(dateString) {
  dateString = dateString || TEST_DATE;

  groupsForDate_(dateString, getConfig()).forEach((g) => {
    const t = g.target;
    Logger.log(
      `${g.family || '(no family)'} [${g.mode}] ${g.events.length} row(s) → ` +
      `chatId=${t.chatId} threadId=${t.threadId || '(none)'} matched=${t.matched} rule=${t.label || '-'}`
    );
    g.events.forEach((e) => Logger.log(`    row ${e.sheetRow}: ${describeEvent_(e)}`));
  });
}

/** Shared by the render/routing helpers: the messages a date would produce. */
function groupsForDate_(dateString, config) {
  const targetDate = parseTargetDateString_(dateString);
  const monthName = MONTH_NAMES[targetDate.month - 1];
  const events = parseMonthEvents(readMonthRows_(monthName), monthName, config, getSpreadsheetTimeZone_());

  return groupEventsForSending_(
    filterEventsForDate_(events, targetDate),
    getGroupMap(),
    getAdminChatId_()
  );
}

// ---------------------------------------------------------------------
// Command-layer helpers (SPEC.md §12) — verify without Telegram
// ---------------------------------------------------------------------

/** A group title to exercise the /rollsetup guesser with from the editor. */
const TEST_GROUP_TITLE = 'UAAP 88 Football GC';

/**
 * What /rollsetup would infer for a group title, and why. Run this before adding
 * the bot to a new GC if you want to know in advance whether the name is
 * guessable — a title it can't read is the one case /rollsetup needs an argument.
 */
function testSetupGuess(title) {
  title = title || TEST_GROUP_TITLE;
  const sports = collectSeasonSports_(getConfig());

  Logger.log(`Title: "${title}"`);
  Logger.log(`Candidates (longest first): ${sportCandidatesFromTitle_(title).join(' | ') || '(none)'}`);

  const guess = guessSportKeyword_(title, sports);
  if (!guess) {
    Logger.log('No match — /rollsetup would ask for an explicit keyword. Sports in the tracker:');
    sports.forEach((s) => Logger.log(`  ${s.sport} (${s.upcoming} upcoming)`));
    return;
  }

  Logger.log(`Keyword: "${guess.keyword}" → matches ${guess.matchedSports.length} sport(s): ${guess.matchedSports.join(', ')}`);
}

/** What /next would find for a keyword, across every month tab. */
function testUpcoming(keyword) {
  keyword = keyword || 'basketball';
  const config = getConfig();

  Logger.log(`Month tabs in season order: ${listSeasonMonths_(config).map((m) => `${m.name} ${m.year}`).join(', ')}`);

  const events = findUpcomingEvents_(config, todayInManila_(), (e) => sportMatchesKeyword_(e.sport, keyword), 5);
  if (!events.length) {
    Logger.log(`No upcoming events matching "${keyword}".`);
    return;
  }
  events.forEach((e) => Logger.log(`${formatEventDate_(e)} — ${describeEvent_(e)}, ${e.time}`));
}

/** Season coverage: which sports exist in the tracker, and which have no GC. */
function testCoverage() {
  const config = getConfig();
  const map = getGroupMap();

  Logger.log(`${map.length} active mapping(s):`);
  map.forEach((g) => Logger.log(`  ${g.label} → ${g.chatId}${g.threadId ? '/' + g.threadId : ''} (${g.title || 'no title recorded'})`));

  collectSeasonSports_(config).forEach((s) => {
    const hit = map.find((g) => sportMatchesKeyword_(s.sport, g.keyword));
    Logger.log(`  ${hit ? '✅' : '❌'} ${s.sport} — ${s.upcoming} upcoming${hit ? ` → ${hit.label}` : ' (NO GC)'}`);
  });
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
