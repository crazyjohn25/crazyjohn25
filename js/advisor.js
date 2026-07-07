/**
 * 多周期综合建议引擎
 * 在 15m / 30m / 1h / 4h 四个周期上分别计算 RSI、成交量、MACD、BOLL、KDJ、DMI，
 * 按打分规则得出各周期多空倾向，再按周期权重加权出总建议（买入/卖出/观望），
 * 输出建议理由与解读。每30分钟自动刷新一次。
 */
import { computeAll } from './indicators.js';

export const TIMEFRAMES = ['15m', '30m', '1h', '4h'];
export const TF_WEIGHTS = { '15m': 1, '30m': 1.5, '1h': 2, '4h': 3 };

/**
 * 单周期分析（纯函数）
 * @param {Array} candles 该周期K线
 * @returns {{score, verdict, reasons: string[]}}
 */
export function analyzeTimeframe(candles) {
  if (!candles || candles.length < 60) {
    return { score: 0, verdict: '数据不足', reasons: ['K线数量不足，跳过该周期'] };
  }
  const ind = computeAll(candles);
  const i = candles.length - 1;
  const c = candles[i];
  const reasons = [];
  let score = 0;

  // --- MACD ---
  const { dif, dea, hist } = ind.macd;
  if (dif[i] !== null && dea[i] !== null) {
    if (dif[i] > dea[i]) {
      score += 1;
      reasons.push(`MACD多头：DIF(${dif[i].toFixed(2)}) > DEA(${dea[i].toFixed(2)})`);
    } else {
      score -= 1;
      reasons.push(`MACD空头：DIF(${dif[i].toFixed(2)}) < DEA(${dea[i].toFixed(2)})`);
    }
    if (hist[i] !== null && hist[i - 1] !== null && hist[i - 2] !== null) {
      if (hist[i] > hist[i - 1] && hist[i - 1] > hist[i - 2]) {
        score += 0.5;
        reasons.push('MACD柱连续放大，动能增强');
      } else if (hist[i] < hist[i - 1] && hist[i - 1] < hist[i - 2]) {
        score -= 0.5;
        reasons.push('MACD柱连续缩小，动能减弱');
      }
    }
  }

  // --- RSI ---
  const rsiV = ind.rsi[i];
  if (rsiV !== null) {
    if (rsiV < 30) {
      score += 1;
      reasons.push(`RSI=${rsiV.toFixed(1)} 处于超卖区，存在反弹需求`);
    } else if (rsiV < 40) {
      score += 0.5;
      reasons.push(`RSI=${rsiV.toFixed(1)} 偏弱但接近超卖`);
    } else if (rsiV > 70) {
      score -= 1;
      reasons.push(`RSI=${rsiV.toFixed(1)} 处于超买区，警惕回调`);
    } else if (rsiV > 60) {
      score -= 0.5;
      reasons.push(`RSI=${rsiV.toFixed(1)} 偏强但接近超买`);
    } else {
      reasons.push(`RSI=${rsiV.toFixed(1)} 处于中性区间`);
    }
  }

  // --- KDJ ---
  const { k, d } = ind.kdj;
  if (k[i] !== null && d[i] !== null) {
    if (k[i] > d[i]) {
      score += 0.5;
      reasons.push(`KDJ K(${k[i].toFixed(1)})在D(${d[i].toFixed(1)})上方`);
    } else {
      score -= 0.5;
      reasons.push(`KDJ K(${k[i].toFixed(1)})在D(${d[i].toFixed(1)})下方`);
    }
    if (k[i] < 20) {
      score += 0.5;
      reasons.push('KDJ进入超卖区');
    } else if (k[i] > 80) {
      score -= 0.5;
      reasons.push('KDJ进入超买区');
    }
  }

  // --- DMI ---
  const { pdi, mdi, adx } = ind.dmi;
  if (pdi[i] !== null && mdi[i] !== null) {
    const trendStrong = adx[i] !== null && adx[i] > 25;
    if (pdi[i] > mdi[i]) {
      score += trendStrong ? 1.5 : 1;
      reasons.push(
        `DMI多头排列（+DI ${pdi[i].toFixed(1)} > -DI ${mdi[i].toFixed(1)}）` +
          (trendStrong ? `，ADX=${adx[i].toFixed(1)} 趋势强劲` : '')
      );
    } else {
      score -= trendStrong ? 1.5 : 1;
      reasons.push(
        `DMI空头排列（+DI ${pdi[i].toFixed(1)} < -DI ${mdi[i].toFixed(1)}）` +
          (trendStrong ? `，ADX=${adx[i].toFixed(1)} 趋势强劲` : '')
      );
    }
  }

  // --- BOLL ---
  const { upper, middle, lower } = ind.boll;
  if (middle[i] !== null) {
    if (c.close > upper[i]) {
      score -= 0.5;
      reasons.push('价格突破布林上轨，短线超买风险');
    } else if (c.close < lower[i]) {
      score += 0.5;
      reasons.push('价格跌破布林下轨，超卖修复概率上升');
    } else if (c.close > middle[i]) {
      score += 0.5;
      reasons.push('价格运行于布林中轨上方，偏多格局');
    } else {
      score -= 0.5;
      reasons.push('价格运行于布林中轨下方，偏空格局');
    }
  }

  // --- 成交量 ---
  if (candles.length >= 25) {
    let recent = 0;
    let base = 0;
    for (let j = i - 4; j <= i; j++) recent += candles[j].volume;
    for (let j = i - 24; j <= i - 5; j++) base += candles[j].volume;
    const recentAvg = recent / 5;
    const baseAvg = base / 20;
    if (baseAvg > 0) {
      const ratio = recentAvg / baseAvg;
      const priceUp = c.close > candles[i - 4].close;
      if (ratio > 1.5 && priceUp) {
        score += 0.5;
        reasons.push(`近5根量能为前期${ratio.toFixed(1)}倍且价格上行，量价配合健康`);
      } else if (ratio > 1.5 && !priceUp) {
        score -= 0.5;
        reasons.push(`近5根放量${ratio.toFixed(1)}倍但价格下行，抛压明显`);
      } else if (ratio < 0.6) {
        reasons.push('量能萎缩，方向选择前观望为宜');
      }
    }
  }

  return { score, verdict: verdictOf(score), reasons };
}

