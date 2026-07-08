import test from 'node:test';
import assert from 'node:assert/strict';
import {
  currentWindowStart,
  windowSlug,
  analyzeBook,
  analyzeTrades,
  advise5m,
} from '../js/polymarket.js';

test('currentWindowStart 对齐5分钟边界', () => {
  assert.equal(currentWindowStart(1783416901), 1783416900);
  assert.equal(currentWindowStart(1783417199), 1783416900);
  assert.equal(currentWindowStart(1783417200), 1783417200);
  assert.equal(windowSlug(1783416900), 'btc-updown-5m-1783416900');
});

test('analyzeBook 计算深度与不平衡度', () => {
  const book = {
    bids: [
      { price: '0.5', size: '100' }, // 50
      { price: '0.4', size: '50' }, // 20
    ],
    asks: [{ price: '0.6', size: '50' }], // 30
  };
  const r = analyzeBook(book);
  assert.equal(r.bidDepth, 70);
  assert.equal(r.askDepth, 30);
  assert.ok(Math.abs(r.imbalance - 0.4) < 1e-9);
  assert.equal(r.bestBid, 0.5);
  assert.equal(r.bestAsk, 0.6);
  assert.ok(Math.abs(r.spread - 0.1) < 1e-9);
});

test('analyzeBook 空订单簿不报错', () => {
  const r = analyzeBook({});
  assert.equal(r.imbalance, 0);
  assert.equal(r.bestBid, null);
});

test('analyzeTrades 识别大单、异常单与资金流方向', () => {
  const trades = [
    // BUY Up $650 -> 押涨大单
    { side: 'BUY', outcome: 'Up', size: 1000, price: 0.65, timestamp: 100, pseudonym: 'whale1' },
    // SELL Up $300 -> 押跌（非大单）
    { side: 'SELL', outcome: 'Up', size: 1000, price: 0.3, timestamp: 101 },
    // BUY Down 在95¢的极端追单 $950 -> 大单+异常
    { side: 'BUY', outcome: 'Down', size: 1000, price: 0.95, timestamp: 102 },
  ];
  const r = analyzeTrades(trades, { bigUsd: 500 });
  assert.equal(r.bigTrades.length, 2);
  assert.equal(r.bigTrades[0].direction, 'up');
  assert.equal(r.bigTrades[1].direction, 'down');
  assert.equal(r.anomalies.length, 1);
  assert.ok(r.anomalies[0].desc.includes('极端价位'));
  assert.ok(Math.abs(r.upFlow - 650) < 1e-9);
  assert.ok(Math.abs(r.downFlow - 1250) < 1e-9); // 300 + 950
  assert.ok(r.netUpFlow < 0);
});

function mk1m(n, dir = 1, seed = 100000) {
  let p = seed;
  return Array.from({ length: n }, (_, i) => {
    const open = p;
    const close = open + dir * 15;
    p = close;
    return { time: 1783416600 + i * 60, open, high: Math.max(open, close) + 5, low: Math.min(open, close) - 5, close, volume: 10 };
  });
}

test('advise5m：盘尾窗口内强势领先时建议买Up并给出成本与ROI', () => {
  const candles = mk1m(20, 1); // 一路上涨，现价远超起始
  const r = advise5m({
    candles1m: candles,
    strikePrice: candles[15].open, // 现价比目标价高
    upPrice: 0.55,
    flow: { upFlow: 500, downFlow: 100, netUpFlow: 400, bigTrades: [] },
    book: { imbalance: 0.3 },
    secondsLeft: 120,
  });
  assert.equal(r.action, '买Up');
  assert.ok(r.techProb > 0.6);
  assert.ok(r.conf >= 0.2);
  // 成本与ROI：买Up成本=upPrice
  assert.ok(Math.abs(r.cost - 0.55) < 1e-9);
  assert.ok(Math.abs(r.potentialRoiPct - ((1 - 0.55) / 0.55) * 100) < 1e-6);
  assert.ok(r.evRoiPct > 5, '期望ROI应为正且超过门槛');
  assert.ok(r.reasons.some((x) => x.includes('买入价值')));
});

test('advise5m：早段（剩余>3分钟）强制等待盘尾', () => {
  const candles = mk1m(20, 1);
  const r = advise5m({
    candles1m: candles,
    strikePrice: candles[15].open,
    upPrice: 0.5,
    flow: null,
    book: null,
    secondsLeft: 240,
  });
  assert.ok(r.action.includes('盘尾'));
});

test('advise5m：临近结算不追单', () => {
  const candles = mk1m(20, 1);
  const r = advise5m({
    candles1m: candles,
    strikePrice: candles[15].open,
    upPrice: 0.55,
    flow: null,
    book: null,
    secondsLeft: 20,
  });
  assert.equal(r.action, '临近结算，勿追单');
});

test('advise5m：极端定价时提示无价值', () => {
  const candles = mk1m(20, 1);
  const r = advise5m({
    candles1m: candles,
    strikePrice: candles[10].open,
    upPrice: 0.99,
    flow: null,
    book: null,
    secondsLeft: 100,
  });
  assert.ok(r.action.includes('无') && r.action.includes('价值'));
});

test('advise5m：方向不依赖市场定价（55¢与20¢方向一致）', () => {
  const candles = mk1m(20, 1);
  const base = {
    candles1m: candles,
    strikePrice: candles[15].open,
    flow: null,
    book: null,
    secondsLeft: 120,
  };
  const a = advise5m({ ...base, upPrice: 0.55 });
  const b = advise5m({ ...base, upPrice: 0.2 });
  assert.equal(a.techProb.toFixed(6), b.techProb.toFixed(6), '技术面概率不应随市场定价变化');
});

test('advise5m：数据不足时不给方向', () => {
  const r = advise5m({ candles1m: [], strikePrice: null, upPrice: 0.5, flow: null, book: null, secondsLeft: 100 });
  assert.equal(r.action, '数据不足');
});
