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

function round(value, digits = 2) {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
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
  if (higherBars == null || higherBars.length < 20) return [null, `${name}样本不足，这项不投票`];
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
  else if (ema200 != null && ema20 > ema50 && ema50 > ema200 && close > ema20) add("ema_stack", 1, `20>50>200 多头排列，收盘站稳 EMA20 (${fmt(ema20)})`);
  else if (ema200 != null && ema20 < ema50 && ema50 < ema200 && close < ema20) add("ema_stack", -1, `20<50<200 空头排列，收盘受压于 EMA20 (${fmt(ema20)})`);
  else if (close > ema20 && ema20 > ema50) add("ema_stack", 0.5, `短中期多头排列 (收盘 > EMA20 ${fmt(ema20)} > EMA50 ${fmt(ema50)})`);
  else if (close < ema20 && ema20 < ema50) add("ema_stack", -0.5, `短中期空头排列 (收盘 < EMA20 ${fmt(ema20)} < EMA50 ${fmt(ema50)})`);
  else add("ema_stack", 0, "均线交织缠绕，暂无清晰多空排列");

  const bbiV = at(pack.bbi, i);
  if (bbiV == null) add("bbi", null, "BBI 样本不足");
  else if (close > bbiV) add("bbi", 1, `收盘在多空分界 BBI (${fmt(bbiV)}) 之上`);
  else if (close < bbiV) add("bbi", -1, `收盘跌破多空分界 BBI (${fmt(bbiV)})`);
  else add("bbi", 0, "收盘贴着 BBI");

  const stDir = at(pack.supertrend_dir, i);
  const stLine = at(pack.supertrend, i);
  if (stDir !== 1 && stDir !== -1) add("supertrend", null, "Supertrend 样本不足");
  else add("supertrend", stDir, `Supertrend 处于${stDir === 1 ? "多头波段" : "空头压制"}，跟踪防线 ${fmt(stLine)}`);

  const adx = at(pack.adx, i);
  const plusDi = at(pack.plus_di, i);
  const minusDi = at(pack.minus_di, i);
  if (adx == null || plusDi == null) add("dmi", null, "ADX 样本不足");
  else if (adx < REGIME_RANGE) add("dmi", 0, `ADX ${fmt(adx, 1)} (<18 无趋势)，方向线暂不投票`);
  else if (plusDi > minusDi) add("dmi", 1, `ADX ${fmt(adx, 1)}，多头动能 +DI (${fmt(plusDi, 1)}) 强于 -DI (${fmt(minusDi, 1)})`);
  else add("dmi", -1, `ADX ${fmt(adx, 1)}，空头动能 -DI (${fmt(minusDi, 1)}) 强于 +DI (${fmt(plusDi, 1)})`);

  const [higherDir, higherText] = higherDirection(higherBars, context.higher_name || "高周期");
  add("higher_tf", higherDir, higherText);

  const hist = at(pack.macd_hist, i);
  const histPrev = at(pack.macd_hist, prev);
  const macdV = at(pack.macd, i);
  const macdS = at(pack.macd_signal, i);
  if (hist == null || macdV == null || macdS == null) add("macd", null, "MACD 样本不足");
  else if (macdV > macdS && hist > 0 && histPrev != null && hist >= histPrev) add("macd", 1, `MACD 金叉在信号线上，红柱 (${fmt(hist, 3)}) 持续放大`);
  else if (macdV < macdS && hist < 0 && histPrev != null && hist <= histPrev) add("macd", -1, `MACD 死叉在信号线下，绿柱 (${fmt(hist, 3)}) 继续走弱`);
  else if (macdV > macdS) add("macd", 0, `MACD 仍在信号线上，但上行动能柱已收敛至 ${fmt(hist, 3)}`);
  else if (macdV < macdS) add("macd", 0, `MACD 仍在信号线下，但下跌动能柱已收敛至 ${fmt(hist, 3)}`);
  else add("macd", 0, "MACD 与信号线粘合");

  const rsiV = at(pack.rsi, i);
  const rsiPrev = at(pack.rsi, prev);
  if (rsiV == null) add("rsi", null, "RSI 样本不足");
  else if (regime === "range") {
    if (rsiV < 30) add("rsi", 1, `震荡市 RSI ${fmt(rsiV, 1)} 进入超卖区，具备反弹修复条件`);
    else if (rsiV > 70) add("rsi", -1, `震荡市 RSI ${fmt(rsiV, 1)} 进入超买区，注意冲高回落`);
    else add("rsi", 0, `震荡市 RSI ${fmt(rsiV, 1)} 位于中性区`);
  } else if (regime === "trend") {
    if (rsiV >= 75 || rsiV <= 25) add("rsi", 0, `趋势市 RSI ${fmt(rsiV, 1)} 极端钝化，提示过热/超跌但不逆势摸顶抄底`);
    else if (rsiPrev != null && rsiV >= 50 && rsiV >= rsiPrev) add("rsi", 1, `趋势市 RSI ${fmt(rsiV, 1)} 站稳 50 强弱分水岭之上`);
    else if (rsiPrev != null && rsiV < 45 && rsiV <= rsiPrev) add("rsi", -1, `趋势市 RSI ${fmt(rsiV, 1)} 跌破 45 且重心下移`);
    else add("rsi", 0, `趋势市 RSI ${fmt(rsiV, 1)} 暂未给出加速确认`);
  } else if (rsiPrev != null && rsiPrev < 50 && rsiV >= 50) add("rsi", 1, `过渡期 RSI 上穿 50 中轴，现为 ${fmt(rsiV, 1)}`);
  else if (rsiPrev != null && rsiPrev > 50 && rsiV <= 50) add("rsi", -1, `过渡期 RSI 跌破 50 中轴，现为 ${fmt(rsiV, 1)}`);
  else add("rsi", 0, `过渡期 RSI ${fmt(rsiV, 1)} 中性`);

  const k = at(pack.k, i);
  const d = at(pack.d, i);
  const j = at(pack.j, i);
  if (k == null || d == null) add("kdj", null, "KDJ 样本不足");
  else if (regime === "range") {
    if (j != null && (j < 0 || k < 20) && k >= d) add("kdj", 1, `震荡市 KDJ 低位金叉拐头 (K ${fmt(k, 1)} / D ${fmt(d, 1)} / J ${fmt(j, 1)})`);
    else if (j != null && (j > 100 || k > 80) && k <= d) add("kdj", -1, `震荡市 KDJ 高位死叉拐头 (K ${fmt(k, 1)} / D ${fmt(d, 1)} / J ${fmt(j, 1)})`);
    else add("kdj", 0, `震荡市 KDJ 未到区间极值 (K ${fmt(k, 1)})`);
  } else if (k > d && k > 50) add("kdj", regime !== "trend" ? 1 : 0.5, `KDJ 金叉且 K (${fmt(k, 1)}) 位于 50 上方`);
  else if (k < d && k < 50) add("kdj", regime !== "trend" ? -1 : -0.5, `KDJ 死叉且 K (${fmt(k, 1)}) 位于 50 下方`);
  else add("kdj", 0, `KDJ (K ${fmt(k, 1)} / D ${fmt(d, 1)}) 方向不显著`);

  const cciV = at(pack.cci, i);
  if (cciV == null) add("cci", null, "CCI 样本不足");
  else if (regime === "range") {
    if (cciV < -100) add("cci", 1, `震荡市 CCI ${fmt(cciV, 0)} 跌入 -100 下方超卖区`);
    else if (cciV > 100) add("cci", -1, `震荡市 CCI ${fmt(cciV, 0)} 升入 +100 上方超买区`);
    else add("cci", 0, `震荡市 CCI ${fmt(cciV, 0)} 常态波动`);
  } else if (Math.abs(cciV) > 200) add("cci", 0, `CCI ${fmt(cciV, 0)} 极端延伸，防追单但不逆势猜顶底`);
  else if (cciV > 0) add("cci", 1, `CCI ${fmt(cciV, 0)} 位于零轴多头区`);
  else add("cci", -1, `CCI ${fmt(cciV, 0)} 位于零轴空头区`);

  const trixV = at(pack.trix, i);
  const trixS = at(pack.trix_signal, i);
  const trixPrev = at(pack.trix, prev);
  if (trixV == null || trixS == null) add("trix", null, "TRIX 样本不足");
  else if (trixV > trixS && (trixPrev == null || trixV >= trixPrev)) add("trix", 1, `中长线 TRIX (${fmt(trixV, 3)}) 在信号线上方上行`);
  else if (trixV < trixS && (trixPrev == null || trixV <= trixPrev)) add("trix", -1, `中长线 TRIX (${fmt(trixV, 3)}) 在信号线下方走弱`);
  else add("trix", 0, `TRIX (${fmt(trixV, 3)}) 与信号线斜率分歧`);

  const sk = at(pack.stoch_k, i);
  const sd = at(pack.stoch_d, i);
  if (sk == null || sd == null) add("stochrsi", null, "StochRSI 样本不足");
  else if (regime === "range" && sk < 20 && sk >= sd) add("stochrsi", 1, `震荡市 StochRSI (${fmt(sk, 1)}) 低位拐头向上`);
  else if (regime === "range" && sk > 80 && sk <= sd) add("stochrsi", -1, `震荡市 StochRSI (${fmt(sk, 1)}) 高位拐头向下`);
  else if (regime === "trend" && sk > sd && sk > 50) add("stochrsi", 0.5, `趋势市 StochRSI (${fmt(sk, 1)}) 偏强`);
  else if (regime === "trend" && sk < sd && sk < 50) add("stochrsi", -0.5, `趋势市 StochRSI (${fmt(sk, 1)}) 偏弱`);
  else add("stochrsi", 0, `StochRSI (${fmt(sk, 1)}) 中性`);

  const obvNow = at(pack.obv, i);
  const obvThen = at(pack.obv, Math.max(0, i - 10));
  const priceSlope = close - bars[Math.max(0, i - 10)].c;
  if (obvNow == null || obvThen == null) add("obv", null, "OBV 样本不足");
  else {
    const obvSlope = obvNow - obvThen;
    if (priceSlope > 0 && obvSlope > 0) add("obv", 1, "近 10 根 K 线价涨量增，OBV 同步上行确认");
    else if (priceSlope < 0 && obvSlope < 0) add("obv", -1, "近 10 根 K 线重心下移且 OBV 资金持续流出");
    else if (priceSlope > 0 && obvSlope < 0) add("obv", 0, "价格上行但 OBV 未跟随，量价背离需警惕");
    else if (priceSlope < 0 && obvSlope > 0) add("obv", 0, "价格回落但 OBV 承接抬升，抛压减弱");
    else add("obv", 0, "OBV 近 10 根走平");
  }

  const vol = bars[i].v || 0;
  const volMa = at(pack.vol_ma, i);
  const candleUp = close >= bars[i].o;
  if (volMa == null || volMa === 0) add("volume", null, "成交量均线不足");
  else {
    const ratio = vol / volMa;
    if (ratio >= 1.15 && ((candleUp && priceSlope >= 0) || (!candleUp && priceSlope < 0))) {
      add("volume", candleUp ? 1 : -1, `成交量为 20 均量的 ${ratio.toFixed(2)} 倍，放量顺势确认`);
    } else if (ratio < 0.75) add("volume", 0, `成交量仅为 20 均量的 ${ratio.toFixed(2)} 倍，缩量观望`);
    else add("volume", 0, `成交量为 20 均量的 ${ratio.toFixed(2)} 倍，量能温和`);
  }

  const mfiV = at(pack.mfi, i);
  if (mfiV == null) add("mfi", null, "MFI 样本不足");
  else if (regime === "range" && mfiV < 20) add("mfi", 1, `震荡市资金流量 MFI ${fmt(mfiV, 1)} 超卖`);
  else if (regime === "range" && mfiV > 80) add("mfi", -1, `震荡市资金流量 MFI ${fmt(mfiV, 1)} 超买`);
  else if (regime !== "range" && mfiV > 85) add("mfi", 0, `MFI ${fmt(mfiV, 1)} 过热钝化，不逆势做空`);
  else if (mfiV > 55) add("mfi", regime !== "range" ? 1 : 0, `MFI ${fmt(mfiV, 1)} > 55，量价资金净流入占优`);
  else if (mfiV < 45) add("mfi", regime !== "range" ? -1 : 0, `MFI ${fmt(mfiV, 1)} < 45，量价资金偏流出`);
  else add("mfi", 0, `MFI ${fmt(mfiV, 1)} 中性`);

  const cmfV = at(pack.cmf, i);
  if (cmfV == null) add("cmf", null, "CMF 样本不足");
  else if (cmfV > 0.05) add("cmf", 1, `蔡金资金流 CMF ${fmt(cmfV, 3)} > 0，收盘持续偏向日内高位`);
  else if (cmfV < -0.05) add("cmf", -1, `蔡金资金流 CMF ${fmt(cmfV, 3)} < 0，收盘持续偏向日内低位`);
  else add("cmf", 0, `CMF ${fmt(cmfV, 3)} 无显著资金偏向`);

  const vwap = at(pack.vwap, i);
  const daily = (context.interval_sec ?? 86400) >= 86400;
  if (vwap == null) add("vwap", null, "VWAP 样本不足");
  else if (close > vwap) {
    const note = daily ? "收盘站上 20 周期成交量加权均价" : "收盘站上窗口 VWAP 成本线";
    add("vwap", 1, `${note} (${fmt(vwap)})，买方持仓处于浮盈优势`);
  } else {
    const note = daily ? "收盘位于 20 周期成交量加权均价下方" : "收盘受制于窗口 VWAP 成本线";
    add("vwap", -1, `${note} (${fmt(vwap)})，上方存在筹码压制`);
  }

  const percentB = at(pack.percent_b, i);
  const mid = at(pack.bb_mid, i);
  if (percentB == null) add("bollinger", null, "布林带样本不足");
  else if (regime === "range" && percentB <= 0.08) add("bollinger", 1, `震荡市贴近布林下轨 (%B=${fmt(percentB, 2)})，具备下沿支撑优势`);
  else if (regime === "range" && percentB >= 0.92) add("bollinger", -1, `震荡市触及布林上轨 (%B=${fmt(percentB, 2)})，上沿阻力明显`);
  else if (regime === "trend" && percentB >= 1) add("bollinger", 0, `突破布林上轨 (%B=${fmt(percentB, 2)})，趋势市不视为做空信号`);
  else if (close > (mid ?? close)) add("bollinger", regime === "trend" ? 0.5 : 0, `运行于布林中轨之上 (%B=${fmt(percentB, 2)})`);
  else if (close < (mid ?? close)) add("bollinger", regime === "trend" ? -0.5 : 0, `运行于布林中轨之下 (%B=${fmt(percentB, 2)})`);
  else add("bollinger", 0, `%B ${fmt(percentB, 2)}`);

  const will = at(pack.williams, i);
  if (will == null) add("williams", null, "Williams %R 样本不足");
  else if (regime !== "range") add("williams", 0, `威廉指标 %R ${fmt(will, 1)}（趋势/过渡市防钝化记 0）`);
  else if (will <= -80) add("williams", 1, `震荡市 %R ${fmt(will, 1)} 超卖`);
  else if (will >= -20) add("williams", -1, `震荡市 %R ${fmt(will, 1)} 超买`);
  else add("williams", 0, `%R ${fmt(will, 1)} 中性`);

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
    if (action >= 55) return ["range_long", "震荡逢低做多"];
    if (action >= 28) return ["range_long_light", "震荡轻仓低吸"];
    if (action <= -55) return ["range_short", "震荡逢高减仓/做空"];
    if (action <= -28) return ["range_short_light", "震荡轻度防守"];
    return ["flat", "观望等待"];
  }
  const prefix = regime === "trend" ? "趋势" : "过渡";
  if (action >= 60) return [`${regime}_long`, `${prefix}顺势看多`];
  if (action >= 28) return [`${regime}_long_light`, `${prefix}温和偏多`];
  if (action <= -60) return [`${regime}_short`, `${prefix}明确偏空`];
  if (action <= -28) return [`${regime}_short_light`, `${prefix}偏空防守`];
  return ["flat", "观望等待"];
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
      notes.push("现价贴近 EMA20 支撑/阻力带，属于顺势回踩位置而非盲目追单");
    } else if (stretch <= 1.4) score += 4;
    else if (stretch <= 2.4) {
      score -= 14;
      notes.push(`现价已偏离 EMA20 达 ${stretch.toFixed(1)} 倍 ATR，直接追单盈亏比下降`);
    } else {
      score -= 28;
      notes.push(`现价远离 EMA20 达 ${stretch.toFixed(1)} 倍 ATR，短线过度延伸，严禁现价追涨杀跌`);
    }
  }
  if (regime === "range" && percentB != null) {
    if (percentB <= 0.12 || percentB >= 0.88) {
      if ((directionScore > 0 && percentB <= 0.12) || (directionScore < 0 && percentB >= 0.88)) {
        score += 14;
        notes.push("震荡市价格正处于区间边缘，入场位置赔率较优");
      }
    } else {
      score -= 10;
      notes.push("震荡市价格处于区间中部，上下空间相当，缺乏位置优势");
    }
  }
  const volMa = at(pack.vol_ma, index);
  if (volMa != null && volMa !== 0) {
    const ratio = (bars[index].v || 0) / volMa;
    if (ratio >= 1.15) score += 6;
    else if (ratio < 0.7) {
      score -= 6;
      notes.push("当前成交量低于 20 均量的 70%，突破持续性存疑");
    }
  }
  if ((contextFlags.risk || 0) >= 75) {
    score -= 10;
    notes.push("盘面波动与事件风险读数高于 75，下调时机评分");
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
  const pct = close ? ((level - close) / close) * 100 : null;
  return {
    level,
    side,
    atr: atrV,
    pct: pct == null ? null : round(pct, 2),
    distance_atr: atrV ? Math.abs(close - level) / atrV : null,
    text: `若本周期收盘${side === "多头" ? "跌破" : "站上"} ${fmt(level)}（距现价 ${pct == null ? "—" : signed(pct, 2)}%），当前${side}逻辑即告证伪失效，应无条件执行风控离场。`,
  };
}

