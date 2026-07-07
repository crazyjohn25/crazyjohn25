import test from 'node:test';
import assert from 'node:assert/strict';
import { detectCandleAnomalies, WhaleFeed } from '../js/anomaly.js';

function flat(n, { vol = 100, price = 100 } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    time: 1700000000 + i * 3600,
    open: price,
    high: price + 0.6,
    low: price - 0.6,
    close: price + Math.sin(i) * 0.5, // 微小波动，保证std>0
    volume: vol + (i % 5), // 微小量差
  }));
}

test('平稳行情不产生异动', () => {
  const candles = flat(150);
  assert.equal(detectCandleAnomalies(candles).length, 0);
});

test('突然放量被检测为volume异动', () => {
  const candles = flat(150);
  candles[140].volume = 2000; // 20倍放量
  const out = detectCandleAnomalies(candles);
  assert.ok(out.length >= 1);
  const hit = out.find((a) => a.time === candles[140].time);
  assert.ok(hit);
  assert.ok(['volume', 'both'].includes(hit.type));
});

test('单根暴跌被检测为price异动', () => {
  const candles = flat(150);
  candles[145].close = candles[144].close * 0.9; // -10%
  const out = detectCandleAnomalies(candles);
  const hit = out.find((a) => a.time === candles[145].time);
  assert.ok(hit);
  assert.ok(['price', 'both'].includes(hit.type));
  assert.ok(hit.pricePct < -5);
});

test('放量+暴涨同时命中为both', () => {
  const candles = flat(150);
  candles[130].volume = 3000;
  candles[130].close = candles[129].close * 1.12;
  const out = detectCandleAnomalies(candles);
  const hit = out.find((a) => a.time === candles[130].time);
  assert.ok(hit);
  assert.equal(hit.type, 'both');
});

test('数据不足时返回空数组', () => {
  assert.deepEqual(detectCandleAnomalies(flat(50)), []);
});

test('WhaleFeed 保留上限并新在前', () => {
  const feed = new WhaleFeed(3);
  for (let i = 0; i < 5; i++) feed.push({ usd: i });
  assert.equal(feed.trades.length, 3);
  assert.equal(feed.trades[0].usd, 4);
  feed.clear();
  assert.equal(feed.trades.length, 0);
});
