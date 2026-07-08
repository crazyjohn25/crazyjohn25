/**
 * 历史回测引擎
 * 用当前建议引擎的同一套指标逻辑（advisor.analyzeTimeframe），在过去7天的历史K线上
 * 逐点复现"当时会给出的建议"，并按 30分钟 / 2小时 / 4小时 / 12小时 四个持有周期
 * 检验建议是否正确，输出命中率、盈亏、正确/错误案例（含理由）与反思结论。
 *
 * 这是对实际建议逻辑的诚实回测：决策点只使用该点之前的数据（无未来函数）。
 */
import { analyzeTimeframe } from './advisor.js';

/** 各持有周期采用的基础K线与提前根数 */
export const HORIZONS = [
  { key: '30m', label: '30分钟', base: '5m', ahead: 6, seconds: 1800 },
  { key: '2h', label: '2小时', base: '15m', ahead: 8, seconds: 7200 },
  { key: '4h', label: '4小时', base: '30m', ahead: 8, seconds: 14400 },
  { key: '12h', label: '12小时', base: '1h', ahead: 12, seconds: 43200 },
];

const WINDOW = 220; // 指标滚动窗口（覆盖EMA200）
const SCORE_TH = 0.75; // 与实时建议一致的方向阈值
const DAYS = 7;

/**
 * 回测单个周期（纯函数）
 * @param {Array} candles 基础周期K线（时间升序，覆盖>7天）
 * @param {Object} h HORIZONS成员
 * @returns {{key,label,total,hits,hitRate,pnl,cum,longs,shorts,cases}}
 */
export function backtestHorizon(candles, h) {
  const n = candles.length;
  const cutoff = candles.length ? candles[n - 1].time - DAYS * 86400 : 0;
  const calls = [];
  // 非重叠步进：stride=ahead，模拟"每个持有周期做一次决策"
  for (let i = Math.max(WINDOW, 0); i < n - h.ahead; i += h.ahead) {
    if (candles[i].time < cutoff) continue;
    const slice = candles.slice(Math.max(0, i - WINDOW), i + 1);
    const r = analyzeTimeframe(slice);
    if (r.verdict === '数据不足') continue;
    const direction = r.score >= SCORE_TH ? 'up' : r.score <= -SCORE_TH ? 'down' : null;
    if (!direction) continue;

    const entry = candles[i].close;
    const exit = candles[i + h.ahead].close;
    const changePct = ((exit - entry) / entry) * 100;
    const hit = direction === 'up' ? changePct > 0 : changePct < 0;
    const ret = direction === 'up' ? changePct : -changePct; // 跟随建议方向的收益

    calls.push({
      time: candles[i].time,
      exitTime: candles[i + h.ahead].time,
      direction,
      score: r.score,
      verdict: r.verdict,
      entry,
      exit,
      changePct,
      ret,
      hit,
      reasons: r.reasons.slice(0, 5),
    });
  }

  const hits = calls.filter((c) => c.hit).length;
  const pnl = calls.reduce((s, c) => s + c.ret, 0);
  // 复利累计（每次按固定仓位跟随）
  let cum = 1;
  for (const c of calls) cum *= 1 + c.ret / 100;

  // 代表性案例：最赚的对、最亏的错各取若干
  const wins = calls.filter((c) => c.hit).sort((a, b) => b.ret - a.ret).slice(0, 2);
  const losses = calls.filter((c) => !c.hit).sort((a, b) => a.ret - b.ret).slice(0, 3);

  return {
    key: h.key,
    label: h.label,
    total: calls.length,
    hits,
    hitRate: calls.length ? hits / calls.length : null,
    pnl,
    cum: (cum - 1) * 100,
    longs: calls.filter((c) => c.direction === 'up').length,
    shorts: calls.filter((c) => c.direction === 'down').length,
    cases: { wins, losses },
    calls,
  };
}

/**
 * 运行全周期回测
 * @param {Function} fetchCandles (interval, limit) => Promise<candles>
 */
export async function runBacktest(fetchCandles) {
  const results = [];
  for (const h of HORIZONS) {
    try {
      // 需覆盖7天：根据基础周期换算所需根数，再加窗口余量
      const perDay = 86400 / intervalSeconds(h.base);
      const limit = Math.ceil(perDay * DAYS) + WINDOW + h.ahead + 10;
      const candles = await fetchCandles(h.base, Math.min(limit, 1500));
      results.push(backtestHorizon(candles, h));
    } catch (_) {
      results.push({ key: h.key, label: h.label, total: 0, hitRate: null, error: true, calls: [] });
    }
  }
  return {
    horizons: results,
    reflections: reflectBacktest(results),
    generatedAt: Math.floor(Date.now() / 1000),
  };
}

function intervalSeconds(iv) {
  return { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400 }[iv] || 3600;
}

/**
 * 汇总反思结论（纯函数）：找出系统性弱点并给出改进方向
 */
export function reflectBacktest(results) {
  const out = [];
  const valid = results.filter((r) => r.total > 0 && r.hitRate !== null);
  if (valid.length === 0) return ['过去7天样本不足或数据获取失败，无法回测'];

  const overallCalls = valid.reduce((s, r) => s + r.total, 0);
  const overallHits = valid.reduce((s, r) => s + r.hits, 0);
  out.push(
    `过去7天共复盘 ${overallCalls} 次建议，综合命中率 ${((overallHits / overallCalls) * 100).toFixed(0)}%`
  );

  // 最好/最差周期
  const sorted = [...valid].sort((a, b) => b.hitRate - a.hitRate);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  if (best !== worst) {
    out.push(
      `${best.label}周期表现最好（命中${(best.hitRate * 100).toFixed(0)}%、累计${best.cum >= 0 ? '+' : ''}${best.cum.toFixed(1)}%），` +
        `${worst.label}周期最差（命中${(worst.hitRate * 100).toFixed(0)}%、累计${worst.cum >= 0 ? '+' : ''}${worst.cum.toFixed(1)}%）`
    );
  }

  for (const r of valid) {
    if (r.hitRate < 0.45) {
      out.push(
        `【${r.label}】命中率${(r.hitRate * 100).toFixed(0)}%低于抛硬币：该周期趋势信号在近7天失效，多为震荡行情——应提高该周期的信号阈值或改用均值回归策略，切勿在此周期重仓`
      );
    } else if (r.hitRate >= 0.6 && r.cum > 0) {
      out.push(
        `【${r.label}】命中率${(r.hitRate * 100).toFixed(0)}%且累计正收益：该周期趋势跟随近期有效，可适度提高跟随仓位（仍需止损）`
      );
    }
    // 方向偏差：若几乎全做多但市场在跌
    if (r.longs > 0 && r.shorts === 0 && r.hitRate < 0.5) {
      out.push(`【${r.label}】期间只发出做多信号却胜率不足，说明指标在下跌/震荡中偏多失灵，需加入趋势过滤（如价格在EMA200下方时禁止做多）`);
    }
  }

  // 短周期普遍差 → 提醒少做短线
  const short = valid.find((r) => r.key === '30m');
  if (short && short.hitRate < 0.5) {
    out.push('深刻反思：30分钟级别噪音大、胜率低，频繁短线交易是过去亏损的主因之一；建议减少超短线操作，把仓位集中到胜率更高的中长周期，并对每笔交易强制设置止损以控制单次最大回撤');
  }

  return out;
}
