/**
 * Row parsing logic (SPEC.md §3). Deliberately free of SpreadsheetApp/
 * Utilities/Logger calls so this file's functions can be exercised outside
 * the Apps Script runtime (see the build-order test functions in Main.js,
 * which supply the live SpreadsheetApp values).
 *
 * Row arrays are 0-indexed matching column letters: A=0, B=1, ... R=17.
 */

const COL = {
  DAY: 1,        // B
  WEEKDAY: 2,    // C — informational only, never trusted (§2.1)
  TIME: 3,       // D
  EVENT: 4,      // E
  VENUE: 5,      // F
  H: 7, I: 8, J: 9, K: 10, L: 11, M: 12, N: 13, O: 14, // deliverable flags
  RECAP: 16,     // Q
  LIVETWEET: 17, // R
};

const DELIVERABLE_LABELS = {
  6: 'Game Day',
  7: 'HN',
  8: 'Livetweet',
  9: 'HT',
  10: 'Buzzer',
  11: 'POTG',
  12: 'Album Caption',
  13: 'Recap',
  14: 'IGs',
};

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const FIRST_DATA_ROW = 5; // §2.1 — rows 1-4 are headers, 1-indexed sheet row

function monthNumberFromName_(monthName) {
  const idx = MONTH_NAMES.findIndex((m) => m.toLowerCase() === String(monthName || '').toLowerCase());
  if (idx === -1) throw new Error(`Unknown month name: ${monthName}`);
  return idx + 1;
}

function resolveYear_(monthNumber, config) {
  return monthNumber >= config.SEASON_START_MONTH
    ? config.SEASON_START_YEAR
    : config.SEASON_START_YEAR + 1;
}

function weekdayName_(year, monthNumber, day) {
  return WEEKDAY_NAMES[new Date(year, monthNumber - 1, day).getDay()];
}

/**
 * §3.1 — column B is a real Date, a bare number, or empty (continuation of a
 * merged cell). Empty forward-fills from the last resolved day. Anything
 * else unrecognised also forward-fills rather than throwing.
 */
function resolveDayOfMonth_(raw, lastDay) {
  if (raw instanceof Date) return raw.getDate();
  if (typeof raw === 'number' && raw > 0) return raw;
  return lastDay;
}

/**
 * §3.1 — venue (column F) is forward-filled the same way as the date.
 * Unlike the date, an unrecognised value degrades to the last venue too
 * since there's no "correct" venue type to fall back on.
 */
function resolveVenue_(raw, lastVenue) {
  const trimmed = (raw === null || raw === undefined) ? '' : String(raw).trim();
  return trimmed === '' ? lastVenue : trimmed;
}

/**
 * §3.4 — "[SPORT]: DLSU vs [OPPONENT]", opponent is whichever side isn't
 * DLSU. Never throws: any shape that doesn't fit degrades to the raw text.
 */
function parseEventName_(raw) {
  const normalized = String(raw || '').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

  // Split on the LAST colon, not the first: the sport prefix is sometimes
  // typed with an internal colon (e.g. "R1: Men's Basketball: DLSU vs ADMU"),
  // but the matchup ("DLSU vs X") never contains one — so the final colon
  // reliably divides sport from matchup.
  let sport = '';
  let matchup = normalized;
  const colonIdx = normalized.lastIndexOf(':');
  if (colonIdx !== -1) {
    sport = normalized.slice(0, colonIdx).trim();
    matchup = normalized.slice(colonIdx + 1).trim();
  }

  const vsMatch = matchup.match(/\b(vs\.?|v)\b/i);
  if (!vsMatch) {
    return { sport, opponent: matchup, reversed: false, raw: normalized };
  }

  const left = matchup.slice(0, vsMatch.index).trim();
  const right = matchup.slice(vsMatch.index + vsMatch[0].length).trim();
  const leftIsDLSU = left.toUpperCase() === 'DLSU';
  const rightIsDLSU = right.toUpperCase() === 'DLSU';

  if (leftIsDLSU === rightIsDLSU) {
    // Neither side (or both) reads as DLSU — can't identify the opponent.
    return { sport, opponent: matchup, reversed: false, raw: normalized };
  }

  const opponent = leftIsDLSU ? right : left;
  return { sport, opponent, reversed: true, raw: normalized };
}

/**
 * §3.6 — a real Date/time value is formatted "h:mm a" lowercased; free text
 * passes through unparsed with newlines collapsed.
 *
 * `tz` must be the *spreadsheet's* timezone (SpreadsheetApp.getActiveSpreadsheet()
 * .getSpreadsheetTimeZone()), not the script's. `getValues()` builds a time-only
 * cell's Date against Google Sheets' 1899 epoch using the spreadsheet's timezone,
 * whose historical LMT offset differs from the modern one by a few odd minutes.
 * Reading it back with `.getHours()` (which uses the *script's* timezone) leaks
 * that difference in as a skew (observed: +23 min). Formatting with the same
 * spreadsheet timezone that built the Date cancels the offset exactly, yielding
 * the wall-clock time the user actually typed.
 *
 * When Utilities is unavailable (local Node tests), fall back to manual
 * extraction — fixture Dates there are modern, so there is no epoch skew.
 */
