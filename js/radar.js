/**
 * KOL 交易信号雷达（BTC / ETH / SOL / BNB / HYPE）
 *
 * 关注源：
 * - 默认清单按 x.com/johnliu409 一类中文合约/链上交易员的关注风格整理
 *   （链上监控、Hyperliquid、主流币交易员、中文加密媒体）
 * - 后台设置可追加 X 账号；Telegram 公开频道链接稍后填入即可接入
 *
 * 数据通道（诚实声明）：
 * - X 官方 API 与 Telegram 私有社群均需付费 Key，纯前端无法直连；
 * - 本模块用公开通道：rsshub 镜像的 X 用户 RSS / Telegram 公开频道 RSS、
 *   以及 Google News 对账号名的转载检索；
 * - 预留 fetchLiveSignals(apiUrl) 钩子：自建代理返回统一 JSON 即可无缝接入。
 */

const RSS2JSON = 'https://api.rss2json.com/v1/api.json?rss_url=';

const RSSHUB = [
  'https://rsshub.rssforever.com',
  'https://rsshub.app',
];

/** 参考 x.com/johnliu409 关注风格的默认监控清单（公开账号，不构成推荐） */
export const KOLS = [
  { name: 'johnliu409', handle: '@johnliu409', platform: 'X', url: 'https://x.com/johnliu409', style: '关注源种子账号', query: 'johnliu409 crypto OR bitcoin OR solana when:3d' },
  { name: 'Lookonchain', handle: '@lookonchain', platform: 'X', url: 'https://x.com/lookonchain', style: '链上大额与聪明钱', query: 'Lookonchain bitcoin OR ethereum OR solana when:3d' },
  { name: 'Onchain Lens', handle: '@OnchainLens', platform: 'X', url: 'https://x.com/OnchainLens', style: '链上异动', query: 'OnchainLens crypto when:3d' },
  { name: '余烬', handle: '@EmberCN', platform: 'X', url: 'https://x.com/EmberCN', style: '中文链上监控', query: 'EmberCN OR 余烬 crypto when:3d' },
  { name: 'ai_9684xtpa', handle: '@ai_9684xtpa', platform: 'X', url: 'https://x.com/ai_9684xtpa', style: '中文链上/合约动态', query: 'ai_9684xtpa crypto when:3d' },
  { name: 'Hyperliquid', handle: '@HyperliquidX', platform: 'X', url: 'https://x.com/HyperliquidX', style: 'HYPE 生态与开仓', query: 'Hyperliquid HYPE crypto when:3d' },
  { name: 'Daan Crypto', handle: '@DaanCrypto', platform: 'X', url: 'https://x.com/DaanCrypto', style: '日内关键位与资金费率', query: '"Daan Crypto" bitcoin OR ethereum when:3d' },
  { name: 'Hsaka', handle: '@HsakaTrades', platform: 'X', url: 'https://x.com/HsakaTrades', style: '动量与情绪', query: 'Hsaka crypto trader when:3d' },
  { name: 'Pentoshi', handle: '@Pentosh1', platform: 'X', url: 'https://x.com/Pentosh1', style: '宏观+主流币波段', query: 'Pentoshi crypto when:3d' },
  { name: 'Kaleo', handle: '@CryptoKaleo', platform: 'X', url: 'https://x.com/CryptoKaleo', style: '高波动叙事', query: 'Kaleo crypto BTC OR SOL when:3d' },
  { name: 'The Flow Horse', handle: '@TheFlowHorse', platform: 'X', url: 'https://x.com/TheFlowHorse', style: '资金流与仓位', query: '"Flow Horse" crypto when:3d' },
  { name: 'Cobie', handle: '@cobie', platform: 'X', url: 'https://x.com/cobie', style: '交易观点', query: 'cobie bitcoin OR ethereum when:3d' },
  { name: 'CZ', handle: '@cz_binance', platform: 'X', url: 'https://x.com/cz_binance', style: 'BNB/行业动态', query: 'CZ Binance BNB bitcoin when:3d' },
  { name: '何一', handle: '@heyibinance', platform: 'X', url: 'https://x.com/heyibinance', style: '币安中文动态', query: 'heyibinance OR 何一 BNB OR bitcoin when:3d' },
  { name: '吴说区块链', handle: '@WuBlockchain', platform: 'X', url: 'https://x.com/WuBlockchain', style: '中文加密快讯', query: 'WuBlockchain bitcoin OR ethereum when:3d' },
  { name: 'Peter Brandt', handle: '@PeterLBrandt', platform: 'X', url: 'https://x.com/PeterLBrandt', style: '经典图表形态', query: '"Peter Brandt" bitcoin OR crypto when:3d' },
  { name: 'Rekt Capital', handle: '@rektcapital', platform: 'X', url: 'https://x.com/rektcapital', style: 'BTC周期', query: '"Rekt Capital" bitcoin when:3d' },
  { name: 'Michaël van de Poppe', handle: '@CryptoMichNL', platform: 'X', url: 'https://x.com/CryptoMichNL', style: '波段与山寨轮动', query: '"van de Poppe" crypto when:3d' },
  { name: 'Glassnode', handle: '@glassnode', platform: 'X', url: 'https://x.com/glassnode', style: '链上指标', query: 'Glassnode bitcoin when:3d' },
];

