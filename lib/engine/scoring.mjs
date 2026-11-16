import { PROS_CONS } from "./catalog.mjs";
import { compute, percentileRank } from "./indicators.mjs";
import { formatYMDHM, SH } from "./time.mjs";

const REGIME_TREND = 25;
const REGIME_RANGE = 18;

const WEIGHTS = {
  ema_stack: ["trend", 12],
  bbi: ["trend", 6],
  supertrend: ["trend", 10],
  dmi: ["trend", 8],
  higher_tf: ["trend", 8],
  macd: ["momentum", 9],
  rsi: ["momentum", 7],
  kdj: ["momentum", 6],
  cci: ["momentum", 5],
  trix: ["momentum", 5],
  stochrsi: ["momentum", 4],
  obv: ["volume", 7],
  volume: ["volume", 4],
  mfi: ["volume", 5],
  cmf: ["volume", 4],
  vwap: ["volume", 5],
  bollinger: ["location", 6],
  williams: ["location", 3],
  relative: ["relative", 6],
  tvmc: ["summary", 8],
  etf_flow: ["flow", 8],
  funding: ["flow", 6],
};

const REGIME_MULT = {
  trend: { trend: 1.25, momentum: 1, volume: 1.05, location: 0.45, relative: 0.9, summary: 1, flow: 0.85 },
  range: { trend: 0.55, momentum: 1.2, volume: 0.9, location: 1.25, relative: 0.7, summary: 1, flow: 0.8 },
  transition: { trend: 0.8, momentum: 0.75, volume: 0.8, location: 0.6, relative: 0.6, summary: 0.8, flow: 0.7 },
};

function at(series, index) {
  if (series == null || index < 0 || index >= series.length) return null;
  return series[index];
}

function sign(value, dead = 0) {
  if (value > dead) return 1;
  if (value < -dead) return -1;
  return 0;
}

function fmt(value, digits = 2) {
  if (value == null) return "—";
  return Number(value).toFixed(digits);
}

function signed(value, digits) {
  const text = Math.abs(value).toFixed(digits);
  return `${value >= 0 ? "+" : "-"}${text}`;
}

export function classifyRegime(adxNow) {
  if (adxNow == null) return "transition";
  if (adxNow >= REGIME_TREND) return "trend";
  if (adxNow <= REGIME_RANGE) return "range";
  return "transition";
}

function swingPoints(values, kind, left = 3, right = 3) {
  const found = [];
  for (let i = left; i < values.length - right; i += 1) {
    const window = values.slice(i - left, i + right + 1);
    if (window.some((value) => value == null)) continue;
    if (kind === "high" && values[i] === Math.max(...window) && values[i] > values[i - 1]) found.push(i);
    if (kind === "low" && values[i] === Math.min(...window) && values[i] < values[i - 1]) found.push(i);
  }
  return found;
}

export function divergence(price, indicator, kind, end) {
  const start = Math.max(0, end - 45);
  const px = price.slice(start, end + 1);
  const ind = indicator.slice(start, end + 1);
  const points = swingPoints(px, kind === "bear" ? "high" : "low");
  if (points.length < 2) return false;
  const a = points[points.length - 2];
  const b = points[points.length - 1];
  if (b - a < 5 || b < px.length - 18) return false;
  if (ind[a] == null || ind[b] == null) return false;
  if (kind === "bear") return px[b] > px[a] && ind[b] < ind[a];
  return px[b] < px[a] && ind[b] > ind[a];
}

function higherDirection(higherBars, name) {
  if (higherBars == null || higherBars.length < 25) return [null, `${name}样本不足，这项不投票`];
  const pack = compute(higherBars);
  const i = higherBars.length - 1;
  const emaFast = at(pack.ema20, i);
  const emaSlow = at(pack.ema50, i);
  const close = higherBars[i].c;
  const st = at(pack.supertrend_dir, i);
  if (emaFast == null) return [null, `${name}均线尚未形成`];
  const votes = [];
  if (emaSlow != null) {
    if (close > emaFast && emaFast > emaSlow) votes.push(1);
    else if (close < emaFast && emaFast < emaSlow) votes.push(-1);
    else votes.push(0);
  } else votes.push(close > emaFast ? 1 : -1);
  if (st === 1 || st === -1) votes.push(st);
  const score = votes.reduce((sum, vote) => sum + vote, 0) / votes.length;
  if (score > 0.4) return [1, `${name}收盘与均线、Supertrend 同为多头`];
  if (score < -0.4) return [-1, `${name}收盘与均线、Supertrend 同为空头`];
  return [0, `${name}内部不一致，记为中性`];
}

function eventHorizon(events, now) {
  let upcoming = null;
  let inWindow = false;
  let earningsWindow = false;
  for (const event of events) {
    const delta = event.t - now;
    if (delta >= -6 * 3600 && delta <= 48 * 3600 && event.impact === "high") {
      inWindow = true;
      if (event.kind === "earnings") earningsWindow = true;
    }
    if (delta >= -6 * 3600 && (upcoming == null || event.t < upcoming.t)) upcoming = event;
  }
  return {
    in_window: inWindow,
    earnings_window: earningsWindow,
    next: upcoming,
    days: upcoming == null ? null : (upcoming.t - now) / 86400,
  };
}

