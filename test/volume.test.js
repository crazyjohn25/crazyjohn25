import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hourlyVolumeStats,
  rolling24hVolume,
  hourOfDayProfile,
  formatVolume,
} from '../js/volume.js';

/** 构造连续1小时K线，volume由回调给出 */
function hourly(n, volFn) {
  const start = Date.UTC(2026, 0, 1, 0, 0) / 1000; // 从UTC 0点整开始
  return Array.from({ length: n }, (_, i) => ({
    time: start + i * 3600,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: volFn(i),
  }));
}

test('hourlyVolumeStats 环比与同时段对比计算正确', () => {
  // 每天24根，10天；每根量 = 100 + UTC小时数，最后一根改为翻倍
  const candles = hourly(240, (i) => 100 + (i % 24));
  candles[239].volume = (100 + 23) * 2; // 最后一根（23点）翻倍

  const rows = hourlyVolumeStats(candles, 3);
  assert.equal(rows.length, 3);
  const last = rows[0]; // 新的在前
  assert.equal(last.hourUtc, 23);
  // 环比：前一根是22点=122
  assert.ok(Math.abs(last.vsPrevPct - ((246 - 122) / 122) * 100) < 1e-9);
  // 7日同时段均值 = 123（历史每天23点都是123）
  assert.equal(last.sameHourAvg, 123);
  assert.ok(Math.abs(last.vsSameHourAvgPct - 100) < 1e-9); // 翻倍即+100%
});

test('rolling24hVolume 对比前后24小时', () => {
  // 前24根每根100，后24根每根200
  const candles = hourly(48, (i) => (i < 24 ? 100 : 200));
  const r = rolling24hVolume(candles);
  assert.equal(r.last24, 4800);
  assert.equal(r.prev24, 2400);
  assert.ok(Math.abs(r.changePct - 100) < 1e-9);
});

test('rolling24hVolume 数据不足返回null', () => {
  assert.equal(rolling24hVolume(hourly(30, () => 100)), null);
});

test('hourOfDayProfile 输出24个时段', () => {
  const candles = hourly(240, (i) => 100 + (i % 24));
  const profile = hourOfDayProfile(candles);
  assert.equal(profile.length, 24);
  assert.equal(profile[0].avgVolume, 100);
  assert.equal(profile[23].avgVolume, 123);
  assert.equal(profile[5].samples, 10);
});

test('formatVolume 缩写', () => {
  assert.equal(formatVolume(1234), '1.23K');
  assert.equal(formatVolume(1234567), '1.23M');
  assert.equal(formatVolume(1.5e9), '1.50B');
  assert.equal(formatVolume(null), '-');
});
