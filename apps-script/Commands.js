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
  const sports = collectSeasonSports_(config);
  if (!sports.length) {
    sendReply_(ctx.chatId, ctx.threadId, [
      'The tracker has no games in it yet, so there is nothing to map this GC to.',
      '',
      'Check that the month tabs are filled in, and that SEASON_START_YEAR in the Config tab is set to this season.',
    ].join('\n'));
    return;
  }

  const explicit = ctx.args.join(' ').trim();
  let keyword;
  let source;

  if (explicit) {
    keyword = explicit;
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
      ].join('\n'));
      return;
    }
    keyword = guess.keyword;
    source = `this GC's name ("${ctx.chatTitle}")`;
  }

  const matched = sports.filter((s) => sportMatchesKeyword_(s.sport, keyword));
  if (!matched.length) {
    sendReply_(ctx.chatId, ctx.threadId, [
      `Nothing in the tracker matches "${keyword}".`,
      '',
      'Sports in the tracker right now:',
      formatSportList_(sports, 15),
      '',
      'Run /rollsetup <keyword> with a word from one of those.',
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

  let result;
  try {
    result = upsertGroupMapping_({
      keyword: keyword,
      chatId: ctx.chatId,
      threadId: ctx.threadId,
      title: ctx.chatTitle,
    }, matched.map((s) => s.sport));
  } finally {
    lock.releaseLock();
  }

  const names = matched.map((s) => s.sport);
  const upcoming = matched.reduce((total, s) => total + s.upcoming, 0);
  const next = findNextEventForKeywords_(config, [keyword]);

  const lines = [
    result.action === 'updated' ? `Updated the mapping for: ${keyword}` : `Mapped this GC to: ${keyword}`,
    `Matched from ${source}.`,
    '',
    `Tracker sports it covers (${names.length}): ${names.slice(0, 4).join(', ')}${names.length > 4 ? `, +${names.length - 4} more` : ''}`,
    `Upcoming games: ${upcoming}`,
  ];
  if (next) lines.push(`Next: ${formatEventDate_(next)} — ${next.opponent} vs DLSU, ${next.time}`);

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
      `The next ${scope.label} game is ${formatEventDate_(event)} — ${days} days away.`,
      `${event.opponent} vs DLSU, ${event.time}`,
      '',
      'Nothing posted. That’s far enough out that it’s usually the wrong GC or the wrong sport.',
      'Run /rollcall force if you really do want it now.',
    ].join('\n'));
    return;
  }

  const eventKey = buildEventKey_(event);
  if (hasBeenSent_(eventKey) && !parsed.force) {
    sendReply_(ctx.chatId, ctx.threadId, [
      `Already posted: ${formatEventDate_(event)} — ${event.opponent} vs DLSU.`,
      '',
      'Nothing sent. Use /rollcall force to post it a second time (if the first got deleted, say).',
    ].join('\n'));
    return;
  }

  const target = resolveTarget_(event, getGroupMap(), getAdminChatId_());
  let message = renderMessage_(event, getStafferMap(), config);
  if (!target.matched) {
    message += `\n\n(⚠️ No Groups mapping for sport "${event.sport}" — posted to the admin chat. Add a row in the Groups tab.)`;
  }

  sendTelegramMessage_(message, { parseMode: 'HTML', chatId: target.chatId, threadId: target.threadId });
  logStatus_(eventKey, 'SENT', `${target.chatId}${target.threadId ? '/' + target.threadId : ''} (manual: ${ctx.userName})`);

  const lines = [
    `Posted: ${event.sport} — ${event.opponent} vs DLSU, ${formatEventDate_(event)}.`,
    `Sent to ${describeTarget_(target, ctx)}.`,
    'Logged as sent, so tonight’s run will skip it.',
  ];
  if (parsed.force && days <= MANUAL_PUSH_WARN_DAYS) lines.push('(forced — the duplicate check was skipped)');
  if (config.DRY_RUN) {
    lines.push('', 'Note: DRY_RUN is TRUE, so the nightly run is still paused. This manual post went out anyway.');
  }
  if (!target.matched) {
    lines.push('', `⚠️ "${event.sport}" has no Groups rule, so it went to the admin chat. Run /rollsetup in the right GC.`);
  }

  sendReply_(ctx.chatId, ctx.threadId, lines.join('\n'));
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

  const days = daysUntil_(event, todayInManila_());
  const sent = hasBeenSent_(buildEventKey_(event));
  const target = resolveTarget_(event, getGroupMap(), getAdminChatId_());

  const header = [
    `Next up for ${scope.label}:`,
    `${formatEventDate_(event)} — ${event.opponent} vs DLSU, ${event.time}`,
    `${days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `In ${days} days`} · goes to ${describeTarget_(target, ctx)}`,
    sent ? 'Status: already posted — /rollcall would skip it.' : 'Status: not posted yet.',
    '',
    '— preview only, nothing has been sent —',
    '',
  ].join('\n');

  sendReply_(ctx.chatId, ctx.threadId, header + renderPreview_(event, getStafferMap(), config));
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
      lines.push(`  ${r.label} → ${r.threadId ? `thread ${r.threadId}` : 'main view'} (Groups row ${r.rowNumber})`);
    });

    const event = findNextEventForKeywords_(config, rows.map((r) => r.keyword));
    lines.push(event
      ? `Next game: ${formatEventDate_(event)} — ${event.opponent} vs DLSU`
      : 'Next game: none upcoming in the tracker.');
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
      lines.push(`• ${g.label} → ${where} ${g.threadId ? `(thread ${g.threadId})` : '(main view)'}`);
    });
  }

  const sports = collectSeasonSports_(config);
  const unmapped = sports.filter(
    (s) => s.upcoming > 0 && !map.some((g) => sportMatchesKeyword_(s.sport, g.keyword))
  );

  lines.push('');
  if (unmapped.length) {
    lines.push(`No GC yet — these have upcoming games (${unmapped.length}):`);
    unmapped.slice(0, 12).forEach((s) => {
      lines.push(`• ${s.sport} — ${s.upcoming} upcoming, next ${formatEventDate_(s.next)}`);
    });
    if (unmapped.length > 12) lines.push(`…and ${unmapped.length - 12} more`);
    lines.push('', 'Until a GC is mapped, their roll calls go to the admin chat with a warning.');
  } else {
    lines.push('Every sport with upcoming games has a GC. ✅');
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
    'TLS Roll Call bot — posts each game’s roll call the night before, from the coverage tracker.',
    '',
    '/rollsetup [sport] — map this topic as the sport’s Roll Call thread (admins)',
    '/rollcall [sport] [force] — post the next roll call for this GC now (admins)',
    '/next — preview the next game and its roll call; posts nothing',
    '/rollwhere — IDs, mapping, and bot status for this topic',
    '/groups — every mapping, plus sports with no GC yet',
    '/unmap — stop routing roll calls to this topic (admins)',
    '',
    rows.length
      ? `This GC is mapped to: ${rows.map((r) => r.label).join(', ')}`
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