function buildPlaybook({
  bars,
  pack,
  index,
  regime,
  direction,
  execScore,
  action,
  riskScore,
  invalidationLevel,
  events,
  positives,
  negatives,
  adjustments,
}) {
  const close = bars[index].c;
  const atrV = at(pack.atr, index) || close * 0.02;
  const ema20 = at(pack.ema20, index) ?? close;
  const ema50 = at(pack.ema50, index) ?? ema20;
  const bbUp = at(pack.bb_up, index) ?? close + 2 * atrV;
  const bbLow = at(pack.bb_low, index) ?? close - 2 * atrV;
  const recent = bars.slice(Math.max(0, index - 20), index + 1);
  const swingHigh = Math.max(...recent.map((b) => b.h));
  const swingLow = Math.min(...recent.map((b) => b.l));
  const stretch = atrV ? Math.abs(close - ema20) / atrV : 0;

  let zoneTitle;
  let zoneLow;
  let zoneHigh;
  let target1;
  let target2;
  let bias;

  if (direction >= 18) {
    bias = "long";
    zoneTitle = regime === "range" ? "支撑低吸参考区" : "顺势回踩介入区";
    if (regime === "range") {
      zoneLow = Math.min(bbLow, swingLow);
      zoneHigh = zoneLow + 0.45 * atrV;
    } else {
      const anchor = Math.max(invalidationLevel.level + 0.15 * atrV, ema20 - 0.35 * atrV);
      zoneLow = Math.min(close, anchor);
      zoneHigh = Math.min(close * 1.003, Math.max(anchor + 0.45 * atrV, ema20 + 0.2 * atrV));
    }
    target1 = Math.max(close + 1.4 * atrV, swingHigh, bbUp);
    target2 = Math.max(target1 + 1.2 * atrV, close + 2.8 * atrV);
  } else if (direction <= -18) {
    bias = "short";
    zoneTitle = "反弹减仓 / 压力观察区";
    const cap = invalidationLevel.level - 0.15 * atrV;
    const anchor = Math.min(cap, ema20 + 0.3 * atrV);
    zoneLow = Math.max(close * 0.997, Math.min(ema20 - 0.25 * atrV, anchor - 0.4 * atrV));
    zoneHigh = Math.max(zoneLow + 0.25 * atrV, anchor);
    target1 = Math.min(close - 1.4 * atrV, swingLow, bbLow);
    target2 = Math.min(target1 - 1.2 * atrV, close - 2.8 * atrV);
  } else {
    bias = "neutral";
    zoneTitle = "震荡区间下沿支撑 / 上沿阻力";
    zoneLow = Math.min(bbLow, swingLow);
    zoneHigh = Math.max(bbUp, swingHigh);
    target1 = zoneHigh;
    target2 = Math.min(bbLow, swingLow);
  }

  const riskDist = Math.max(Math.abs(close - invalidationLevel.level), 0.85 * atrV);
  const rewardDist = Math.abs(target1 - close);
  const rrNow = round(Math.min(6, rewardDist / riskDist), 2);

  const entryMid = (zoneLow + zoneHigh) / 2;
  const entryRisk = Math.max(Math.abs(entryMid - invalidationLevel.level), 0.85 * atrV);
  const entryReward = Math.abs(target1 - entryMid);
  const rrOnPullback = round(Math.min(6, entryReward / entryRisk), 2);

  let verdictTitle;
  let verdictTone;
  let spotAction;
  let swingAction;
  let positionCap;

  if (events.earnings_window) {
    verdictTitle = "财报跳空高危窗口 · 严控仓位观望";
    verdictTone = "flat";
    spotAction = "距离财报极近，财报后盘前盘后常出现无视技术面的跳空缺口。忠实建议：不要在财报前新开重仓赌方向；已有浮盈仓位可适当减半锁利。";
    swingAction = "暂停新建高倍杠杆或短线追单，等待财报落地、首根放量 K 线确认方向后再顺势跟随。";
    positionCap = "10%–15% 以内（财报避险上限）";
  } else if (events.in_window) {
    verdictTitle = "重大宏观数据窗口 · 降仓避险";
    verdictTone = "flat";
    spotAction = "未来 48 小时内有美联储利率决议 / CPI / 非农等核心宏观数据，瞬时双向插针概率高。建议暂停追单，保留充足现金等待数据落地。";
    swingAction = "主动收缩杠杆敞口，严格避免在数据公布前重仓扛单。";
    positionCap = "15%–20% 以内（宏观窗口上限）";
  } else if (action >= 55) {
    verdictTitle = "多头强力共振 · 顺势偏多布局";
    verdictTone = "up";
    spotAction = `趋势、动量与量能多头同向（综合总分 +${Math.round(action)}），且价格未过度透支。可按计划分批建仓或安心顺势持仓，收盘不破 ${fmt(invalidationLevel.level)} 不轻易下车。`;
    swingAction = `回踩 ${fmt(zoneLow)}–${fmt(zoneHigh)} 一带可顺势做多，止损设于 ${fmt(invalidationLevel.level)} 下方，第一目标看 ${fmt(target1)}。`;
    positionCap = riskScore >= 68 ? "35%–45%（波动偏高，控制单笔）" : "50%–65%（标准顺势仓）";
  } else if (action >= 25) {
    verdictTitle = "温和偏多 · 逢低分批，切勿追高";
    verdictTone = "up";
    spotAction = `大方向看涨（方向分 +${Math.round(direction)}），适合逢回调在 ${fmt(zoneLow)}–${fmt(zoneHigh)} 分批低吸，不建议在大阳线急拉时一把满仓。`;
    swingAction = `耐心等回踩支撑企稳再介入，把盈亏比拉高到 ${rrOnPullback || "1.8"}:1 以上，破 ${fmt(invalidationLevel.level)} 止损。`;
    positionCap = "25%–40%（分 2 批介入）";
  } else if (direction >= 28 && action < 25) {
    verdictTitle = "多头趋势但短线追高性价比差 · 等回踩";
    verdictTone = "flat";
    spotAction = `虽然趋势指标偏多（方向分 +${Math.round(direction)}），但当前现价偏离均线较远（时机分仅 ${Math.round(execScore)}），现在追买容易挨短线回调。忠实建议：老仓持有，新资金挂单等回踩 ${fmt(zoneLow)}–${fmt(zoneHigh)}。`;
    swingAction = "现价不追多，等待价格回靠 EMA20 缩量企稳后再进场。";
    positionCap = "新仓暂缓，回踩后 20%–30%";
  } else if (action <= -55) {
    verdictTitle = "空头趋势确立 · 严格规避抄底";
    verdictTone = "down";
    spotAction = `多项核心指标共振看跌（综合总分 ${Math.round(action)}），下跌趋势未见底。现货/美股买方忠实建议：严禁左侧盲目抄底“接飞刀”，持仓者宜逢反抽减仓保护本金。`;
    swingAction = `反抽 ${fmt(zoneLow)}–${fmt(zoneHigh)} 受阻可顺势偏空对待，若收盘重新站上 ${fmt(invalidationLevel.level)} 则空头止损离场。`;
    positionCap = "现货 0%–10% 防守；空单上限 30%–40%";
  } else if (action <= -25) {
    verdictTitle = "偏空承压 · 减仓防守，不急抄底";
    verdictTone = "down";
    spotAction = stretch >= 2.2
      ? `大方向明确偏空（方向分 ${Math.round(direction)}），只是短线急跌偏离均线达 ${stretch.toFixed(1)} 倍 ATR。现货买方切勿把超跌反弹当反转重仓抄底；被套仓位等反弹至 ${fmt(zoneLow)}–${fmt(zoneHigh)} 减仓降风险。`
      : `盘面空头力量占优（综合总分 ${Math.round(action)}），上方均线与筹码构成压制。建议少动多看、反弹减仓，等待日线收复 ${fmt(invalidationLevel.level)} 后再评估买点。`;
    swingAction = stretch >= 2.2
      ? `短线已远离均线，切忌在地板价直接追空！耐心等反抽 ${fmt(zoneLow)}–${fmt(zoneHigh)} 动能衰竭再试空。`
      : `以反弹高空或观望为主，突破 ${fmt(invalidationLevel.level)} 严格止损，下方支撑留意 ${fmt(target1)}。`;
    positionCap = "现货防守观望；波段轻仓 15%–25%";
  } else if (direction <= -28 && action > -25) {
    verdictTitle = "空头趋势但短线超跌 · 勿追空亦勿重仓抄底";
    verdictTone = "flat";
    spotAction = `大结构仍是空头（方向分 ${Math.round(direction)}），但短线跌幅已大、远离均线（时机分仅 ${Math.round(execScore)}），所以综合分收窄至 ${Math.round(action)}。忠实建议：既不要盲目抄底，也不要在最低点恐慌割肉，等技术性反抽再处理仓位。`;
    swingAction = `地板价追空极易被短线空头回补拉爆，耐心等待反抽 ${fmt(zoneLow)}–${fmt(zoneHigh)} 观察承压情况。`;
    positionCap = "0%–15%（多看少动）";
  } else {
    verdictTitle = "多空分歧拉锯 · 现金观望最有利";
    verdictTone = "flat";
    spotAction = `多空指标互相抵消（方向分 ${signed(direction, 0)}，综合总分 ${signed(action, 0)}），当前市场没有给你清晰的概率优势。“不交易”在此刻就是最专业、最忠实的仓位管理。`;
    swingAction = `区间震荡对待，下方留意 ${fmt(zoneLow)} 支撑，上方留意 ${fmt(zoneHigh)} 阻力，未突破前不重仓押注单边。`;
    positionCap = "0%–15%（保留现金耐心等待）";
  }

  const bullPoints = positives.slice(0, 4).map((s) => ({
    name: s.name,
    points: round(s.points, 1),
    text: s.reading,
  }));
  const bearPoints = [
    ...negatives.slice(0, 3).map((s) => ({
      name: s.name,
      points: round(s.points, 1),
      text: s.reading,
    })),
    ...adjustments.slice(0, 2).map((adj) => ({
      name: adj.name,
      points: null,
      text: `${adj.effect}：${adj.text}`,
    })),
  ].slice(0, 4);

  return {
    bias,
    verdict_title: verdictTitle,
    verdict_tone: verdictTone,
    spot_action: spotAction,
    swing_action: swingAction,
    position_cap: positionCap,
    zone_title: zoneTitle,
    entry_low: round(zoneLow, 4),
    entry_high: round(zoneHigh, 4),
    stop_level: round(invalidationLevel.level, 4),
    stop_pct: invalidationLevel.pct,
    target_1: round(target1, 4),
    target_2: round(target2, 4),
    rr_now: rrNow,
    rr_pullback: rrOnPullback,
    swing_high_20: round(swingHigh, 4),
    swing_low_20: round(swingLow, 4),
    stretch_atr: round(stretch, 2),
    bull_points: bullPoints,
    bear_points: bearPoints,
  };
}

