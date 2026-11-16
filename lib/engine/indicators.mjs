function none(n) {
  return Array(n).fill(null);
}

export function sma(values, period) {
  const out = none(values.length);
  if (period <= 0 || values.length < period) return out;
  let total = values.slice(0, period).reduce((sum, value) => sum + value, 0);
  out[period - 1] = total / period;
  for (let i = period; i < values.length; i += 1) {
    total += values[i] - values[i - period];
    out[i] = total / period;
  }
  return out;
}

export function ema(values, period) {
  const out = none(values.length);
  if (values.length < period || period <= 0) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function emaOptional(values, period) {
  const out = none(values.length);
  const buf = [];
  let start = null;
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] == null) continue;
    buf.push(values[i]);
    if (buf.length === period) {
      const seed = buf.reduce((sum, value) => sum + value, 0) / period;
      out[i] = seed;
      start = i;
      break;
    }
  }
  if (start == null) return out;
  const k = 2 / (period + 1);
  let prev = out[start];
  for (let i = start + 1; i < values.length; i += 1) {
    if (values[i] == null) continue;
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function stdev(window) {
  const mean = window.reduce((sum, value) => sum + value, 0) / window.length;
  const variance = window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / window.length;
  return Math.sqrt(variance);
}

export function trueRanges(high, low, close) {
  const out = [high[0] - low[0]];
  for (let i = 1; i < close.length; i += 1) {
    out.push(Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])));
  }
  return out;
}

export function rma(values, period) {
  const out = none(values.length);
  if (values.length < period || period <= 0) return out;
  let prev = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i += 1) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function atr(high, low, close, period = 14) {
  return rma(trueRanges(high, low, close), period);
}

export function rsi(close, period = 14) {
  const out = none(close.length);
  if (close.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = close[i] - close[i - 1];
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const reading = (avgG, avgL) => {
    if (avgL === 0) return avgG > 0 ? 100 : 50;
    return 100 - 100 / (1 + avgG / avgL);
  };
  out[period] = reading(avgGain, avgLoss);
  for (let i = period + 1; i < close.length; i += 1) {
    const change = close[i] - close[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    out[i] = reading(avgGain, avgLoss);
  }
  return out;
}

export function macd(close, fast = 12, slow = 26, signalN = 9) {
  const fastEma = ema(close, fast);
  const slowEma = ema(close, slow);
  const line = close.map((_, i) => (fastEma[i] == null || slowEma[i] == null ? null : fastEma[i] - slowEma[i]));
  const signal = emaOptional(line, signalN);
  const hist = close.map((_, i) => (line[i] == null || signal[i] == null ? null : line[i] - signal[i]));
  return [line, signal, hist];
}

export function kdj(high, low, close, n = 9) {
  const kOut = none(close.length);
  const dOut = none(close.length);
  const jOut = none(close.length);
  let k = 50;
  let d = 50;
  for (let i = 0; i < close.length; i += 1) {
    if (i < n - 1) continue;
    const lowest = Math.min(...low.slice(i - n + 1, i + 1));
    const highest = Math.max(...high.slice(i - n + 1, i + 1));
    const rsv = highest === lowest ? 50 : ((close[i] - lowest) / (highest - lowest)) * 100;
    k = (2 * k + rsv) / 3;
    d = (2 * d + k) / 3;
    kOut[i] = k;
    dOut[i] = d;
    jOut[i] = 3 * k - 2 * d;
  }
  return [kOut, dOut, jOut];
}

export function bollinger(close, period = 20, mult = 2) {
  const mid = sma(close, period);
  const upper = none(close.length);
  const lower = none(close.length);
  const width = none(close.length);
  const percentB = none(close.length);
  for (let i = period - 1; i < close.length; i += 1) {
    const window = close.slice(i - period + 1, i + 1);
    const sd = stdev(window);
    const middle = mid[i];
    upper[i] = middle + mult * sd;
    lower[i] = middle - mult * sd;
    if (middle) width[i] = (upper[i] - lower[i]) / middle;
    const span = upper[i] - lower[i];
    percentB[i] = span === 0 ? 0.5 : (close[i] - lower[i]) / span;
  }
  return [mid, upper, lower, width, percentB];
}

export function dmi(high, low, close, period = 14) {
  const size = close.length;
  const plusDm = Array(size).fill(0);
  const minusDm = Array(size).fill(0);
  for (let i = 1; i < size; i += 1) {
    const up = high[i] - high[i - 1];
    const down = low[i - 1] - low[i];
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
  }
  const smTr = rma(trueRanges(high, low, close), period);
  const smPlus = rma(plusDm, period);
  const smMinus = rma(minusDm, period);
  const plusDi = none(size);
  const minusDi = none(size);
  const dx = none(size);
  for (let i = 0; i < size; i += 1) {
    if (smTr[i] == null || smTr[i] === 0 || smPlus[i] == null || smMinus[i] == null) continue;
    plusDi[i] = (100 * smPlus[i]) / smTr[i];
    minusDi[i] = (100 * smMinus[i]) / smTr[i];
    const denom = plusDi[i] + minusDi[i];
    dx[i] = denom === 0 ? 0 : (100 * Math.abs(plusDi[i] - minusDi[i])) / denom;
  }
  const adx = none(size);
  const dxValues = [];
  for (let i = 0; i < size; i += 1) if (dx[i] != null) dxValues.push([i, dx[i]]);
  if (dxValues.length >= period) {
    const seedIdx = dxValues[period - 1][0];
    let prev = dxValues.slice(0, period).reduce((sum, pair) => sum + pair[1], 0) / period;
    adx[seedIdx] = prev;
    for (const [i, value] of dxValues.slice(period)) {
      prev = (prev * (period - 1) + value) / period;
      adx[i] = prev;
    }
  }
  return [plusDi, minusDi, adx];
}

export function obv(close, volume) {
  const out = [volume.length ? volume[0] : 0];
  for (let i = 1; i < close.length; i += 1) {
    if (close[i] > close[i - 1]) out.push(out[out.length - 1] + volume[i]);
    else if (close[i] < close[i - 1]) out.push(out[out.length - 1] - volume[i]);
    else out.push(out[out.length - 1]);
  }
  return out;
}

export function rollingVwap(high, low, close, volume, period = 20) {
  const out = none(close.length);
  const typical = close.map((_, i) => (high[i] + low[i] + close[i]) / 3);
  for (let i = period - 1; i < close.length; i += 1) {
    let vol = 0;
    let money = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      vol += volume[j];
      money += typical[j] * volume[j];
    }
    if (vol === 0) continue;
    out[i] = money / vol;
  }
  return out;
}

export function supertrend(high, low, close, period = 10, mult = 3) {
  const size = close.length;
  const atrValues = atr(high, low, close, period);
  const line = none(size);
  const direction = none(size);
  let finalUpper = null;
  let finalLower = null;
  for (let i = 0; i < size; i += 1) {
    if (atrValues[i] == null) continue;
    const hl2 = (high[i] + low[i]) / 2;
    const basicUpper = hl2 + mult * atrValues[i];
    const basicLower = hl2 - mult * atrValues[i];
    if (finalUpper == null) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      direction[i] = close[i] >= hl2 ? 1 : -1;
      line[i] = direction[i] === 1 ? finalLower : finalUpper;
      continue;
    }
    const prevUpper = finalUpper;
    const prevLower = finalLower;
    const prevDir = direction[i - 1] == null ? 1 : direction[i - 1];
    finalUpper = basicUpper < prevUpper || close[i - 1] > prevUpper ? basicUpper : prevUpper;
    finalLower = basicLower > prevLower || close[i - 1] < prevLower ? basicLower : prevLower;
    if (prevDir === 1) direction[i] = close[i] < finalLower ? -1 : 1;
    else direction[i] = close[i] > finalUpper ? 1 : -1;
    line[i] = direction[i] === 1 ? finalLower : finalUpper;
  }
  return [line, direction];
}