function risk(pack, bars, index, eventWindow, daysToEvent) {
  const close = bars[index].c;
  const atrV = at(pack.atr, index);
  const ema20 = at(pack.ema20, index);
  const atrPct = bars.map((bar, i) => (pack.atr[i] == null || bar.c === 0 ? null : pack.atr[i] / bar.c));
  const volRank = percentileRank(atrPct, index);
  const widthRank = percentileRank(pack.bb_width, index);
  const parts = {};
  const weights = {};
  if (volRank != null) {
    parts["波动分位"] = volRank;
    weights["波动分位"] = 0.28;
  }
  if (widthRank != null) {
    parts["带宽分位"] = widthRank;
    weights["带宽分位"] = 0.18;
  }
  if (atrV != null && atrV !== 0 && ema20 != null) {
    parts["偏离"] = Math.min(100, (Math.abs(close - ema20) / atrV) * 25);
    weights["偏离"] = 0.26;
  }
  if (atrV != null && atrV !== 0 && index >= 1) {
    parts["冲击"] = Math.min(100, (Math.abs(close - bars[index - 1].c) / atrV) * 40);
    weights["冲击"] = 0.16;
  }
  if (eventWindow) parts["事件"] = 78;
  else if (daysToEvent != null && daysToEvent >= 0 && daysToEvent <= 5) parts["事件"] = 42;
  else parts["事件"] = 8;
  weights["事件"] = 0.12;
  const totalW = Object.values(weights).reduce((sum, value) => sum + value, 0);
  const score = Object.keys(parts).reduce((sum, key) => sum + parts[key] * weights[key], 0) / totalW;
  return [Math.max(0, Math.min(100, score)), parts];
}

function flowSignal(flows) {
  if (!flows || flows.length < 3) return [null, "没有足够的 ETF 净流数据"];
  const recent = flows.slice(-8);
  const last = recent[recent.length - 1].total_musd;
  const side = sign(last, 1);
  let streak = 0;
  if (side !== 0) {
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      if (sign(recent[i].total_musd, 1) === side) streak += 1;
      else break;
    }
  }
  const five = recent.slice(-5).reduce((sum, row) => sum + row.total_musd, 0);
  const reading = `最近公布日 ${signed(last, 0)} 百万美元，同向连续 ${streak} 日，近 5 日合计 ${signed(five, 0)}`;
  if (streak >= 4 && side !== 0) return [side, reading];
  if (five <= -500) return [-0.5, reading];
  if (five >= 500) return [0.5, reading];
  return [0, reading];
}

function fundingSignal(rate) {
  if (rate == null) return [null, "这个标的没有永续资金费率"];
  const pct = rate * 100;
  const reading = `当前资金费率 ${pct.toFixed(4)}% / 期`;
  if (rate >= 0.0003) return [-0.5, `${reading}，多头拥挤到值得折扣，但不足以单独做空`];
  if (rate <= -0.0003) return [0.5, `${reading}，空头拥挤到值得折扣，但不足以单独做多`];
  return [0, `${reading}，未到极端，不改变方向`];
}

function relativeSignal(primary, secondary, label) {
  if (primary == null && secondary == null) return [null, "没有基准可比较"];
  const bits = [];
  const votes = [];
  if (primary != null) {
    bits.push(`相对主基准 ${signed(primary * 100, 1)}%`);
    votes.push(Math.abs(primary) >= 0.02 ? sign(primary) : 0);
  }
  if (secondary != null) {
    bits.push(`相对次基准 ${signed(secondary * 100, 1)}%`);
    votes.push(Math.abs(secondary) >= 0.02 ? sign(secondary) : 0);
  }
  if (!votes.length) return [null, label];
  if (votes.every((vote) => vote === 1)) return [1, `${label}，${bits.join("，")}`];
  if (votes.every((vote) => vote === -1)) return [-1, `${label}，${bits.join("，")}`];
  return [0, `${label}，${bits.join("，")}，基准之间不一致`];
}

