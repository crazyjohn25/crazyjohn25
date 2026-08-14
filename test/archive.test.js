import test from 'node:test';
import assert from 'node:assert/strict';
import { SignalArchive, signalFingerprint, SIGNAL_DEDUP_SEC } from '../js/archive.js';
import { MAJOR_THRESHOLD } from '../js/advisor.js';

const T0 = 1783500000;

function mk() {
  return new SignalArchive({});
}

function sig(over = {}) {
  return {
    symbol: 'BTCUSDT',
    strategy: 'short',
    side: 'long',
    score: 3.2,
    action: '买入',
    label: '短线',
    price: 100,
    time: T0,
    ...over,
  };
}

test('弱信号不入库', () => {
  const a = mk();
  assert.equal(a.consider(sig({ score: 2.4 })), null);
  assert.equal(a.items.length, 0);
});

test('达到强烈阈值才存档', () => {
  const a = mk();
  const rec = a.consider(sig());
  assert.ok(rec);
  assert.equal(rec.fingerprint, signalFingerprint(sig()));
  assert.equal(a.recent(1)[0].id, rec.id);
  assert.ok(MAJOR_THRESHOLD >= 3);
});

test('同指纹去重窗口内不刷屏', () => {
  const a = mk();
  assert.ok(a.consider(sig()));
  assert.equal(a.consider(sig({ time: T0 + 60, score: 3.3 })), null);
  assert.equal(a.items.length, 1);
});

test('评分明显增强时允许再存一条', () => {
  const a = mk();
  assert.ok(a.consider(sig({ score: 3.0 })));
  const up = a.consider(sig({ time: T0 + 120, score: 3.6 }));
  assert.ok(up);
  assert.equal(a.items.length, 2);
});

test('方向反转视为新信号', () => {
  const a = mk();
  assert.ok(a.consider(sig({ side: 'long' })));
  assert.ok(a.consider(sig({ side: 'short', score: -3.1, time: T0 + 10 })));
  assert.equal(a.items.length, 2);
});

test('去重窗口过后可再存', () => {
  const a = mk();
  assert.ok(a.consider(sig()));
  assert.ok(a.consider(sig({ time: T0 + SIGNAL_DEDUP_SEC + 1 })));
});
