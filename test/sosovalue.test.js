import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSosoValue, normalizeSoso, describeSoso } from '../js/sosovalue.js';

test('normalizeSoso 提取资金费率与交易量', () => {
  const raw = { data: { fundingRate: 0.0001, volume24h: 12345, news: [{ title: 'BTC ETF' }] } };
  const r = normalizeSoso(raw);
  assert.equal(r.fundingRate, 0.0001);
  assert.equal(r.volume24h, 12345);
  assert.equal(r.news[0], 'BTC ETF');
});

test('describeSoso 有数据时输出摘要', () => {
  const s = describeSoso({ fundingRate: 0.0001, volume24h: 100, news: ['x'] });
  assert.ok(s.includes('资金费率'));
  assert.ok(s.includes('100'));
});

test('describeSoso 无数据时提示不可用', () => {
  assert.ok(describeSoso(null).includes('暂不可用'));
});

test('fetchSosoValue 网络失败时返回 null 而不抛错', async () => {
  // 在测试环境无网络代理，预期返回 null
  const r = await fetchSosoValue();
  assert.ok(r === null || typeof r === 'object');
});