export function cci(high, low, close, period = 20) {
  const out = none(close.length);
  const typical = close.map((_, i) => (high[i] + low[i] + close[i]) / 3);
  for (let i = period - 1; i < close.length; i += 1) {
    const window = typical.slice(i - period + 1, i + 1);
    const mean = window.reduce((sum, value) => sum + value, 0) / period;
    const meanDev = window.reduce((sum, value) => sum + Math.abs(value - mean), 0) / period;
    out[i] = meanDev === 0 ? 0 : (typical[i] - mean) / (0.015 * meanDev);
  }
  return out;
}

export function trix(close, period = 12, signalN = 9) {
  const e1 = ema(close, period);
  const e2 = emaOptional(e1, period);
  const e3 = emaOptional(e2, period);
  const line = none(close.length);
  for (let i = 1; i < close.length; i += 1) {
    if (e3[i] == null || e3[i - 1] == null || e3[i - 1] === 0) continue;
    line[i] = ((e3[i] - e3[i - 1]) / Math.abs(e3[i - 1])) * 100;
  }
  return [line, emaOptional(line, signalN)];
}

export function bbi(close) {
  const m3 = sma(close, 3);
  const m6 = sma(close, 6);
  const m12 = sma(close, 12);
  const m24 = sma(close, 24);
  const out = none(close.length);
  for (let i = 0; i < close.length; i += 1) {
    const parts = [m3[i], m6[i], m12[i], m24[i]];
    if (parts.some((part) => part == null)) continue;
    out[i] = parts.reduce((sum, part) => sum + part, 0) / 4;
  }
  return out;
}

export function mfi(high, low, close, volume, period = 14) {
  const out = none(close.length);
  const typical = close.map((_, i) => (high[i] + low[i] + close[i]) / 3);
  for (let i = period; i < close.length; i += 1) {
    let pos = 0;
    let neg = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      const flow = typical[j] * volume[j];
      if (typical[j] > typical[j - 1]) pos += flow;
      else if (typical[j] < typical[j - 1]) neg += flow;
    }
    if (neg === 0 && pos === 0) out[i] = 50;
    else if (neg === 0) out[i] = 100;
    else out[i] = 100 - 100 / (1 + pos / neg);
  }
  return out;
}

