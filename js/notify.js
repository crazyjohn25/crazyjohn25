/**
 * 外部提醒通道：Telegram Bot / 邮箱Webhook
 * 在"后台设置"中配置后，重大信号、开平仓、每日复盘会自动推送。
 * Telegram Bot API 支持浏览器跨域直连；邮箱通过用户自建的webhook（IFTTT/Zapier/自服务）。
 */
import { getSettings } from './settings.js';

/** 发送 Telegram 消息（需在设置中配置 bot token 与 chat_id） */
export async function sendTelegram(text) {
  const { telegramToken, telegramChatId } = getSettings();
  if (!telegramToken || !telegramChatId) return { ok: false, reason: '未配置Telegram' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramChatId,
        text,
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json();
    return { ok: Boolean(data.ok), reason: data.ok ? '' : data.description || '发送失败' };
  } catch (e) {
    return { ok: false, reason: '网络错误' };
  }
}

/** 发送邮箱提醒（POST JSON 到用户配置的 webhook） */
export async function sendEmail(subject, text) {
  const { emailWebhook } = getSettings();
  if (!emailWebhook) return { ok: false, reason: '未配置邮箱webhook' };
  try {
    const res = await fetch(emailWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, text }),
    });
    return { ok: res.ok, reason: res.ok ? '' : `HTTP ${res.status}` };
  } catch (_) {
    return { ok: false, reason: '网络错误' };
  }
}

/** 统一外发：Telegram + 邮箱（哪个配了发哪个） */
export async function notifyExternal(title, body) {
  const text = `${title}\n${body}`;
  const results = await Promise.all([sendTelegram(text), sendEmail(title, body)]);
  return results;
}
