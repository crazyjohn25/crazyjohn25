import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewLog, adaptWeights } from '../js/review.js';

test('record 登记并去重', () => {
  const log = new ReviewLog({});
  const r1 = log.record({ source: 'advisor:1h', symbol: 'BTCUSDT', direction: 'up', priceAtCall: 100, callTime: 1000, evalTime: 4600 });
  const r2 = log.record({ source: 'advisor:1h', symbol: 'BTCUSDT', direction: 'up', priceAtCall: 101, callTime: 1100, evalTime: 4600 });
  assert.ok(r1);
  assert.equal(r2, null, '同一来源同一评估点应去重');
  assert.equal(log.pendingCount(), 1);
});

test('settle 按实际价格判定命中', () => {
  const log = new ReviewLog({});
  log.record({ source: 'advisor:1h', symbol: 'BTC', direction: 'up', priceAtCall: 100, callTime: 0, evalTime: 100 });
  log.record({ source: 'advisor:1h', symbol: 'BTC', direction: 'down', priceAtCall: 100, callTime: 0, evalTime: 200 });
  log.record({ source: 'advisor:4h', symbol: 'BTC', direction: 'up', priceAtCall: 100, callTime: 0, evalTime: 99999 }); // 未到期

  const settled = log.settle((sym, t) => (t === 100 ? 105 : t === 200 ? 95 : null), 300);
  assert.equal(settled.length, 2);
  assert.equal(settled[0].outcome, 'hit'); // up 100->105
  assert.equal(settled[1].outcome, 'hit'); // down 100->95
  assert.equal(log.pendingCount(), 1);

  const stats = log.stats();
  assert.equal(stats['advisor:1h'].hits, 2);
  assert.equal(stats['advisor:1h'].hitRate, 1);
});

test('settle 方向错误判为miss', () => {
  const log = new ReviewLog({});
  log.record({ source: 'advisor:short', symbol: 'BTC', direction: 'up', priceAtCall: 100, callTime: 0, evalTime: 100 });
  const settled = log.settle(() => 98, 300);
  assert.equal(settled[0].outcome, 'miss');
});

test('adaptWeights 低命中率降权并生成反思', () => {
  const stats = {
    'advisor:15m': { total: 10, hits: 3, hitRate: 0.3 }, // <35% 减半
    'advisor:1h': { total: 10, hits: 7, hitRate: 0.7 }, // >60% 加权
    'advisor:4h': { total: 3, hits: 0, hitRate: 0 }, // 样本太少不动
  };
  const base = { '15m': 1, '30m': 1.5, '1h': 2, '4h': 3 };
  const { weights, reflections } = adaptWeights(stats, base);
  assert.equal(weights['15m'], 0.5);
  assert.ok(Math.abs(weights['1h'] - 2.4) < 1e-9);
  assert.equal(weights['4h'], 3);
  assert.equal(weights['30m'], 1.5);
  assert.ok(reflections.some((r) => r.includes('15m')));
  assert.ok(reflections.some((r) => r.includes('1h')));
});

test('adaptWeights 低命中周期降权', () => {
  const { weights, reflections } = adaptWeights(
    { 'advisor:15m': { total: 8, hits: 3, hitRate: 0.375 } },
    { '15m': 1 }
  );
  assert.ok(weights['15m'] < 1);
  assert.ok(reflections.some((r) => r.includes('15m')));
});
