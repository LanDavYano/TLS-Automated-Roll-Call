/**
 * Groups tab: maps each sport to the Telegram group + topic its roll call is
 * sent to (SPEC.md §4.4). Columns:
 *   A  Sport keyword   matched (case-insensitive) against the event; COMMA-SEPARATED
 *   B  Chat ID         the group's chat id (same for every topic in a group)
 *   C  Thread ID       the Roll Call topic's message_thread_id (blank = no topic)
 *   D  Notes           free text for humans; ignored by the script
 *   E  Group title     the GC's name as Telegram reported it at /rollsetup time
 *   F  Last updated    when /rollsetup last wrote this row
 *   G  Active          FALSE retires a row without deleting it; blank = active
 *   H  Mode            `session` or `event` (blank = event) — see §4.5
 *
 * ONE GC = ONE ROLL CALL TOPIC = ONE ROW. The GCs have per-category topics
 * (Men's, Women's, Beach, 3x3) for discussion, but every roll call posts to the
 * single Roll Call topic, so a group needs exactly one mapping.
 *
 * COLUMN A HOLDS A LIST. `esports, valorant, nba2k` is one rule with three
 * keywords, any of which routes here. Necessary because a GC's sports do not
 * always share a word: "esports" appears in "Esports Mobile Legends: Bang Bang!"
 * but not in "VALORANT" or "NBA2k", and "baseball" is nowhere in "Women's
 * Softball". A single keyword (the common case) is just a list of one.
 *
 * ROW ORDER IS PRIORITY. The first rule whose keyword appears in the event wins.
 * A single "Basketball" row handles Men's and Women's games; a sub-variant that
 * needs its own row — because it collates differently, like 3x3, or posts
 * somewhere else — goes ABOVE the general one.
 *
 * MODE decides how many messages a day produces. `event` (the default) sends one
 * roll call per fixture, which is right for Football, Basketball and Volleyball
 * where each game stands alone. `session` merges everything matching this rule on
 * one date into a single message, which is right for Fencing, Athletics, Golf,
 * 3x3 and Chess, where the categories play as one block. Mode cannot be inferred
 * from the sheet — "R4 Men's Blitz Chess:" and "R1 Men's Football:" are typed
 * identically and behave oppositely — so it is configuration, set per rule.
 *
 * Rows are normally written by /rollsetup from inside Telegram (Commands.js), which
 * places new rows correctly on its own — see upsertGroupMapping_. Hand-editing
 * still works: this tab remains the source of truth, read live on every run.
 */

const GROUPS_SHEET_NAME = 'Groups';

const GROUPS_HEADERS = [
  'Sport keyword(s), comma-separated',
  'Chat ID',
  'Thread ID (Roll Call topic)',
  'Notes',
  'Group title',
  'Last updated',
  'Active',
  'Mode (event / session)',
];

const GCOL = {
  KEYWORD: 0, CHAT: 1, THREAD: 2, NOTES: 3, TITLE: 4, UPDATED: 5, ACTIVE: 6, MODE: 7,
};

/** §4.5 — one message per fixture, or one per sport per day. */
const GROUP_MODES = { EVENT: 'event', SESSION: 'session' };

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

/** Column A split into its individual keywords. `"Esports, VALORANT"` → two. */
function splitKeywords_(value) {
  return normalizeForMatch_(value)
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
}

/**
 * The single match test used by routing, /rollsetup validation, and the commands.
 * `keyword` may be one keyword or a comma-separated list; any member matching is
 * a match for the whole rule.
 */
function sportMatchesKeyword_(sport, keyword) {
  const haystack = normalizeForMatch_(sport);
  if (!haystack) return false;
  return splitKeywords_(keyword).some((k) => haystack.indexOf(k) !== -1);
}

/** Blank, unknown, or misspelled modes fall back to `event`, the safe direction. */
function normalizeMode_(value) {
  return normalizeForMatch_(value) === GROUP_MODES.SESSION
    ? GROUP_MODES.SESSION
    : GROUP_MODES.EVENT;
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
      keywords: splitKeywords_(label),
      chatId: String(row[GCOL.CHAT] || '').trim(),
      threadId: String(row[GCOL.THREAD] || '').trim(),
      notes: String(row[GCOL.NOTES] || '').trim(),
      title: String(row[GCOL.TITLE] || '').trim(),
      active: isActiveValue_(row[GCOL.ACTIVE]),
      mode: normalizeMode_(row[GCOL.MODE]),
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
      keywords: r.keywords,
      label: r.label,
      chatId: r.chatId,
      threadId: r.threadId,
      title: r.title,
      mode: r.mode,
      rowNumber: r.rowNumber,
    }));
}

/**
 * Pick where an event's roll call goes (row order = priority), in two passes.
 *
 * Pass 1 tests the event's SPORT — the text before the last colon, which is what
 * a well-formed row gives you ("R1 Men's Football", "Fencing Day 1").
 *
 * Pass 2 tests the WHOLE event text, and exists because not every row has a
 * colon: "Athletics Day 1" and "Golf Day 2" carry their sport in a name the
 * §3.4 split leaves with an empty sport. Without this fallback those events
 * match nothing and land in the admin chat forever.
 *
 * Both passes run over the full rule list before the next begins, so a sport
 * prefix match always beats a loose full-text one. That ordering is what keeps
 * "UAAP Season 88 Collegiate Basketball Press Conference" from outranking the
 * Basketball rule for an actual basketball game — the game matches in pass 1.
 *
 * Unmapped events fall back to the admin chat with matched:false so the caller
 * can flag it. That fallback is now load-bearing: since §3.3 stopped requiring
 * an opponent, tournament-wide events with no sport in their name ("UAAP:
 * Opening ceremony") are expected to arrive here and be surfaced to a human.
 */
