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
function notifyError_(message) {
  try {
    sendTelegramMessage_(message, { parseMode: undefined });
  } catch (err) {
    Logger.log(`Failed to send error notification: ${err}`);
  }
}

/**
 * Setup helper: post a message in each Roll Call topic (and any group the bot
 * should send to), then run this to read the chat IDs and topic thread IDs out
 * of the bot's recent updates. Paste them into the Groups tab.
 *
 * Gotchas: the bot only sees messages if it is a group admin OR privacy mode is
 * off (BotFather → /setprivacy → Disable). getUpdates only returns the last ~24h
 * and won't work if a webhook is set.
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
