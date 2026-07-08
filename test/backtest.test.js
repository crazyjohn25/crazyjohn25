import test from 'node:test';
import assert from 'node:assert/strict';
import { backtestHorizon, reflectBacktest, HORIZONS, runBacktest } from '../js/backtest.js';

/** 生成确定性趋势K线（够长以覆盖7天+窗口） */
function makeCandles(n, dir, base, seconds) {
  let p = 100;
  const now = Math.floor(Date.now() / 1000);
  const start = now - n * seconds;
  return Array.from({ length: n }, (_, i) => {
    const open = p;
    // 明确趋势 + 小噪音（确定性）
    const noise = (((i * 2654435761) % 100) / 100 - 0.5) * base * 0.3;
    const close = open + dir * base + noise;
    p = close;
    return {
      time: start + i * seconds,
      open,
      high: Math.max(open, close) + base * 0.2,
      low: Math.min(open, close) - base * 0.2,
      close,
      volume: 1000 + (i % 50),
    };
  });
}

test('backtestHorizon 上涨趋势中做多信号占多且命中率高', () => {
  const h = HORIZONS[0]; // 30m: base 5m ahead 6
  const candles = makeCandles(2500, 1, 0.5, 300); // 持续上涨
  const r = backtestHorizon(candles, h);
  assert.ok(r.total > 0, '应产生回测样本');
  assert.ok(r.longs > r.shorts, '上涨趋势应以做多为主');
  assert.ok(r.hitRate > 0.6, `上涨趋势跟随命中率应高，实际${r.hitRate}`);
  assert.ok(r.cum > 0, '累计收益应为正');
});

test('backtestHorizon 每次call含方向/理由/盈亏字段', () => {
  const r = backtestHorizon(makeCandles(2500, 1, 0.5, 300), HORIZONS[0]);
  for (const c of r.calls.slice(0, 5)) {
    assert.ok(['up', 'down'].includes(c.direction));
    assert.ok(Array.isArray(c.reasons) && c.reasons.length > 0);
    assert.ok(typeof c.changePct === 'number');
    assert.ok(typeof c.ret === 'number');
    assert.equal(c.hit, c.direction === 'up' ? c.changePct > 0 : c.changePct < 0);
  }
});

test('backtestHorizon 数据不足返回空', () => {
  const r = backtestHorizon(makeCandles(50, 1, 0.5, 300), HORIZONS[0]);
  assert.equal(r.total, 0);
});

test('backtestHorizon 只回测近7天', () => {
  // 20天数据，只应统计最近7天的决策点
  const h = HORIZONS[3]; // 12h: base 1h ahead 12
  const candles = makeCandles(24 * 20, 1, 0.5, 3600);
  const r = backtestHorizon(candles, h);
  const cutoff = candles[candles.length - 1].time - 7 * 86400;
  for (const c of r.calls) assert.ok(c.time >= cutoff, '不应包含7天前的决策');
});

test('reflectBacktest 无样本时给提示', () => {
  const out = reflectBacktest([{ key: '30m', label: '30分钟', total: 0, hitRate: null }]);
  assert.ok(out[0].includes('样本不足') || out[0].includes('无法回测'));
});

test('reflectBacktest 低命中周期被点名', () => {
  const results = [
    { key: '30m', label: '30分钟', total: 20, hits: 6, hitRate: 0.3, cum: -5, longs: 20, shorts: 0 },
    { key: '4h', label: '4小时', total: 10, hits: 7, hitRate: 0.7, cum: 12, longs: 6, shorts: 4 },
  ];
  const out = reflectBacktest(results);
  assert.ok(out.some((x) => x.includes('30分钟')));
  assert.ok(out.some((x) => x.includes('4小时')));
  assert.ok(out.some((x) => x.includes('反思') || x.includes('短线')));
});

test('runBacktest 编排四周期并容错', async () => {
  const bt = await runBacktest(async (interval, limit) => {
    const secs = { '5m': 300, '15m': 900, '30m': 1800, '1h': 3600 }[interval] || 3600;
    return makeCandles(Math.min(limit, 2500), 1, 0.5, secs);
  });
  assert.equal(bt.horizons.length, 4);
  assert.ok(bt.reflections.length > 0);
  assert.ok(typeof bt.generatedAt === 'number');
});
