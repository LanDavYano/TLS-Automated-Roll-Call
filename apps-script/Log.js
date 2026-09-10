/**
 * `_log` tab: idempotency ledger (SPEC.md §5) and error trail (SPEC.md §6).
 * Created automatically, hidden from normal view.
 */

const LOG_SHEET_NAME = '_log';

function getLogSheet_() {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    sheet.appendRow(['Timestamp', 'EventKey', 'Status', 'Detail']);
    sheet.hideSheet();
  }
  return sheet;
}

/**
 * §5 — a stable identity for one SENT MESSAGE, used to detect duplicate sends.
 *
 * The unit is the message, not the row, because a session-mode sport posts one
 * roll call covering several rows (§4.5). Keying on the row would let the same
 * fencing day be announced three times.
 *
 * Deliberately excludes the chat and thread: routing is derived from the event,
 * and including the destination would make re-pointing a GC mid-season look like
 * a brand new message and re-announce everything already sent.
 *
 *   session  year|month|day|family|session
 *   event    year|month|day|family|category|opponent-or-detail|time
 *
 * The event-mode discriminator falls back to `detail` because a row without an
 * opponent still needs to be distinguishable from its neighbours — two rows of
 * the same family, category and time would otherwise collide.
 */
function buildGroupKey_(group) {
  if (group.mode === GROUP_MODES.SESSION) {
    return [group.year, group.month, group.day, group.family, 'session'].join('|').toLowerCase();
  }

  const event = group.events[0];
  return [
    group.year, group.month, group.day, group.family,
    event.category, event.opponent || event.detail, event.time,
  ].join('|').toLowerCase();
}

/**
 * The keys this same set of rows would have had under the OTHER mode.
 *
 * Changing a sport's mode mid-season is a supported, one-cell edit — but it
 * changes the shape of the ledger key, so a roll call already sent as a session
 * is invisible to an event-mode lookup and vice versa. Without this, flipping
 * the mode after a send but before the fixture would let a later /rollcall post
 * the same roll call a second time, in the GC, to the staffers.
 */
function buildAlternateModeKeys_(group) {
  if (group.mode === GROUP_MODES.SESSION) {
    return group.events.map((event) => buildGroupKey_({
      year: group.year, month: group.month, day: group.day, family: group.family,
      mode: GROUP_MODES.EVENT, events: [event],
    }));
  }
  return [buildGroupKey_(Object.assign({}, group, { mode: GROUP_MODES.SESSION }))];
}

/**
 * Whether this message already went out — under its own mode, or the other one.
 *
 * Returns {key, sameMode} or null. `sameMode: false` is the interesting case: it
 * means the mode was changed after part of this day was already announced, which
 * the caller reports rather than silently swallowing. Skipping is the safe half
 * of that decision (a duplicate roll call is worse than a late one), but it can
 * leave rows added under the new mode unannounced, so a human is told.
 */
function findPriorSend_(group) {
  const own = buildGroupKey_(group);
  if (hasBeenSent_(own)) return { key: own, sameMode: true };

  const alternates = buildAlternateModeKeys_(group);
  for (let i = 0; i < alternates.length; i++) {
    if (hasBeenSent_(alternates[i])) return { key: alternates[i], sameMode: false };
  }
  return null;
}

/**
 * The `SENT` keys already in the ledger, memoised for this execution.
 *
 * `hasBeenSent_` is asked once per candidate key, and a session group checks its
 * alternate-mode keys too — so a `/scan` across a dozen sports asks the same
 * question dozens of times. Reading the whole tab each time turned that into
 * dozens of round trips against a season's worth of rows, with an operator
 * watching a chat window for the reply; a scan slow enough to look hung is a scan
 * someone types a second time, which is the collision the lock then has to catch.
 *
 * Held for exactly one execution and no longer. Within one, the only writer is
 * `logStatus_`, which appends and updates this set as it goes; an Apps Script
 * global lives one execution, so another run's writes are seen by the next
 * command, and the script lock is what keeps two senders from interleaving.
 */
let sentKeys_ = null;

function loadSentKeys_() {
  if (sentKeys_) return sentKeys_;

  sentKeys_ = {};
  getLogSheet_().getDataRange().getValues().slice(1).forEach((row) => {
    if (row[2] === 'SENT') sentKeys_[row[1]] = true;
  });
  return sentKeys_;
}

function hasBeenSent_(eventKey) {
  return loadSentKeys_()[eventKey] === true;
}

function logStatus_(eventKey, status, detail) {
  getLogSheet_().appendRow([new Date(), eventKey, status, detail || '']);

  // Keep the memo honest within this execution: a scan sends several messages in
  // a row, and the second must see the first's SENT row.
  if (status === 'SENT' && sentKeys_) sentKeys_[eventKey] = true;
}

/** Testing helper: wipe all ledger rows, keeping the header, so a date can be re-sent from scratch. */
function clearLog_() {
  const sheet = getLogSheet_();
  const last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).clearContent();
  sentKeys_ = null;
}