function parseTime_(raw, tz) {
  if (raw instanceof Date) {
    if (tz && typeof Utilities !== 'undefined') {
      return Utilities.formatDate(raw, tz, 'h:mm a').toLowerCase();
    }
    let hours = raw.getHours();
    const minutes = String(raw.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'pm' : 'am';
    hours = hours % 12;
    if (hours === 0) hours = 12;
    return `${hours}:${minutes} ${ampm}`;
  }
  return String(raw || '').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
}

/** §3.7 — columns G-O marked "Yes", mapped to display labels, in column order. */
function getDeliverables_(row) {
  const labels = [];
  [6, 7, 8, 9, 10, 11, 12, 13, 14].forEach((colIndex) => {
    const val = String(row[colIndex] || '').trim().toLowerCase();
    if (val === 'yes') labels.push(DELIVERABLE_LABELS[colIndex]);
  });
  return labels;
}

/** §3.5 — comma-separated names, trimmed, empties dropped. Never forward-filled. */
function parseStafferNames_(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * §2.1/§3.1/§3.3 — walk every data row (row 5 onward) of a month sheet,
 * forward-filling date and venue, and return one entry per row regardless
 * of whether it qualifies as a game day. Used to verify forward-fill in
 * isolation (build order step 3) before the event filter is layered on.
 */
function resolveRows_(rows, monthName, config) {
  const monthNumber = monthNumberFromName_(monthName);
  const year = resolveYear_(monthNumber, config);
  let lastDay = null;
  let lastVenue = '';

  return rows.map((row, i) => {
    const day = resolveDayOfMonth_(row[COL.DAY], lastDay);
    if (day !== null && day !== undefined) lastDay = day;
    const venue = resolveVenue_(row[COL.VENUE], lastVenue);
    lastVenue = venue;

    return {
      sheetRow: FIRST_DATA_ROW + i,
      year,
      month: monthNumber,
      day,
      venue,
      row,
    };
  });
}

/**
 * §3.3 (revised) — a row qualifies as a real game once its event name
 * resolves to an identifiable opponent (§3.4's `reversed` flag: exactly one
 * side of the "vs"/"v" split reads as DLSU). This intentionally ignores the
 * `Game day` column (G) — it does not reliably distinguish real games from
 * non-game entries in practice, so an unambiguous opponent match is used
 * instead. Non-game rows (press conferences, ceremonies) have no "vs" and
 * are excluded naturally.
 */
function isAnnounceableName_(parsedName) {
  return parsedName.reversed === true;
}

/**
 * §3.1-§3.7 combined — full pipeline for one month sheet: resolves dates
 * (forward-filled), filters to rows with an identifiable opponent, and
 * returns fully parsed event objects (name, time, deliverables, staffer
 * names). Staffer *handle* resolution (Staffers tab lookup) happens one
 * layer up, since this function has no access to the Staffers map.
 *
 * `tz` is the spreadsheet's timezone, passed through to parseTime_ so time
 * cells are formatted without the 1899-epoch skew (see parseTime_).
 */
function parseMonthEvents(rows, monthName, config, tz) {
  return resolveRows_(rows, monthName, config)
    .map((r) => Object.assign({ name: parseEventName_(r.row[COL.EVENT]) }, r))
    .filter((r) => isAnnounceableName_(r.name))
    .map((r) => ({
      year: r.year,
      month: r.month,
      day: r.day,
      weekday: weekdayName_(r.year, r.month, r.day),
      sport: r.name.sport,
      opponent: r.name.opponent,
      venue: r.venue,
      time: parseTime_(r.row[COL.TIME], tz),
      deliverables: getDeliverables_(r.row),
      recapNames: parseStafferNames_(r.row[COL.RECAP]),
      livetweetNames: parseStafferNames_(r.row[COL.LIVETWEET]),
      sheetRow: r.sheetRow,
    }));
}

/** §3.3 — events whose resolved date equals the target {year, month, day}. */
function filterEventsForDate_(events, targetDate) {
  return events.filter(
    (e) => e.year === targetDate.year && e.month === targetDate.month && e.day === targetDate.day
  );
}

/** Resolve a "today + LEAD_DAYS" style target date string (YYYY-MM-DD) to {year, month, day}. */
function parseTargetDateString_(dateString) {
  const [year, month, day] = String(dateString).split('-').map((n) => parseInt(n, 10));
  return { year, month, day };
}
