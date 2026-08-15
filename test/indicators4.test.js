import test from 'node:test';
import assert from 'node:assert/strict';
import { computeAll, parabolicSar, superTrend, cvdSeries, volumeProfile, liquidationClusters } from '../js/indicators.js';

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

test('SAR 在上涨趋势中位于价格下方', () => {
  const candles = trend(60, 1);
  const sar = parabolicSar(candles);
  assert.ok(sar[sar.length - 1] < candles[candles.length - 1].close);
  assert.ok(sar.every((v, i) => i < 2 || v !== null));
});

test('SUPER 趋势方向与价格一致', () => {
  const candles = trend(60, 1);
  const st = superTrend(candles);
  assert.equal(st.direction[st.direction.length - 1], 1);
  assert.ok(st.line[st.line.length - 1] < candles[candles.length - 1].close);
});

test('CVD 随上涨累计为正', () => {
  const candles = trend(40, 1);
  const cvd = cvdSeries(candles);
  assert.ok(cvd[cvd.length - 1] > 0);
});

test('Volume Profile 有 POC 与价值区', () => {
  const candles = trend(120, 1);
  const vp = volumeProfile(candles);
  assert.ok(vp);
  assert.ok(vp.poc > 0);
  assert.ok(vp.vaLow < vp.vaHigh);
});

test('清算簇在震荡市聚集', () => {
  const candles = [];
  let p = 100;
  for (let i = 0; i < 96; i++) {
    const o = p;
    p = p + Math.sin(i / 5) * 0.8;
    candles.push({ time: 1700000000 + i * 3600, open: o, high: Math.max(o, p) + 0.3, low: Math.min(o, p) - 0.3, close: p, volume: 100 });
  }
  const clusters = liquidationClusters(candles);
  assert.ok(clusters.length > 0);
  assert.ok(clusters[0].price > 0);
});

test('computeAll 包含 sar/super/cvd/vp/liquidation', () => {
  const candles = trend(80, 1);
  const ind = computeAll(candles);
  assert.ok(ind.sar);
  assert.ok(ind.super);
  assert.ok(ind.cvd);
  assert.ok(ind.vp);
  assert.ok(ind.liquidation);
});
