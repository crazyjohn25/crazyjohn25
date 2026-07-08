/**
 * KOL交易信号雷达（BTC / ETH / HYPE）
 * 目标：24小时持续聚合知名交易员/分析师的最新公开观点与信号。
 *
 * 数据通道说明（诚实声明）：
 * - X(Twitter) API 与 Telegram 私有频道API均需付费Key，纯前端无法直连；
 * - 本模块用两类公开通道替代：
 *   1. Google News 对每位KOL姓名/账号的专项检索（有公开报道/转载即可捕获）；
 *   2. rsshub 公共镜像的 Telegram 公开频道RSS（部分信号频道可用）；
 * - 预留 fetchLiveSignals(apiUrl) 钩子：自建代理（如X API/TG Bot转发）返回统一JSON即可无缝接入。
 */

const RSS2JSON = 'https://api.rss2json.com/v1/api.json?rss_url=';

/** 10个知名KOL/社群清单（公开、有长期记录的分析师，不构成推荐） */
export const KOLS = [
  { name: 'Peter Brandt', handle: '@PeterLBrandt', platform: 'X', url: 'https://x.com/PeterLBrandt', style: '经典图表形态，40年经验', query: '"Peter Brandt" bitcoin OR crypto when:3d' },
  { name: 'Rekt Capital', handle: '@rektcapital', platform: 'X', url: 'https://x.com/rektcapital', style: 'BTC周期与减半分析', query: '"Rekt Capital" bitcoin when:3d' },
  { name: 'Michaël van de Poppe', handle: '@CryptoMichNL', platform: 'X', url: 'https://x.com/CryptoMichNL', style: '波段交易与山寨轮动', query: '"van de Poppe" crypto when:3d' },
  { name: 'Daan Crypto Trades', handle: '@DaanCrypto', platform: 'X', url: 'https://x.com/DaanCrypto', style: '日内关键位与资金费率', query: '"Daan Crypto" when:3d' },
  { name: 'Hsaka', handle: '@HsakaTrades', platform: 'X', url: 'https://x.com/HsakaTrades', style: '动量与情绪交易', query: 'Hsaka crypto trader when:3d' },
  { name: 'Pentoshi', handle: '@Pentosh1', platform: 'X', url: 'https://x.com/Pentosh1', style: '宏观+主流币波段', query: 'Pentoshi crypto when:3d' },
  { name: 'Kaleo', handle: '@CryptoKaleo', platform: 'X', url: 'https://x.com/CryptoKaleo', style: '高波动叙事交易', query: 'Kaleo crypto when:3d' },
  { name: 'Cheds', handle: '@BigCheds', platform: 'X', url: 'https://x.com/BigCheds', style: '技术形态与纪律', query: 'Cheds trading crypto when:3d' },
  { name: 'CryptoQuant社区', handle: 'cryptoquant.com', platform: 'Web', url: 'https://cryptoquant.com/community', style: '链上数据信号', query: 'CryptoQuant bitcoin analysis when:2d' },
  { name: 'Glassnode', handle: '@glassnode', platform: 'X', url: 'https://x.com/glassnode', style: '链上指标周报', query: 'Glassnode bitcoin when:3d' },
];

/** 信号相关关键词（只保留 BTC/ETH/HYPE 相关内容） */
const COIN_WORDS = ['btc', 'bitcoin', '比特币', 'eth', 'ethereum', '以太坊', 'hype', 'hyperliquid'];
const SIGNAL_WORDS = [
  'buy', 'sell', 'long', 'short', 'target', 'support', 'resistance', 'breakout',
  'bullish', 'bearish', 'rally', 'correction', 'bottom', 'top', 'entry', 'signal',
  'prediction', 'forecast', 'analysis', 'price', '看多', '看空', '买入', '卖出', '目标价', '支撑', '压力',
];

export function isSignalRelevant(title) {
  const t = String(title).toLowerCase();
  return COIN_WORDS.some((w) => t.includes(w)) && SIGNAL_WORDS.some((w) => t.includes(w));
}

/** 简易方向判断：标题措辞的多空倾向 */
export function classifySignalBias(title) {
  const t = String(title).toLowerCase();
  const bull = ['buy', 'long', 'bullish', 'breakout', 'rally', 'bottom', 'accumulate', 'target', '看多', '买入', '突破'].filter((w) => t.includes(w)).length;
  const bear = ['sell', 'short', 'bearish', 'correction', 'crash', 'top', 'dump', 'warning', '看空', '卖出', '回调'].filter((w) => t.includes(w)).length;
  if (bull > bear) return 'bullish';
  if (bear > bull) return 'bearish';
  return 'neutral';
}

async function fetchFeedJson(url, timeoutMs = 12000) {
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

/**
 * 聚合全部KOL的最新信号（每位取最新2条相关内容）
 * @returns {Array<{kol, handle, url, title, link, time, bias}>} 按时间降序
 */
export async function fetchKolSignals() {
  const results = await Promise.all(
    KOLS.map(async (k) => {
      const gUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(k.query)}&hl=en-US&gl=US&ceid=US:en`;
      const items = (await fetchFeedJson(gUrl)) || [];
      return items
        .map((it) => ({
          kol: k.name,
          handle: k.handle,
          url: k.url,
          title: it.title || '',
          link: it.link || '',
          time: Math.floor(new Date(it.pubDate).getTime() / 1000) || 0,
        }))
        .filter((x) => x.title && x.time && isSignalRelevant(x.title))
        .slice(0, 2);
    })
  );

  const seen = new Set();
  const out = [];
  for (const x of results.flat().sort((a, b) => b.time - a.time)) {
    const key = x.title.slice(0, 50);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...x, bias: classifySignalBias(x.title) });
  }
  return out.slice(0, 20);
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
