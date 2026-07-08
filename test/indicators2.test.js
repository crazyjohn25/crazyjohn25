import test from 'node:test';
import assert from 'node:assert/strict';
import { cci, mfi, willr, computeAll } from '../js/indicators.js';

function candles(closes, vol = 100) {
  return closes.map((c, i) => ({
    time: 1700000000 + i * 3600,
    open: c - 0.5,
    high: c + 1,
    low: c - 1,
    close: c,
    volume: vol + (i % 7),
  }));
}

test('cci 上升趋势为正、下降为负', () => {
  const up = cci(candles(Array.from({ length: 40 }, (_, i) => 100 + i)));
  const down = cci(candles(Array.from({ length: 40 }, (_, i) => 100 - i)));
  assert.equal(up[18], null);
  assert.ok(up[39] > 0);
  assert.ok(down[39] < 0);
});

test('mfi 值域0-100且上升趋势偏高', () => {
  const up = mfi(candles(Array.from({ length: 40 }, (_, i) => 100 + i)));
  assert.equal(up[13], null);
  for (let i = 14; i < 40; i++) {
    assert.ok(up[i] >= 0 && up[i] <= 100);
  }
  assert.ok(up[39] > 60);
});

test('willr 值域-100~0，高位接近0', () => {
  const up = willr(candles(Array.from({ length: 40 }, (_, i) => 100 + i)));
  assert.equal(up[12], null);
  for (let i = 13; i < 40; i++) {
    assert.ok(up[i] <= 0 && up[i] >= -100);
  }
  assert.ok(up[39] > -30, '持续新高时W%R应接近0');
});

test('computeAll 包含新指标且长度一致', () => {
  const cs = candles(Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 4) * 8));
  const all = computeAll(cs);
  assert.equal(all.cci.length, 60);
  assert.equal(all.mfi.length, 60);
  assert.equal(all.willr.length, 60);
});
