/**
 * Telegram webhook + command routing (SPEC.md §12).
 *
 * The nightly trigger posts roll calls; this file is how the bot *receives*.
 * Telegram POSTs every update to the Web App's /exec URL, doPost hands it to
 * handleUpdate_, and the handlers in Commands.js do the work.
 *
 * Deployment is the part that bites: the live webhook points at a specific
 * *deployment*, not at the editor code. After `clasp push`, edit the existing
 * deployment (Deploy → Manage deployments → ✏️ → New version). Creating a new
 * deployment mints a new /exec URL and silently breaks the webhook.
 */

const CMD = {
  SETUP: '/setup',
  ROLLCALL: '/rollcall',
  NEXT: '/next',
  WHEREAMI: '/whereami',
  GROUPS: '/groups',
  UNMAP: '/unmap',
  HELP: '/help',
  START: '/start',
};

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

/**
 * Webhook entry point. MUST always return 200 — Telegram retries anything else,
 * and a retried /rollcall is a double post in the GC.
 */
function doPost(e) {
  try {
    if (!webhookSecretOk_(e)) {
      console.warn('Rejected webhook POST: missing or wrong secret');
      return ContentService.createTextOutput('ok');
    }
    handleUpdate_(JSON.parse(e.postData.contents));
  } catch (err) {
    console.error(`doPost: ${(err && err.stack) || err}`);
  }
  return ContentService.createTextOutput('ok');
}

/**
 * A Web App deployed for "Anyone" is a public URL, and anyone who learns it can
 * POST a forged update. Apps Script can't read request headers, so Telegram's
 * own `secret_token` header is unusable here — the secret rides in the query
 * string instead, set once by setupWebhook().
 *
 * Optional: with WEBHOOK_SECRET unset the endpoint stays open, which is the
 * behaviour you get before anyone configures it. Set it.
 */
function webhookSecretOk_(e) {
  const expected = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
  if (!expected) return true;
  return !!(e && e.parameter && e.parameter.secret === expected);
}

// ---------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------

function handleUpdate_(update) {
  if (!update || typeof update.update_id === 'undefined') return;

  // The bot being added to (or removed from) a group.
  if (update.my_chat_member) {
    handleMembershipChange_(update.my_chat_member);
    return;
  }

  // Edited messages are deliberately ignored: editing "/next" into "/rollcall"
  // should not fire a post.
  const message = update.message;
  if (!message || !message.text) return;

  const parsed = parseCommand_(message.text);
  if (!parsed) return;

  const chat = message.chat || {};
  const ctx = {
    message: message,
    chatId: chat.id,
    threadId: message.message_thread_id,
    chatTitle: chat.title || '',
    chatType: chat.type || '',
    userId: message.from && message.from.id,
    userName: describeUser_(message.from),
    args: parsed.args,
  };

  switch (parsed.command) {
    case CMD.SETUP:
      return runCommand_(ctx, handleSetup_);
    case CMD.ROLLCALL:
      return runCommand_(ctx, handleRollcall_);
    case CMD.NEXT:
      return runCommand_(ctx, handleNext_);
    case CMD.WHEREAMI:
      return runCommand_(ctx, handleWhereami_);
    case CMD.GROUPS:
      return runCommand_(ctx, handleGroups_);
    case CMD.UNMAP:
      return runCommand_(ctx, handleUnmap_);
    case CMD.HELP:
    case CMD.START:
      return runCommand_(ctx, handleHelp_);
    default:
      return; // not ours — stay quiet, other bots may share this group
  }
}

/**
 * Runs a handler with a net under it. A handler that throws would otherwise
 * vanish into the execution log, leaving whoever typed the command staring at
 * silence and assuming the bot is dead.
 */
function runCommand_(ctx, handler) {
  try {
    handler(ctx);
  } catch (err) {
    console.error(`command error: ${(err && err.stack) || err}`);
    try {
      logStatus_('COMMAND', 'ERROR', String((err && err.stack) || err));
    } catch (logErr) {
      console.error(`could not write _log: ${logErr}`);
    }
    sendReply_(ctx.chatId, ctx.threadId, `That command broke:\n${(err && err.message) || err}`);
  }
}

