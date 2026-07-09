import test from 'node:test';
import assert from 'node:assert/strict';
import { zigzag, stochSmooth, wae, computeAll } from '../js/indicators.js';

/** 构造锯齿行情：涨升50根、跌30根交替，波动明显 */
function zigzagCandles(cycles = 4) {
  const out = [];
  let p = 1000;
  let t = 1700000000;
  for (let c = 0; c < cycles; c++) {
    for (let i = 0; i < 50; i++) {
      const open = p;
      p += 10;
      out.push({ time: t, open, high: p + 3, low: open - 3, close: p, volume: 100 });
      t += 3600;
    }
    for (let i = 0; i < 30; i++) {
      const open = p;
      p -= 12;
      out.push({ time: t, open, high: open + 3, low: p - 3, close: p, volume: 100 });
      t += 3600;
    }
  }
  return out;
}

test('zigzag 识别交替的高低摆动点', () => {
  const candles = zigzagCandles(4);
  const swings = zigzag(candles);
  assert.ok(swings.length >= 5, `应识别多个摆动点，实际${swings.length}`);
  // 类型应交替
  for (let i = 1; i < swings.length; i++) {
    assert.notEqual(swings[i].type, swings[i - 1].type, '高低点应交替出现');
    assert.ok(swings[i].time > swings[i - 1].time, '时间应递增');
  }
  // 高点价格应高于相邻低点
  for (let i = 1; i < swings.length; i++) {
    const [a, b] = [swings[i - 1], swings[i]];
    const high = a.type === 'high' ? a : b;
    const low = a.type === 'low' ? a : b;
    assert.ok(high.price > low.price);
  }
});

test('zigzag 数据不足返回空', () => {
  assert.deepEqual(zigzag(zigzagCandles(1).slice(0, 10)), []);
});

test('stochSmooth 值域0-100且上涨末端处于高位', () => {
  const candles = zigzagCandles(2);
  const { k, d } = stochSmooth(candles);
  let checked = 0;
  for (let i = 0; i < candles.length; i++) {
    if (k[i] === null) continue;
    assert.ok(k[i] >= 0 && k[i] <= 100);
    checked++;
  }
  assert.ok(checked > 50);
  // 第49根附近是上涨段末端 → K应处于高位
  assert.ok(k[48] > 60, `上涨末端K应高位，实际${k[48]}`);
  assert.ok(d[60] !== null, 'D线应有值');
});

test('wae 上涨初段动量为正且爆发线为正数', () => {
  const candles = zigzagCandles(2);
  const { momentum, explosion } = wae(candles);
  assert.equal(momentum.length, candles.length);
  // 找上涨中段一根（第二周期上涨中段 idx=80+25）
  const i = 105;
  assert.notEqual(momentum[i], null);
  assert.ok(explosion[i] > 0);
  // 上涨中段动量应为正
  assert.ok(momentum[i] > 0, `上涨中段动量应为正，实际${momentum[i]}`);
});

test('computeAll 包含新增的彩带/摆动/随机/动能字段', () => {
  const candles = zigzagCandles(2);
  const all = computeAll(candles);
  assert.equal(all.ema10.length, candles.length);
  assert.equal(all.ema30.length, candles.length);
  assert.equal(all.ema60.length, candles.length);
  assert.ok(Array.isArray(all.swings) && all.swings.length > 0);
  assert.equal(all.stoch.k.length, candles.length);
  assert.equal(all.wae.momentum.length, candles.length);
});