export function buildSignals(bars, pack, higherBars, context) {
  const i = bars.length - 1;
  const close = bars[i].c;
  const prev = Math.max(0, i - 1);
  const regime = classifyRegime(at(pack.adx, i));
  const signals = [];
  const add = (sid, direction, reading) => {
    const [group, weight] = WEIGHTS[sid];
    const meta = PROS_CONS[sid];
    signals.push({
      id: sid,
      name: meta.name,
      group,
      weight,
      direction,
      reading,
      pros: meta.pros,
      cons: meta.cons,
    });
  };

  const ema20 = at(pack.ema20, i);
  const ema50 = at(pack.ema50, i);
  const ema200 = at(pack.ema200, i);
  if (ema20 == null || ema50 == null) add("ema_stack", null, "均线样本不足");
  else if (ema200 != null && ema20 > ema50 && ema50 > ema200 && close > ema20) add("ema_stack", 1, `20>50>200，收盘在 EMA20 ${fmt(ema20)} 之上`);
  else if (ema200 != null && ema20 < ema50 && ema50 < ema200 && close < ema20) add("ema_stack", -1, `20<50<200，收盘在 EMA20 ${fmt(ema20)} 之下`);
  else if (close > ema20 && ema20 > ema50) add("ema_stack", 0.5, "短中期多头，EMA200 尚未同向");
  else if (close < ema20 && ema20 < ema50) add("ema_stack", -0.5, "短中期空头，EMA200 尚未同向");
  else add("ema_stack", 0, "均线缠绕，没有排列");

  const bbiV = at(pack.bbi, i);
  if (bbiV == null) add("bbi", null, "BBI 样本不足");
  else if (close > bbiV) add("bbi", 1, `收盘在 BBI ${fmt(bbiV)} 之上`);
  else if (close < bbiV) add("bbi", -1, `收盘在 BBI ${fmt(bbiV)} 之下`);
  else add("bbi", 0, "收盘贴着 BBI");

  const stDir = at(pack.supertrend_dir, i);
  const stLine = at(pack.supertrend, i);
  if (stDir !== 1 && stDir !== -1) add("supertrend", null, "Supertrend 样本不足");
  else add("supertrend", stDir, `Supertrend 为${stDir === 1 ? "多头" : "空头"}，线在 ${fmt(stLine)}`);

  const adx = at(pack.adx, i);
  const plusDi = at(pack.plus_di, i);
  const minusDi = at(pack.minus_di, i);
  if (adx == null || plusDi == null) add("dmi", null, "ADX 样本不足");
  else if (adx < REGIME_RANGE) add("dmi", 0, `ADX ${fmt(adx, 1)}，低于 18，方向线不投票`);
  else if (plusDi > minusDi) add("dmi", 1, `ADX ${fmt(adx, 1)}，+DI ${fmt(plusDi, 1)} 高于 -DI ${fmt(minusDi, 1)}`);
  else add("dmi", -1, `ADX ${fmt(adx, 1)}，-DI ${fmt(minusDi, 1)} 高于 +DI ${fmt(plusDi, 1)}`);

  const [higherDir, higherText] = higherDirection(higherBars, context.higher_name || "高周期");
  add("higher_tf", higherDir, higherText);

  const hist = at(pack.macd_hist, i);
  const histPrev = at(pack.macd_hist, prev);
  const macdV = at(pack.macd, i);
  const macdS = at(pack.macd_signal, i);
  if (hist == null || macdV == null || macdS == null) add("macd", null, "MACD 样本不足");
  else if (macdV > macdS && hist > 0 && histPrev != null && hist >= histPrev) add("macd", 1, `MACD 在信号线上，柱 ${fmt(hist, 3)} 未缩短`);
  else if (macdV < macdS && hist < 0 && histPrev != null && hist <= histPrev) add("macd", -1, `MACD 在信号线下，柱 ${fmt(hist, 3)} 继续向下`);
  else if (macdV > macdS) add("macd", 0, `仍在信号线上，但柱已缩短到 ${fmt(hist, 3)}`);
  else if (macdV < macdS) add("macd", 0, `仍在信号线下，但空头柱已缩短到 ${fmt(hist, 3)}`);
  else add("macd", 0, "MACD 与信号线粘合");

  const rsiV = at(pack.rsi, i);
  const rsiPrev = at(pack.rsi, prev);
  if (rsiV == null) add("rsi", null, "RSI 样本不足");
  else if (regime === "range") {
    if (rsiV < 30) add("rsi", 1, `震荡框架，RSI ${fmt(rsiV, 1)} 进入超卖区`);
    else if (rsiV > 70) add("rsi", -1, `震荡框架，RSI ${fmt(rsiV, 1)} 进入超买区`);
    else add("rsi", 0, `震荡框架，RSI ${fmt(rsiV, 1)} 在中性区`);
  } else if (regime === "trend") {
    if (rsiV >= 75 || rsiV <= 25) add("rsi", 0, `趋势框架，RSI ${fmt(rsiV, 1)} 极端，只记位置风险，不反向`);
    else if (rsiPrev != null && rsiV >= 50 && rsiV >= rsiPrev) add("rsi", 1, `趋势框架，RSI ${fmt(rsiV, 1)} 站在 50 上`);
    else if (rsiPrev != null && rsiV < 45 && rsiV <= rsiPrev) add("rsi", -1, `趋势框架，RSI ${fmt(rsiV, 1)} 掉到 45 下并走弱`);
    else add("rsi", 0, `趋势框架，RSI ${fmt(rsiV, 1)} 没有给出同向确认`);
  } else if (rsiPrev != null && rsiPrev < 50 && rsiV >= 50) add("rsi", 1, `过渡框架，RSI 上穿 50，现为 ${fmt(rsiV, 1)}`);
  else if (rsiPrev != null && rsiPrev > 50 && rsiV <= 50) add("rsi", -1, `过渡框架，RSI 下穿 50，现为 ${fmt(rsiV, 1)}`);
  else add("rsi", 0, `过渡框架，RSI ${fmt(rsiV, 1)} 不作为方向`);

  const k = at(pack.k, i);
  const d = at(pack.d, i);
  const j = at(pack.j, i);
  if (k == null || d == null) add("kdj", null, "KDJ 样本不足");
  else if (regime === "range") {
    if (j != null && (j < 0 || k < 20) && k >= d) add("kdj", 1, `震荡框架，K ${fmt(k, 1)} D ${fmt(d, 1)} J ${fmt(j, 1)} 在低位转上`);
    else if (j != null && (j > 100 || k > 80) && k <= d) add("kdj", -1, `震荡框架，K ${fmt(k, 1)} D ${fmt(d, 1)} J ${fmt(j, 1)} 在高位转下`);
    else add("kdj", 0, `震荡框架，KDJ 未到边缘，K ${fmt(k, 1)}`);
  } else if (k > d && k > 50) add("kdj", regime !== "trend" ? 1 : 0.5, `K ${fmt(k, 1)} 在 D 之上且高于 50`);
  else if (k < d && k < 50) add("kdj", regime !== "trend" ? -1 : -0.5, `K ${fmt(k, 1)} 在 D 之下且低于 50`);
  else add("kdj", 0, `K ${fmt(k, 1)} D ${fmt(d, 1)} 没有干净交叉`);

  const cciV = at(pack.cci, i);
  if (cciV == null) add("cci", null, "CCI 样本不足");
  else if (regime === "range") {
    if (cciV < -100) add("cci", 1, `震荡框架，CCI ${fmt(cciV, 0)} 低于 -100`);
    else if (cciV > 100) add("cci", -1, `震荡框架，CCI ${fmt(cciV, 0)} 高于 100`);
    else add("cci", 0, `震荡框架，CCI ${fmt(cciV, 0)} 在常态内`);
  } else if (Math.abs(cciV) > 200) add("cci", 0, `CCI ${fmt(cciV, 0)} 极端，只说明延伸，不反向`);
  else if (cciV > 0) add("cci", 1, `CCI ${fmt(cciV, 0)} 在零轴上`);
  else add("cci", -1, `CCI ${fmt(cciV, 0)} 在零轴下`);

  const trixV = at(pack.trix, i);
  const trixS = at(pack.trix_signal, i);
  const trixPrev = at(pack.trix, prev);
  if (trixV == null || trixS == null) add("trix", null, "TRIX 样本不足");
  else if (trixV > trixS && (trixPrev == null || trixV >= trixPrev)) add("trix", 1, `TRIX ${fmt(trixV, 3)} 在信号线之上`);
  else if (trixV < trixS && (trixPrev == null || trixV <= trixPrev)) add("trix", -1, `TRIX ${fmt(trixV, 3)} 在信号线之下`);
  else add("trix", 0, `TRIX ${fmt(trixV, 3)} 与信号线方向不一致`);

  const sk = at(pack.stoch_k, i);
  const sd = at(pack.stoch_d, i);
  if (sk == null || sd == null) add("stochrsi", null, "StochRSI 样本不足");
  else if (regime === "range" && sk < 20 && sk >= sd) add("stochrsi", 1, `震荡框架，StochRSI K ${fmt(sk, 1)} 低位转上`);
  else if (regime === "range" && sk > 80 && sk <= sd) add("stochrsi", -1, `震荡框架，StochRSI K ${fmt(sk, 1)} 高位转下`);
  else if (regime === "trend" && sk > sd && sk > 50) add("stochrsi", 0.5, `趋势框架，StochRSI K ${fmt(sk, 1)} 在 50 上`);
  else if (regime === "trend" && sk < sd && sk < 50) add("stochrsi", -0.5, `趋势框架，StochRSI K ${fmt(sk, 1)} 在 50 下`);
  else add("stochrsi", 0, `StochRSI K ${fmt(sk, 1)} 不额外投票`);

  const obvNow = at(pack.obv, i);
  const obvThen = at(pack.obv, Math.max(0, i - 10));
  const priceSlope = close - bars[Math.max(0, i - 10)].c;
  if (obvNow == null || obvThen == null) add("obv", null, "OBV 样本不足");
  else {
    const obvSlope = obvNow - obvThen;
    if (priceSlope > 0 && obvSlope > 0) add("obv", 1, "近 10 根价格与 OBV 同时向上");
    else if (priceSlope < 0 && obvSlope < 0) add("obv", -1, "近 10 根价格与 OBV 同时向下");
    else if (priceSlope > 0 && obvSlope < 0) add("obv", 0, "价格上涨但 OBV 下降，量能不确认");
    else if (priceSlope < 0 && obvSlope > 0) add("obv", 0, "价格下跌但 OBV 上升，抛压没有同步");
    else add("obv", 0, "价格或 OBV 近 10 根几乎走平");
  }

  const vol = bars[i].v || 0;
  const volMa = at(pack.vol_ma, i);
  const candleUp = close >= bars[i].o;
  if (volMa == null || volMa === 0) add("volume", null, "成交量均线不足");
  else {
    const ratio = vol / volMa;
    if (ratio >= 1.15 && ((candleUp && priceSlope >= 0) || (!candleUp && priceSlope < 0))) {
      add("volume", candleUp ? 1 : -1, `成交量是 20 均量的 ${ratio.toFixed(2)} 倍，并与 K 线方向一致`);
    } else if (ratio < 0.75) add("volume", 0, `成交量只有 20 均量的 ${ratio.toFixed(2)} 倍，不确认突破`);
    else add("volume", 0, `成交量是 20 均量的 ${ratio.toFixed(2)} 倍，中性`);
  }

  const mfiV = at(pack.mfi, i);
  if (mfiV == null) add("mfi", null, "MFI 样本不足");
  else if (regime === "range" && mfiV < 20) add("mfi", 1, `震荡框架，MFI ${fmt(mfiV, 1)} 超卖`);
  else if (regime === "range" && mfiV > 80) add("mfi", -1, `震荡框架，MFI ${fmt(mfiV, 1)} 超买`);
  else if (regime !== "range" && mfiV > 85) add("mfi", 0, `MFI ${fmt(mfiV, 1)} 极端，趋势里不反向`);
  else if (mfiV > 55) add("mfi", regime !== "range" ? 1 : 0, `MFI ${fmt(mfiV, 1)} 在 55 之上`);
  else if (mfiV < 45) add("mfi", regime !== "range" ? -1 : 0, `MFI ${fmt(mfiV, 1)} 在 45 之下`);
  else add("mfi", 0, `MFI ${fmt(mfiV, 1)} 在中轴附近`);

  const cmfV = at(pack.cmf, i);
  if (cmfV == null) add("cmf", null, "CMF 样本不足");
  else if (cmfV > 0.05) add("cmf", 1, `CMF ${fmt(cmfV, 3)}，收盘偏向高位`);
  else if (cmfV < -0.05) add("cmf", -1, `CMF ${fmt(cmfV, 3)}，收盘偏向低位`);
  else add("cmf", 0, `CMF ${fmt(cmfV, 3)}，没有明显偏向`);

  const vwap = at(pack.vwap, i);
  const daily = (context.interval_sec ?? 86400) >= 86400;
  if (vwap == null) add("vwap", null, "VWAP 样本不足");
  else if (close > vwap) {
    const note = daily ? "日线使用 20 根滚动 VWAP，不是分时 VWAP" : "收盘在窗口 VWAP 之上";
    add("vwap", 1, `${note}，VWAP ${fmt(vwap)}`);
  } else {
    const note = daily ? "日线使用 20 根滚动 VWAP，不是分时 VWAP" : "收盘在窗口 VWAP 之下";
    add("vwap", -1, `${note}，VWAP ${fmt(vwap)}`);
  }

  const percentB = at(pack.percent_b, i);
  const mid = at(pack.bb_mid, i);
  if (percentB == null) add("bollinger", null, "布林带样本不足");
  else if (regime === "range" && percentB <= 0.08) add("bollinger", 1, `震荡框架，%B ${fmt(percentB, 2)} 贴下轨`);
  else if (regime === "range" && percentB >= 0.92) add("bollinger", -1, `震荡框架，%B ${fmt(percentB, 2)} 贴上轨`);
  else if (regime === "trend" && percentB >= 1) add("bollinger", 0, `%B ${fmt(percentB, 2)} 收在上轨外，趋势里这不是做空`);
  else if (close > (mid ?? close)) add("bollinger", regime === "trend" ? 0.5 : 0, `%B ${fmt(percentB, 2)}，在中轨之上`);
  else if (close < (mid ?? close)) add("bollinger", regime === "trend" ? -0.5 : 0, `%B ${fmt(percentB, 2)}，在中轨之下`);
  else add("bollinger", 0, `%B ${fmt(percentB, 2)}`);

  const will = at(pack.williams, i);
  if (will == null) add("williams", null, "Williams %R 样本不足");
  else if (regime !== "range") add("williams", 0, `%R ${fmt(will, 1)}。趋势或过渡里这条会钝化，方向分记 0`);
  else if (will <= -80) add("williams", 1, `震荡框架，%R ${fmt(will, 1)} 进入超卖`);
  else if (will >= -20) add("williams", -1, `震荡框架，%R ${fmt(will, 1)} 进入超买`);
  else add("williams", 0, `%R ${fmt(will, 1)} 在中性区`);

  const [relDir, relText] = relativeSignal(context.rs_primary, context.rs_secondary, context.rs_label || "相对强弱");
  add("relative", relDir, relText);
  if (context.asset_id === "btc") {
    const [flowDir, flowText] = flowSignal(context.flows);
    add("etf_flow", flowDir, flowText);
  }
  if (context.asset_class === "crypto") {
    const [fundDir, fundText] = fundingSignal(context.funding_rate);
    add("funding", fundDir, fundText);
  }
  return [signals, regime, { percent_b: percentB, higher: higherDir }];
}

