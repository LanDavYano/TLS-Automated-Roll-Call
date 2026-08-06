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

// Full names, not abbreviations: the roll call date line reads "March 13 (Friday)".
const WEEKDAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

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
 * Time (column D) is merged the same way date and venue are — a fencing day
 * with two 9:00 AM sessions and a 1:00 PM one is typed as one merged 9:00 AM
 * cell spanning the first two rows, so the second row reads back empty.
 * Without this the second session renders "Time:" with nothing after it.
 *
 * Unlike venue, the fill is reset when the DAY changes (see resolveRows_): a
 * blank time on the first row of a new day is a data error either way, and
 * inheriting yesterday's last time would state a confidently wrong one.
 * Returning the raw value (not a string) keeps Date cells intact for parseTime_.
 */
function resolveTime_(raw, lastRaw) {
  const isBlank = raw === null || raw === undefined || String(raw).trim() === '';
  return isBlank ? lastRaw : raw;
}

/** Curly apostrophes are typed interchangeably with straight ones. */
function normalizeApostrophes_(value) {
  return String(value == null ? '' : value).replace(/[‘’ʼ]/g, "'");
}

/**
 * The sport a row belongs to, with everything that varies *within* a sport
 * stripped off. This is what session-mode collation groups by (§4.5), and what
 * the roll call's title line is built from.
 *
 * Four steps, in order:
 *   1. "Day N" delimits the sport from the session detail, exactly like the
 *      colon does — "Fencing Day 1" is the sport, "Men's Sabre Individual" is
 *      one session of it. Safe to drop because collation is already scoped to a
 *      single calendar date, and Day 1 and Day 2 are by definition different days.
 *   2. Round prefixes ("R1", "R4:") number the fixture, not the sport.
 *   3. Category words move to the bracket on the opponent line, so Men's and
 *      Women's Chess resolve to the same family and can share one message.
 *
 * What survives is deliberately specific: "3x3 Basketball" stays distinct from
 * "Basketball", "Blitz Chess" from "Chess", "Beach Volleyball" from
 * "Volleyball". Those are separate competitions that happen to share a GC, and
 * they must never be merged into one another's roll call.
 */