export const SCORE_LEGEND = {
  formula: "综合多空总分 = 趋势方向分 × (入场时机分 ÷ 100)",
  plus_meaning: "正分（+1 ~ +100）代表多头看涨信号占优：+25 ~ +54 为温和偏多（宜回踩低吸），+55 以上为强力多头共振。",
  minus_meaning: "负分（-1 ~ -100）代表空头看跌信号占优：-25 ~ -54 为偏空承压（宜减仓防守、勿抄底），-55 以下为强空头趋势。",
  neutral_meaning: "-24 ~ +24 为观望区：要么多空指标互相打架，要么虽然有趋势但现价涨跌过急/临近财报与美联储决议，现价出手赔率不佳。",
};

export function evaluate(bars, higherBars, context) {
  if (bars.length < 80) {
    return {
      ok: false,
      reason: `当前周期已收盘 K 线仅 ${bars.length} 根（少于 80 根最低统计样本，新上市标的在周线级别常见），为对你的本金负责，本周期不强行输出多空分，请切换至日线 / 4小时 / 1小时查看完整量化评估。`,
    };
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
  tvmcReading += tvmcDir === 0 ? "。三组未完全同向，不额外加共振分" : "。趋势、动量、量能三组同向共振，计入加分";
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
      text: "均线趋势组与短线动量组方向相反，说明处于回调或反抽拉锯期，主动调低单边预期。",
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
      adjustments.push({ name, effect: "方向分 ×0.86", text: `检测到${name}，提示当前趋势动能有所衰减，对同向追单做折扣保护。` });
    } else {
      adjustments.push({ name, effect: "辅助参考", text: `检测到${name}，但背离不单独作为逆势重仓依据。` });
    }
  }

  if ((extra.higher === 1 || extra.higher === -1) && ![0, extra.higher].includes(sign(direction, 8))) {
    direction *= 0.75;
    adjustments.push({
      name: "大小周期方向冲突",
      effect: "方向分 ×0.75",
      text: "当前周期与高一级别大周期方向相反，逆大周期操作的胜率需要打折。",
    });
  }

  const damp = 1 - 0.3 * Math.max(0, (riskScore - 55) / 45);
  if (damp < 0.999) {
    direction *= damp;
    adjustments.push({
      name: "波动与事件风险折扣",
      effect: `方向分 ×${damp.toFixed(2)}`,
      text: `盘面风险指数 ${riskScore.toFixed(0)}/100，高波动期自动压缩激进评分以控制回撤。`,
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
      effect: "时机分封顶 34",
      text: "财报发布前后 48 小时，跳空风险远大于技术指标，强制压低入场时机分。",
    });
  } else if (events.in_window) {
    execScore = Math.min(execScore, 40);
    adjustments.push({
      name: "宏观窗口",
      effect: "时机分封顶 40",
      text: "CPI、非农或美联储利率决议临近，事件波动主导短线走势，下调入场时机分。",
    });
  }
  if (coverage < 0.75) {
    execScore = Math.min(execScore, 58);
    adjustments.push({
      name: "数据缺口",
      effect: "时机分封顶 58",
      text: "部分长周期指标样本尚在累积中，保守下调执行信心。",
    });
  }
  const action = direction * (execScore / 100);
  const [code, label] = stance(action, regime);
  const level = invalidation(bars, pack, i, Math.abs(action) >= 8 ? action : direction);
  for (const signal of signals) {
    signal.points = signal.direction == null || available === 0 ? null : (100 * signal.direction * signal.effective_weight) / available;
  }
  const regimeLabel = { trend: "趋势市", range: "震荡市", transition: "过渡期" }[regime];
  const positives = signals.filter((signal) => (signal.points || 0) > 1.5).sort((a, b) => (b.points || 0) - (a.points || 0));
  const negatives = signals.filter((signal) => (signal.points || 0) < -1.5).sort((a, b) => (a.points || 0) - (b.points || 0));

  const playbook = buildPlaybook({
    bars,
    pack,
    index: i,
    regime,
    direction,
    execScore,
    action,
    riskScore,
    invalidationLevel: level,
    events,
    positives,
    negatives,
    adjustments,
  });

  const bits = [
    `当前盘面处于【${regimeLabel}】（基于最后一根已收盘 K 线核对）。`,
    `趋势方向分 ${signed(direction, 0)}，入场时机分 ${execScore.toFixed(0)}/100，折算综合多空总分 ${signed(action, 0)}（${label}）。`,
  ];
  if (positives.length) bits.push(`多头支撑来自：${positives.slice(0, 3).map((signal) => signal.name).join("、")}。`);
  if (negatives.length) bits.push(`空头压制来自：${negatives.slice(0, 3).map((signal) => signal.name).join("、")}。`);
  for (const note of execNotes.slice(0, 2)) bits.push(`${note}。`);
  if (events.next != null) {
    bits.push(`最近高影响日程：${events.next.title}（${formatYMDHM(events.next.t, SH)} 上海时间）。`);
  }

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
    score_legend: SCORE_LEGEND,
    playbook,
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
