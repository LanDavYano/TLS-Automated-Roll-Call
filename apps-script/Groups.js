/**
 * Groups tab: maps each sport to the Telegram group + topic its roll call is
 * sent to (SPEC.md §4.4). Columns:
 *   A  Sport keyword   matched (case-insensitive) against the event's sport
 *   B  Chat ID         the group's chat id (same for every topic in a group)
 *   C  Thread ID       the Roll Call topic's message_thread_id (blank = no topic)
 *   D  Notes           free text for humans; ignored by the script
 *
 * ROW ORDER IS PRIORITY. The first rule whose keyword appears in the event's
 * sport wins. Currently a single "Basketball" row handles Men's, Women's, and
 * 3x3 games — all go to the Basketball group's Roll Call topic. If you ever
 * want a sub-variant to land in a different topic, add a more specific row
 * (e.g. "3x3") ABOVE the general one and it will win for matching events.
 *
 * Adding a sport is a data edit: add a row, no code change (read live each run).
 */

const GROUPS_SHEET_NAME = 'Groups';

/** Read the Groups tab top-to-bottom. Rows missing a keyword or Chat ID are skipped. */
function getGroupMap() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(GROUPS_SHEET_NAME);
  if (!sheet) return [];

  const rows = sheet.getDataRange().getValues().slice(1); // skip header
  const map = [];
  for (const row of rows) {
    const keyword = String(row[0] || '').trim();
    const chatId = String(row[1] || '').trim();
    const threadId = String(row[2] || '').trim();
    if (!keyword || !chatId) continue;
    map.push({ keyword: keyword.toLowerCase(), chatId: chatId, threadId: threadId });
  }
  return map;
}

/**
 * Pick where an event's roll call goes: the first Groups rule whose keyword is
 * contained in the event's sport (row order = priority). Unmapped sports fall
 * back to the admin chat with matched:false so the caller can flag it.
 */
function resolveTarget_(event, groupMap, adminChatId) {
  const sport = String(event.sport || '').toLowerCase();
  for (const g of groupMap) {
    if (g.keyword && sport.indexOf(g.keyword) !== -1) {
      return { chatId: g.chatId, threadId: g.threadId, matched: true, keyword: g.keyword };
    }
  }
  return { chatId: adminChatId, threadId: '', matched: false, keyword: null };
}

/**
 * One-time setup helper: create the Groups tab with headers and two example
 * rows demonstrating the "specific above general" ordering (3x3 above
 * Basketball). Only creates/seeds when missing — never overwrites your rows.
 * The example rows have blank Chat IDs, so they're ignored until you fill them.
 */
function setupGroupsTab() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(GROUPS_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(GROUPS_SHEET_NAME);

  if (String(sheet.getRange(1, 1).getValue()).trim().toLowerCase() !== 'sport keyword') {
    sheet.getRange(1, 1, 1, 4)
      .setValues([['Sport keyword', 'Chat ID', 'Thread ID (Roll Call topic)', 'Notes']])
      .setFontWeight('bold');
  }

  if (sheet.getLastRow() < 2) {
    sheet.getRange(2, 1, 1, 4).setValues([
      ['Basketball', '', '', 'EXAMPLE — fill Chat ID + Thread ID (Roll Call topic), then add one row per sport. This row covers Men’s, Women’s, and 3x3. Rows with a blank Chat ID are ignored. Run harvestChatIds() to find the IDs.'],
    ]);
  }

  sheet.autoResizeColumns(1, 4);
  Logger.log('Groups tab ready. Add one row per sport (keyword + Chat ID + Roll Call topic Thread ID). Blank-Chat-ID rows are ignored.');
}
