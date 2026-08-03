/**
 * Season-wide reads (SPEC.md §12.4).
 *
 * The nightly run only ever needs one month tab — it knows the target date, so
 * it knows the tab. The chat commands don't: "what's the next Football game?"
 * can be answered by this month's tab, next month's, or the one after that.
 * These helpers walk the season's month tabs in chronological order and stop
 * as early as they can, so the common case still costs a single tab read.
 */

/** §7 — today in Asia/Manila as {year, month, day}. Never the runtime default. */
function todayInManila_() {
  const [year, month, day] = Utilities.formatDate(new Date(), 'Asia/Manila', 'yyyy-MM-dd')
    .split('-')
    .map((n) => parseInt(n, 10));
  return { year, month, day };
}

/** Comparable integer for any {year, month, day}, for ordering and range tests. */
function dateOrdinal_(d) {
  return d.year * 10000 + d.month * 100 + d.day;
}

/** Whole days from `from` to `event`. Negative once the event has passed. */
function daysUntil_(event, from) {
  const a = Date.UTC(from.year, from.month - 1, from.day);
  const b = Date.UTC(event.year, event.month - 1, event.day);
  return Math.round((b - a) / 86400000);
}

/** "September 20 (Sat)" — the date line used in every command reply. */
function formatEventDate_(event) {
  return `${MONTH_NAMES[event.month - 1]} ${event.day} (${event.weekday})`;
}

/**
 * Every month tab in the spreadsheet, resolved to its season year (§3.2) and
 * sorted chronologically. Tabs that aren't English month names (Config,
 * Staffers, Groups, _log) are skipped by name, so no list of tabs has to be
 * maintained in code — adding a month tab is enough.
 */
function listSeasonMonths_(config) {
  const months = [];

  getSpreadsheet_().getSheets().forEach((sheet) => {
    const name = String(sheet.getName()).trim();
    const idx = MONTH_NAMES.findIndex((m) => m.toLowerCase() === name.toLowerCase());
    if (idx === -1) return;

    const month = idx + 1;
    months.push({ sheet, name: MONTH_NAMES[idx], month, year: resolveYear_(month, config) });
  });

  months.sort((a, b) => (a.year - b.year) || (a.month - b.month));
  return months;
}

/** Parsed events for one entry from listSeasonMonths_. */
function monthEvents_(entry, config, tz) {
  return parseMonthEvents(readSheetRows_(entry.sheet), entry.name, config, tz);
}

/**
 * Events on or after `from`, in date order, optionally narrowed by `predicate`.
 * Returns as soon as `limit` events are collected — "the next game" normally
 * resolves inside the first tab it opens.
 */
function findUpcomingEvents_(config, from, predicate, limit) {
  const tz = getSpreadsheetTimeZone_();
  const fromOrd = dateOrdinal_(from);
  const found = [];

  const months = listSeasonMonths_(config);
  for (let i = 0; i < months.length; i++) {
    const entry = months[i];
    // Skip whole months that are already behind us.
    if (entry.year * 100 + entry.month < from.year * 100 + from.month) continue;

    const events = monthEvents_(entry, config, tz)
      .filter((e) => dateOrdinal_(e) >= fromOrd)
      .filter((e) => !predicate || predicate(e))
      .sort((a, b) => (dateOrdinal_(a) - dateOrdinal_(b)) || (a.sheetRow - b.sheetRow));

    for (let j = 0; j < events.length; j++) {
      found.push(events[j]);
      if (limit && found.length >= limit) return found;
    }
  }

  return found;
}

/** The soonest game (today onward) whose sport matches any of `keywords`. */
function findNextEventForKeywords_(config, keywords) {
  const events = findUpcomingEvents_(
    config,
    todayInManila_(),
    (e) => keywords.some((k) => sportMatchesKeyword_(e.sport, k)),
    1
  );
  return events.length ? events[0] : null;
}

/**
 * Every distinct sport string in the season, with its game counts and next
 * fixture. /rollsetup validates a keyword against this list rather than trusting a
 * group title blindly, and /groups uses it to name the sports that still have
 * no GC mapped.
 */
function collectSeasonSports_(config) {
  const tz = getSpreadsheetTimeZone_();
  const today = dateOrdinal_(todayInManila_());
  const byName = {};

  listSeasonMonths_(config).forEach((entry) => {
    monthEvents_(entry, config, tz).forEach((event) => {
      const sport = String(event.sport || '').trim();
      if (!sport) return;

      const record = byName[sport] || (byName[sport] = { sport, total: 0, upcoming: 0, next: null });
      record.total++;
      if (dateOrdinal_(event) >= today) {
        record.upcoming++;
        if (!record.next || dateOrdinal_(event) < dateOrdinal_(record.next)) record.next = event;
      }
    });
  });

  return Object.keys(byName)
    .map((key) => byName[key])
    .sort((a, b) => a.sport.localeCompare(b.sport));
}
