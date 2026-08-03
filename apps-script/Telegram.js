/**
 * Telegram Bot API sender (SPEC.md §4.1, §8). Credentials live in Script
 * Properties, not the Config tab, so they aren't visible to anyone with
 * edit access to the spreadsheet.
 *
 * TELEGRAM_CHAT_ID is the *admin / fallback* chat: error alerts and any
 * roll call whose sport isn't mapped in the Groups tab go here. Per-sport
 * routing (chat + topic) is resolved separately — see Groups.js.
 */

function getBotToken_() {
  const token = PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN');
  if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN in Script Properties');
  return token;
}

function getAdminChatId_() {
  const chatId = PropertiesService.getScriptProperties().getProperty('TELEGRAM_CHAT_ID');
  if (!chatId) throw new Error('Missing TELEGRAM_CHAT_ID in Script Properties');
  return chatId;
}

/**
 * Low-level Bot API call. Returns the parsed response body and never throws on
 * an HTTP error — callers that must react to failure check `body.ok`. Used by
 * the command layer, where a failed reply should be logged, not fatal.
 */
function telegramApi_(method, payload) {
  const url = `https://api.telegram.org/bot${getBotToken_()}/${method}`;
  const options = { method: 'post', contentType: 'application/json', muteHttpExceptions: true };
  if (payload) options.payload = JSON.stringify(payload);

  const response = UrlFetchApp.fetch(url, options);
  try {
    return JSON.parse(response.getContentText());
  } catch (err) {
    return { ok: false, description: `Unparseable response (HTTP ${response.getResponseCode()})` };
  }
}

/**
 * Send one message. options:
 *   chatId    — target chat (defaults to the admin chat)
 *   threadId  — forum topic (message_thread_id); omitted for non-topic chats
 *   parseMode — e.g. 'HTML'; omitted for plain text
 */
function sendTelegramMessage_(text, options) {
  options = options || {};
  const token = getBotToken_();
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  const payload = {
    chat_id: options.chatId || getAdminChatId_(),
    text: text,
    parse_mode: options.parseMode,
  };
  if (options.threadId) payload.message_thread_id = Number(options.threadId);

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error(`Telegram API error ${code}: ${response.getContentText()}`);
  }
  return response;
}

/**
 * §6 — loud failure is correct here: swallow send errors internally (just
 * log them) so a broken Telegram connection never masks the original
 * exception that triggered the notification. Always goes to the admin chat.
 */
function notifyAdmin_(message) {
  try {
    sendTelegramMessage_(message, { parseMode: undefined });
  } catch (err) {
    Logger.log(`Failed to send admin notification: ${err}`);
  }
}

/** §6 — error alerts. Same channel as notifyAdmin_; named for the caller's intent. */
function notifyError_(message) {
  notifyAdmin_(message);
}

/**
 * Reply to a command, in the topic it was typed in.
 *
 * Plain text on purpose: replies quote group titles, sheet values, and whatever
 * the user typed, and a single stray "<" in HTML mode makes Telegram reject the
 * whole message — turning a helpful error into silence.
 */
function sendReply_(chatId, threadId, text) {
  const payload = { chat_id: chatId, text: text };
  if (threadId !== null && threadId !== undefined && threadId !== '') {
    payload.message_thread_id = Number(threadId);
  }

  const body = telegramApi_('sendMessage', payload);
  if (!body.ok) console.error(`sendReply_ failed: ${JSON.stringify(body)}`);
  return body;
}

/**
 * True when the user can administer this chat. Gates the commands that write to
 * the tracker or post to the whole GC. Fails closed: an API error or an
 * unparseable response denies rather than allows.
 *
 * Anonymous admins post as the group itself, so they carry no user id and won't
 * pass — post normally when running /setup.
 */
function isChatAdmin_(chatId, userId) {
  if (!userId) return false;

  const body = telegramApi_('getChatMember', { chat_id: chatId, user_id: userId });
  if (!body.ok || !body.result) return false;
  return body.result.status === 'creator' || body.result.status === 'administrator';
}

/**
 * LEGACY setup helper, superseded by /setup and /whereami (Commands.js): post a
 * message in each Roll Call topic, then run this to read the chat and topic IDs
 * out of the bot's recent updates and paste them into the Groups tab by hand.
 *
 * Kept as a fallback for when the webhook is down. Note that getUpdates and a
 * registered webhook are mutually exclusive — with the webhook live this
 * returns a 409, and you'd have to removeWebhook() first (which stops every
 * command working until setupWebhook() runs again). Use /whereami instead.
 */
function harvestChatIds() {
  const token = getBotToken_();
  const resp = UrlFetchApp.fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
    muteHttpExceptions: true,
  });
  const data = JSON.parse(resp.getContentText());

  if (!data.ok) {
    Logger.log(`getUpdates failed: ${resp.getContentText()}`);
    return;
  }
  if (!data.result.length) {
    Logger.log('No recent updates. Make the bot a group admin (or disable its privacy mode), post a message in each Roll Call topic, then run again.');
    return;
  }

  const seen = {};
  data.result.forEach((u) => {
    const m = u.message || u.channel_post || u.edited_message;
    if (!m || !m.chat) return;
    const key = `${m.chat.id}|${m.message_thread_id || ''}`;
    if (seen[key]) return;
    seen[key] = true;
    Logger.log(
      `chat="${m.chat.title || m.chat.id}" chatId=${m.chat.id} threadId=${m.message_thread_id || '(none)'} sample="${String(m.text || '').slice(0, 40)}"`
    );
  });
}
