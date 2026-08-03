/**
 * Message rendering (SPEC.md §4). Pure string building — no SpreadsheetApp/
 * Telegram calls — so it can be exercised the same way as Parser.js.
 */

function escapeHtml_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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

/** §4.1/§4.2 — render the full Telegram message body for one event. */
function renderMessage_(event, stafferMap, config) {
  const monthName = MONTH_NAMES[event.month - 1];
  const showWarning = config.SHOW_UNASSIGNED_WARNING;

  const reminders = [];
  if (event.deliverables.indexOf('HN') !== -1) {
    reminders.push('Pls send HN at least 30 min before the game starts!');
  }
  if (event.deliverables.indexOf('Buzzer') !== -1) {
    reminders.push('And pls prep buzzer before the game ends!');
  }

  const lines = [
    'SPORTS @rollcall',
    '',
    escapeHtml_(event.sport),
    `${escapeHtml_(event.opponent)} vs DLSU`,
    `${monthName} ${event.day} (${event.weekday})`,
    `Time: ${escapeHtml_(event.time)}`,
    `Venue: ${escapeHtml_(event.venue)}`,
    '',
    renderStafferLine_('Recap', event.recapNames, stafferMap, showWarning),
    renderStafferLine_('Livetweet', event.livetweetNames, stafferMap, showWarning),
    '',
    "Don't forget to discuss w your co-writer on how to distribute captions!",
    '',
    `Deliverables: ${event.deliverables.join(', ')}`,
  ];

  if (reminders.length > 0) {
    lines.push('');
    lines.push(...reminders);
  }

  lines.push('');
  lines.push('Thank you so much & enjoy!');

  return lines.join('\n');
}

/**
 * The roll call as it will *appear* in Telegram, for the plain-text previews
 * the chat commands reply with. Command replies are sent without parse_mode
 * (see sendReply_), so the HTML entities renderMessage_ escapes would show up
 * literally as "&amp;" in a preview — unescaping is what makes the preview an
 * honest picture of the real message. Order matters: & last, or "&amp;lt;"
 * would collapse into "<".
 */
function renderPreview_(event, stafferMap, config) {
  return renderMessage_(event, stafferMap, config)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
