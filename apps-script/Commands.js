/**
 * Chat command handlers (SPEC.md §12). Routing and the webhook live in
 * Webhook.js; everything here assumes it has been handed a `ctx`:
 *
 *   { message, chatId, threadId, chatTitle, chatType, userId, userName, args }
 *
 * Every handler replies in the topic the command was typed in — including on
 * refusal. A command that fails silently is worse than one that fails.
 */

/**
 * A manual push further out than this is almost always a mistake (the wrong GC,
 * or a sport whose season hasn't started), so it asks for `force` first.
 */
const MANUAL_PUSH_WARN_DAYS = 14;

// ---------------------------------------------------------------------
// /rollsetup — map this GC to a sport, from inside Telegram
// ---------------------------------------------------------------------

/**
 * Reads the chat and thread IDs off its own update, works out which sport the
 * GC covers, checks that sport actually exists in the tracker, and writes the
 * Groups row. Nothing to copy, paste, or look up.
 *
 * With no argument the sport is inferred from the group's title; `/rollsetup <word>`
 * overrides that. Either way the keyword is only accepted if it matches a sport
 * the tracker really has — a mapping to a sport nobody plays is a roll call
 * that never fires, and it would fail silently months later.
 */
function handleSetup_(ctx) {
  if (!requireAdmin_(ctx, '/rollsetup')) return;

  const config = getConfig();
  const parsed = splitSetupArgs_(ctx.args);

  // `/rollsetup session` with no keyword: adjust what is already mapped here.
  // Changing a sport's mode is a routine mid-season correction, and retyping the
  // keyword list to do it is exactly the friction this command exists to remove.
  if (!parsed.keyword && parsed.mode) {
    changeModeHere_(ctx, parsed.mode);
    return;
  }

  const sports = collectSeasonSports_(config);
  if (!sports.length && !parsed.force) {
    sendReply_(ctx.chatId, ctx.threadId, [
      'The tracker has no events in it yet, so there is nothing to map this GC to.',
      '',
      'Check that the month tabs are filled in, and that SEASON_START_YEAR in the Config tab is set to this season.',
      'If you are setting this GC up ahead of the schedule, run /rollsetup <sport> force.',
    ].join('\n'));
    return;
  }

  let keyword;
  let source;

  if (parsed.keyword) {
    keyword = parsed.keyword;
    source = 'the keyword you typed';
  } else {
    const guess = guessSportKeyword_(ctx.chatTitle, sports);
    if (!guess) {
      sendReply_(ctx.chatId, ctx.threadId, [
        `I couldn't tell which sport this GC covers from its name ("${ctx.chatTitle}").`,
        '',
        'Sports in the tracker right now:',
        formatSportList_(sports, 15),
        '',
        'Run /rollsetup <keyword> with a word from one of those — e.g. /rollsetup Football',
        'Several keywords are fine when a GC covers sports that share no word:',
        '  /rollsetup esports, valorant, nba2k',
      ].join('\n'));
      return;
    }
    keyword = guess.keyword;
    source = `this GC's name ("${ctx.chatTitle}")`;
  }

  const matched = sports.filter((s) => sportMatchesKeyword_(s.sport, keyword));

  // The guard exists because a mapping to a sport nobody plays is a roll call
  // that never fires and fails silently months later. `force` is for the one
  // legitimate case — building a GC before its month tab is filled in.
  if (!matched.length && !parsed.force) {
    sendReply_(ctx.chatId, ctx.threadId, [
      `Nothing in the tracker matches "${keyword}".`,
      '',
      'Sports in the tracker right now:',
      formatSportList_(sports, 15),
      '',
      'Run /rollsetup <keyword> with a word from one of those.',
      `If this sport just isn't in the sheet yet, /rollsetup ${keyword} force maps it anyway.`,
    ].join('\n'));
    return;
  }

  // Snapshot before the write: this is what *else* already points at this GC.
  const alsoHere = getGroupMap().filter(
    (g) => g.chatId === String(ctx.chatId) && g.keyword !== normalizeForMatch_(keyword)
  );

  // The Groups write is read-modify-write (it may insert a row), so serialise
  // concurrent /rollsetup calls from different GCs.
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (err) {
    sendReply_(ctx.chatId, ctx.threadId, 'Another setup is running right now — try again in a moment.');
    return;
  }

  // No mode typed and none on file: read the tracker for a hint. Sports that
  // number their days ("Fencing Day 1", "Golf Day 2") run as one block, which is
  // the shape session mode exists for — so suggest it rather than making the
  // choice a thing you have to know about in advance.
  const suggestSession = !parsed.mode && looksLikeSessionSport_(config, keyword);

  let result;
  try {
    result = upsertGroupMapping_({
      keyword: keyword,
      chatId: ctx.chatId,
      threadId: ctx.threadId,
      title: ctx.chatTitle,
      mode: parsed.mode,
    }, matched.map((s) => s.sport));
  } finally {
    lock.releaseLock();
  }

  const names = matched.map((s) => s.sport);
  const upcoming = matched.reduce((total, s) => total + s.upcoming, 0);
  const next = findNextEventForKeywords_(config, splitKeywords_(keyword));

  const lines = [
    result.action === 'updated' ? `Updated the mapping for: ${keyword}` : `Mapped this GC to: ${keyword}`,
    `Matched from ${source}.`,
    '',
    `Tracker sports it covers (${names.length}): ${names.slice(0, 4).join(', ')}${names.length > 4 ? `, +${names.length - 4} more` : ''}`,
    `Upcoming events: ${upcoming}`,
  ];
  if (next) lines.push(`Next: ${formatEventDate_(next)} — ${describeEvent_(next)}, ${next.time}`);

  lines.push('', describeMode_(result.mode));
  if (suggestSession && result.mode !== GROUP_MODES.SESSION) {
    lines.push(
      `⚠️ The tracker numbers this sport's days ("Day 1", "Day 2"), which usually means the categories play as one block.`,
      'If so, run /rollsetup session here and they will post as a single roll call instead.'
    );
  }

  if (!matched.length) {
    lines.push('', `⚠️ Nothing in the tracker matches "${keyword}" yet — mapped anyway because you passed force.`,
      'Roll calls start once the month tab has events whose names contain that keyword.');
  }

  lines.push('');
  lines.push(ctx.threadId
    ? `Roll calls will post in this topic (thread ${ctx.threadId}).`
    : 'Roll calls will post in this group’s main view — you ran /rollsetup outside a topic. If this GC has a Roll Call topic, run /rollsetup there and the mapping moves.');
  lines.push(`Chat ${ctx.chatId} · Groups tab row ${result.rowNumber}`);

  if (result.above) {
    lines.push('', `Placed above the "${result.above}" rule, so these games route here first.`);
  }
  if (result.duplicates) {
    lines.push('', `⚠️ ${result.duplicates} other Groups row(s) use this same keyword. The topmost wins — delete the rest.`);
  }
  if (alsoHere.length) {
    lines.push('', `Note: ${alsoHere.map((g) => g.label).join(', ')} also route(s) to this GC.`);
  }
  if (config.DRY_RUN) {
    lines.push('', '⚠️ DRY_RUN is TRUE in the Config tab — the nightly run is paused and will send nothing. Set it to FALSE to go live.');
  }
  lines.push('', 'Check it with /next. Post one now with /rollcall.');

  sendReply_(ctx.chatId, ctx.threadId, lines.join('\n'));
}