function resolveTarget_(event, groupMap, adminChatId) {
  const hit = (g) => ({
    chatId: g.chatId,
    threadId: g.threadId,
    matched: true,
    keyword: g.keyword,
    label: g.label,
    mode: g.mode,
  });

  for (const g of groupMap) {
    if (sportMatchesKeyword_(event.sport, g.keyword)) return hit(g);
  }
  for (const g of groupMap) {
    if (sportMatchesKeyword_(event.rawName, g.keyword)) return hit(g);
  }

  return {
    chatId: adminChatId,
    threadId: '',
    matched: false,
    keyword: null,
    label: null,
    mode: GROUP_MODES.EVENT,
  };
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

/**
 * Look up one mapping by keyword — exact first, then a contains match. Checks
 * each of a rule's keywords individually, so `/next valorant` finds the row
 * written as `esports, valorant, nba2k`.
 */
function findGroupByKeyword_(keyword) {
  const want = normalizeForMatch_(keyword);
  if (!want) return null;

  const map = getGroupMap();
  return map.find((g) => g.keywords.indexOf(want) !== -1) ||
    map.find((g) => g.keywords.some((k) => k.indexOf(want) !== -1 || want.indexOf(k) !== -1)) ||
    null;
}

// ---------------------------------------------------------------------
// Writing (/rollsetup, /unmap)
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
  const keywords = splitKeywords_(entry.keyword);
  const canonical = keywords.join(', ');
  const write = Object.assign({}, entry, { keyword: canonical });

  // A rule is "the same rule" if its keyword list is identical, or if it
  // overlaps one already mapped to this same GC — that second case is someone
  // widening `esports` into `esports, valorant, nba2k`, which should edit the
  // row rather than leave a stale one above it. Overlap is required, so the
  // Basketball GC's separate `3x3` and `basketball` rules stay separate.
  const existing = rows.filter((r) =>
    r.keywords.length && (
      r.keywords.join(', ') === canonical ||
      (r.chatId === String(entry.chatId) && r.keywords.some((k) => keywords.indexOf(k) !== -1))
    )
  );

  if (existing.length) {
    // Re-running /rollsetup in a topic updates its row in place — that's what makes
    // a season rollover (new GCs, same sports) cheap.
    writeGroupRow_(sheet, existing[0].rowNumber, write, existing[0]);
    return {
      action: 'updated',
      rowNumber: existing[0].rowNumber,
      above: null,
      duplicates: existing.length - 1,
      mode: normalizeMode_(entry.mode || existing[0].mode),
    };
  }

  const conflict = rows.find((r) =>
    r.keyword && r.chatId && r.active && r.keywords.join(', ') !== canonical &&
    (matchedSports || []).some((sport) => sportMatchesKeyword_(sport, r.keyword))
  );

  const mode = normalizeMode_(entry.mode);

  if (conflict) {
    sheet.insertRowBefore(conflict.rowNumber);
    writeGroupRow_(sheet, conflict.rowNumber, write, null);
    return { action: 'created', rowNumber: conflict.rowNumber, above: conflict.label, duplicates: 0, mode };
  }

  const rowNumber = Math.max(sheet.getLastRow() + 1, 2);
  writeGroupRow_(sheet, rowNumber, write, null);
  return { action: 'created', rowNumber, above: null, duplicates: 0, mode };
}

/**
 * Writes columns A-H for one mapping, keeping any hand-written Notes cell.
 *
 * Mode is likewise preserved when the caller doesn't set one: re-running
 * /rollsetup to move a GC to a new topic must not quietly reset a sport back to
 * `event` and start splitting its session into four messages.
 */
function writeGroupRow_(sheet, rowNumber, entry, previous) {
  const notes = entry.notes || (previous && previous.notes) || '';
  const mode = normalizeMode_(entry.mode || (previous && previous.mode) || GROUP_MODES.EVENT);
  const threadId = entry.threadId === null || entry.threadId === undefined ? '' : String(entry.threadId);

  sheet.getRange(rowNumber, 1, 1, GROUPS_HEADERS.length).setValues([[
    entry.keyword,
    String(entry.chatId),
    threadId,
    notes,
    entry.title || '',
    Utilities.formatDate(new Date(), 'Asia/Manila', 'yyyy-MM-dd HH:mm'),
    'TRUE',
    mode,
  ]]);
}

/** Change just the Mode cell of a rule — what `/rollsetup session` writes. */
function setGroupMode_(rowNumber, mode) {
  ensureGroupsSheet_().getRange(rowNumber, GCOL.MODE + 1).setValue(normalizeMode_(mode));
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
 * matches — the signal for /rollsetup to ask for an explicit keyword rather than
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
 * The Groups tab, created and headed if absent. /rollsetup calls this so a brand
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
 * Since the command layer landed, you shouldn't need this: /rollsetup creates the
 * tab and writes rows itself, from inside Telegram.
 */
function setupGroupsTab() {
  const sheet = ensureGroupsSheet_();

  if (sheet.getLastRow() < 2) {
    sheet.getRange(2, 1, 1, GROUPS_HEADERS.length).setValues([[
      'Basketball', '', '', 'EXAMPLE — normally written by /rollsetup from inside the GC. This row covers Men’s and Women’s games, one message each. 3x3 wants its own row above this one with Mode = session. Rows with a blank Chat ID are ignored.', '', '', 'TRUE', GROUP_MODES.EVENT,
    ]]);
  }

  sheet.autoResizeColumns(1, GROUPS_HEADERS.length);
  Logger.log('Groups tab ready. Preferred path: run /rollsetup in each GC’s Roll Call topic.');
}