/** 解析逗号分隔的 X 账号（去 @、去空） */
export function parseHandles(raw) {
  return String(raw || '')
    .split(/[,，\s]+/)
    .map((s) => s.trim().replace(/^@/, ''))
    .filter(Boolean);
}

/** 解析 Telegram 公开频道：接受 @name、t.me/name 或纯用户名 */
export function parseTgChannels(raw) {
  return String(raw || '')
    .split(/[,，\s]+/)
    .map((s) =>
      s
        .trim()
        .replace(/^@/, '')
        .replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '')
        .replace(/\/+$/, '')
        .split('/')[0]
    )
    .filter(Boolean);
}

/** 合并默认清单 + 用户在后台设置里配置的 X 关注（参考 x.com/johnliu409） */
export function getKolList(customXAccounts = '') {
  const seen = new Set(KOLS.map((k) => k.handle.toLowerCase()));
  const extra = parseHandles(customXAccounts)
    .filter((handle) => !seen.has(`@${handle}`.toLowerCase()))
    .map((handle) => ({
      name: handle,
      handle: `@${handle}`,
      platform: 'X',
      url: `https://x.com/${handle}`,
      style: '自定义关注',
      query: `"${handle}" crypto OR bitcoin OR ethereum OR solana OR BNB OR Hyperliquid when:3d`,
    }));
  return [...KOLS, ...extra];
}

const COIN_WORDS = [
  'btc', 'bitcoin', '比特币',
  'eth', 'ethereum', 'ether', '以太坊',
  'sol', 'solana', '索拉纳',
  'bnb', 'binance coin', '币安币',
  'hype', 'hyperliquid',
];

const SIGNAL_WORDS = [
  'buy', 'sell', 'long', 'short', 'target', 'support', 'resistance', 'breakout',
  'bullish', 'bearish', 'rally', 'correction', 'bottom', 'top', 'entry', 'signal',
  'prediction', 'forecast', 'analysis', 'price', 'leverage', 'position', 'opened',
  '看多', '看空', '买入', '卖出', '目标价', '支撑', '压力', '开多', '开空', '加仓', '减仓', '建仓', '平仓',
];

const OPEN_WORDS = [
  'long', 'short', 'entry', 'opened', 'position', 'leverage', 'full send',
  '开多', '开空', '加仓', '建仓', '开仓', '进场', '做多', '做空', '杠杆',
];

export function isSignalRelevant(title) {
  const t = String(title).toLowerCase();
  return COIN_WORDS.some((w) => t.includes(w)) && SIGNAL_WORDS.some((w) => t.includes(w));
}

export function isOpenSignal(title) {
  const t = String(title).toLowerCase();
  return OPEN_WORDS.some((w) => t.includes(w));
}

export function classifySignalBias(title) {
  const t = String(title).toLowerCase();
  const bull = ['buy', 'long', 'bullish', 'breakout', 'rally', 'bottom', 'accumulate', 'target', '看多', '买入', '突破', '开多', '做多', '加仓'].filter((w) => t.includes(w)).length;
  const bear = ['sell', 'short', 'bearish', 'correction', 'crash', 'top', 'dump', 'warning', '看空', '卖出', '回调', '开空', '做空', '减仓'].filter((w) => t.includes(w)).length;
  if (bull > bear) return 'bullish';
  if (bear > bull) return 'bearish';
  return 'neutral';
}

