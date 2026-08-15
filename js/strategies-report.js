/**
 * 多维策略报告（策略1 + 策略2）
 * 策略1：体制（周线趋势+宏观+资金费率拥挤度）→ 位置（VP节点/VWAP/前高前低/清算簇）→ 确认（CVD/OI同向）→ 执行（放量收盘、回踩缩量、风险与盈亏比）
 * 策略2：EMA/MACD/RSI/SUPER/SAR/KDJ/OBV/DMI 按「趋势/动量/震荡/量能」分组打分，输出多维趋势报告
 */
import { analyzeTimeframe } from './advisor.js';
import { volumeProfile, liquidationClusters } from './indicators.js';

/** 宏观新闻偏向（沿用 computeNewsBias 的输入结构） */
function regimeScore(newsBias, fundingRate) {
  let score = 0;
  const lines = [];
  if (newsBias && Math.abs(newsBias.score) > 0.05) {
    score += newsBias.score * 1.5;
    lines.push(`宏观新闻面：${newsBias.reason}`);
  }
  if (fundingRate !== null && fundingRate !== undefined) {
    if (Math.abs(fundingRate) > 0.0005) {
      score += fundingRate > 0 ? -0.4 : 0.4;
      lines.push(`资金费率拥挤：${(fundingRate * 100).toFixed(3)}%，反向风险增加`);
    } else {
      lines.push('资金费率中性，未出现拥挤');
    }
  }
  return { score, lines };
}

/** 策略1：体制→位置→确认→执行 */
export function strategyOne({ symbol, candles1d, candles1h, candles30m, newsBias, soso }) {
  const d1 = analyzeTimeframe(candles1d);
  const h1 = analyzeTimeframe(candles1h);
  const m30 = analyzeTimeframe(candles30m);
  const close = candles1d[candles1d.length - 1].close;
  const vp = volumeProfile(candles1d);
  const clusters = liquidationClusters(candles1h);
  const fundingRate = soso ? soso.fundingRate : null;
  const regime = regimeScore(newsBias, fundingRate);

  const posLines = [];
  if (vp) {
    posLines.push(`Volume Profile：POC ${vp.poc.toFixed(1)}，价值区 ${vp.vaLow.toFixed(1)}~${vp.vaHigh.toFixed(1)}`);
    if (vp.hvnAbove) posLines.push(`上方高量节点 ${vp.hvnAbove.toFixed(1)}`);
    if (vp.hvnBelow) posLines.push(`下方高量节点 ${vp.hvnBelow.toFixed(1)}`);
  }
  if (h1.meta?.vwap) posLines.push(`VWAP ${h1.meta.vwap.toFixed(1)}，价格${close > h1.meta.vwap ? '在其上' : '在其下'}`);
  if (h1.meta?.support && h1.meta?.resistance) posLines.push(`前高前低：支撑 ${h1.meta.support.toFixed(1)} / 阻力 ${h1.meta.resistance.toFixed(1)}`);
  if (clusters.length) posLines.push(`清算簇：${clusters.map((c) => c.price.toFixed(0)).join(' / ')}`);

  const cvd = h1.meta?.cvd;
  const oi = soso ? soso.openInterest : null;
  const confirmLines = [];
  if (cvd !== null && cvd !== undefined) confirmLines.push(`CVD ${cvd >= 0 ? '累计为正' : '累计为负'}（${cvd.toFixed(0)}）`);
  if (oi !== null && oi !== undefined) confirmLines.push(`OI ${oi >= 0 ? '增' : '减'} ${Math.abs(oi)}`);
  if (confirmLines.length) {
    const sameDir = cvd !== null && oi !== null && Math.sign(cvd) === Math.sign(oi);
    confirmLines.push(sameDir ? 'CVD/OI 同向，趋势确认' : 'CVD/OI 背离，减仓或等反转');
  } else {
    confirmLines.push('缺少 CVD/OI 实时数据，无法确认');
  }

  const vol5 = candles30m.slice(-5).reduce((s, c) => s + c.volume, 0) / 5;
  const vol20 = candles30m.slice(-25, -5).reduce((s, c) => s + c.volume, 0) / 20;
  const breakoutVol = vol5 > vol20 * 1.5;
  const pullbackVol = vol5 < vol20 * 0.8;
  const execLines = [
    `30m 近5根均量 ${vol5.toFixed(0)} vs 前20根 ${vol20.toFixed(0)}`,
    breakoutVol ? '放量，突破有效' : pullbackVol ? '缩量，回踩观察' : '量能中性，等待确认',
    '执行纪律：突破必须放量收盘；回踩要缩量；单笔风险 0.5%–2%，盈亏比至少 2:1',
  ];

  const total = d1.score * 2 + h1.score + m30.score + regime.score;
  const verdict = total >= 4 ? '强烈看多' : total >= 1.5 ? '看多' : total <= -4 ? '强烈看空' : total <= -1.5 ? '看空' : '中性';

  return {
    symbol,
    verdict,
    totalScore: +total.toFixed(2),
    sections: [
      { title: '体制（周线/宏观/资金费率）', lines: [`日线趋势 ${d1.verdict}（${d1.score.toFixed(1)}）`, ...regime.lines] },
      { title: '位置（VP/VWAP/前高前低/清算簇）', lines: posLines },
      { title: '确认（CVD/OI）', lines: confirmLines },
      { title: '执行（量能/风险）', lines: execLines },
    ],
  };
}

