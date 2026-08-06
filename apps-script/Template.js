/**
 * Grouping + message rendering (SPEC.md §4). Pure string building — no
 * SpreadsheetApp/Telegram calls — so it can be exercised the same way as
 * Parser.js.
 *
 * One renderer serves both modes (§4.5). A single football game and a fencing
 * day with three sessions produce the same shape of message; the only difference
 * is how many lines sit above the title. Two templates would drift apart, and a
 * GC would see two different-looking roll calls depending on the sport.
 */

function escapeHtml_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------
// Grouping (§4.5)
// ---------------------------------------------------------------------

/**
 * Turn a day's parsed events into the messages that will actually be sent.
 *
 * `event`-mode rules produce one group per row: each football game stands alone
 * and gets its own roll call. `session`-mode rules merge every row sharing a
 * destination, a date and a sport family into one — which is what turns three
 * `Fencing Day 1:` rows into a single message, and Men's + Women's 3x3 into one.
 *
 * Routing decides the mode, so an unmapped event (admin chat) always falls into
 * `event` mode and is never silently merged with anything else.
 */
function groupEventsForSending_(events, groupMap, adminChatId) {
  const groups = [];
  const byKey = {};

  events.forEach((event) => {
    const target = resolveTarget_(event, groupMap, adminChatId);

    const make = () => {
      const group = {
        year: event.year,
        month: event.month,
        day: event.day,
        weekday: event.weekday,
        family: event.family,
        mode: target.mode,
        target,
        events: [],
      };
      groups.push(group);
      return group;
    };

    if (target.mode !== GROUP_MODES.SESSION) {
      make().events.push(event);
      return;
    }

    const key = [
      event.year, event.month, event.day,
      target.chatId, target.threadId,
      normalizeForMatch_(event.family),
    ].join('|');

    (byKey[key] || (byKey[key] = make())).events.push(event);
  });

  return groups;
}

// ---------------------------------------------------------------------
// Field collapsing
// ---------------------------------------------------------------------

/** "10:00 am" → 600, for ordering. Free-text times return null and sort last. */
function timeToMinutes_(value) {
  const m = String(value || '').match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (!m) return null;
  const hours = (parseInt(m[1], 10) % 12) + (/pm/i.test(m[3]) ? 12 : 0);
  return hours * 60 + parseInt(m[2], 10);
}

/** House style writes a round hour as "10 am", not "10:00 am". */
function prettyTime_(value) {
  return String(value || '').replace(/:00(\s*[ap]m)/i, '$1');
}

/**
 * One Time line for the whole group. Sessions that all start together read
 * "Time: 10 am"; a fencing day running 9 AM and 1 PM reads "Time: Beginning at
 * 9 am", because the roll call is telling staffers when to show up, not
 * reproducing the schedule.
 */
function collapseTimes_(events) {
  const times = events.map((e) => e.time).filter((t) => String(t || '').trim() !== '');
  if (!times.length) return 'TBA';

  const distinct = times.filter((t, i) => times.indexOf(t) === i);
  if (distinct.length === 1) return prettyTime_(distinct[0]);

  const sorted = distinct.slice().sort((a, b) => {
    const am = timeToMinutes_(a);
    const bm = timeToMinutes_(b);
    if (am === null && bm === null) return 0;
    if (am === null) return 1;
    if (bm === null) return -1;
    return am - bm;
  });
  return `Beginning at ${prettyTime_(sorted[0])}`;
}

/** Distinct venues in sheet order. Usually one — merged cells see to that. */
function collapseVenues_(events) {
  const venues = events.map((e) => String(e.venue || '').trim()).filter(Boolean);
  const distinct = venues.filter((v, i) => venues.indexOf(v) === i);
  return distinct.length ? distinct.join(', ') : 'TBA';
}

/** Union of the group's deliverables, re-emitted in column order (§3.7). */
function unionDeliverables_(events) {
  const seen = {};
  events.forEach((e) => (e.deliverables || []).forEach((d) => { seen[d] = true; }));

  return Object.keys(DELIVERABLE_LABELS)
    .map((key) => DELIVERABLE_LABELS[key])
    .filter((label) => seen[label]);
}

/** Union of a staffer column across the group, deduplicated, order preserved. */
function unionStafferNames_(events, field) {
  const seen = {};
  const names = [];

  events.forEach((e) => (e[field] || []).forEach((name) => {
    const key = name.toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    names.push(name);
  }));

  return names;
}

// ---------------------------------------------------------------------
// Headline block
// ---------------------------------------------------------------------

/** Men's before Women's, anything unrecognised last. */
const CATEGORY_ORDER = ["Men's", "Women's", 'Boys', 'Girls'];

function categoryRank_(category) {
  const idx = CATEGORY_ORDER.indexOf(category);
  return idx === -1 ? CATEGORY_ORDER.length : idx;
}

/**
 * §4.1 — the lines above the title: what is actually happening.
 *
 * Rows with an opponent collapse per category, so five chess games become two
 * lines: "[FEU, UST] vs DLSU [Men's]" and "[ADMU, UST, FEU] vs DLSU [Women's]".
 * A single opponent skips the brackets — they exist to punctuate a list.
 *
 * Rows without an opponent contribute their own detail text instead ("Men's
 * Sabre Individual"), which is what a fencing or athletics day is made of. A
 * group can contain both, and opponents lead.
 */