/** 从标题粗提标的（用于雷达展示） */
export function detectCoins(title) {
  const t = String(title).toLowerCase();
  const hits = [];
  if (/(btc|bitcoin|比特币)/.test(t)) hits.push('BTC');
  if (/(eth|ethereum|ether|以太坊)/.test(t)) hits.push('ETH');
  if (/(solana|\bsol\b|索拉纳)/.test(t)) hits.push('SOL');
  if (/(\bbnb\b|binance coin|币安币)/.test(t)) hits.push('BNB');
  if (/(hype|hyperliquid)/.test(t)) hits.push('HYPE');
  return hits;
}

async function fetchFeedJson(url, timeoutMs = 10000) {
  try {
    const res = await fetch(RSS2JSON + encodeURIComponent(url), {
      signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.status === 'ok' && Array.isArray(data.items) ? data.items : null;
  } catch (_) {
    return null;
  }
}

function mapItems(items, meta) {
  return (items || [])
    .map((it) => ({
      kol: meta.name,
      handle: meta.handle,
      url: meta.url,
      platform: meta.platform || 'X',
      title: it.title || '',
      link: it.link || '',
      time: Math.floor(new Date(it.pubDate || it.isoDate || 0).getTime() / 1000) || 0,
    }))
    .filter((x) => x.title && x.time && isSignalRelevant(x.title));
}

async function fetchXUserRss(handle) {
  const user = String(handle).replace(/^@/, '');
  for (const host of RSSHUB) {
    const items = await fetchFeedJson(`${host}/twitter/user/${encodeURIComponent(user)}`, 8000);
    if (items && items.length) return items;
  }
  return null;
}

async function fetchKolX(k) {
  const rss = await fetchXUserRss(k.handle);
  if (rss) return mapItems(rss, k).slice(0, 3);
  const gUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(k.query)}&hl=en-US&gl=US&ceid=US:en`;
  const items = (await fetchFeedJson(gUrl)) || [];
  return mapItems(items, k).slice(0, 2);
}

async function fetchTelegramChannel(channel) {
  const name = parseTgChannels(channel)[0];
  if (!name) return [];
  for (const host of RSSHUB) {
    const items = await fetchFeedJson(`${host}/telegram/channel/${encodeURIComponent(name)}`, 8000);
    if (items && items.length) {
      return mapItems(items, {
        name: `TG/${name}`,
        handle: `@${name}`,
        url: `https://t.me/${name}`,
        platform: 'Telegram',
      }).slice(0, 4);
    }
  }
  return [];
}

function decorate(x) {
  return {
    ...x,
    bias: classifySignalBias(x.title),
    open: isOpenSignal(x.title),
    coins: detectCoins(x.title),
  };
}

/**
 * 聚合 X + Telegram 的最新开仓/建议信号
 * @param {string} customXAccounts 后台设置的自定义 X 账号（逗号分隔）
 * @param {string} tgChannels 公开频道用户名或 t.me 链接（逗号分隔；社群链接稍后可填）
 */
export async function fetchKolSignals(customXAccounts = '', tgChannels = '') {
  const kols = getKolList(customXAccounts);
  const channels = parseTgChannels(tgChannels);

  const [xResults, tgResults] = await Promise.all([
    Promise.all(kols.map((k) => fetchKolX(k).catch(() => []))),
    Promise.all(channels.map((ch) => fetchTelegramChannel(ch).catch(() => []))),
  ]);

  const seen = new Set();
  const out = [];
  const merged = [...xResults.flat(), ...tgResults.flat()].sort((a, b) => b.time - a.time);
  for (const x of merged) {
    const key = x.title.slice(0, 50);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(decorate(x));
  }
  // 开仓措辞优先，其余按时间
  out.sort((a, b) => Number(b.open) - Number(a.open) || b.time - a.time);
  return out.slice(0, 24);
}

/** 自建信号代理钩子：返回 [{kol,title,link,time,bias}] 即可 */
export async function fetchLiveSignals(apiUrl) {
  if (!apiUrl) return [];
  try {
    const res = await fetch(apiUrl);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (_) {
    return [];
  }
}
