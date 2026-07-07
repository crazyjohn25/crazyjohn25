/**
 * Polymarket「BTC Up or Down 5分钟」玩法接入
 * 数据源均为 Polymarket 公开API（浏览器可跨域，无需Key）：
 *   - gamma-api.polymarket.com/events?slug=btc-updown-5m-<窗口起始秒>  市场信息与隐含概率
 *   - clob.polymarket.com/book?token_id=...                          订单簿深度
 *   - data-api.polymarket.com/trades?market=<conditionId>            成交记录
 *
 * 玩法：每5分钟一期，窗口结束时 Chainlink BTC/USD >= 窗口开始价 判为 Up。
 * 窗口开始时的 Chainlink 价格即"目标价"（strike），会画到K线图上。
 */

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const DATA = 'https://data-api.polymarket.com';

/** 当前5分钟窗口的起始时间戳（slug用） */
export function currentWindowStart(nowSec = Math.floor(Date.now() / 1000)) {
  return Math.floor(nowSec / 300) * 300;
}

export function windowSlug(startSec) {
  return `btc-updown-5m-${startSec}`;
}

/** 拉取指定窗口的市场信息 */
export async function fetchWindowMarket(startSec) {
  const res = await fetch(`${GAMMA}/events?slug=${windowSlug(startSec)}`);
  if (!res.ok) throw new Error(`gamma HTTP ${res.status}`);
  const events = await res.json();
  if (!Array.isArray(events) || events.length === 0) return null;
  const ev = events[0];
  const m = ev.markets && ev.markets[0];
  if (!m) return null;

  let outcomes = [];
  let prices = [];
  let tokenIds = [];
  try {
    outcomes = JSON.parse(m.outcomes || '[]');
    prices = JSON.parse(m.outcomePrices || '[]').map(Number);
    tokenIds = JSON.parse(m.clobTokenIds || '[]');
  } catch (_) {
    /* 字段格式异常时按空处理 */
  }
  const upIdx = outcomes.findIndex((o) => /up/i.test(o));
  const downIdx = outcomes.findIndex((o) => /down/i.test(o));

  return {
    slug: windowSlug(startSec),
    startSec,
    endSec: startSec + 300,
    question: m.question || ev.title,
    conditionId: m.conditionId,
    upPrice: upIdx >= 0 ? prices[upIdx] : null, // 隐含Up概率
    downPrice: downIdx >= 0 ? prices[downIdx] : null,
    upTokenId: upIdx >= 0 ? tokenIds[upIdx] : null,
    downTokenId: downIdx >= 0 ? tokenIds[downIdx] : null,
    volume: Number(m.volume) || 0,
    liquidity: Number(m.liquidity) || 0,
    url: `https://polymarket.com/event/${windowSlug(startSec)}`,
  };
}

/** 拉取订单簿 */
export async function fetchBook(tokenId) {
  const res = await fetch(`${CLOB}/book?token_id=${tokenId}`);
  if (!res.ok) throw new Error(`clob HTTP ${res.status}`);
  return res.json();
}

