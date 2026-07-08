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

/** 内部：对1分钟收盘价算短周期RSI（Wilder） */
function rsi1m(closes, period = 7) {
  if (closes.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let ag = gain / period;
  let al = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

/**
 * 5分钟Up/Down方向建议（纯函数）——盘尾决策版
 *
 * 设计原则：
 * 1. 方向判断只依据K线技术面（价格vs目标价、1分钟动能、短周期RSI、量能方向、窗口VWAP）
 *    与Polymarket微观结构（订单簿不平衡、大单资金流）——【不用】Up/Down市场价格反推方向；
 * 2. 只在盘尾决策窗口（剩余30~180秒，即最后2-3分钟）给出方向信号，
 *    早段一律观望——时间越长反转概率越高，这是历史错误归因的最大来源；
 * 3. Up/Down价格仅用于计算买入成本与ROI：买入价值=成本(¢)，命中ROI=(1-成本)/成本，未中=-100%。
 *
 * @returns {{action, techProb, conf, cost, potentialRoiPct, evRoiPct, edge, reasons}}
 */
export function advise5m(p) {
  const reasons = [];
  const { candles1m, strikePrice, upPrice, flow, book, secondsLeft } = p;
  if (!candles1m || candles1m.length < 10) {
    return { action: '数据不足', edge: 0, techProb: null, conf: 0, cost: null, potentialRoiPct: null, evRoiPct: null, reasons: ['1分钟K线不足'] };
  }
  const last = candles1m[candles1m.length - 1];
  const cur = last.close;
  const winStart = strikePrice !== null && strikePrice !== undefined;

  // ---------- 技术面打分（与市场定价无关） ----------
  let score = 0; // >0偏Up，<0偏Down

  // 1) 价格 vs 目标价：盘尾领先是最强信号，按ATR尺度归一
  if (winStart) {
    const diffPct = ((cur - strikePrice) / strikePrice) * 100;
    // 用近20根1m的平均振幅估计每分钟波动，衡量领先是否"安全"
    const c20 = candles1m.slice(-20);
    const avgRange =
      c20.reduce((s, c) => s + (c.high - c.low) / c.open, 0) / c20.length * 100 || 0.02;
    const leadInAtr = avgRange > 0 ? diffPct / avgRange : 0; // 领先了几个"分钟波动"
    const minutesLeft = secondsLeft / 60;
    // 领先(分钟波动数) 与 剩余分钟的平方根比较：剩余越少，同样领先越难被逆转
    const safety = leadInAtr / Math.max(0.5, Math.sqrt(minutesLeft));
    score += Math.max(-2.2, Math.min(2.2, safety * 1.1));
    reasons.push(
      `现价${cur.toFixed(1)} vs 目标价${strikePrice.toFixed(1)}（${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(3)}%＝${leadInAtr.toFixed(1)}个分钟波动，剩余${secondsLeft}秒）`
    );
  }

  // 2) 短线动能：近3根方向 + 最后一根实体强度
  const c3 = candles1m.slice(-3);
  const mom = c3.filter((c) => c.close > c.open).length - c3.filter((c) => c.close < c.open).length;
  if (mom !== 0) {
    score += mom * 0.35;
    reasons.push(`近3根1分钟K线${mom > 0 ? '偏多' : '偏空'}（${mom > 0 ? '+' : ''}${mom}）`);
  }
  const body = last.high - last.low > 0 ? (last.close - last.open) / (last.high - last.low) : 0;
  if (Math.abs(body) > 0.5) {
    score += body * 0.5;
    reasons.push(`当前1分钟${body > 0 ? '强实体阳线' : '强实体阴线'}（实体占比${(Math.abs(body) * 100).toFixed(0)}%）`);
  }

  // 3) 短周期RSI(7)：超短线动量方向
  const closes = candles1m.slice(-30).map((c) => c.close);
  const r7 = rsi1m(closes, 7);
  if (r7 !== null) {
    if (r7 > 60) score += 0.4;
    else if (r7 < 40) score -= 0.4;
    reasons.push(`1分钟RSI(7)=${r7.toFixed(0)}${r7 > 60 ? '，短线偏强' : r7 < 40 ? '，短线偏弱' : '，中性'}`);
  }

  // 4) 量能方向：窗口内上涨分钟量 vs 下跌分钟量
  if (winStart) {
    const winCandles = candles1m.filter((c) => c.time >= p.winStartSec || c.time >= last.time - 300);
    let upVol = 0;
    let downVol = 0;
    for (const c of winCandles.slice(-5)) {
      if (c.close > c.open) upVol += c.volume;
      else if (c.close < c.open) downVol += c.volume;
    }
    if (upVol + downVol > 0) {
      const volBias = (upVol - downVol) / (upVol + downVol);
      if (Math.abs(volBias) > 0.2) {
        score += volBias * 0.6;
        reasons.push(`窗口内量能${volBias > 0 ? '买方' : '卖方'}占优（${(Math.abs(volBias) * 100).toFixed(0)}%）`);
      }
    }
  }

  // 5) Polymarket微观结构确认（小权重，仅作确认不作主导）
  if (flow && flow.bigTrades && flow.bigTrades.length > 0) {
    const bigUp = flow.bigTrades.filter((t) => t.direction === 'up').reduce((s, t) => s + t.usd, 0);
    const bigDown = flow.bigTrades.filter((t) => t.direction === 'down').reduce((s, t) => s + t.usd, 0);
    if (bigUp + bigDown > 500) {
      const bigBias = (bigUp - bigDown) / (bigUp + bigDown);
      score += bigBias * 0.3;
      reasons.push(`PM大单：押涨$${bigUp.toFixed(0)} vs 押跌$${bigDown.toFixed(0)}`);
    }
  }
  if (book && Math.abs(book.imbalance) > 0.3) {
    score += book.imbalance * 0.2;
    reasons.push(`Up订单簿${book.imbalance > 0 ? '买盘厚' : '卖压大'}（${(book.imbalance * 100).toFixed(0)}%）`);
  }

  // ---------- 概率与置信度 ----------
  const techProb = Math.min(0.97, Math.max(0.03, 1 / (1 + Math.exp(-score * 1.1))));
  const conf = Math.abs(techProb - 0.5) * 2; // 0~1

  // ---------- 决策窗口控制（盘尾2-3分钟） ----------
  let action;
  const dir = techProb >= 0.5 ? 'up' : 'down';
  const extremePricing =
    upPrice !== null && upPrice !== undefined && (upPrice >= 0.985 || upPrice <= 0.015);
  if (secondsLeft > 180) {
    action = '等待盘尾决策窗口（剩余2-3分钟时出手）';
    reasons.push('早段反转概率高，纪律：只在最后2-3分钟做方向决策');
  } else if (secondsLeft < 30) {
    action = '临近结算，勿追单';
    reasons.push('剩余<30秒，滑点与成交延迟会吃掉优势');
  } else if (extremePricing) {
    action = '定价接近极端，本期已无交易价值';
    reasons.push('市场已定价>98.5¢或<1.5¢，买贵侧ROI趋近0、买便宜侧胜率极低');
  } else if (conf < 0.2) {
    action = '信号不足，观望';
    reasons.push(`技术面置信度仅${(conf * 100).toFixed(0)}%（需≥20%），本期放弃`);
  } else {
    action = dir === 'up' ? '买Up' : '买Down';
  }

  // ---------- 成本与ROI（市场价只在这里使用，不参与方向判断） ----------
  let cost = null;
  let potentialRoiPct = null;
  let evRoiPct = null;
  let edge = 0;
  if (upPrice !== null && upPrice > 0.01 && upPrice < 0.99) {
    cost = dir === 'up' ? upPrice : 1 - upPrice;
    potentialRoiPct = ((1 - cost) / cost) * 100;
    const winProb = dir === 'up' ? techProb : 1 - techProb;
    evRoiPct = (winProb * (1 - cost) / cost - (1 - winProb)) * 100;
    edge = winProb - cost;
    if (action === '买Up' || action === '买Down') {
      reasons.push(
        `买入价值：${(cost * 100).toFixed(0)}¢/份 → 命中ROI +${potentialRoiPct.toFixed(0)}%，未中-100%；按技术面胜率${(winProb * 100).toFixed(0)}%计算期望ROI ${evRoiPct >= 0 ? '+' : ''}${evRoiPct.toFixed(0)}%`
      );
      if (evRoiPct < 5) {
        action = '期望ROI不足，观望';
        reasons.push('技术面胜率相对当前价格无期望优势（期望ROI<5%），放弃本期');
      }
    }
  }

  return { action, edge, techProb, conf, cost, potentialRoiPct, evRoiPct, reasons };
}