/**
 * Parses a message into { command, args }. Strips the @botname suffix Telegram
 * appends in groups and lowercases the command for case-insensitive matching.
 */
function parseCommand_(text) {
  const tokens = String(text).trim().split(/\s+/);
  if (!tokens.length || !tokens[0] || tokens[0].charAt(0) !== '/') return null;
  return { command: tokens[0].split('@')[0].toLowerCase(), args: tokens.slice(1) };
}

/** "@handle" when there is one, else a display name — for the _log audit trail. */
function describeUser_(from) {
  if (!from) return 'unknown';
  if (from.username) return `@${from.username}`;
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || String(from.id);
}

// ---------------------------------------------------------------------
// Onboarding: greet the group when the bot is added
// ---------------------------------------------------------------------

/**
 * Setup starts before anyone has to remember a command: the moment the bot is
 * added to a GC it posts what it thinks the sport is and the one command to
 * run. This is why setupWebhook() subscribes to my_chat_member.
 */
function handleMembershipChange_(change) {
  const chat = change.chat || {};
  if (chat.type !== 'group' && chat.type !== 'supergroup') return;

  const status = (change.new_chat_member && change.new_chat_member.status) || '';
  const previous = (change.old_chat_member && change.old_chat_member.status) || '';
  const joined = (status === 'member' || status === 'administrator') &&
    (previous === 'left' || previous === 'kicked' || previous === '');
  if (!joined) return;

  let guessLine = 'I couldn’t tell which sport this GC covers from its name.';
  let command = '/setup <sport>';
  try {
    const guess = guessSportKeyword_(chat.title, collectSeasonSports_(getConfig()));
    if (guess) {
      guessLine = `Best guess from the group name: ${guess.keyword}`;
      command = '/setup';
    }
  } catch (err) {
    console.error(`greeting sport guess failed: ${(err && err.stack) || err}`);
  }

  sendReply_(chat.id, null, [
    '👋 TLS Roll Call bot is in.',
    '',
    guessLine,
    '',
    `Next step — open this GC’s Roll Call topic and run:  ${command}`,
    '',
    'That maps this group so roll calls for its sport post in that topic the night before each game.',
    'Make me an admin too, so I can post reliably and always see commands.',
    '',
    'Type /help for everything else.',
  ].join('\n'));
}

// ---------------------------------------------------------------------
// Webhook management (run these from the editor)
// ---------------------------------------------------------------------

/**
 * Point the bot at this deployment. Run once after the first deploy, and again
 * only if the /exec URL ever changes.
 *
 * ⚠️ A bot token can have exactly ONE webhook. If this token is shared with
 * another script — the /recap bot, say — registering here takes that bot's
 * updates away silently. Run checkWebhook() first and read the bot username it
 * prints. If a webhook is already registered elsewhere this refuses; use
 * replaceExistingWebhook() once you're sure.
 */
function setupWebhook() {
  registerWebhook_(false);
}

/** setupWebhook() that overwrites another URL already registered on this token. */
function replaceExistingWebhook() {
  registerWebhook_(true);
}

