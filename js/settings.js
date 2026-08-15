/**
 * 后台设置模块（localStorage持久化）
 * 包含：提醒通道（Telegram Bot / 邮箱Webhook）、钱包初始资金、X关注列表、TG频道列表
 */

const KEY = 'kchart.settings.v1';

const DEFAULTS = {
  telegramToken: '', // BotFather 创建的 bot token
  telegramChatId: '', // 你的 chat_id（可先给bot发消息再访问 getUpdates 获取）
  emailWebhook: '', // 邮箱提醒webhook（如自建服务/IFTTT/Zapier），POST {subject, text}
  initialCapital: 10000, // 合约钱包初始资金（USD）
  pmCapital: 0, // 已停用
  xAccounts: 'johnliu409', // 逗号分隔的X账号；默认种子参考 x.com/johnliu409
  tgChannels: 'ChannelPANews,foresightnews', // 公开频道用户名或 t.me 链接，社群链接稍后可追加
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    return { ...DEFAULTS, ...(raw ? JSON.parse(raw) : {}) };
  } catch (_) {
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch) {
  const cur = loadSettings();
  const next = { ...cur, ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function getSettings() {
  return loadSettings();
}
