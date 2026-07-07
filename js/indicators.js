/**
 * 技术指标计算模块（纯函数，无外部依赖）
 * 所有函数接收K线数组 candles: [{ time, open, high, low, close, volume }]
 * 返回与输入等长的数组，数据不足的位置为 null。
 */

/** 简单移动平均 */
export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** 指数移动平均（首值用前period个值的SMA做种子） */
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * MACD 指标
 * @returns {{ dif: Array, dea: Array, hist: Array }}
 */
export function macd(candles, fast = 12, slow = 26, signal = 9) {
  const closes = candles.map((c) => c.close);
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const dif = closes.map((_, i) =>
    emaFast[i] !== null && emaSlow[i] !== null ? emaFast[i] - emaSlow[i] : null
  );

  // 对 dif 的有效段做 EMA 得到 DEA
  const firstValid = dif.findIndex((v) => v !== null);
  const dea = new Array(closes.length).fill(null);
  if (firstValid >= 0) {
    const validDif = dif.slice(firstValid);
    const deaValid = ema(validDif, signal);
    for (let i = 0; i < deaValid.length; i++) {
      dea[firstValid + i] = deaValid[i];
    }
  }

  const hist = dif.map((v, i) =>
    v !== null && dea[i] !== null ? v - dea[i] : null
  );
  return { dif, dea, hist };
}

/**
 * 布林带 Bollinger Bands
 * @returns {{ middle: Array, upper: Array, lower: Array }}
 */
export function bollinger(candles, period = 20, mult = 2) {
  const closes = candles.map((c) => c.close);
  const middle = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = closes[j] - middle[i];
      sumSq += d * d;
    }
    const std = Math.sqrt(sumSq / period);
    upper[i] = middle[i] + mult * std;
    lower[i] = middle[i] - mult * std;
  }
  return { middle, upper, lower };
}

/**
 * RSI（Wilder 平滑法）
 */
export function rsi(candles, period = 14) {
  const closes = candles.map((c) => c.close);
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * KDJ 随机指标
 * @returns {{ k: Array, d: Array, j: Array }}
 */
export function kdj(candles, period = 9, kSmooth = 3, dSmooth = 3) {
  const n = candles.length;
  const k = new Array(n).fill(null);
  const d = new Array(n).fill(null);
  const j = new Array(n).fill(null);
  let prevK = 50;
  let prevD = 50;

  for (let i = 0; i < n; i++) {
    if (i < period - 1) continue;
    let highest = -Infinity;
    let lowest = Infinity;
    for (let m = i - period + 1; m <= i; m++) {
      if (candles[m].high > highest) highest = candles[m].high;
      if (candles[m].low < lowest) lowest = candles[m].low;
    }
    const range = highest - lowest;
    const rsv = range === 0 ? 50 : ((candles[i].close - lowest) / range) * 100;
    prevK = ((kSmooth - 1) * prevK + rsv) / kSmooth;
    prevD = ((dSmooth - 1) * prevD + prevK) / dSmooth;
    k[i] = prevK;
    d[i] = prevD;
    j[i] = 3 * prevK - 2 * prevD;
  }
  return { k, d, j };
}

/**
 * DMI/ADX 动向指标（Wilder 平滑）
 * @returns {{ pdi: Array, mdi: Array, adx: Array }}
 */
export function dmi(candles, period = 14) {
  const n = candles.length;
  const pdi = new Array(n).fill(null);
  const mdi = new Array(n).fill(null);
  const adx = new Array(n).fill(null);
  if (n <= period) return { pdi, mdi, adx };

  const trArr = [];
  const pdmArr = [];
  const mdmArr = [];
  for (let i = 1; i < n; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    const upMove = cur.high - prev.high;
    const downMove = prev.low - cur.low;
    trArr.push(tr);
    pdmArr.push(upMove > downMove && upMove > 0 ? upMove : 0);
    mdmArr.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Wilder 平滑
  let trS = 0;
  let pdmS = 0;
  let mdmS = 0;
  for (let i = 0; i < period; i++) {
    trS += trArr[i];
    pdmS += pdmArr[i];
    mdmS += mdmArr[i];
  }

  const dxArr = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (i > period) {
      trS = trS - trS / period + trArr[i - 1];
      pdmS = pdmS - pdmS / period + pdmArr[i - 1];
      mdmS = mdmS - mdmS / period + mdmArr[i - 1];
    }
    const p = trS === 0 ? 0 : (pdmS / trS) * 100;
    const m = trS === 0 ? 0 : (mdmS / trS) * 100;
    pdi[i] = p;
    mdi[i] = m;
    dxArr[i] = p + m === 0 ? 0 : (Math.abs(p - m) / (p + m)) * 100;
  }

  // ADX = DX 的 Wilder 平滑
  const firstAdxIdx = period * 2 - 1;
  if (n > firstAdxIdx) {
    let sum = 0;
    for (let i = period; i <= firstAdxIdx; i++) sum += dxArr[i];
    let prevAdx = sum / period;
    adx[firstAdxIdx] = prevAdx;
    for (let i = firstAdxIdx + 1; i < n; i++) {
      prevAdx = (prevAdx * (period - 1) + dxArr[i]) / period;
      adx[i] = prevAdx;
    }
  }
  return { pdi, mdi, adx };
}

/**
 * OBV 能量潮
 */
export function obv(candles) {
  const out = new Array(candles.length).fill(null);
  if (candles.length === 0) return out;
  let cum = 0;
  out[0] = 0;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) cum += candles[i].volume;
    else if (candles[i].close < candles[i - 1].close) cum -= candles[i].volume;
    out[i] = cum;
  }
  return out;
}