function sportFamily_(sportSegment) {
  let s = normalizeApostrophes_(sportSegment).replace(/\s+/g, ' ').trim();

  const dayIdx = s.search(/\bday\s*\d+/i);
  if (dayIdx !== -1) s = s.slice(0, dayIdx);

  s = s.replace(/^r\s*\d+\s*:?\s*/i, '');
  s = s.replace(/\b(men|women|boys|girls)'?s?\b/gi, ' ');

  return s.replace(/\s+/g, ' ').replace(/^[\s:\-–—]+|[\s:\-–—]+$/g, '').trim();
}

/**
 * §4.1 — the bracket on the opponent line ("UE vs DLSU [Men's]"). Women's is
 * tested first: "Women's" contains the letters of "men", and while the word
 * boundary already prevents a false hit, the ordering makes that independent of
 * the regex being exactly right.
 */
function eventCategory_(text) {
  const s = normalizeApostrophes_(text);
  if (/\bwomen'?s?\b/i.test(s)) return "Women's";
  if (/\bmen'?s?\b/i.test(s)) return "Men's";
  if (/\bgirls'?\b/i.test(s)) return 'Girls';
  if (/\bboys'?\b/i.test(s)) return 'Boys';
  return '';
}

/**
 * §3.4 — splits one column E value into the pieces the renderer and the router
 * need. Never throws: any shape that doesn't fit degrades to the raw text.
 *
 *   sport        text before the last colon, as typed ("R1 Men's Football")
 *   family       sport with round/day/category stripped ("Football")
 *   category     "Men's" / "Women's" / '' — rendered in the bracket
 *   opponent     the side of the "vs" that isn't DLSU, when there is one
 *   detail       the non-matchup remainder ("Men's Sabre Individual") — what a
 *                session-mode message lists when there are no opponents
 *   hasOpponent  whether the vs split identified exactly one non-DLSU side
 *
 * `hasOpponent` used to be the announce filter; it is now purely a rendering
 * choice, because a row without a "vs" is a real covered event (a ceremony, a
 * fencing session, an awarding) rather than noise to skip. See isAnnounceableName_.
 */
function parseEventName_(raw) {
  const normalized = String(raw || '').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

  // Split on the LAST colon, not the first: the sport prefix is sometimes
  // typed with an internal colon (e.g. "R1: Men's Basketball: DLSU vs ADMU",
  // "Esports Mobile Legends: Bang Bang!: DLSU vs UP"), but the matchup
  // ("DLSU vs X") never contains one — so the final colon reliably divides
  // sport from matchup.
  let sport = '';
  let matchup = normalized;
  const colonIdx = normalized.lastIndexOf(':');
  if (colonIdx !== -1) {
    sport = normalized.slice(0, colonIdx).trim();
    matchup = normalized.slice(colonIdx + 1).trim();
  }

  // The category is normally in the sport prefix ("R1 Men's Football"), but for
  // tournament sessions it sits after the colon ("Fencing Day 1: Men's Sabre").
  const base = {
    sport,
    family: sportFamily_(sport || normalized),
    category: eventCategory_(sport) || eventCategory_(matchup),
    detail: matchup,
    raw: normalized,
  };

  const vsMatch = matchup.match(/\b(vs\.?|v)\b/i);
  if (!vsMatch) {
    return Object.assign(base, { opponent: '', hasOpponent: false });
  }

  const left = matchup.slice(0, vsMatch.index).trim();
  const right = matchup.slice(vsMatch.index + vsMatch[0].length).trim();
  const leftIsDLSU = left.toUpperCase() === 'DLSU';
  const rightIsDLSU = right.toUpperCase() === 'DLSU';

  if (leftIsDLSU === rightIsDLSU) {
    // Neither side (or both) reads as DLSU — can't identify the opponent, so
    // treat the whole thing as descriptive text rather than inventing a matchup.
    return Object.assign(base, { opponent: '', hasOpponent: false });
  }

  return Object.assign(base, { opponent: leftIsDLSU ? right : left, hasOpponent: true });
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
  let lastTime = '';

  return rows.map((row, i) => {
    const day = resolveDayOfMonth_(row[COL.DAY], lastDay);
    const dayChanged = day !== lastDay;
    if (day !== null && day !== undefined) lastDay = day;

    const venue = resolveVenue_(row[COL.VENUE], lastVenue);
    lastVenue = venue;

    // Merged time cells only ever span rows within one day's block, so the fill
    // is dropped at every day boundary rather than leaking across dates.
    const time = resolveTime_(row[COL.TIME], dayChanged ? '' : lastTime);
    lastTime = time;

    return {
      sheetRow: FIRST_DATA_ROW + i,
      year,
      month: monthNumber,
      day,
      venue,
      time,
      row,
    };
  });
}

/**
 * §3.3 (revised again) — a row qualifies once column E has anything in it.
 *
 * This replaces the previous rule, which required an identifiable opponent. That
 * rule silently dropped every event the tracker carries that isn't a head-to-head
 * fixture: opening ceremonies, awardings, press conferences, and — the expensive
 * ones — every multi-day tournament session (Fencing Day 1, Athletics Day 2,
 * Golf Day 1). All of those are covered by staffers and need a roll call.
 *
 * The `Game day` column (G) is still not used: in the live tracker it reads "No"
 * on most real games, so it distinguishes nothing.
 *
 * Nothing is lost by being permissive here, because routing is the second gate —
 * an event whose text matches no Groups keyword goes to the admin chat with a
 * warning (§4.4) rather than to a GC. A spurious row surfaces there for a human
 * to look at instead of being discarded without trace.
 */
function isAnnounceableName_(parsedName) {
  return String(parsedName.raw || '').trim() !== '';
}

/**
 * §3.1-§3.7 combined — full pipeline for one month sheet: resolves dates,
 * venues and times (forward-filled), drops rows with no event name, and
 * returns fully parsed event objects (name, family, category, time,
 * deliverables, staffer names). Staffer *handle* resolution (Staffers tab
 * lookup) happens one layer up, since this function has no access to the
 * Staffers map; grouping into per-message digests happens one layer up too,
 * since it depends on the Groups tab's per-sport mode (§4.5).
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
      family: r.name.family,
      category: r.name.category,
      opponent: r.name.opponent,
      hasOpponent: r.name.hasOpponent,
      detail: r.name.detail,
      rawName: r.name.raw,
      venue: r.venue,
      time: parseTime_(r.time, tz),
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