/** 策略2：EMA/MACD/RSI/SUPER/SAR/KDJ/OBV/DMI 科学分组打分 */
export function strategyTwo({ symbol, candles1h, candles4h, candles1d }) {
  const groups = {
    trend: { label: '趋势组（EMA/SUPER/SAR/DMI）', score: 0, lines: [] },
    momentum: { label: '动量组（MACD/RSI）', score: 0, lines: [] },
    oscillator: { label: '震荡组（KDJ）', score: 0, lines: [] },
    volume: { label: '量能组（OBV）', score: 0, lines: [] },
  };

  const tfs = [
    { name: '1小时', r: analyzeTimeframe(candles1h), ind: candles1h.length ? computeAllLite(candles1h) : null },
    { name: '4小时', r: analyzeTimeframe(candles4h), ind: candles4h.length ? computeAllLite(candles4h) : null },
    { name: '日线', r: analyzeTimeframe(candles1d), ind: candles1d.length ? computeAllLite(candles1d) : null },
  ];

  for (const { name, r, ind } of tfs) {
    if (!ind) continue;
    const i = candlesFrom(ind).length - 1;
    const close = ind.close[i];
    // 趋势组
    if (ind.ema20[i] !== null && ind.ema50[i] !== null) {
      const s = close > ind.ema20[i] && ind.ema20[i] > ind.ema50[i] ? 1 : close < ind.ema20[i] && ind.ema20[i] < ind.ema50[i] ? -1 : 0;
      groups.trend.score += s;
      if (s !== 0) groups.trend.lines.push(`${name} EMA20${s > 0 ? '上' : '下'}穿EMA50，趋势${s > 0 ? '多' : '空'}`);
    }
    if (ind.super.direction[i] !== null) {
      groups.trend.score += ind.super.direction[i];
      groups.trend.lines.push(`${name} SuperTrend ${ind.super.direction[i] > 0 ? '多头' : '空头'}`);
    }
    if (ind.sar[i] !== null) {
      const s = close > ind.sar[i] ? 1 : -1;
      groups.trend.score += s * 0.5;
      if (s !== 0) groups.trend.lines.push(`${name} SAR ${s > 0 ? '支撑' : '压力'}`);
    }
    if (ind.dmi.adx[i] !== null && ind.dmi.adx[i] > 20) {
      const s = ind.dmi.pdi[i] > ind.dmi.mdi[i] ? 1 : -1;
      groups.trend.score += s;
      groups.trend.lines.push(`${name} DMI ADX=${ind.dmi.adx[i].toFixed(1)}，${s > 0 ? '+DI主导' : '-DI主导'}`);
    }
    // 动量组
    if (ind.macd.dif[i] !== null && ind.macd.dea[i] !== null) {
      const s = ind.macd.dif[i] > ind.macd.dea[i] ? 1 : -1;
      groups.momentum.score += s;
      groups.momentum.lines.push(`${name} MACD ${s > 0 ? '多头' : '空头'}`);
    }
    if (ind.rsi[i] !== null) {
      if (ind.rsi[i] < 30) { groups.momentum.score += 1; groups.momentum.lines.push(`${name} RSI 超卖 ${ind.rsi[i].toFixed(1)}`); }
      else if (ind.rsi[i] > 70) { groups.momentum.score -= 1; groups.momentum.lines.push(`${name} RSI 超买 ${ind.rsi[i].toFixed(1)}`); }
      else groups.momentum.lines.push(`${name} RSI 中性 ${ind.rsi[i].toFixed(1)}`);
    }
    // 震荡组
    if (ind.kdj.k[i] !== null && ind.kdj.d[i] !== null) {
      const s = ind.kdj.k[i] > ind.kdj.d[i] ? 1 : -1;
      const zone = ind.kdj.k[i] > 80 ? '超买' : ind.kdj.k[i] < 20 ? '超卖' : '中性';
      groups.oscillator.score += s * 0.5;
      groups.oscillator.lines.push(`${name} KDJ ${zone}，K${s > 0 ? '>' : '<'}D`);
    }
    // 量能组
    if (ind.obv[i] !== null && i > 0 && ind.obv[i - 1] !== null) {
      const s = ind.obv[i] > ind.obv[i - 1] ? 1 : -1;
      groups.volume.score += s * 0.5;
      groups.volume.lines.push(`${name} OBV ${s > 0 ? '流入' : '流出'}`);
    }
  }

  const total = Object.values(groups).reduce((s, g) => s + g.score, 0);
  const verdict = total >= 4 ? '强烈看多' : total >= 1.5 ? '看多' : total <= -4 ? '强烈看空' : total <= -1.5 ? '看空' : '中性';

  return {
    symbol,
    verdict,
    totalScore: +total.toFixed(2),
    sections: Object.values(groups).map((g) => ({ title: `${g.label} 得分 ${g.score.toFixed(1)}`, lines: g.lines.length ? g.lines : ['无明确信号'] })),
  };
}

/** 从指标对象还原 candles 长度与收盘价（避免重复传参） */
function candlesFrom(ind) {
  const n = ind.rsi.length;
  const close = new Array(n).fill(null);
  return { length: n, close };
}

/** 轻量 computeAll 供策略2内部使用（避免重复引入大对象） */
import { computeAll } from './indicators.js';
function computeAllLite(candles) {
  const ind = computeAll(candles);
  const closes = candles.map((c) => c.close);
  return { ...ind, close: closes };
}