// ---------------------------------------------------------------------
// /rollcall — push this GC's next roll call now
// ---------------------------------------------------------------------

/**
 * Finds the soonest upcoming game for this GC's sport and posts its roll call
 * immediately, then records it as SENT so the nightly run skips it. The whole
 * point is that a manual push and the automatic one can never both fire for the
 * same game.
 *
 * `/rollcall <sport>` targets another GC's sport (handy from the admin chat);
 * `/rollcall force` overrides both the already-sent check and the "that game is
 * weeks away" guard.
 *
 * Deliberately ignores DRY_RUN: it pauses the *unattended* run, and someone
 * typing a command is not unattended. The reply says so when it applies.
 */
function handleRollcall_(ctx) {
  if (!requireAdmin_(ctx, '/rollcall')) return;

  const parsed = splitRollcallArgs_(ctx.args);
  const scope = resolveCommandScope_(ctx, parsed.keyword);
  if (!scope) return;

  const config = getConfig();
  const event = findNextEventForKeywords_(config, scope.keywords);
  if (!event) {
    sendReply_(ctx.chatId, ctx.threadId,
      `No upcoming games for ${scope.label} left in the tracker.\n` +
      'Either the season is done or the month tab isn’t filled in yet.');
    return;
  }

  const today = todayInManila_();
  const days = daysUntil_(event, today);
  if (days > MANUAL_PUSH_WARN_DAYS && !parsed.force) {
    sendReply_(ctx.chatId, ctx.threadId, [
      `The next ${scope.label} event is ${formatEventDate_(event)} — ${days} days away.`,
      `${describeEvent_(event)}, ${event.time}`,
      '',
      'Nothing posted. That’s far enough out that it’s usually the wrong GC or the wrong sport.',
      'Run /rollcall force if you really do want it now.',
    ].join('\n'));
    return;
  }

  // Push the whole MESSAGE the nightly run would send, not just the row that
  // happened to be found first. For a session-mode sport that means the entire
  // day — posting one fencing bout and leaving the other two would be worse than
  // not posting at all.
  const group = buildGroupForEvent_(event, config);
  if (!group) {
    sendReply_(ctx.chatId, ctx.threadId, 'Found that event but couldn’t rebuild its roll call — check the Groups tab.');
    return;
  }

  const groupKey = buildGroupKey_(group);
  const prior = findPriorSend_(group);
  if (prior && !parsed.force) {
    sendReply_(ctx.chatId, ctx.threadId, [
      `Already posted: ${formatEventDate_(event)} — ${describeGroup_(group)}.`,
      '',
      prior.sameMode
        ? 'Nothing sent. Use /rollcall force to post it a second time (if the first got deleted, say).'
        : 'It went out under this sport’s previous mode, before you changed it. Nothing sent — check the GC first, then /rollcall force if the roll call really is missing.',
    ].join('\n'));
    return;
  }

  const target = group.target;
  let message = renderDigest_(group, getStafferMap(), config);
  if (!target.matched) {
    message += `\n\n(⚠️ No Groups mapping for "${group.events[0].rawName}" — posted to the admin chat. Add a row in the Groups tab.)`;
  }

  sendTelegramMessage_(message, { parseMode: 'HTML', chatId: target.chatId, threadId: target.threadId });
  logStatus_(groupKey, 'SENT', `${target.chatId}${target.threadId ? '/' + target.threadId : ''} (manual: ${ctx.userName})`);

  const lines = [
    `Posted: ${describeGroup_(group)}, ${formatEventDate_(event)}.`,
    `Sent to ${describeTarget_(target, ctx)}.`,
    'Logged as sent, so tonight’s run will skip it.',
  ];
  if (group.events.length > 1) {
    lines.push(`Covered ${group.events.length} rows in one message (${group.family} runs in session mode).`);
  }
  if (parsed.force && days <= MANUAL_PUSH_WARN_DAYS) lines.push('(forced — the duplicate check was skipped)');
  if (config.DRY_RUN) {
    lines.push('', 'Note: DRY_RUN is TRUE, so the nightly run is still paused. This manual post went out anyway.');
  }
  if (!target.matched) {
    lines.push('', `⚠️ "${event.rawName}" has no Groups rule, so it went to the admin chat. Run /rollsetup in the right GC.`);
  }

  sendReply_(ctx.chatId, ctx.threadId, lines.join('\n'));
}