/**
 * ATR 平均真实波幅（Wilder 平滑）
 */
export function atr(candles, period = 14) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n <= period) return out;
  const trs = [];
  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    trs.push(
      Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))
    );
  }
  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i];
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < n; i++) {
    prev = (prev * (period - 1) + trs[i - 1]) / period;
    out[i] = prev;
  }
  return out;
}

/**
 * VWAP 成交量加权均价（按UTC日锚定，机构常用的日内基准）
 */
export function vwapSeries(candles) {
  const out = new Array(candles.length).fill(null);
  let cumPV = 0;
  let cumV = 0;
  let curDay = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const day = Math.floor(c.time / 86400);
    if (day !== curDay) {
      curDay = day;
      cumPV = 0;
      cumV = 0;
    }
    const typical = (c.high + c.low + c.close) / 3;
    cumPV += typical * c.volume;
    cumV += c.volume;
    out[i] = cumV > 0 ? cumPV / cumV : null;
  }
  return out;
}

/**
 * 摆动高低点支撑/阻力：用 wings 根K线确认的枢轴点，
 * 返回距当前价最近的下方支撑与上方阻力。
 */
export function swingLevels(candles, { lookback = 80, wings = 2 } = {}) {
  const n = candles.length;
  if (n < wings * 2 + 2) return { support: null, resistance: null };
  const last = candles[n - 1].close;
  const start = Math.max(wings, n - lookback);
  let support = null;
  let resistance = null;
  for (let i = start; i < n - wings; i++) {
    let isHigh = true;
    let isLow = true;
    for (let w = 1; w <= wings; w++) {
      if (candles[i].high < candles[i - w].high || candles[i].high < candles[i + w].high)
        isHigh = false;
      if (candles[i].low > candles[i - w].low || candles[i].low > candles[i + w].low)
        isLow = false;
    }
    if (isHigh && candles[i].high > last && (resistance === null || candles[i].high < resistance))
      resistance = candles[i].high;
    if (isLow && candles[i].low < last && (support === null || candles[i].low > support))
      support = candles[i].low;
  }
  return { support, resistance };
}

/** 一次性计算全部指标，供图表与信号引擎复用 */
export function computeAll(candles, params = {}) {
  const closes = candles.map((c) => c.close);
  return {
    macd: macd(candles, params.macdFast, params.macdSlow, params.macdSignal),
    boll: bollinger(candles, params.bollPeriod, params.bollMult),
    rsi: rsi(candles, params.rsiPeriod),
    kdj: kdj(candles, params.kdjPeriod),
    dmi: dmi(candles, params.dmiPeriod),
    obv: obv(candles),
    atr: atr(candles, params.atrPeriod),
    vwap: vwapSeries(candles),
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
  };
}
