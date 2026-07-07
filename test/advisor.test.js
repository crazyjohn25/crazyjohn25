import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeTimeframe,
  combineAdvice,
  verdictOf,
  runAdvisor,
  TIMEFRAMES,
} from '../js/advisor.js';

function trend(n, dir = 1, seed = 100) {
  let price = seed;
  return Array.from({ length: n }, (_, i) => {
    const open = price;
    const close = open + dir * (0.8 + ((i * 13) % 7) * 0.1);
    price = close;
    return {
      time: 1700000000 + i * 3600,
      open,
      high: Math.max(open, close) + 0.4,
      low: Math.min(open, close) - 0.4,
      close,
      volume: 100 + ((i * 17) % 40),
    };
  });
}

test('单边上涨周期分析结论偏多', () => {
  const r = analyzeTimeframe(trend(200, 1));
  assert.ok(r.score > 0, `上涨行情应为正分，实际${r.score}`);
  assert.ok(r.reasons.length >= 4, '应给出多条理由');
  assert.ok(['看多', '强烈看多', '中性'].includes(r.verdict));
});

test('单边下跌周期分析结论偏空', () => {
  const r = analyzeTimeframe(trend(200, -1, 500));
  assert.ok(r.score < 0, `下跌行情应为负分，实际${r.score}`);
});

test('数据不足时给出提示', () => {
  const r = analyzeTimeframe(trend(20));
  assert.equal(r.verdict, '数据不足');
});

test('verdictOf 阈值边界', () => {
  assert.equal(verdictOf(3), '强烈看多');
  assert.equal(verdictOf(1), '看多');
  assert.equal(verdictOf(0), '中性');
  assert.equal(verdictOf(-1), '看空');
  assert.equal(verdictOf(-3), '强烈看空');
});

test('combineAdvice 按权重加权且4h主导', () => {
  const perTf = {
    '15m': { score: -1, verdict: '看空', reasons: [] },
    '30m': { score: -1, verdict: '看空', reasons: [] },
    '1h': { score: 2, verdict: '看多', reasons: [] },
    '4h': { score: 3, verdict: '强烈看多', reasons: [] },
  };
  const r = combineAdvice(perTf);
  // (−1×1 −1×1.5 +2×2 +3×3) / 7.5 = 10.5/7.5 = 1.4
  assert.ok(Math.abs(r.overallScore - 1.4) < 1e-9);
  assert.ok(['轻仓试多', '买入'].includes(r.action));
  assert.ok(r.summary.includes('4小时'));
});

test('combineAdvice 大小周期冲突时提示', () => {
  const perTf = {
    '15m': { score: -2, verdict: '看空', reasons: [] },
    '30m': { score: 0, verdict: '中性', reasons: [] },
    '1h': { score: 0, verdict: '中性', reasons: [] },
    '4h': { score: 2, verdict: '看多', reasons: [] },
  };
  const r = combineAdvice(perTf);
  assert.ok(r.summary.includes('冲突'));
});

test('runAdvisor 编排四个周期并容错', async () => {
  const result = await runAdvisor(async (tf) => {
    if (tf === '4h') throw new Error('network');
    return trend(200, 1);
  });
  for (const tf of TIMEFRAMES) assert.ok(result.perTf[tf]);
  assert.equal(result.perTf['4h'].verdict, '数据不足');
  assert.ok(typeof result.updatedAt === 'number');
  assert.ok(result.summary.length > 10);
});