/**
 * The message one event belongs to. Re-reads its month tab so the neighbouring
 * rows are available: a session-mode group is defined by what shares its date
 * and family, which a single event object can't know on its own.
 */
function buildGroupForEvent_(event, config) {
  const monthName = MONTH_NAMES[event.month - 1];
  const events = parseMonthEvents(
    readMonthRows_(monthName), monthName, config, getSpreadsheetTimeZone_()
  );
  const sameDay = filterEventsForDate_(events, {
    year: event.year, month: event.month, day: event.day,
  });

  const groups = groupEventsForSending_(sameDay, getGroupMap(), getAdminChatId_());
  return groups.find((g) => g.events.some((e) => e.sheetRow === event.sheetRow)) || null;
}

// ---------------------------------------------------------------------
// /next — preview without posting
// ---------------------------------------------------------------------

/**
 * The dry run for /rollcall: same lookup, same message, nothing sent and
 * nothing written to the ledger. Open to everyone — a staffer checking whether
 * they're on tomorrow's roll call shouldn't need admin.
 */
function handleNext_(ctx) {
  const parsed = splitRollcallArgs_(ctx.args);
  const scope = resolveCommandScope_(ctx, parsed.keyword);
  if (!scope) return;

  const config = getConfig();
  const event = findNextEventForKeywords_(config, scope.keywords);
  if (!event) {
    sendReply_(ctx.chatId, ctx.threadId, `No upcoming games for ${scope.label} left in the tracker.`);
    return;
  }

  const group = buildGroupForEvent_(event, config);
  if (!group) {
    sendReply_(ctx.chatId, ctx.threadId, 'Found that event but couldn’t rebuild its roll call — check the Groups tab.');
    return;
  }

  const days = daysUntil_(event, todayInManila_());
  const sent = findPriorSend_(group);
  const target = group.target;

  const header = [
    `Next up for ${scope.label}:`,
    `${formatEventDate_(event)} — ${describeGroup_(group)}, ${collapseTimes_(group.events)}`,
    `${days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `In ${days} days`} · goes to ${describeTarget_(target, ctx)}`,
    group.events.length > 1
      ? `Collated: ${group.events.length} rows in one message (${group.family} is in session mode).`
      : `Posting: one message per event (${group.family || 'this sport'} is in event mode).`,
    sent
      ? (sent.sameMode
        ? 'Status: already posted — /rollcall would skip it.'
        : 'Status: already posted under this sport’s previous mode — /rollcall would skip it.')
      : 'Status: not posted yet.',
    '',
    '— preview only, nothing has been sent —',
    '',
  ].join('\n');

  sendReply_(ctx.chatId, ctx.threadId, header + renderPreview_(group, getStafferMap(), config));
}

