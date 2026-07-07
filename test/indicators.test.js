import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sma,
  ema,
  macd,
  bollinger,
  rsi,
  kdj,
  dmi,
  obv,
  computeAll,
} from '../js/indicators.js';

/** 用收盘价数组构造candles */
function candlesFromCloses(closes) {
  return closes.map((c, i) => ({
    time: 1700000000 + i * 3600,
    open: c,
    high: c + 1,
    low: c - 1,
    close: c,
    volume: 100,
  }));
}

test('sma 基本计算', () => {
  const out = sma([1, 2, 3, 4, 5], 3);
  assert.deepEqual(out, [null, null, 2, 3, 4]);
});

test('ema 首值为SMA种子且逐步平滑', () => {
  const out = ema([1, 2, 3, 4, 5], 3);
  assert.equal(out[0], null);
  assert.equal(out[1], null);
  assert.equal(out[2], 2); // (1+2+3)/3
  // EMA(3): k=0.5, out[3] = 4*0.5 + 2*0.5 = 3
  assert.equal(out[3], 3);
  assert.equal(out[4], 4);
});

test('macd DIF = EMA快线 - EMA慢线，且 hist = dif - dea', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
  const candles = candlesFromCloses(closes);
  const { dif, dea, hist } = macd(candles);
  // 前25根数据不足
  assert.equal(dif[24], null);
  assert.notEqual(dif[25], null);
  const lastIdx = closes.length - 1;
  assert.ok(Math.abs(hist[lastIdx] - (dif[lastIdx] - dea[lastIdx])) < 1e-9);
  // 持续上涨时 DIF 应为正
  assert.ok(dif[lastIdx] > 0);
});

test('bollinger 上下轨对称于中轨', () => {
  const closes = Array.from({ length: 30 }, () => 100 + Math.sin(0.5) * 5);
  const candles = candlesFromCloses(closes);
  const { middle, upper, lower } = bollinger(candles, 20, 2);
  assert.equal(middle[18], null);
  const i = 25;
  assert.ok(
    Math.abs(upper[i] - middle[i] - (middle[i] - lower[i])) < 1e-9,
    '上下轨与中轨等距'
  );
});

test('bollinger 常数序列上下轨等于中轨', () => {
  const candles = candlesFromCloses(new Array(25).fill(50));
  const { middle, upper, lower } = bollinger(candles, 20, 2);
  assert.equal(upper[24], middle[24]);
  assert.equal(lower[24], middle[24]);
});

test('rsi 持续上涨时为100，持续下跌时接近0', () => {
  const up = candlesFromCloses(Array.from({ length: 30 }, (_, i) => 100 + i));
  const down = candlesFromCloses(Array.from({ length: 30 }, (_, i) => 100 - i));
  const rsiUp = rsi(up, 14);
  const rsiDown = rsi(down, 14);
  assert.notEqual(rsiUp[14], null);
  assert.equal(rsiUp[29], 100);
  assert.ok(rsiDown[29] < 1);
});

test('rsi 数据不足时返回全null', () => {
  const candles = candlesFromCloses([1, 2, 3]);
  assert.ok(rsi(candles, 14).every((v) => v === null));
});

test('kdj 值域合理且 J = 3K - 2D', () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 10);
  const candles = closes.map((c, i) => ({
    time: 1700000000 + i * 3600,
    open: c,
    high: c + 2,
    low: c - 2,
    close: c,
    volume: 100,
  }));
  const { k, d, j } = kdj(candles);
  for (let i = 0; i < candles.length; i++) {
    if (k[i] === null) continue;
    assert.ok(k[i] >= 0 && k[i] <= 100);
    assert.ok(d[i] >= 0 && d[i] <= 100);
    assert.ok(Math.abs(j[i] - (3 * k[i] - 2 * d[i])) < 1e-9);
  }
});

test('dmi 上升趋势中 +DI > -DI 且 ADX 有值', () => {
  const candles = Array.from({ length: 60 }, (_, i) => ({
    time: 1700000000 + i * 3600,
    open: 100 + i,
    high: 101.5 + i,
    low: 99.5 + i,
    close: 101 + i,
    volume: 100,
  }));
  const { pdi, mdi, adx } = dmi(candles, 14);
  const i = 50;
  assert.ok(pdi[i] > mdi[i], '+DI应大于-DI');
  assert.notEqual(adx[i], null);
  assert.ok(adx[i] > 25, '单边趋势中ADX应较高');
});

test('obv 涨加量、跌减量、平不变', () => {
  const candles = [
    { time: 1, open: 10, high: 11, low: 9, close: 10, volume: 100 },
    { time: 2, open: 10, high: 12, low: 10, close: 11, volume: 200 },
    { time: 3, open: 11, high: 12, low: 10, close: 10.5, volume: 150 },
    { time: 4, open: 10.5, high: 11, low: 10, close: 10.5, volume: 300 },
  ];
  assert.deepEqual(obv(candles), [0, 200, 50, 50]);
});

test('computeAll 输出长度与输入一致', () => {
  const candles = candlesFromCloses(
    Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i / 5) * 8)
  );
  const all = computeAll(candles);
  assert.equal(all.rsi.length, 100);
  assert.equal(all.macd.dif.length, 100);
  assert.equal(all.boll.upper.length, 100);
  assert.equal(all.kdj.k.length, 100);
  assert.equal(all.dmi.adx.length, 100);
  assert.equal(all.obv.length, 100);
});

test('空输入不抛异常', () => {
  const empty = [];
  assert.doesNotThrow(() => computeAll(empty));
  assert.deepEqual(obv(empty), []);
});
