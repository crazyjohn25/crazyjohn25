/**
 * Serenity（X: @aleabitoreddit）跟踪模块
 *
 * Serenity 是约90万粉丝的AI半导体供应链分析师，方法论为"卡脖子理论"
 * （Chokepoint Theory）：不买AI品牌股，买"没有它AI建设就停摆"的上游垄断供应商，
 * 重点在光子学、磷化铟(InP)衬底、光模块环节。
 *
 * X的API需要付费授权，纯前端无法实时抓取推文，因此：
 * 1. 内置其近30天公开推荐的股票数据集（含推荐日期、行业、叙事、原文要点）；
 * 2. 预留 fetchLivePicks 钩子，可接自建的推文抓取代理（如 serenity-watch 开源项目）；
 * 3. 用真实日线行情把推荐组合合成"Serenity指数"（等权、基期=100）并自动评分。
 */

/** 行业分类 */
export const INDUSTRIES = {
  inp: { label: 'InP衬底/外延', color: '#e6b800' },
  optics: { label: '光模块/CPO', color: '#4d94ff' },
  laser: { label: 'CW激光器', color: '#ff7f2a' },
  foundry: { label: '晶圆代工', color: '#26a69a' },
  cloud: { label: 'AI云/算力', color: '#9966ff' },
  memory: { label: '存储', color: '#e05252' },
  package: { label: '封测/组装', color: '#8a8a8a' },
  power: { label: '电源/电力', color: '#52b3e0' },
};

/** 叙事强度权重（评分用）：核心卡脖子>直接受益>外围AI暴露 */
export const NARRATIVES = {
  chokepoint: { label: '核心卡脖子', weight: 3 },
  beneficiary: { label: '直接受益链', weight: 2 },
  exposure: { label: 'AI暴露盘', weight: 1 },
};

/**
 * 近30天公开推荐数据集（源自其X公开推文与第三方跟踪归档，UTC时间戳）
 * disclosed=true 表示其公开披露持仓
 */
export const SERENITY_PICKS = [
  { ticker: 'AXTI', name: 'AXT Inc', industry: 'inp', narrative: 'chokepoint', date: Date.UTC(2026, 5, 9) / 1000, disclosed: false,
    note: '核心命题"AXTI海峡"：InP衬底近垄断，AI光互连绕不开；IntelliEPI CEO其后公开证实InP短缺' },
  { ticker: 'SIVE.ST', name: 'Sivers Semiconductors', industry: 'laser', narrative: 'chokepoint', date: Date.UTC(2026, 5, 12) / 1000, disclosed: false,
    note: 'CW激光器稀缺标的，其推演收购链：SIVE→Win→POET→Celestial→MRVL，上游光源被低价锁定' },
  { ticker: 'AAOI', name: 'Applied Optoelectronics', industry: 'laser', narrative: 'chokepoint', date: Date.UTC(2026, 5, 9) / 1000, disclosed: true,
    note: '曾在卖方一致预期+14%时喊出+55%营收增速，实际+58%，两日涨超70%；公开披露持仓' },
  { ticker: 'LITE', name: 'Lumentum', industry: 'optics', narrative: 'beneficiary', date: Date.UTC(2026, 5, 9) / 1000, disclosed: false,
    note: '光模块/CPO头部，InP产能自有，"光学与CPO"环节双供应商之一' },
  { ticker: 'COHR', name: 'Coherent', industry: 'optics', narrative: 'beneficiary', date: Date.UTC(2026, 5, 9) / 1000, disclosed: false,
    note: '与LITE并列的光学环节双寡头，受益CPO渗透' },
  { ticker: 'TSEM', name: 'Tower Semiconductor', industry: 'foundry', narrative: 'beneficiary', date: Date.UTC(2026, 5, 9) / 1000, disclosed: true,
    note: '特色工艺代工（SiPho硅光平台），公开披露持仓' },
  { ticker: 'NBIS', name: 'Nebius Group', industry: 'cloud', narrative: 'beneficiary', date: Date.UTC(2026, 5, 9) / 1000, disclosed: true,
    note: 'AI云算力，$10-100B区间"仍有性价比"名单成员，公开披露持仓' },
  { ticker: 'IQE.L', name: 'IQE plc', industry: 'inp', narrative: 'chokepoint', date: Date.UTC(2026, 5, 15) / 1000, disclosed: false,
    note: '外延片(Epiwafer)环节，InP产业链上游，~2.9亿美元市值"如果再便宜就……"' },
  { ticker: 'POET', name: 'POET Technologies', industry: 'optics', narrative: 'exposure', date: Date.UTC(2026, 5, 12) / 1000, disclosed: false,
    note: '光子集成，出现在其SIVE收购链推演中间环节' },
  { ticker: 'MU', name: 'Micron', industry: 'memory', narrative: 'exposure', date: Date.UTC(2026, 5, 20) / 1000, disclosed: false,
    note: 'HBM存储是AI算力另一瓶颈，广义AI暴露主题' },
  { ticker: 'ASX', name: 'ASE Technology', industry: 'package', narrative: 'exposure', date: Date.UTC(2026, 5, 9) / 1000, disclosed: false,
    note: '6/9"$10-100B AI暴露"名单：封测龙头' },
  { ticker: 'JBL', name: 'Jabil', industry: 'package', narrative: 'exposure', date: Date.UTC(2026, 5, 9) / 1000, disclosed: false,
    note: '6/9名单：AI服务器组装制造' },
  { ticker: 'VICR', name: 'Vicor', industry: 'power', narrative: 'exposure', date: Date.UTC(2026, 5, 9) / 1000, disclosed: false,
    note: '6/9名单：GPU供电模块' },
  { ticker: 'GFS', name: 'GlobalFoundries', industry: 'foundry', narrative: 'exposure', date: Date.UTC(2026, 5, 9) / 1000, disclosed: false,
    note: '6/9名单：特色代工' },
  { ticker: 'FN', name: 'Fabrinet', industry: 'optics', narrative: 'beneficiary', date: Date.UTC(2026, 5, 9) / 1000, disclosed: false,
    note: '6/9名单：光模块代工，800G/1.6T放量受益' },
  { ticker: 'CLS', name: 'Celestica', industry: 'package', narrative: 'beneficiary', date: Date.UTC(2026, 5, 9) / 1000, disclosed: false,
    note: '6/9名单：AI网络设备ODM' },
  { ticker: 'AMKR', name: 'Amkor', industry: 'package', narrative: 'exposure', date: Date.UTC(2026, 5, 9) / 1000, disclosed: false,
    note: '6/9名单：先进封装' },
  { ticker: 'MRVL', name: 'Marvell', industry: 'optics', narrative: 'exposure', date: Date.UTC(2026, 5, 12) / 1000, disclosed: false,
    note: '出现在收购链推演终点：其供应链依赖上游光源' },
];