export function verdictOf(score) {
  if (score >= 2.5) return '强烈看多';
  if (score >= 1) return '看多';
  if (score <= -2.5) return '强烈看空';
  if (score <= -1) return '看空';
  return '中性';
}

/**
 * 综合多周期结果（纯函数）
 * @param {Object} perTf { '15m': {score,verdict,reasons}, ... }
 * @returns {{ overallScore, action, summary, perTf }}
 */
export function combineAdvice(perTf) {
  let weighted = 0;
  let totalW = 0;
  for (const tf of TIMEFRAMES) {
    const r = perTf[tf];
    if (!r || r.verdict === '数据不足') continue;
    weighted += r.score * (TF_WEIGHTS[tf] || 1);
    totalW += TF_WEIGHTS[tf] || 1;
  }
  const overallScore = totalW > 0 ? weighted / totalW : 0;

  let action;
  if (overallScore >= 1.5) action = '买入';
  else if (overallScore >= 0.75) action = '轻仓试多';
  else if (overallScore <= -1.5) action = '卖出';
  else if (overallScore <= -0.75) action = '减仓防守';
  else action = '观望';

  const parts = [];
  const tf4h = perTf['4h'];
  const tf1h = perTf['1h'];
  const tf15 = perTf['15m'];
  if (tf4h && tf4h.verdict !== '数据不足') parts.push(`4小时级别${tf4h.verdict}（大方向权重最高）`);
  if (tf1h && tf1h.verdict !== '数据不足') parts.push(`1小时级别${tf1h.verdict}`);
  if (tf15 && tf15.verdict !== '数据不足') parts.push(`15分钟级别${tf15.verdict}（短线情绪）`);

  let conflict = '';
  if (tf4h && tf15 && tf4h.score * tf15.score < -1) {
    conflict = '注意：大周期与小周期方向冲突，多为震荡或转折初期，建议降低仓位、等待共振。';
  }

  const summary =
    `${parts.join('；')}。加权总分 ${overallScore.toFixed(2)}，综合建议【${action}】。` +
    (conflict ? ' ' + conflict : '') +
    ' 本建议由技术指标规则生成，仅供参考，不构成投资建议。';

  return { overallScore, action, summary, perTf };
}

/**
 * 编排：拉取各周期K线并产出综合建议
 * @param {Function} fetchCandles (interval) => Promise<candles>
 */
export async function runAdvisor(fetchCandles) {
  const perTf = {};
  await Promise.all(
    TIMEFRAMES.map(async (tf) => {
      try {
        const candles = await fetchCandles(tf);
        perTf[tf] = analyzeTimeframe(candles);
      } catch (_) {
        perTf[tf] = { score: 0, verdict: '数据不足', reasons: ['该周期数据获取失败'] };
      }
    })
  );
  return { ...combineAdvice(perTf), updatedAt: Math.floor(Date.now() / 1000) };
}