export function cmf(high, low, close, volume, period = 20) {
  const out = none(close.length);
  const mult = close.map((_, i) => {
    const span = high[i] - low[i];
    return span === 0 ? 0 : (close[i] - low[i] - (high[i] - close[i])) / span;
  });
  for (let i = period - 1; i < close.length; i += 1) {
    let vol = 0;
    let flow = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      vol += volume[j];
      flow += mult[j] * volume[j];
    }
    if (vol === 0) continue;
    out[i] = flow / vol;
  }
  return out;
}

function smaOptional(values, period) {
  const out = none(values.length);
  for (let i = period - 1; i < values.length; i += 1) {
    const window = values.slice(i - period + 1, i + 1);
    if (window.some((value) => value == null)) continue;
    out[i] = window.reduce((sum, value) => sum + value, 0) / period;
  }
  return out;
}

export function stochRsi(close, rsiPeriod = 14, stochPeriod = 14, smooth = 3) {
  const rsiValues = rsi(close, rsiPeriod);
  const raw = none(close.length);
  for (let i = 0; i < close.length; i += 1) {
    const window = [];
    for (let j = i - stochPeriod + 1; j <= i; j += 1) {
      if (j >= 0) window.push(rsiValues[j]);
    }
    if (window.length < stochPeriod || window.some((value) => value == null)) continue;
    const low = Math.min(...window);
    const high = Math.max(...window);
    raw[i] = high === low ? 50 : ((rsiValues[i] - low) / (high - low)) * 100;
  }
  const k = smaOptional(raw, smooth);
  return [k, smaOptional(k, smooth)];
}

export function williamsR(high, low, close, period = 14) {
  const out = none(close.length);
  for (let i = period - 1; i < close.length; i += 1) {
    const highest = Math.max(...high.slice(i - period + 1, i + 1));
    const lowest = Math.min(...low.slice(i - period + 1, i + 1));
    out[i] = highest === lowest ? -50 : ((highest - close[i]) / (highest - lowest)) * -100;
  }
  return out;
}

export function aroon(high, low, period = 25) {
  const up = none(high.length);
  const down = none(high.length);
  for (let i = period; i < high.length; i += 1) {
    const windowH = high.slice(i - period, i + 1);
    const windowL = low.slice(i - period, i + 1);
    const barsSinceHigh = [...windowH].reverse().indexOf(Math.max(...windowH));
    const barsSinceLow = [...windowL].reverse().indexOf(Math.min(...windowL));
    up[i] = (100 * (period - barsSinceHigh)) / period;
    down[i] = (100 * (period - barsSinceLow)) / period;
  }
  return [up, down];
}

export function percentileRank(series, index, lookback = 120) {
  if (index < 0 || series[index] == null) return null;
  const start = Math.max(0, index - lookback + 1);
  const window = [];
  for (let i = start; i <= index; i += 1) if (series[i] != null) window.push(series[i]);
  if (window.length < 20) return null;
  const value = series[index];
  return (100 * window.filter((item) => item <= value).length) / window.length;
}

export function compute(bars) {
  const close = bars.map((bar) => bar.c);
  const high = bars.map((bar) => bar.h);
  const low = bars.map((bar) => bar.l);
  const volume = bars.map((bar) => bar.v || 0);
  const [macdLine, macdSignal, macdHist] = macd(close);
  const [k, d, j] = kdj(high, low, close);
  const [bbMid, bbUp, bbLow, bbWidth, percentB] = bollinger(close);
  const [plusDi, minusDi, adx] = dmi(high, low, close);
  const [stLine, stDir] = supertrend(high, low, close);
  const [trixLine, trixSignal] = trix(close);
  const [stochK, stochD] = stochRsi(close);
  const [aroonUp, aroonDown] = aroon(high, low);
  return {
    ema20: ema(close, 20),
    ema50: ema(close, 50),
    ema200: ema(close, 200),
    macd: macdLine,
    macd_signal: macdSignal,
    macd_hist: macdHist,
    k,
    d,
    j,
    rsi: rsi(close),
    bb_mid: bbMid,
    bb_up: bbUp,
    bb_low: bbLow,
    bb_width: bbWidth,
    percent_b: percentB,
    plus_di: plusDi,
    minus_di: minusDi,
    adx,
    obv: obv(close, volume),
    vwap: rollingVwap(high, low, close, volume, 20),
    supertrend: stLine,
    supertrend_dir: stDir,
    cci: cci(high, low, close),
    trix: trixLine,
    trix_signal: trixSignal,
    bbi: bbi(close),
    atr: atr(high, low, close, 14),
    mfi: mfi(high, low, close, volume),
    cmf: cmf(high, low, close, volume),
    stoch_k: stochK,
    stoch_d: stochD,
    williams: williamsR(high, low, close),
    aroon_up: aroonUp,
    aroon_down: aroonDown,
    vol_ma: sma(volume, 20),
  };
}