// ---------------------------------------------------------------------
// /rollwhere — IDs and status for this topic
// ---------------------------------------------------------------------

/**
 * Everything you'd otherwise dig out of getUpdates and the Config tab, in one
 * reply. The fast way to tell a missing mapping from a wrong one.
 */
function handleWhereami_(ctx) {
  const config = getConfig();
  const rows = findGroupRowsForChat_(ctx.chatId, ctx.threadId);

  const lines = [
    `Group: ${ctx.chatTitle || '(no title)'}`,
    `Chat ID: ${ctx.chatId}`,
    `Thread ID: ${ctx.threadId === undefined || ctx.threadId === null ? '(none — main view)' : ctx.threadId}`,
    '',
  ];

  if (!rows.length) {
    lines.push('Mapped: no — run /rollsetup here (in the Roll Call topic).');
  } else {
    lines.push(`Mapped: ${rows.map((r) => r.label).join(', ')}`);
    rows.forEach((r) => {
      lines.push(`  ${r.label} [${r.mode}] → ${r.threadId ? `thread ${r.threadId}` : 'main view'} (Groups row ${r.rowNumber})`);
    });

    const event = findNextEventForKeywords_(config, rows.map((r) => r.keyword));
    lines.push(event
      ? `Next event: ${formatEventDate_(event)} — ${describeEvent_(event)}`
      : 'Next event: none upcoming in the tracker.');
  }

  lines.push(
    '',
    'Bot status',
    `DRY_RUN: ${config.DRY_RUN ? 'TRUE — nightly sends are paused' : 'FALSE — live'}`,
    `Season: ${config.SEASON_START_YEAR}, starting month ${config.SEASON_START_MONTH}`,
    `Lead days: ${config.LEAD_DAYS} (roll calls go out the night before)`,
    `Nightly trigger: ${describeNightlyTrigger_()}`
  );

  sendReply_(ctx.chatId, ctx.threadId, lines.join('\n'));
}

