import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStrategyAdvice, STRATEGIES, analyzeTimeframe } from '../js/advisor.js';

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

function perTfAll(dir) {
  const c = trend(300, dir);
  const a = analyzeTimeframe(c);
  return { '1h': a, '4h': a, '1d': a };
}

test('三层策略齐备且上涨行情给买入', () => {
  const out = buildStrategyAdvice(perTfAll(1));
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((s) => s.key), STRATEGIES.map((s) => s.key));
  for (const st of out) {
    assert.ok(st.action.includes('买'), `${st.key}应看多，实际${st.action}`);
    assert.ok(st.plan, '方向明确时应有交易计划');
    assert.ok(st.plan.stop < st.plan.entry, '做多止损应低于入场');
    assert.ok(st.reasons.length >= 3);
  }
});

test('大周期反向时信号降级', () => {
  const up = analyzeTimeframe(trend(300, 1));
  const down = analyzeTimeframe(trend(300, -1, 600));
  // 1h看多但4h强烈看空 → 短线信号被压缩
  const out = buildStrategyAdvice({ '1h': up, '4h': down, '1d': down });
  const short = out.find((s) => s.key === 'short');
  assert.ok(Math.abs(short.score) < Math.abs(up.score), '逆大势时评分应被压缩');
  assert.ok(short.reasons.some((r) => r.includes('不与大趋势作对')));
});

test('新闻面偏向注入且短线权重最大', () => {
  const base = perTfAll(1);
  const noNews = buildStrategyAdvice(base);
  const withNews = buildStrategyAdvice(base, {
    newsBias: { score: -1, reason: '新闻面：利空压制' },
  });
  const s0 = noNews.find((s) => s.key === 'short');
  const s1 = withNews.find((s) => s.key === 'short');
  const l0 = noNews.find((s) => s.key === 'long');
  const l1 = withNews.find((s) => s.key === 'long');
  assert.ok(s1.score < s0.score, '利空新闻应压低短线评分');
  assert.ok(Math.abs(s0.score - s1.score) > Math.abs(l0.score - l1.score), '短线受新闻影响应大于长线');
  assert.ok(s1.reasons.some((r) => r.includes('利空压制')));
});

test('经验修正：低命中率降权并写明理由', () => {
  const base = perTfAll(1);
  const out = buildStrategyAdvice(base, {
    experience: { short: { hitRate: 0.3, total: 10 } },
  });
  const short = out.find((s) => s.key === 'short');
  assert.ok(short.reasons.some((r) => r.includes('经验修正') && r.includes('30%')));
});

test('重大信号标记与置顶字段', () => {
  const out = buildStrategyAdvice(perTfAll(1));
  const majors = out.filter((s) => s.major);
  for (const m of majors) {
    assert.ok(Math.abs(m.score) >= 2.5);
    assert.ok(m.reasons[0].includes('重大信号'));
  }
});

test('数据不足时对应策略明确提示', () => {
  const a = analyzeTimeframe(trend(300, 1));
  const out = buildStrategyAdvice({ '1h': a, '4h': a, '1d': { score: 0, verdict: '数据不足', reasons: [] } });
  const long = out.find((s) => s.key === 'long');
  assert.equal(long.action, '数据不足');
});