function leg(signals, group) {
  const vals = signals.filter((signal) => signal.group === group && signal.direction != null).map((signal) => signal.direction);
  if (!vals.length) return null;
  return vals.reduce((sum, value) => sum + value, 0) / vals.length;
}

function tvmc(signals) {
  const trend = leg(signals, "trend");
  const mom = leg(signals, "momentum");
  const vol = leg(signals, "volume");
  if ([trend, mom, vol].some((part) => part == null)) return [0, 0];
  const value = Math.max(-100, Math.min(100, 100 * (0.45 * trend + 0.35 * mom + 0.2 * vol)));
  const signs = [sign(trend, 0.2), sign(mom, 0.2), sign(vol, 0.2)];
  if (signs[0] !== 0 && signs[0] === signs[1] && signs[1] === signs[2]) return [signs[0], value];
  return [0, value];
}

function stance(action, regime) {
  if (regime === "range") {
    if (action >= 55) return ["range_long", "震荡低吸"];
    if (action >= 28) return ["range_long_light", "震荡轻度低吸"];
    if (action <= -55) return ["range_short", "震荡高抛"];
    if (action <= -28) return ["range_short_light", "震荡轻度高抛"];
    return ["flat", "观望"];
  }
  const prefix = regime === "trend" ? "趋势" : "过渡";
  if (action >= 60) return [`${regime}_long`, `${prefix}偏多`];
  if (action >= 28) return [`${regime}_long_light`, `${prefix}轻度偏多`];
  if (action <= -60) return [`${regime}_short`, `${prefix}偏空`];
  if (action <= -28) return [`${regime}_short_light`, `${prefix}轻度偏空`];
  return ["flat", "观望"];
}

