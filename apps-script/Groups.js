/**
 * Groups tab: maps each sport to the Telegram group + topic its roll call is
 * sent to (SPEC.md §4.4). Columns:
 *   A  Sport keyword   matched (case-insensitive) against the event's sport
 *   B  Chat ID         the group's chat id (same for every topic in a group)
 *   C  Thread ID       the Roll Call topic's message_thread_id (blank = no topic)
 *   D  Notes           free text for humans; ignored by the script
 *   E  Group title     the GC's name as Telegram reported it at /setup time
 *   F  Last updated    when /setup last wrote this row
 *   G  Active          FALSE retires a row without deleting it; blank = active
 *
 * ROW ORDER IS PRIORITY. The first rule whose keyword appears in the event's
 * sport wins. A single "Basketball" row handles Men's, Women's, and 3x3 games —
 * all go to the Basketball group's Roll Call topic. A sub-variant that needs a
 * different destination gets its own row ABOVE the general one.
 *
 * Rows are normally written by /setup from inside Telegram (Commands.js), which
 * places new rows correctly on its own — see upsertGroupMapping_. Hand-editing
 * still works: this tab remains the source of truth, read live on every run.
 */

const GROUPS_SHEET_NAME = 'Groups';

const GROUPS_HEADERS = [
  'Sport keyword',
  'Chat ID',
  'Thread ID (Roll Call topic)',
  'Notes',
  'Group title',
  'Last updated',
  'Active',
];

const GCOL = { KEYWORD: 0, CHAT: 1, THREAD: 2, NOTES: 3, TITLE: 4, UPDATED: 5, ACTIVE: 6 };

// ---------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------

/**
 * Sport names are typed by hand in the sheet and group titles are typed by
 * hand in Telegram, so "Men's" and "Men’s" both turn up. Normalising the
 * apostrophe (and case, and runs of whitespace) is what keeps a keyword
 * harvested from one from failing against the other.
 */