function registerWebhook_(force) {
  const props = PropertiesService.getScriptProperties();
  const configured = String(props.getProperty('WEB_APP_URL') || '').trim();
  const url = configured || ScriptApp.getService().getUrl();

  if (!url) {
    Logger.log('No Web App URL. Deploy → New deployment → Web app, then put the /exec URL in the WEB_APP_URL script property and re-run.');
    return;
  }
  if (url.indexOf('/exec') === -1) {
    Logger.log(`That URL is not a deployment URL: ${url}\nTelegram needs the /exec URL (the /dev one requires a Google login). Set WEB_APP_URL and re-run.`);
    return;
  }

  const me = telegramApi_('getMe');
  if (!me.ok) {
    Logger.log(`getMe failed — check TELEGRAM_BOT_TOKEN: ${JSON.stringify(me)}`);
    return;
  }
  Logger.log(`Bot: @${me.result.username} (${me.result.first_name})`);

  const info = telegramApi_('getWebhookInfo');
  const existing = (info.ok && info.result && info.result.url) || '';
  if (existing && existing.split('?')[0] !== url && !force) {
    Logger.log(
      `⚠️ REFUSING: @${me.result.username} already has a webhook at\n  ${existing}\n` +
      `and this deployment is\n  ${url}\n\n` +
      'If that other URL is a different bot script sharing this token, registering here would break it. ' +
      'If you are sure this is the right bot, run replaceExistingWebhook().'
    );
    return;
  }

  const secret = props.getProperty('WEBHOOK_SECRET');
  if (!secret) {
    Logger.log('⚠️ WEBHOOK_SECRET is not set — the /exec URL will accept updates from anyone who finds it. Set it in Script Properties and re-run.');
  }
  const hookUrl = secret ? `${url}?secret=${encodeURIComponent(secret)}` : url;

  const result = telegramApi_('setWebhook', {
    url: hookUrl,
    // my_chat_member is what makes the join greeting work; without it Telegram
    // never tells us the bot was added to a group.
    allowed_updates: ['message', 'my_chat_member'],
    // Anything queued while the webhook was down is stale by definition, and
    // replaying it would fire commands from hours ago.
    drop_pending_updates: true,
  });

  Logger.log(result.ok
    ? `Webhook registered → ${url}${secret ? ' (secret in query string)' : ''}\nNow run publishCommandMenu(), then add the bot to a GC.`
    : `setWebhook failed: ${JSON.stringify(result)}`);
}

/** Diagnostic: which bot this token is, and where its updates currently go. */
function checkWebhook() {
  const me = telegramApi_('getMe');
  Logger.log(me.ok ? `Bot: @${me.result.username} (id ${me.result.id})` : `getMe failed: ${JSON.stringify(me)}`);

  const info = telegramApi_('getWebhookInfo');
  if (!info.ok) {
    Logger.log(`getWebhookInfo failed: ${JSON.stringify(info)}`);
    return;
  }

  const r = info.result;
  Logger.log(`URL: ${r.url || '(none — the bot is not receiving commands)'}`);
  Logger.log(`Pending updates: ${r.pending_update_count}`);
  Logger.log(`Allowed updates: ${(r.allowed_updates || ['(default)']).join(', ')}`);
  if (r.last_error_message) {
    Logger.log(`⚠️ Last delivery error: ${r.last_error_message} (${new Date(r.last_error_date * 1000)})`);
  }
}

/** Stop receiving commands. getUpdates/harvestChatIds work again afterwards. */
function removeWebhook() {
  const result = telegramApi_('deleteWebhook', { drop_pending_updates: true });
  Logger.log(result.ok
    ? 'Webhook removed. Commands are dead until setupWebhook() runs again; the nightly trigger is unaffected.'
    : `deleteWebhook failed: ${JSON.stringify(result)}`);
}

/**
 * Publish the command list to Telegram so members get autocomplete when they
 * type "/" in a GC. Cosmetic, but it is the difference between a documented
 * bot and one nobody knows the commands for. Re-run after changing the list.
 */
function publishCommandMenu() {
  const result = telegramApi_('setMyCommands', {
    commands: [
      { command: 'setup', description: 'Map this topic as the sport’s Roll Call thread (admins)' },
      { command: 'rollcall', description: 'Post the next roll call for this GC now (admins)' },
      { command: 'next', description: 'Preview the next game and its roll call — posts nothing' },
      { command: 'whereami', description: 'IDs, mapping, and bot status for this topic' },
      { command: 'groups', description: 'Every mapping, plus sports with no GC yet' },
      { command: 'unmap', description: 'Stop routing roll calls to this topic (admins)' },
      { command: 'help', description: 'What this bot can do' },
    ],
    scope: { type: 'all_group_chats' },
  });
  Logger.log(result.ok ? 'Command menu published.' : `setMyCommands failed: ${JSON.stringify(result)}`);
}
