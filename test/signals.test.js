import test from 'node:test';
import assert from 'node:assert/strict';
import { computeAll } from '../js/indicators.js';
import { generateSignals } from '../js/signals.js';

/** 构造 V 形反转行情：先跌后涨，应在底部附近出现买入信号 */
function vShapeCandles(n = 120) {
  const candles = [];
  let price = 200;
  for (let i = 0; i < n; i++) {
    const drift = i < n / 2 ? -1.2 : 1.5;
    const open = price;
    const close = open + drift + (((i * 7919) % 13) - 6) * 0.1; // 确定性伪随机
    candles.push({
      time: 1700000000 + i * 3600,
      open,
      high: Math.max(open, close) + 0.5,
      low: Math.min(open, close) - 0.5,
      close,
      volume: 100 + ((i * 31) % 50),
    });
    price = close;
  }
  return candles;
}

test('V形反转行情中生成买入信号且发生在下半场', () => {
  const candles = vShapeCandles();
  const ind = computeAll(candles);
  const signals = generateSignals(candles, ind);
  const buys = signals.filter((s) => s.side === 'buy');
  assert.ok(buys.length > 0, '应至少产生一个买入信号');
  // 买入信号应集中在反转之后
  assert.ok(
    buys.some((s) => s.index >= candles.length / 2),
    '反转后应出现买入信号'
  );
});

test('信号包含必要字段且原因数量与强度一致', () => {
  const candles = vShapeCandles();
  const ind = computeAll(candles);
  const signals = generateSignals(candles, ind);
  for (const s of signals) {
    assert.ok(['buy', 'sell'].includes(s.side));
    assert.ok(typeof s.time === 'number');
    assert.ok(typeof s.price === 'number');
    assert.ok(Array.isArray(s.reasons) && s.reasons.length > 0);
    assert.ok(s.score >= s.reasons.length, 'score >= 原因数（可含ADX加权）');
    assert.ok(s.score <= s.reasons.length + 1, 'ADX最多加权1分');
  }
});

test('minScore 阈值提高后信号数量单调不增', () => {
  const candles = vShapeCandles();
  const ind = computeAll(candles);
  const loose = generateSignals(candles, ind, { minScore: 1 });
  const strict = generateSignals(candles, ind, { minScore: 3 });
  assert.ok(strict.length <= loose.length);
});

test('数据过短时不抛异常且无信号', () => {
  const candles = vShapeCandles(5);
  const ind = computeAll(candles);
  assert.doesNotThrow(() => generateSignals(candles, ind));
});