/** 拉取市场成交记录 */
export async function fetchTrades(conditionId, limit = 100) {
  const res = await fetch(`${DATA}/trades?market=${conditionId}&limit=${limit}`);
  if (!res.ok) throw new Error(`data-api HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/**
 * 订单簿分析（纯函数）
 * @param {Object} book { bids:[{price,size}], asks:[{price,size}] }
 * @returns {{bidDepth, askDepth, imbalance, bestBid, bestAsk, spread}}
 * imbalance>0 表示买盘更厚（支撑该结果），<0 表示卖压更大
 */
export function analyzeBook(book) {
  const sum = (arr) =>
    (arr || []).reduce((acc, l) => acc + Number(l.price) * Number(l.size), 0);
  const bids = book?.bids || [];
  const asks = book?.asks || [];
  const bidDepth = sum(bids);
  const askDepth = sum(asks);
  const bestBid = bids.length ? Math.max(...bids.map((l) => Number(l.price))) : null;
  const bestAsk = asks.length ? Math.min(...asks.map((l) => Number(l.price))) : null;
  return {
    bidDepth,
    askDepth,
    imbalance: bidDepth + askDepth > 0 ? (bidDepth - askDepth) / (bidDepth + askDepth) : 0,
    bestBid,
    bestAsk,
    spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
  };
}

/**
 * 成交流分析（纯函数）：大额订单 + 异常订单 + 主力方向
 * @param {Array} trades data-api 返回的成交（新在前）
 * @param {Object} opts { bigUsd 大单阈值美元, extremePrice 异常价格阈值 }
 * @returns {{bigTrades, anomalies, upFlow, downFlow, netUpFlow, tradeCount}}
 */
export function analyzeTrades(trades, opts = {}) {
  const cfg = { bigUsd: 500, extremePrice: 0.9, ...opts };
  const bigTrades = [];
  const anomalies = [];
  let upFlow = 0;
  let downFlow = 0;

  for (const t of trades) {
    const usd = Number(t.size) * Number(t.price);
    const isUp = /up/i.test(t.outcome || '');
    // BUY Up = 押涨；BUY Down = 押跌；SELL 则相反
    const direction = (t.side === 'BUY') === isUp ? 'up' : 'down';
    if (direction === 'up') upFlow += usd;
    else downFlow += usd;

    if (usd >= cfg.bigUsd) {
      bigTrades.push({
        time: Number(t.timestamp),
        usd,
        price: Number(t.price),
        outcome: t.outcome,
        side: t.side,
        direction,
        trader: t.pseudonym || (t.proxyWallet || '').slice(0, 8),
      });
    }
    // 异常订单：在极端概率价位大额吃单（>0.9 追高确定性 或 <0.1 博反转）
    if (usd >= cfg.bigUsd && (Number(t.price) >= cfg.extremePrice || Number(t.price) <= 1 - cfg.extremePrice)) {
      anomalies.push({
        time: Number(t.timestamp),
        usd,
        price: Number(t.price),
        outcome: t.outcome,
        side: t.side,
        desc:
          Number(t.price) >= cfg.extremePrice
            ? `极端价位追单：$${usd.toFixed(0)} 在 ${(Number(t.price) * 100).toFixed(0)}¢ 吃 ${t.outcome}`
            : `低概率博弈单：$${usd.toFixed(0)} 在 ${(Number(t.price) * 100).toFixed(0)}¢ 抄 ${t.outcome}`,
      });
    }
  }
  return {
    bigTrades: bigTrades.slice(0, 10),
    anomalies: anomalies.slice(0, 5),
    upFlow,
    downFlow,
    netUpFlow: upFlow - downFlow,
    tradeCount: trades.length,
  };
}

/**
 * 5分钟Up/Down方向建议（纯函数）
 * 结合：1分钟K线短线动能（技术面胜率估计） vs Polymarket隐含概率（市场定价），
 * 加上资金流与订单簿不平衡度，寻找"技术面概率 > 市场价格"的期望值优势。
 *
 * @param {Object} p {
 *   candles1m,        近期1分钟K线（含当前窗口内的走势）
 *   strikePrice,      窗口开始价（目标价）
 *   upPrice,          Polymarket Up 当前价格（隐含概率）
 *   flow,             analyzeTrades 输出
 *   book,             analyzeBook 输出（Up token的订单簿）
 *   secondsLeft,      窗口剩余秒数
 * }
 */
export function advise5m(p) {
  const reasons = [];
  const { candles1m, strikePrice, upPrice, flow, book, secondsLeft } = p;
  if (!candles1m || candles1m.length < 10) {
    return { action: '数据不足', edge: 0, techProb: null, reasons: ['1分钟K线不足'] };
  }
  const last = candles1m[candles1m.length - 1];
  const cur = last.close;

  // 1) 技术面估计Up概率：当前价相对目标价的位置 + 剩余时间 + 短线动能
  let techProb = 0.5;
  if (strikePrice) {
    const diffPct = ((cur - strikePrice) / strikePrice) * 100;
    // 剩余时间越少，当前领先优势越难被逆转
    const timeFactor = Math.min(1, Math.max(0.15, 1 - secondsLeft / 300));
    const lead = Math.tanh(diffPct * 8) * 0.35 * (0.5 + timeFactor);
    techProb += lead;
    reasons.push(
      `现价 ${cur.toFixed(1)} vs 目标价 ${strikePrice.toFixed(1)}（${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(3)}%），剩余${secondsLeft}秒`
    );
  }
  // 短线动能：近3根1分钟K线方向
  const c3 = candles1m.slice(-3);
  const mom = c3.filter((c) => c.close > c.open).length - c3.filter((c) => c.close < c.open).length;
  techProb += mom * 0.04;
  if (mom !== 0) reasons.push(`近3根1分钟K线${mom > 0 ? '偏多' : '偏空'}（${mom > 0 ? '+' : ''}${mom}）`);

  // 2) Polymarket资金流
  if (flow && flow.upFlow + flow.downFlow > 100) {
    const flowBias = flow.netUpFlow / (flow.upFlow + flow.downFlow);
    techProb += flowBias * 0.05;
    reasons.push(
      `Polymarket资金流：押涨$${flow.upFlow.toFixed(0)} vs 押跌$${flow.downFlow.toFixed(0)}（${flowBias > 0 ? '偏涨' : '偏跌'}）`
    );
  }
  // 3) 订单簿不平衡
  if (book && Math.abs(book.imbalance) > 0.15) {
    techProb += book.imbalance * 0.03;
    reasons.push(`Up订单簿${book.imbalance > 0 ? '买盘更厚' : '卖压更大'}（不平衡度${(book.imbalance * 100).toFixed(0)}%）`);
  }

  techProb = Math.min(0.97, Math.max(0.03, techProb));

  // 4) 与市场定价比较，计算期望值优势（edge）
  let action = '观望';
  let edge = 0;
  if (upPrice !== null && upPrice > 0.02 && upPrice < 0.98) {
    const edgeUp = techProb - upPrice; // 买Up的每股期望优势
    const edgeDown = (1 - techProb) - (1 - upPrice);
    edge = Math.abs(edgeUp) >= Math.abs(edgeDown) ? edgeUp : -edgeDown;
    reasons.push(
      `技术面Up概率≈${(techProb * 100).toFixed(0)}%，市场定价${(upPrice * 100).toFixed(0)}¢，差值${(edgeUp * 100).toFixed(1)}分`
    );
    if (edgeUp > 0.08) action = '买Up';
    else if (edgeUp < -0.08) action = '买Down';
    else action = '无优势，观望';
    if (secondsLeft < 40) {
      action = '临近结算，勿追单';
      reasons.push('剩余时间过短，滑点与手续费会吃掉优势');
    }
  } else {
    reasons.push('市场定价已接近极端（<2¢或>98¢），无交易价值');
    action = '本期已无价值，等下一期';
  }

  return { action, edge, techProb, reasons };
}