/** Whether the 7 PM trigger that actually runs the bot is installed. */
function describeNightlyTrigger_() {
  try {
    const count = ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === 'main').length;
    return count ? `installed${count > 1 ? ` (${count} — one is enough, delete the extras)` : ''}` : 'NOT installed — run createDailyTrigger() in the editor';
  } catch (err) {
    return `couldn't check (${err})`;
  }
}

// ---------------------------------------------------------------------
// /groups — coverage across the whole season
// ---------------------------------------------------------------------

/**
 * Every mapping, in priority order, and — the part that earns its keep — the
 * sports with upcoming games that have no GC yet. That second list is the
 * season's onboarding to-do list.
 */
function handleGroups_(ctx) {
  const config = getConfig();
  const map = getGroupMap();
  const allRows = readGroupRows_().filter((r) => r.keyword);
  const lines = [];

  if (!map.length) {
    lines.push('No sports are mapped yet.', 'Open a GC’s Roll Call topic and run /rollsetup there.');
  } else {
    lines.push(`Mapped sports (${map.length}), in priority order:`);
    map.forEach((g) => {
      const where = g.title || `chat ${g.chatId}`;
      lines.push(
        `• ${g.label} [${g.mode}] → ${where} ${g.threadId ? `(thread ${g.threadId})` : '(main view)'}`
      );
    });
    lines.push('', 'session = one roll call per day, all categories merged. event = one per fixture.');
  }

  const sports = collectSeasonSports_(config);
  const unmapped = sports.filter(
    (s) => s.upcoming > 0 && !map.some((g) => sportMatchesKeyword_(s.sport, g.keyword))
  );

  lines.push('');
  if (unmapped.length) {
    lines.push(`No GC yet — these have upcoming events (${unmapped.length}):`);
    unmapped.slice(0, 12).forEach((s) => {
      lines.push(`• ${s.sport} — ${s.upcoming} upcoming, next ${formatEventDate_(s.next)}`);
    });
    if (unmapped.length > 12) lines.push(`…and ${unmapped.length - 12} more`);
    lines.push('', 'Until a GC is mapped, their roll calls go to the admin chat with a warning.');
  } else {
    lines.push('Every sport with upcoming events has a GC. ✅');
  }

  const retired = allRows.filter((r) => !r.active).length;
  const incomplete = allRows.filter((r) => r.active && !r.chatId).length;
  if (retired) lines.push('', `${retired} retired row(s) in the Groups tab (Active = FALSE).`);
  if (incomplete) lines.push(`${incomplete} row(s) have no Chat ID and are being ignored.`);

  sendReply_(ctx.chatId, ctx.threadId, lines.join('\n'));
}

// ---------------------------------------------------------------------
// /unmap — stop routing here
// ---------------------------------------------------------------------

