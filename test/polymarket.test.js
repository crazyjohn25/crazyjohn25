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

function ticksRising(candles, step = 5) {
  // 与K线同步的tick缓存：近3分钟每15秒一个点，缓慢上行
  const endT = candles[candles.length - 1].time + 59;
  const cur = candles[candles.length - 1].close;
  const out = [];
  for (let i = 12; i >= 0; i--) {
    out.push({ t: endT - i * 15, price: cur - i * step });
  }
  return out;
}

test('advise5m：强势领先时立即决策，成本用真实卖一价', () => {
  const candles = mk1m(20, 1); // 一路上涨，现价远超起始
  const r = advise5m({
    candles1m: candles,
    tickBuffer: ticksRising(candles),
    strikePrice: candles[15].open,
    upAsk: 0.55,
    downAsk: 0.47,
    flow: { bigTrades: [] },
    book: { imbalance: 0.3 },
    secondsLeft: 120,
  });
  assert.equal(r.action, '买Up');
  assert.ok(r.decided);
  assert.ok(r.techProb > 0.6);
  // 成本必须等于订单簿卖一，而不是任何中间价
  assert.ok(Math.abs(r.cost - 0.55) < 1e-9);
  assert.ok(Math.abs(r.potentialRoiPct - ((1 - 0.55) / 0.55) * 100) < 1e-6);
  assert.ok(r.evRoiPct > 8);
  assert.ok(r.reasons.some((x) => x.includes('真实成本') || x.includes('真实买价')));
});

test('advise5m：不再限制早段——剩余240秒信号充分也可出手（越早越好）', () => {
  const candles = mk1m(20, 1);
  const r = advise5m({
    candles1m: candles,
    tickBuffer: ticksRising(candles),
    strikePrice: candles[15].open,
    upAsk: 0.5,
    downAsk: 0.52,
    flow: null,
    book: null,
    secondsLeft: 240,
  });
  assert.ok(r.decided, `早段信号充分应可决策，实际action=${r.action}`);
});

test('advise5m：筹码失真（>72¢）时放弃', () => {
  const candles = mk1m(20, 1);
  const r = advise5m({
    candles1m: candles,
    tickBuffer: ticksRising(candles),
    strikePrice: candles[15].open,
    upAsk: 0.9, // 已被抢到90¢
    downAsk: 0.12,
    flow: null,
    book: null,
    secondsLeft: 120,
  });
  assert.ok(!r.decided);
  assert.ok(r.action.includes('失真'));
});

test('advise5m：剩余<20秒放弃', () => {
  const candles = mk1m(20, 1);
  const r = advise5m({
    candles1m: candles,
    tickBuffer: ticksRising(candles),
    strikePrice: candles[15].open,
    upAsk: 0.5,
    downAsk: 0.5,
    flow: null,
    book: null,
    secondsLeft: 15,
  });
  assert.ok(r.action.includes('放弃'));
  assert.ok(!r.decided);
});

test('advise5m：规则1快速通道——价差小且筹码接近时三级动能共振速断', () => {
  // 平缓K线：现价只领先目标价$5（<$20），三级动能全部向上
  const candles = mk1m(20, 0.3, 100000); // 每分钟+~4.5
  const last = candles[candles.length - 1].close;
  const r = advise5m({
    candles1m: candles,
    tickBuffer: ticksRising(candles, 2),
    strikePrice: last - 5,
    upAsk: 0.52,
    downAsk: 0.5, // 筹码价差2¢ < 20¢
    flow: null,
    book: { imbalance: 0.2 },
    secondsLeft: 200,
  });
  assert.ok(r.reasons.some((x) => x.includes('快速通道')));
  assert.ok(r.decided, `三级动能共振应速断，实际=${r.action}`);
  assert.equal(r.action, '买Up');
});

test('advise5m：规则2反转警报——大幅领先但筹码五五开', () => {
  const candles = mk1m(20, 1);
  const last = candles[candles.length - 1].close;
  const r = advise5m({
    candles1m: candles,
    tickBuffer: ticksRising(candles),
    strikePrice: last - 40, // 领先$40 > $30
    upAsk: 0.52,
    downAsk: 0.48, // 价差4¢ < 10¢
    flow: null,
    book: null,
    secondsLeft: 120,
  });
  assert.ok(r.reversalAlert, '应触发反转警报');
  assert.ok(r.reasons.some((x) => x.includes('反转警报')));
});

test('advise5m：数据不足时不给方向', () => {
  const r = advise5m({ candles1m: [], tickBuffer: [], strikePrice: null, upAsk: 0.5, downAsk: 0.5, flow: null, book: null, secondsLeft: 100 });
  assert.equal(r.action, '数据不足');
});
