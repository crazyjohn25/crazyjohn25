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

/**
 * 拉取双边订单簿并提取真实成交价格（关键：gamma的outcomePrices是滞后中间价，
 * 实际买入要吃对手卖单，必须用订单簿卖一价 bestAsk）
 * @returns {{ upAsk, downAsk, upBid, downBid, upBook, spreadCents }}
 */
export async function fetchRealPrices(upTokenId, downTokenId) {
  const [upBook, downBook] = await Promise.all([
    upTokenId ? fetchBook(upTokenId) : null,
    downTokenId ? fetchBook(downTokenId) : null,
  ]);
  const bestAsk = (b) =>
    b && b.asks && b.asks.length ? Math.min(...b.asks.map((l) => Number(l.price))) : null;
  const bestBid = (b) =>
    b && b.bids && b.bids.length ? Math.max(...b.bids.map((l) => Number(l.price))) : null;
  const upAsk = bestAsk(upBook);
  const downAsk = bestAsk(downBook);
  return {
    upAsk,
    downAsk,
    upBid: bestBid(upBook),
    downBid: bestBid(downBook),
    upBook,
    // 两边筹码价差（¢）：|Up买价 - Down买价|
    spreadCents:
      upAsk !== null && downAsk !== null ? Math.abs(upAsk - downAsk) * 100 : null,
  };
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

/** 从tick缓存取n秒前的价格（缓存为[{t,price}]升序） */
function priceAgo(tickBuffer, nowSec, secondsAgo) {
  if (!tickBuffer || tickBuffer.length < 2) return null;
  const target = nowSec - secondsAgo;
  for (let i = tickBuffer.length - 1; i >= 0; i--) {
    if (tickBuffer[i].t <= target) return tickBuffer[i].price;
  }
  return tickBuffer[0].price;
}

/** 允许的最高买入成本：越早越便宜，任何时候超过72¢都视为筹码失真 */
export const MAX_ENTRY_COST = 0.72;

/**
 * 5分钟Up/Down方向建议（纯函数）——真实价格+尽早决策版
 *
 * 核心修正（针对"成本严重失真"问题）：
 * 1. 成本与ROI一律使用【订单簿卖一真实买价】(upAsk/downAsk)，不用gamma滞后中间价；
 * 2. 不再限定盘尾时间窗：每期从头开始侦察，信号一旦充分立即出手——越早筹码越便宜；
 *    但每期只允许一次方向决策（由调用方锁定）；
 * 3. 规则1（快速通道）：|现价-目标价|≤$20 且 两边筹码价差≤20¢ → 用30秒/1分钟/5分钟
 *    三级短线动能快速决断，三者共振即出手；
 * 4. 规则2（反转警报）：|现价-目标价|≥$30 但 两边筹码价差≤10¢（大幅领先却近似五五开定价）
 *    → 市场在押注反转，返回 reversalAlert 供调用方报警；
 * 5. 买入成本>72¢直接放弃（"价格越低越好"）。
 *
 * @param {Object} p { candles1m, tickBuffer, strikePrice, upAsk, downAsk, flow, book, secondsLeft }
 * @returns {{action, techProb, conf, cost, potentialRoiPct, evRoiPct, edge, reasons, reversalAlert, decided}}
 */
export function advise5m(p) {
  const reasons = [];
  const { candles1m, tickBuffer, strikePrice, upAsk, downAsk, flow, book, secondsLeft } = p;
  const base = { edge: 0, techProb: null, conf: 0, cost: null, potentialRoiPct: null, evRoiPct: null, reversalAlert: false, decided: false };
  if (!candles1m || candles1m.length < 10) {
    return { ...base, action: '数据不足', reasons: ['1分钟K线不足'] };
  }
  if (strikePrice === null || strikePrice === undefined) {
    return { ...base, action: '等待目标价确立', reasons: ['窗口起始价尚未生成'] };
  }
  const last = candles1m[candles1m.length - 1];
  const nowSec = last.time + 59; // 近似当前时刻
  const cur = tickBuffer && tickBuffer.length ? tickBuffer[tickBuffer.length - 1].price : last.close;

  const leadUsd = cur - strikePrice;
  const spreadCents =
    upAsk !== null && downAsk !== null ? Math.abs(upAsk - downAsk) * 100 : null;

  reasons.push(
    `现价${cur.toFixed(1)} vs 目标价${strikePrice.toFixed(1)}（差${leadUsd >= 0 ? '+' : ''}$${leadUsd.toFixed(1)}），剩余${secondsLeft}秒` +
      (upAsk !== null && downAsk !== null
        ? `；真实买价 Up ${(upAsk * 100).toFixed(0)}¢ / Down ${(downAsk * 100).toFixed(0)}¢（订单簿卖一）`
        : '')
  );

  // ---------- 规则2：反转警报 ----------
  let reversalAlert = false;
  if (Math.abs(leadUsd) >= 30 && spreadCents !== null && spreadCents <= 10) {
    reversalAlert = true;
    reasons.push(
      `⚠ 反转警报：价格已领先$${Math.abs(leadUsd).toFixed(0)}但两边筹码仅差${spreadCents.toFixed(0)}¢——` +
        `聪明钱在押注反转，领先方并不安全`
    );
  }

  // ---------- 三级短线动能（30秒 / 1分钟 / 5分钟） ----------
  const p30 = priceAgo(tickBuffer, nowSec, 30);
  const mom30 = p30 !== null ? Math.sign(cur - p30) : 0;
  const c1 = candles1m[candles1m.length - 1];
  const mom1m = Math.sign(c1.close - c1.open);
  const c5 = candles1m.slice(-5);
  const mom5m = Math.sign(c5[c5.length - 1].close - c5[0].open);
  const momSum = mom30 + mom1m + mom5m;
  reasons.push(
    `三级动能：30秒${mom30 > 0 ? '↑' : mom30 < 0 ? '↓' : '—'} / 1分钟${mom1m > 0 ? '↑' : mom1m < 0 ? '↓' : '—'} / 5分钟${mom5m > 0 ? '↑' : mom5m < 0 ? '↓' : '—'}`
  );

  // ---------- 技术面打分 ----------
  let score = 0;

  // 领先度（按分钟波动归一 + 时间衰减）
  const c20 = candles1m.slice(-20);
  const avgRangeUsd = c20.reduce((s, c) => s + (c.high - c.low), 0) / c20.length || 1;
  const leadInAtr = leadUsd / avgRangeUsd;
  const minutesLeft = Math.max(0.3, secondsLeft / 60);
  score += Math.max(-2.2, Math.min(2.2, (leadInAtr / Math.sqrt(minutesLeft)) * 1.1));

  // 三级动能
  score += momSum * 0.35;

  // 1分钟RSI(7)
  const closes = candles1m.slice(-30).map((c) => c.close);
  const r7 = rsi1m(closes, 7);
  if (r7 !== null) {
    if (r7 > 60) score += 0.35;
    else if (r7 < 40) score -= 0.35;
    reasons.push(`1分钟RSI(7)=${r7.toFixed(0)}`);
  }

  // 量能方向（近5根）
  let upVol = 0;
  let downVol = 0;
  for (const c of c5) {
    if (c.close > c.open) upVol += c.volume;
    else if (c.close < c.open) downVol += c.volume;
  }
  if (upVol + downVol > 0) {
    const volBias = (upVol - downVol) / (upVol + downVol);
    if (Math.abs(volBias) > 0.2) {
      score += volBias * 0.5;
      reasons.push(`量能${volBias > 0 ? '买方' : '卖方'}占优（${(Math.abs(volBias) * 100).toFixed(0)}%）`);
    }
  }

  // PM微观结构（小权重确认）
  if (flow && flow.bigTrades && flow.bigTrades.length > 0) {
    const bigUp = flow.bigTrades.filter((t) => t.direction === 'up').reduce((s, t) => s + t.usd, 0);
    const bigDown = flow.bigTrades.filter((t) => t.direction === 'down').reduce((s, t) => s + t.usd, 0);
    if (bigUp + bigDown > 500) {
      score += ((bigUp - bigDown) / (bigUp + bigDown)) * 0.3;
      reasons.push(`PM大单：押涨$${bigUp.toFixed(0)} vs 押跌$${bigDown.toFixed(0)}`);
    }
  }
  if (book && Math.abs(book.imbalance) > 0.3) {
    score += book.imbalance * 0.2;
  }

  // 反转警报时压低对领先方的信心
  if (reversalAlert) score *= 0.5;

  const techProb = Math.min(0.97, Math.max(0.03, 1 / (1 + Math.exp(-score * 1.1))));
  const conf = Math.abs(techProb - 0.5) * 2;
  const dir = techProb >= 0.5 ? 'up' : 'down';

  // ---------- 决策 ----------
  const fastTrack = Math.abs(leadUsd) <= 20 && spreadCents !== null && spreadCents <= 20;
  let wantDecide = false;
  if (secondsLeft < 20) {
    return { ...base, action: '临近结算，本期放弃', techProb, conf, reversalAlert, reasons: [...reasons, '剩余<20秒，成交延迟风险过高'] };
  }
  if (fastTrack) {
    reasons.push(`快速通道：价差$${Math.abs(leadUsd).toFixed(1)}≤20且筹码价差${spreadCents.toFixed(0)}¢≤20——用三级动能速断`);
    // 三级动能完全共振，或2/3共振+订单簿同向
    const bookAgree = book && Math.sign(book.imbalance) === Math.sign(momSum) && Math.abs(book.imbalance) > 0.15;
    wantDecide = Math.abs(momSum) === 3 || (Math.abs(momSum) >= 1 && bookAgree && conf >= 0.15);
    if (!wantDecide) reasons.push('三级动能未共振，继续侦察等待时机');
  } else {
    wantDecide = conf >= 0.18;
    if (!wantDecide) reasons.push(`置信度${(conf * 100).toFixed(0)}%不足18%，继续侦察`);
  }

  // ---------- 成本与ROI（真实卖一价） ----------
  const ask = dir === 'up' ? upAsk : downAsk;
  let action = '继续侦察，时机未到';
  let cost = null;
  let potentialRoiPct = null;
  let evRoiPct = null;
  let edge = 0;
  let decided = false;

  if (wantDecide) {
    if (ask === null) {
      action = '订单簿无卖单，无法成交';
      reasons.push('目标方向订单簿缺少卖一价');
    } else if (ask > MAX_ENTRY_COST) {
      action = `筹码已失真（${(ask * 100).toFixed(0)}¢>72¢），放弃本期`;
      reasons.push('真实买价过高，命中ROI太低不值得参与——下期争取更早出手');
    } else {
      cost = ask;
      potentialRoiPct = ((1 - cost) / cost) * 100;
      const winProb = dir === 'up' ? techProb : 1 - techProb;
      evRoiPct = ((winProb * (1 - cost)) / cost - (1 - winProb)) * 100;
      edge = winProb - cost;
      if (evRoiPct >= 8) {
        action = dir === 'up' ? '买Up' : '买Down';
        decided = true;
        reasons.push(
          `真实成本${(cost * 100).toFixed(0)}¢/份（卖一实价）→ 命中ROI +${potentialRoiPct.toFixed(0)}%，未中-100%；技术面胜率${(winProb * 100).toFixed(0)}% → 期望ROI ${evRoiPct >= 0 ? '+' : ''}${evRoiPct.toFixed(0)}%`
        );
      } else {
        action = '期望ROI不足8%，继续侦察';
        reasons.push(`按真实价${(cost * 100).toFixed(0)}¢计算期望ROI仅${evRoiPct.toFixed(0)}%，不出手`);
      }
    }
  }

  return { action, edge, techProb, conf, cost, potentialRoiPct, evRoiPct, reasons, reversalAlert, decided };
}