function renderHeadlineLines_(events) {
  const lines = [];
  const byCategory = {};
  const categories = [];

  events.filter((e) => e.hasOpponent).forEach((e) => {
    const category = e.category || '';
    if (!byCategory[category]) {
      byCategory[category] = [];
      categories.push(category);
    }
    if (byCategory[category].indexOf(e.opponent) === -1) byCategory[category].push(e.opponent);
  });

  categories
    .sort((a, b) => categoryRank_(a) - categoryRank_(b))
    .forEach((category) => {
      const opponents = byCategory[category].map(escapeHtml_);
      const list = opponents.length > 1 ? `[${opponents.join(', ')}]` : opponents[0];
      lines.push(`${list} vs DLSU${category ? ` [${escapeHtml_(category)}]` : ''}`);
    });

  events.filter((e) => !e.hasOpponent).forEach((e) => {
    lines.push(escapeHtml_(e.detail || e.rawName));
  });

  return lines;
}

/**
 * §4.1 — the title line. Normally "UAAP Season 88 Fencing Tournament", built
 * from SEASON_NUMBER and the sport family.
 *
 * Events already named "UAAP ..." are the exception: ceremonies, shows and press
 * conferences carry their own full title in the sheet, and wrapping one would
 * produce "UAAP Season 88 UAAP Season 88 Collegiate Basketball Press Conference
 * Tournament". Those render their name as typed.
 */
function renderTitle_(group, config) {
  const family = String(group.family || '').trim();
  if (!family || /^uaap\b/i.test(family)) return group.events[0].rawName;
  return `UAAP Season ${config.SEASON_NUMBER} ${family} Tournament`;
}

// ---------------------------------------------------------------------
// Staffer lines
// ---------------------------------------------------------------------

/** §3.5 — resolve each staffer name to its handle, or flag it if unknown. */
function resolveStafferHandles_(names, stafferMap) {
  return names.map((name) => {
    const handle = stafferMap[name.toLowerCase()];
    return handle ? handle : `${name} (no handle on file)`;
  });
}

/**
 * §4.2 — an unassigned column (no names) renders as a warning line when
 * SHOW_UNASSIGNED_WARNING is on; the warning *replaces* the normal line,
 * it doesn't appear alongside it.
 */
function renderStafferLine_(label, names, stafferMap, showUnassignedWarning) {
  if (names.length === 0 && showUnassignedWarning) {
    return `⚠️ ${label}: UNASSIGNED`;
  }
  const resolved = resolveStafferHandles_(names, stafferMap).map(escapeHtml_);
  return `${label}: ${resolved.join(', ')}`;
}

// ---------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------

/** §4.1/§4.2 — render the full Telegram message body for one group. */
function renderDigest_(group, stafferMap, config) {
  const events = group.events;
  const monthName = MONTH_NAMES[group.month - 1];
  const deliverables = unionDeliverables_(events);

  const reminders = [];
  if (deliverables.indexOf('HN') !== -1) {
    reminders.push('Pls send HN at least 30 min before the game starts!');
  }
  if (deliverables.indexOf('Buzzer') !== -1) {
    reminders.push('And pls prep buzzer before the game ends!');
  }

  const lines = [
    'SPORTS @rollcall',
    '',
    '📍',
    ...renderHeadlineLines_(events),
    escapeHtml_(renderTitle_(group, config)),
    `${monthName} ${group.day} (${group.weekday})`,
    `Time: ${escapeHtml_(collapseTimes_(events))}`,
    `Venue: ${escapeHtml_(collapseVenues_(events))}`,
    '',
    renderStafferLine_('Recap', unionStafferNames_(events, 'recapNames'), stafferMap, config.SHOW_UNASSIGNED_WARNING),
    renderStafferLine_('Livetweet', unionStafferNames_(events, 'livetweetNames'), stafferMap, config.SHOW_UNASSIGNED_WARNING),
    '',
    "Don't forget to discuss w your co-writer on how to distribute captions!!",
    '',
    'Deliverables:',
    deliverables.join(', '),
  ];

  if (reminders.length) {
    lines.push('');
    lines.push(reminders.join(' '));
  }

  lines.push('');
  lines.push('Thank you so much & enjoy! 😈');

  return lines.join('\n');
}

/**
 * The roll call as it will *appear* in Telegram, for the plain-text previews
 * the chat commands reply with. Command replies are sent without parse_mode
 * (see sendReply_), so the HTML entities renderDigest_ escapes would show up
 * literally as "&amp;" in a preview — unescaping is what makes the preview an
 * honest picture of the real message. Order matters: & last, or "&amp;lt;"
 * would collapse into "<".
 */
function renderPreview_(group, stafferMap, config) {
  return renderDigest_(group, stafferMap, config)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------
// Short descriptors (admin summary, command replies, error messages)
// ---------------------------------------------------------------------

/**
 * One event in a phrase, for logs and replies. Replaces the `${opponent} vs
 * DLSU` that used to be written out at a dozen call sites — which produced
 * "Opening ceremony vs DLSU" the moment events without an opponent were allowed
 * through (§3.3).
 */
function describeEvent_(event) {
  const headline = event.hasOpponent
    ? `${event.opponent} vs DLSU${event.category ? ` [${event.category}]` : ''}`
    : (event.detail || event.rawName);

  return event.family ? `${event.family} — ${headline}` : headline;
}

/** The same, for a whole group: a merged session names its size, not its rows. */
function describeGroup_(group) {
  if (group.events.length > 1) {
    return `${group.family} — ${group.events.length} events`;
  }
  return describeEvent_(group.events[0]);
}
