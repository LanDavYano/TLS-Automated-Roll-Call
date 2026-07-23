/**
 * Telegram Bot API sender (SPEC.md §4.1, §8). Credentials live in Script
 * Properties, not the Config tab, so they aren't visible to anyone with
 * edit access to the spreadsheet.
 */

function getTelegramCredentials_() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('TELEGRAM_BOT_TOKEN');
  const chatId = props.getProperty('TELEGRAM_CHAT_ID');
  if (!token || !chatId) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in Script Properties');
  }
  return { token, chatId };
}

function sendTelegramMessage_(text, options) {
  options = options || {};
  const { token, chatId } = getTelegramCredentials_();
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: options.parseMode, // omitted (plain text) when undefined
  };

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
 * exception that triggered the notification in the first place.
 */
function notifyError_(message) {
  try {
    sendTelegramMessage_(message, { parseMode: undefined });
  } catch (err) {
    Logger.log(`Failed to send error notification: ${err}`);
  }
}