/**
 * Serenity指数：等权基期100
 * @param {Object} daily { ticker: {candles} } fetchDailyBatch 输出
 * @param {number} baseDaysAgo 基期（默认30天前）
 * @param {Array} picks 成分（默认全部推荐，可传子集构建子指数）
 * @returns {{ series: [{time,value}], current, changePct, covered, total } | null}
 */
export function buildSerenityIndex(
  daily,
  baseDaysAgo = 30,
  nowSec = Math.floor(Date.now() / 1000),
  picks = SERENITY_PICKS
) {
  const baseTime = nowSec - baseDaysAgo * 86400;
  const valid = [];
  for (const p of picks) {
    const d = daily[p.ticker];
    if (!d || !d.candles || d.candles.length < 5) continue;
    const candles = d.candles.filter((c) => c.time >= baseTime - 86400 * 5);
    if (candles.length < 5) continue;
    valid.push({ ticker: p.ticker, candles });
  }
  if (valid.length === 0) return null;

  // 用全部有效日期的并集构建时间轴（取交集容易因不同市场休市日而过窄）
  const timeSet = new Set();
  for (const v of valid) for (const c of v.candles) if (c.time >= baseTime) timeSet.add(c.time);
  const times = [...timeSet].sort((a, b) => a - b);
  if (times.length < 2) return null;

  const series = [];
  for (const t of times) {
    let sum = 0;
    let cnt = 0;
    for (const v of valid) {
      // 找 <=t 的最近收盘 与 基期首个收盘
      let px = null;
      let base = null;
      for (const c of v.candles) {
        if (c.time <= t) px = c.close;
        if (base === null && c.time >= baseTime) base = c.close;
      }
      if (px !== null && base !== null && base > 0) {
        sum += (px / base) * 100;
        cnt++;
      }
    }
    if (cnt > 0) series.push({ time: t, value: sum / cnt });
  }
  if (series.length < 2) return null;
  const current = series[series.length - 1].value;
  return {
    series,
    current,
    changePct: current - 100,
    covered: valid.length,
    total: picks.length,
  };
}

/**
 * 行业子指数：Serenity指数-激光 / -封装 / -光模块 等
 * @returns {Array<{industry, label, color, tickers, index}>} 按30天表现降序
 */