function execution(bars, pack, index, regime, directionScore, contextFlags) {
  const notes = [];
  let score = 62;
  const close = bars[index].c;
  const atrV = at(pack.atr, index);
  const ema20 = at(pack.ema20, index);
  const percentB = at(pack.percent_b, index);
  if (atrV != null && atrV !== 0 && ema20 != null) {
    const stretch = Math.abs(close - ema20) / atrV;
    const aligned = (directionScore > 0 && close >= ema20) || (directionScore < 0 && close <= ema20);
    if (regime === "trend" && aligned && stretch <= 0.7) {
      score += 16;
      notes.push("价格靠近 EMA20，趋势方向上这是回踩而不是追价");
    } else if (stretch <= 1.4) score += 4;
    else if (stretch <= 2.4) {
      score -= 14;
      notes.push(`价格离开 EMA20 已有 ${stretch.toFixed(1)} 倍 ATR`);
    } else {
      score -= 28;
      notes.push(`价格离开 EMA20 达 ${stretch.toFixed(1)} 倍 ATR，不适合追`);
    }
  }
  if (regime === "range" && percentB != null) {
    if (percentB <= 0.12 || percentB >= 0.88) {
      if ((directionScore > 0 && percentB <= 0.12) || (directionScore < 0 && percentB >= 0.88)) {
        score += 14;
        notes.push("震荡框架里，价格正在区间边缘，和方向一致");
      }
    } else {
      score -= 10;
      notes.push("价格在区间中部，震荡策略没有位置优势");
    }
  }
  const volMa = at(pack.vol_ma, index);
  if (volMa != null && volMa !== 0) {
    const ratio = (bars[index].v || 0) / volMa;
    if (ratio >= 1.15) score += 6;
    else if (ratio < 0.7) {
      score -= 6;
      notes.push("成交量偏弱，突破质量不足");
    }
  }
  if ((contextFlags.risk || 0) >= 75) {
    score -= 10;
    notes.push("SCTI-RSK 高于 75，执行分下调");
  }
  return [Math.max(0, Math.min(100, score)), notes];
}