function normalizeForMatch_(value) {
  return String(value == null ? '' : value)
    .replace(/[‘’ʼ]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** The single match test used by routing, /setup validation, and the commands. */
function sportMatchesKeyword_(sport, keyword) {
  const k = normalizeForMatch_(keyword);
  if (!k) return false;
  return normalizeForMatch_(sport).indexOf(k) !== -1;
}

// ---------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------

/** Every Groups row (active or not), normalised, tagged with its sheet row number. */
function readGroupRows_() {
  const sheet = getSpreadsheet_().getSheetByName(GROUPS_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const values = sheet.getDataRange().getValues();
  const rows = [];

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const label = String(row[GCOL.KEYWORD] || '').trim();
    rows.push({
      rowNumber: i + 1,
      label,
      keyword: normalizeForMatch_(label),
      chatId: String(row[GCOL.CHAT] || '').trim(),
      threadId: String(row[GCOL.THREAD] || '').trim(),
      notes: String(row[GCOL.NOTES] || '').trim(),
      title: String(row[GCOL.TITLE] || '').trim(),
      active: isActiveValue_(row[GCOL.ACTIVE]),
    });
  }

  return rows;
}

/**
 * Blank means active. The Active column was added after the first rows were
 * written by hand, and an empty cell must not silently switch a working
 * mapping off.
 */
function isActiveValue_(value) {
  const s = String(value == null ? '' : value).trim().toUpperCase();
  return s !== 'FALSE' && s !== 'NO' && s !== '0';
}

/** Active, usable mapping rules in sheet order (row order = priority). */
function getGroupMap() {
  return readGroupRows_()
    .filter((r) => r.keyword && r.chatId && r.active)
    .map((r) => ({
      keyword: r.keyword,
      label: r.label,
      chatId: r.chatId,
      threadId: r.threadId,
      title: r.title,
      rowNumber: r.rowNumber,
    }));
}

/**
 * Pick where an event's roll call goes: the first Groups rule whose keyword is
 * contained in the event's sport (row order = priority). Unmapped sports fall
 * back to the admin chat with matched:false so the caller can flag it.
 */
function resolveTarget_(event, groupMap, adminChatId) {
  for (const g of groupMap) {
    if (sportMatchesKeyword_(event.sport, g.keyword)) {
      return { chatId: g.chatId, threadId: g.threadId, matched: true, keyword: g.keyword, label: g.label };
    }
  }
  return { chatId: adminChatId, threadId: '', matched: false, keyword: null, label: null };
}

/**
 * The mapping(s) that own this chat. Rows for the exact topic the command was
 * typed in win; otherwise every active row for the chat is returned, which is
 * what lets /rollcall be typed in any topic of the GC and still resolve.
 */
function findGroupRowsForChat_(chatId, threadId) {
  const all = getGroupMap().filter((g) => g.chatId === String(chatId));
  if (!all.length) return [];

  const thread = threadId === null || threadId === undefined ? '' : String(threadId);
  const exact = all.filter((g) => g.threadId === thread);
  return exact.length ? exact : all;
}

/** Look up one mapping by keyword — exact first, then a contains match. */
function findGroupByKeyword_(keyword) {
  const want = normalizeForMatch_(keyword);
  if (!want) return null;

  const map = getGroupMap();
  return map.find((g) => g.keyword === want) ||
    map.find((g) => g.keyword.indexOf(want) !== -1 || want.indexOf(g.keyword) !== -1) ||
    null;
}

// ---------------------------------------------------------------------
// Writing (/setup, /unmap)
// ---------------------------------------------------------------------

/**
 * Write (or refresh) one sport's mapping. Returns
 * {action, rowNumber, above, duplicates}.
 *
 * Row order is priority, so a new keyword can't simply be appended: a "3x3"
 * row below "Basketball" would never win, because a 3x3 game's sport contains
 * both words. Rather than guess from keyword length — which gets 3x3 exactly
 * backwards — the insertion point comes from the data: the new row goes
 * directly ABOVE the first existing rule that also matches the sports this
 * keyword matches. Nothing conflicting, nothing to reorder: append.
 *
 * `matchedSports` is the list of sport strings from the tracker that the new
 * keyword matches (Commands.js computes it to validate the keyword anyway).
 */
function upsertGroupMapping_(entry, matchedSports) {
  const sheet = ensureGroupsSheet_();
  const rows = readGroupRows_();
  const keyword = normalizeForMatch_(entry.keyword);

  const existing = rows.filter((r) => r.keyword === keyword);
  if (existing.length) {
    // Re-running /setup in a topic updates its row in place — that's what makes
    // a season rollover (new GCs, same sports) cheap.
    writeGroupRow_(sheet, existing[0].rowNumber, entry, existing[0]);
    return { action: 'updated', rowNumber: existing[0].rowNumber, above: null, duplicates: existing.length - 1 };
  }

  const conflict = rows.find((r) =>
    r.keyword && r.chatId && r.active && r.keyword !== keyword &&
    (matchedSports || []).some((sport) => sportMatchesKeyword_(sport, r.keyword))
  );

  if (conflict) {
    sheet.insertRowBefore(conflict.rowNumber);
    writeGroupRow_(sheet, conflict.rowNumber, entry, null);
    return { action: 'created', rowNumber: conflict.rowNumber, above: conflict.label, duplicates: 0 };
  }

  const rowNumber = Math.max(sheet.getLastRow() + 1, 2);
  writeGroupRow_(sheet, rowNumber, entry, null);
  return { action: 'created', rowNumber, above: null, duplicates: 0 };
}

/** Writes columns A-G for one mapping, keeping any hand-written Notes cell. */
function writeGroupRow_(sheet, rowNumber, entry, previous) {
  const notes = entry.notes || (previous && previous.notes) || '';
  const threadId = entry.threadId === null || entry.threadId === undefined ? '' : String(entry.threadId);

  sheet.getRange(rowNumber, 1, 1, GROUPS_HEADERS.length).setValues([[
    entry.keyword,
    String(entry.chatId),
    threadId,
    notes,
    entry.title || '',
    Utilities.formatDate(new Date(), 'Asia/Manila', 'yyyy-MM-dd HH:mm'),
    'TRUE',
  ]]);
}

/**
 * Retire the rows pointing at this chat/topic (Active = FALSE rather than a
 * delete, so a mis-fired /unmap is one cell edit away from undone). Returns the
 * keywords that were switched off.
 *
 * Run inside a topic it only touches that topic's rows; run outside one, it
 * clears every mapping for the group — the reply names what it changed.
 */
function deactivateGroupMappings_(chatId, threadId) {
  const sheet = ensureGroupsSheet_();
  const wantedChat = String(chatId);
  const thread = threadId === null || threadId === undefined ? '' : String(threadId);
  const retired = [];

  readGroupRows_().forEach((r) => {
    if (!r.active || !r.keyword || r.chatId !== wantedChat) return;
    if (thread && r.threadId && r.threadId !== thread) return;
    sheet.getRange(r.rowNumber, GCOL.ACTIVE + 1).setValue('FALSE');
    retired.push(r.label);
  });

  return retired;
}

// ---------------------------------------------------------------------
// Guessing a sport from a Telegram group title
// ---------------------------------------------------------------------

/**
 * Words that show up in GC titles but never inside a sport name in the
 * tracker. Stripped before guessing, so "UAAP 88 Football GC" reduces to
 * "Football". Bare numbers ("88") are dropped separately.
 */
const TITLE_NOISE_WORDS = [
  'gc', 'gcs', 'group', 'chat', 'uaap', 'ncaa', 'tls', 'lasallian', 'dlsu', 'green', 'archers',
  'season', 'sports', 'sport', 'coverage', 'roll', 'call', 'rollcall', 'the', 'official', 'team',
];

/**
 * Candidate keywords from a group title, longest phrase first, so
 * "Beach Volleyball GC" prefers "beach volleyball" over the bare "volleyball"
 * that would also match every indoor game.
 */
function sportCandidatesFromTitle_(title) {
  const tokens = normalizeForMatch_(String(title || '').replace(/[^A-Za-z0-9'‘’]+/g, ' '))
    .split(' ')
    .filter((t) => t && !/^\d+$/.test(t) && TITLE_NOISE_WORDS.indexOf(t) === -1);

  const seen = {};
  const candidates = [];
  for (let n = tokens.length; n >= 1; n--) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const phrase = tokens.slice(i, i + n).join(' ');
      if (seen[phrase]) continue;
      seen[phrase] = true;
      candidates.push(phrase);
    }
  }
  return candidates;
}

/**
 * Best keyword for a group title: the longest phrase from the title that
 * actually appears in a sport name in the tracker. Returns null when nothing
 * matches — the signal for /setup to ask for an explicit keyword rather than
 * map a GC to a sport nobody is playing.
 */
function guessSportKeyword_(title, sports) {
  const names = sports.map((s) => s.sport);

  const candidates = sportCandidatesFromTitle_(title);
  for (let i = 0; i < candidates.length; i++) {
    const matched = names.filter((name) => sportMatchesKeyword_(name, candidates[i]));
    if (matched.length) return { keyword: candidates[i], matchedSports: matched };
  }
  return null;
}

// ---------------------------------------------------------------------
// Tab setup
// ---------------------------------------------------------------------

/**
 * The Groups tab, created and headed if absent. /setup calls this so a brand
 * new spreadsheet doesn't need setupGroupsTab() run by hand first.
 */
function ensureGroupsSheet_() {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(GROUPS_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(GROUPS_SHEET_NAME);

  const header = sheet.getRange(1, 1, 1, GROUPS_HEADERS.length).getValues()[0];
  const needsHeader = GROUPS_HEADERS.some((title, i) => String(header[i] || '').trim() === '');
  if (needsHeader) {
    // Fill only the blanks: a renamed header stays renamed, and the columns
    // added later (E-G) get their titles without disturbing A-D.
    const merged = GROUPS_HEADERS.map((title, i) => String(header[i] || '').trim() || title);
    sheet.getRange(1, 1, 1, GROUPS_HEADERS.length).setValues([merged]).setFontWeight('bold');
  }

  // Chat IDs are 13-digit negatives; left as numbers they render in scientific
  // notation the moment someone widens the column, which reads as corruption.
  const bodyRows = Math.max(sheet.getMaxRows() - 1, 1);
  sheet.getRange(2, GCOL.CHAT + 1, bodyRows, 2).setNumberFormat('@');

  return sheet;
}

/**
 * One-time setup helper: create the Groups tab with headers and one example
 * row. Only creates/seeds when missing — never overwrites your rows. The
 * example row has a blank Chat ID, so it's ignored until filled.
 *
 * Since the command layer landed, you shouldn't need this: /setup creates the
 * tab and writes rows itself, from inside Telegram.
 */
function setupGroupsTab() {
  const sheet = ensureGroupsSheet_();

  if (sheet.getLastRow() < 2) {
    sheet.getRange(2, 1, 1, GROUPS_HEADERS.length).setValues([[
      'Basketball', '', '', 'EXAMPLE — normally written by /setup from inside the GC. This row covers Men’s, Women’s, and 3x3. Rows with a blank Chat ID are ignored.', '', '', 'TRUE',
    ]]);
  }

  sheet.autoResizeColumns(1, GROUPS_HEADERS.length);
  Logger.log('Groups tab ready. Preferred path: run /setup in each GC’s Roll Call topic.');
}