function handleUnmap_(ctx) {
  if (!requireAdmin_(ctx, '/unmap')) return;

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (err) {
    sendReply_(ctx.chatId, ctx.threadId, 'The tracker is busy right now — try again in a moment.');
    return;
  }

  let retired;
  try {
    retired = deactivateGroupMappings_(ctx.chatId, ctx.threadId);
  } finally {
    lock.releaseLock();
  }

  if (!retired.length) {
    sendReply_(ctx.chatId, ctx.threadId, 'Nothing to unmap — no active mapping points at this GC.');
    return;
  }

  sendReply_(ctx.chatId, ctx.threadId, [
    `Stopped routing to ${ctx.threadId ? 'this topic' : 'this GC'}: ${retired.join(', ')}`,
    '',
    'The rows are marked Active = FALSE in the Groups tab, not deleted — set them back to TRUE to undo, or just run /rollsetup here again.',
    'Until then those roll calls go to the admin chat with a warning, so nothing is lost.',
  ].join('\n'));
}

// ---------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------

function handleHelp_(ctx) {
  const rows = findGroupRowsForChat_(ctx.chatId, ctx.threadId);

  sendReply_(ctx.chatId, ctx.threadId, [
    'TLS Roll Call bot — posts each event’s roll call the night before, from the coverage tracker.',
    '',
    '/rollsetup [sports] [session|event] [force] — map this topic as the Roll Call thread (admins)',
    '/rollcall [sport] [force] — post the next roll call for this GC now (admins)',
    '/next — preview the next roll call; posts nothing',
    '/rollwhere — IDs, mapping, and bot status for this topic',
    '/groups — every mapping, plus sports with no GC yet',
    '/unmap — stop routing roll calls to this topic (admins)',
    '',
    'Setup examples:',
    '  /rollsetup — infer the sport from this GC’s name',
    '  /rollsetup esports, valorant, nba2k — one GC covering sports that share no word',
    '  /rollsetup fencing session — merge a day’s categories into one roll call',
    '  /rollsetup session — change only the mode of what’s already mapped here',
    '  /rollsetup taekwondo force — map ahead of the tracker being filled in',
    '',
    rows.length
      ? `This GC is mapped to: ${rows.map((r) => `${r.label} [${r.mode}]`).join(', ')}`
      : 'This GC is not mapped yet — run /rollsetup in its Roll Call topic.',
  ].join('\n'));
}

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

/**
 * Gate for the commands that write to the tracker or post to a whole GC.
 * Replies with the reason and returns false when the check fails.
 */
function requireAdmin_(ctx, command) {
  if (ctx.chatType !== 'group' && ctx.chatType !== 'supergroup') {
    sendReply_(ctx.chatId, ctx.threadId,
      `${command} only works inside a sport’s group chat — open the GC and run it there.`);
    return false;
  }
  if (!isChatAdmin_(ctx.chatId, ctx.userId)) {
    sendReply_(ctx.chatId, ctx.threadId,
      `Only group admins can run ${command} — it writes to the tracker and posts to the whole GC.\n` +
      '(Anonymous admin posts carry no user, so they don’t pass this check. Post normally.)');
    return false;
  }
  return true;
}

/**
 * Which sport a command is about, and which mapping rows own it. An explicit
 * keyword wins; otherwise it's whatever this GC is mapped to. Replies and
 * returns null when it can't be resolved, so callers just bail on null.
 */
function resolveCommandScope_(ctx, keywordArg) {
  if (keywordArg) {
    const row = findGroupByKeyword_(keywordArg);
    if (!row) {
      sendReply_(ctx.chatId, ctx.threadId,
        `No mapping for "${keywordArg}". /groups lists what is mapped.`);
      return null;
    }
    return { rows: [row], keywords: [row.keyword], label: row.label };
  }

  const rows = findGroupRowsForChat_(ctx.chatId, ctx.threadId);
  if (!rows.length) {
    sendReply_(ctx.chatId, ctx.threadId, [
      'This GC isn’t mapped to a sport yet.',
      '',
      'Open its Roll Call topic and run /rollsetup — or name the sport directly, e.g. /next Football',
    ].join('\n'));
    return null;
  }

  return { rows, keywords: rows.map((r) => r.keyword), label: rows.map((r) => r.label).join(' / ') };
}