function invalidation(bars, pack, index, action) {
  const close = bars[index].c;
  const atrV = at(pack.atr, index) || 0;
  const st = at(pack.supertrend, index);
  const ema20 = at(pack.ema20, index);
  let level;
  let side;
  if (action >= 0) {
    const below = [st, ema20].filter((item) => item != null && item < close);
    level = below.length ? Math.max(...below) : close - 1.5 * atrV;
    side = "多头";
  } else {
    const above = [st, ema20].filter((item) => item != null && item > close);
    level = above.length ? Math.min(...above) : close + 1.5 * atrV;
    side = "空头";
  }
  return {
    level,
    side,
    atr: atrV,
    distance_atr: atrV ? Math.abs(close - level) / atrV : null,
    text: `若之后收盘穿越 ${fmt(level)}，这次${side}读数作废。这是结构失效位，不是已经挂进交易所的止损单。`,
  };
}

export function evaluate(bars, higherBars, context) {
  if (bars.length < 80) {
    return { ok: false, reason: "已收盘 K 线少于 80 根，EMA 与背离都不可靠，这次不给方向分。" };
  }
  const pack = compute(bars);
  const i = bars.length - 1;
  const now = context.now ?? bars[i].t;
  const events = eventHorizon(context.events || [], now);
  const [signals, regime, extra] = buildSignals(bars, pack, higherBars, context);
  const [tvmcDir, tvmcValue] = tvmc(signals);
  const trendLeg = leg(signals, "trend");
  const momLeg = leg(signals, "momentum");
  const volLeg = leg(signals, "volume");
  let tvmcReading = `趋势组 ${fmt(trendLeg == null ? null : trendLeg * 100, 0)}，动量组 ${fmt(momLeg == null ? null : momLeg * 100, 0)}，量能组 ${fmt(volLeg == null ? null : volLeg * 100, 0)}，TVMC ${tvmcValue.toFixed(0)}`;
  tvmcReading += tvmcDir === 0 ? "。三组没有同向，不加摘要分" : "。三组同向，摘要分按这个方向计入";
  signals.push({
    id: "tvmc",
    name: PROS_CONS.tvmc.name,
    group: "summary",
    weight: WEIGHTS.tvmc[1],
    direction: tvmcDir,
    reading: tvmcReading,
    pros: PROS_CONS.tvmc.pros,
    cons: PROS_CONS.tvmc.cons,
  });

  const [riskScore, riskParts] = risk(pack, bars, i, events.in_window, events.days);
  const mults = REGIME_MULT[regime];
  let available = 0;
  let raw = 0;
  for (const signal of signals) {
    const effective = signal.weight * (mults[signal.group] ?? 1);
    signal.effective_weight = effective;
    if (signal.direction == null) {
      signal.points = null;
      continue;
    }
    available += effective;
    raw += signal.direction * effective;
  }
  let direction = available === 0 ? 0 : (100 * raw) / available;
  const adjustments = [];
  const groupSum = (group) =>
    signals
      .filter((signal) => signal.group === group && signal.direction != null)
      .reduce((sum, signal) => sum + signal.direction * signal.effective_weight, 0);
  const trendSum = groupSum("trend");
  const momSum = groupSum("momentum");
  if (trendSum * momSum < 0 && Math.abs(trendSum) > 4 && Math.abs(momSum) > 4) {
    direction *= 0.7;
    adjustments.push({
      name: "趋势与动量冲突",
      effect: "方向分 ×0.70",
      text: "趋势组和动量组方向相反，先视为没有干净的交易，而不是选边。",
    });
  }

  const closeSeries = bars.map((bar) => bar.c);
  const divHits = [];
  if (divergence(closeSeries, pack.rsi, "bear", i)) divHits.push(["RSI 顶背离", "bear"]);
  if (divergence(closeSeries, pack.rsi, "bull", i)) divHits.push(["RSI 底背离", "bull"]);
  if (divergence(closeSeries, pack.macd_hist, "bear", i)) divHits.push(["MACD 柱顶背离", "bear"]);
  if (divergence(closeSeries, pack.macd_hist, "bull", i)) divHits.push(["MACD 柱底背离", "bull"]);
  if (divergence(closeSeries, pack.obv, "bear", i)) divHits.push(["OBV 顶背离", "bear"]);
  if (divergence(closeSeries, pack.obv, "bull", i)) divHits.push(["OBV 底背离", "bull"]);
  for (const [name, kind] of divHits) {
    const against = (kind === "bear" && direction > 0) || (kind === "bull" && direction < 0);
    if (against) {
      direction *= 0.86;
      adjustments.push({ name, effect: "方向分 ×0.86", text: `出现${name}，并且它和当前方向相反。背离只打折，不单独翻向。` });
    } else {
      adjustments.push({ name, effect: "只记录", text: `出现${name}，但当前净方向并不靠它开仓。` });
    }
  }

  if ((extra.higher === 1 || extra.higher === -1) && ![0, extra.higher].includes(sign(direction, 8))) {
    direction *= 0.75;
    adjustments.push({
      name: "高周期冲突",
      effect: "方向分 ×0.75",
      text: "决策周期和高周期方向相反。低周期的优势经常被高周期吃掉。",
    });
  }

  const damp = 1 - 0.3 * Math.max(0, (riskScore - 55) / 45);
  if (damp < 0.999) {
    direction *= damp;
    adjustments.push({
      name: "SCTI-RSK",
      effect: `方向分 ×${damp.toFixed(2)}`,
      text: `风险读数 ${riskScore.toFixed(0)}。高波动和事件只降低信心，不自动翻成反向单。`,
    });
  }
  direction = Math.max(-100, Math.min(100, direction));
  const intended = Object.values(WEIGHTS).reduce((sum, pair) => sum + pair[1], 0);
  const presentWeight = signals.filter((signal) => signal.direction != null).reduce((sum, signal) => sum + signal.weight, 0);
  const possible = signals.reduce((sum, signal) => sum + signal.weight, 0);
  const coverage = possible === 0 ? 1 : presentWeight / possible;
  let [execScore, execNotes] = execution(bars, pack, i, regime, direction, { risk: riskScore });
  if (events.earnings_window) {
    execScore = Math.min(execScore, 34);
    adjustments.push({
      name: "财报窗口",
      effect: "执行分封顶 34",
      text: "财报前后，技术结构解释不了跳空。这段时间不把分数当成加仓理由。",
    });
  } else if (events.in_window) {
    execScore = Math.min(execScore, 40);
    adjustments.push({
      name: "宏观窗口",
      effect: "执行分封顶 40",
      text: "CPI、非农或 FOMC 临近。事件本身比这一组指标更可能主导下一根 K 线。",
    });
  }
  if (coverage < 0.75) {
    execScore = Math.min(execScore, 58);
    adjustments.push({
      name: "数据缺口",
      effect: "执行分封顶 58",
      text: "有指标算不出来。方向分已按可得指标归一，但信心应当下降。",
    });
  }
  const action = direction * (execScore / 100);
  const [code, label] = stance(action, regime);
  const level = invalidation(bars, pack, i, Math.abs(action) >= 8 ? action : direction);
  for (const signal of signals) {
    signal.points = signal.direction == null || available === 0 ? null : (100 * signal.direction * signal.effective_weight) / available;
  }
  const regimeLabel = { trend: "趋势", range: "震荡", transition: "过渡" }[regime];
  const positives = signals.filter((signal) => (signal.points || 0) > 1.5).sort((a, b) => (b.points || 0) - (a.points || 0));
  const negatives = signals.filter((signal) => (signal.points || 0) < -1.5).sort((a, b) => (a.points || 0) - (b.points || 0));
  const bits = [
    `按${regimeLabel}框架，读取最后一根已收盘 K 线。`,
    `方向分 ${direction.toFixed(0)}，执行分 ${execScore.toFixed(0)}，动作分 ${action.toFixed(0)}，结论是「${label}」。`,
  ];
  if (positives.length) bits.push(`多头侧主要来自${positives.slice(0, 3).map((signal) => signal.name).join("、")}。`);
  if (negatives.length) bits.push(`空头侧主要来自${negatives.slice(0, 3).map((signal) => signal.name).join("、")}。`);
  for (const note of execNotes.slice(0, 2)) bits.push(`${note}。`);
  if (events.next != null) {
    bits.push(`下一件高影响日程：${events.next.title}（${formatYMDHM(events.next.t, SH)} 上海）。`);
  }
  bits.push("这是结构读数，不是收益承诺，也不是下单指令。");
  const snapshot = {
    close: bars[i].c,
    t: bars[i].t,
    rsi: at(pack.rsi, i),
    macd: at(pack.macd, i),
    macd_hist: at(pack.macd_hist, i),
    k: at(pack.k, i),
    d: at(pack.d, i),
    j: at(pack.j, i),
    adx: at(pack.adx, i),
    plus_di: at(pack.plus_di, i),
    minus_di: at(pack.minus_di, i),
    cci: at(pack.cci, i),
    trix: at(pack.trix, i),
    bbi: at(pack.bbi, i),
    obv: at(pack.obv, i),
    vwap: at(pack.vwap, i),
    mfi: at(pack.mfi, i),
    cmf: at(pack.cmf, i),
    atr: at(pack.atr, i),
    percent_b: extra.percent_b,
    supertrend: at(pack.supertrend, i),
    supertrend_dir: at(pack.supertrend_dir, i),
    ema20: at(pack.ema20, i),
    ema50: at(pack.ema50, i),
    ema200: at(pack.ema200, i),
    williams: at(pack.williams, i),
    stoch_k: at(pack.stoch_k, i),
    tvmc: tvmcValue,
    aroon_up: at(pack.aroon_up, i),
    aroon_down: at(pack.aroon_down, i),
  };
  const roundedParts = {};
  for (const [key, value] of Object.entries(riskParts)) roundedParts[key] = Math.round(value * 10) / 10;
  return {
    ok: true,
    regime,
    regime_label: regimeLabel,
    direction_score: Math.round(direction * 10) / 10,
    execution_score: Math.round(execScore * 10) / 10,
    action_score: Math.round(action * 10) / 10,
    stance: code,
    stance_label: label,
    risk_score: Math.round(riskScore * 10) / 10,
    risk_parts: roundedParts,
    tvmc: Math.round(tvmcValue * 10) / 10,
    coverage: Math.round(coverage * 100) / 100,
    summary: bits.join(""),
    signals,
    adjustments,
    invalidation: level,
    execution_notes: execNotes,
    snapshot,
    pack,
    decision_index: i,
    next_event: events.next,
    event_window: events.in_window || events.earnings_window,
    intended_weight: intended,
  };
}