export function buildSubIndices(daily, baseDaysAgo = 30, nowSec = Math.floor(Date.now() / 1000)) {
  const out = [];
  for (const [key, meta] of Object.entries(INDUSTRIES)) {
    const picks = SERENITY_PICKS.filter((p) => p.industry === key);
    if (picks.length === 0) continue;
    const index = buildSerenityIndex(daily, baseDaysAgo, nowSec, picks);
    if (!index) continue;
    out.push({
      industry: key,
      label: meta.label,
      color: meta.color,
      tickers: picks.map((p) => p.ticker),
      index,
    });
  }
  return out.sort((a, b) => b.index.changePct - a.index.changePct);
}

/**
 * Serenity组合动态监控：抓取其重点持仓/推荐标的的最新新闻（近3天）
 * 经 rss2json + Google News（X推文API需付费，无法直接抓取，本源作为公开替代信号）
 * 注：rss2json对过长的OR查询会失败，拆成多个短查询并行合并。
 */
export async function fetchSerenityFeed() {
  const queries = [
    'AXTI OR AAOI OR Lumentum when:3d',
    'Coherent laser OR "Tower Semiconductor" OR Nebius when:3d',
    '"applied optoelectronics" OR "AXT Inc" OR Fabrinet when:3d',
  ];
  const fetchOne = async (q) => {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
    try {
      const res = await fetch(
        'https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(url),
        { signal: AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined }
      );
      if (!res.ok) return [];
      const data = await res.json();
      if (data.status !== 'ok' || !Array.isArray(data.items)) return [];
      return data.items.map((it) => ({
        title: it.title || '',
        url: it.link || '',
        time: Math.floor(new Date(it.pubDate).getTime() / 1000) || 0,
      }));
    } catch (_) {
      return [];
    }
  };

  const all = (await Promise.all(queries.map(fetchOne))).flat();
  const seen = new Set();
  const out = [];
  for (const x of all.sort((a, b) => b.time - a.time)) {
    if (!x.title || !x.time) continue;
    const key = x.title.slice(0, 50);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(x);
  }
  return out.slice(0, 12);
}

/**
 * 自动评分（0-10）：叙事权重 + 30天动量 + 披露加成
 * @param {Object} pick SERENITY_PICKS成员
 * @param {Array|null} candles 日线
 */
export function scorePick(pick, candles) {
  let score = (NARRATIVES[pick.narrative]?.weight || 1) * 2; // 2/4/6
  let perf30 = null;
  if (candles && candles.length >= 2) {
    const nowSec = candles[candles.length - 1].time;
    const baseTime = nowSec - 30 * 86400;
    let base = null;
    for (const c of candles) {
      if (c.time >= baseTime) {
        base = c.close;
        break;
      }
    }
    const last = candles[candles.length - 1].close;
    if (base && base > 0) {
      perf30 = ((last - base) / base) * 100;
      // 动量加分：每+10%加0.5分，封顶3分；深跌减分，最多-2
      score += Math.max(-2, Math.min(3, perf30 / 20));
    }
  }
  if (pick.disclosed) score += 1; // 真金白银持仓
  return { score: Math.max(0, Math.min(10, score)), perf30 };
}

/**
 * 实时推文数据钩子：X API需付费Key，可自建代理（参考开源项目 serenity-watch）
 * 返回格式与 SERENITY_PICKS 相同即可无缝合并。
 */
export async function fetchLivePicks(apiUrl) {
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

/** 数据集最后更新时间（UTC秒），持续维护时更新此值 */
export const SERENITY_DATA_UPDATED = Date.UTC(2026, 6, 8) / 1000;

/** Serenity方法论摘要（深度分析，静态知识卡片） */
export const SERENITY_PROFILE = {
  handle: '@aleabitoreddit',
  url: 'https://x.com/aleabitoreddit',
  followers: '~90万',
  style: '高集中度 + 约1.4x杠杆，持仓可忍受单日15-25%波动',
  framework:
    '卡脖子理论：沿"Nvidia GPU→光模块/CPO($LITE/$COHR)→CW激光器($SIVE/$AAOI)→外延片($IQE)→InP衬底($AXTI)"逆向拆解供应链，' +
    '越上游供应商越少、定价权越强——"买瓶颈，不买品牌"。',
  record:
    '代表作：提前一年提出InP短缺（后被IntelliEPI CEO公开证实）；AAOI财报前喊出+55%营收增速（卖方一致预期+14%，实际+58%）。' +
    '自报收益率未经审计，本人声明内容为研究分享而非投资建议。',
  risk:
    '风险提示：其风格高度波动，公开披露的仓位可能随时变动且从不公布权重；' +
    '小市值标的流动性差、跟单滑点大，切勿照抄仓位，只可作为研究线索。',
};
