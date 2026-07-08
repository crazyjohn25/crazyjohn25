/**
 * 真实宏观新闻抓取模块
 * 通过 rss2json 公共服务（浏览器可跨域）抓取以下RSS源：
 *   - The Block
 *   - CoinDesk
 *   - 吴说区块链（Wu Blockchain, Substack）
 *   - AP News（经 Google News 站内检索RSS，聚焦美联储/加密相关）
 * 抓取后按“与当前交易对相关 或 宏观高影响”过滤，映射为标准事件结构上图。
 */

const RSS2JSON = 'https://api.rss2json.com/v1/api.json?rss_url=';

export const NEWS_FEEDS = [
  { source: 'The Block', url: 'https://www.theblock.co/rss.xml' },
  { source: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss' },
  { source: '吴说区块链', url: 'https://www.wublock123.com/feed' },
  { source: '吴说(EN)', url: 'https://wublock.substack.com/feed' },
  {
    source: 'Foresight News',
    url: 'https://news.google.com/rss/search?q=site:foresightnews.pro&hl=zh-CN&gl=CN&ceid=CN:zh-Hans',
  },
  {
    source: 'AP News',
    url: 'https://news.google.com/rss/search?q=site:apnews.com%20(federal%20reserve%20OR%20bitcoin%20OR%20crypto%20OR%20oil%20prices)&hl=en-US&gl=US&ceid=US:en',
  },
  {
    source: 'MicroStrategy追踪',
    url: 'https://news.google.com/rss/search?q=microstrategy%20OR%20%22michael%20saylor%22%20bitcoin&hl=en-US&gl=US&ceid=US:en',
  },
];

/** 品种相关关键词（标题命中即认为与交易对相关） */
const SYMBOL_KEYWORDS = {
  BTC: ['bitcoin', 'btc', '比特币', 'microstrategy', 'saylor', '微策略'],
  ETH: ['ethereum', 'eth', 'ether', '以太坊'],
  SOL: ['solana', 'sol'],
  BNB: ['bnb', 'binance coin'],
  HYPE: ['hyperliquid', 'hype'],
  NDX: ['nasdaq', 'nvidia', 'nvda', 'apple', 'microsoft', 'tech stocks', '纳指', '纳斯达克', 'ai stocks', 'chip', 'semiconductor', '英伟达', '芯片', '半导体'],
};

/** 宏观关键词 -> 分类 */
const MACRO_RULES = [
  { cat: 'fed', words: ['fed', 'fomc', 'powell', 'rate cut', 'rate hike', 'interest rate', 'inflation', 'cpi', 'treasury', '美联储', '加息', '降息', '通胀'] },
  { cat: 'geo', words: ['iran', 'israel', 'war', 'sanction', 'geopolit', 'ukraine', 'russia', 'strait', '伊朗', '战争', '制裁', '地缘'] },
  { cat: 'oil', words: ['oil', 'opec', 'crude', 'brent', 'wti', 'energy price', '石油', '原油', '油价'] },
  { cat: 'sector', words: ['etf', 'mining', 'miner', 'stablecoin', 'defi', 'ai ', 'regulation', 'sec ', '监管', '赛道', '矿'] },
];

/** 高影响关键词（命中则impact=high，会在K线图上标注） */
const HIGH_IMPACT_WORDS = [
  'fed', 'fomc', 'rate cut', 'rate hike', 'etf approv', 'hack', 'exploit',
  'crash', 'plunge', 'surge', 'all-time high', 'liquidat', 'bankrupt', 'sec sues',
  'war', 'strike', 'sanction', '美联储', '加息', '降息', '暴跌', '暴涨', '清算', '黑客',
  'microstrategy', 'saylor', '微策略', 'nonfarm', '非农', 'cpi', '通胀',
];

function classify(text) {
  const t = text.toLowerCase();
  for (const rule of MACRO_RULES) {
    if (rule.words.some((w) => t.includes(w))) return rule.cat;
  }
  return 'other';
}

function isHighImpact(text) {
  const t = text.toLowerCase();
  return HIGH_IMPACT_WORDS.some((w) => t.includes(w));
}

/**
 * 判断新闻是否与交易对相关：命中品种关键词，或命中宏观分类（fed/geo/oil）
 */
export function isRelevant(title, base) {
  const t = title.toLowerCase();
  const symWords = SYMBOL_KEYWORDS[base] || [];
  if (symWords.some((w) => t.includes(w))) return true;
  const cat = classify(t);
  return cat === 'fed' || cat === 'geo' || cat === 'oil';
}

/** 抓取单个RSS源，失败返回空数组 */
async function fetchFeed(feed) {
  try {
    const res = await fetch(RSS2JSON + encodeURIComponent(feed.url), {
      signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (data.status !== 'ok' || !Array.isArray(data.items)) return [];
    return data.items.map((it) => ({
      source: feed.source,
      title: it.title || '',
      url: it.link || '',
      time: Math.floor(new Date(it.pubDate).getTime() / 1000) || 0,
    }));
  } catch (_) {
    return [];
  }
}

/**
 * 抓取全部新闻源并过滤出与 base 品种相关的宏观新闻
 * @param {string} base 品种基础货币，如 'BTC'
 * @returns {Array<{id,time,title,url,source,category,impact,note}>} 按时间降序
 */
export async function fetchNews(base) {
  const all = (await Promise.all(NEWS_FEEDS.map(fetchFeed))).flat();
  const seen = new Set();
  const out = [];
  for (const item of all) {
    if (!item.time || !item.title) continue;
    const key = item.title.slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isRelevant(item.title, base)) continue;
    out.push({
      id: `news_${item.time}_${key.replace(/\W+/g, '').slice(0, 16)}`,
      time: item.time,
      title: item.title,
      url: item.url,
      source: item.source,
      category: classify(item.title),
      impact: isHighImpact(item.title) ? 'high' : 'medium',
      note: item.source,
    });
  }
  return out.sort((a, b) => b.time - a.time).slice(0, 40);
}