/**
 * Splits `/rollsetup baseball, softball session force` into
 * { keyword: 'baseball, softball', mode: 'session', force: true }.
 *
 * Order-independent: `session`, `event` and `force` are recognised wherever they
 * appear, and everything else is keyword text. The keyword tokens are rejoined
 * with spaces rather than commas so a list survives Telegram's tokenising —
 * "baseball," and "softball" come back as "baseball, softball".
 */
function splitSetupArgs_(args) {
  const rest = [];
  let mode = '';
  let force = false;

  (args || []).forEach((arg) => {
    const token = String(arg).toLowerCase().replace(/,+$/, '');
    if (token === GROUP_MODES.SESSION || token === GROUP_MODES.EVENT) mode = token;
    else if (token === 'force') force = true;
    else rest.push(arg);
  });

  return { keyword: rest.join(' ').trim().replace(/,+$/, ''), mode, force };
}

/** `/rollsetup session` — retune what is already mapped here, nothing else. */
function changeModeHere_(ctx, mode) {
  const rows = findGroupRowsForChat_(ctx.chatId, ctx.threadId);
  if (!rows.length) {
    sendReply_(ctx.chatId, ctx.threadId, [
      `Nothing is mapped here yet, so there is no mode to change.`,
      '',
      'Map the sport first — e.g. /rollsetup fencing ' + mode,
    ].join('\n'));
    return;
  }

  rows.forEach((r) => setGroupMode_(r.rowNumber, mode));

  sendReply_(ctx.chatId, ctx.threadId, [
    `Set ${rows.map((r) => r.label).join(', ')} to ${mode} mode.`,
    '',
    describeMode_(mode),
    '',
    'Check it with /next.',
  ].join('\n'));
}

/** One sentence on what a mode actually does, for every reply that reports one. */
function describeMode_(mode) {
  return mode === GROUP_MODES.SESSION
    ? 'Mode: session — everything this rule covers on one date posts as a SINGLE roll call, with the categories listed inside it.'
    : 'Mode: event — each fixture gets its own roll call.';
}

/**
 * Whether the tracker numbers this sport's days. "Fencing Day 1", "Athletics Day
 * 2" and "Golf Day 1" are how a block-format competition is written down, and
 * they are the sports that want session mode — so /rollsetup can suggest it
 * instead of leaving the setting to be discovered.
 *
 * Only a hint: Chess and 3x3 also run as sessions and carry no such marker.
 */
function looksLikeSessionSport_(config, keyword) {
  const keywords = splitKeywords_(keyword);
  const events = findUpcomingEvents_(
    config,
    todayInManila_(),
    (e) => keywords.some((k) => sportMatchesKeyword_(e.sport, k) || sportMatchesKeyword_(e.rawName, k)),
    8
  );
  return events.some((e) => /\bday\s*\d+/i.test(e.rawName));
}

/** Splits `/rollcall Football force` into { keyword: 'Football', force: true }. */
function splitRollcallArgs_(args) {
  const rest = [];
  let force = false;

  (args || []).forEach((arg) => {
    if (String(arg).toLowerCase() === 'force') force = true;
    else rest.push(arg);
  });

  return { keyword: rest.join(' ').trim(), force };
}

/** Where a send landed, phrased relative to where the command was typed. */
function describeTarget_(target, ctx) {
  const thread = target.threadId ? `thread ${target.threadId}` : 'the group’s main view';
  if (!ctx || String(ctx.chatId) !== String(target.chatId)) {
    return `chat ${target.chatId} / ${thread}`;
  }

  const here = ctx.threadId === undefined || ctx.threadId === null ? '' : String(ctx.threadId);
  return here === String(target.threadId || '') ? 'this topic' : `${thread} in this GC`;
}

/** Bulleted sport list for the "here's what the tracker has" replies. */
function formatSportList_(sports, limit) {
  const shown = sports.slice(0, limit).map((s) => `• ${s.sport} (${s.upcoming} upcoming)`);
  if (sports.length > limit) shown.push(`…and ${sports.length - limit} more`);
  return shown.join('\n');
}
