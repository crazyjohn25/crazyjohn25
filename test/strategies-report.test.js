import test from 'node:test';
import assert from 'node:assert/strict';
import { strategyOne, strategyTwo } from '../js/strategies-report.js';

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

test('策略1 输出四段结构与执行纪律', () => {
  const r = strategyOne({
    symbol: 'BTCUSDT',
    candles1d: trend(250, 1),
    candles1h: trend(400, 1),
    candles30m: trend(400, 1),
    newsBias: { score: 0.5, reason: '新闻面偏多' },
    soso: { fundingRate: 0.0002, openInterest: 120, liquidation: { x: 1 }, volume24h: 1000, news: ['a'] },
  });
  assert.equal(r.sections.length, 4);
  assert.ok(r.sections[3].lines.some((l) => l.includes('盈亏比至少 2:1')));
  assert.ok(r.totalScore > 0);
});

test('策略2 按四组打分', () => {
  const r = strategyTwo({
    symbol: 'BTCUSDT',
    candles1h: trend(400, 1),
    candles4h: trend(400, 1),
    candles1d: trend(250, 1),
  });
  assert.equal(r.sections.length, 4);
  assert.ok(r.sections[0].title.includes('趋势组'));
  assert.ok(r.sections[1].title.includes('动量组'));
  assert.ok(r.sections[2].title.includes('震荡组'));
  assert.ok(r.sections[3].title.includes('量能组'));
});
