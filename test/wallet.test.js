import test from 'node:test';
import assert from 'node:assert/strict';
import { PaperWallet, FEE_RATE, FUNDING_RATE, FUNDING_INTERVAL, leverageFromScore, LEV_MAX } from '../js/wallet.js';

const T0 = 1783500000;

function mkWallet() {
  return new PaperWallet({}); // 无localStorage时自动用内存存储
}

test('开仓进入不可变账本并保留细节', () => {
  const w = mkWallet();
  const pos = w.openPosition({
    symbol: 'BTCUSDT', side: 'long', price: 100, margin: 500, leverage: 10,
    stop: 99, target: 103, reason: '强烈信号', time: T0, strategy: 'short', signalId: 'sg1', signalScore: 3.6,
    plan: { direction: 'long', entry: 100, stop: 99, target: 103, rr: 3 },
  });
  assert.ok(pos.id);
  assert.equal(pos.status, 'open');
  assert.equal(pos.signalId, 'sg1');
  assert.equal(pos.signalScore, 3.6);
  assert.ok(pos.plan && pos.plan.rr === 3);
  assert.ok(pos.events.some((e) => e.type === 'open'));
  assert.equal(w.trades.length, 1);
});

test('平仓后账本记录完整费用与盈亏', () => {
  const w = mkWallet();
  w.openPosition({ symbol: 'BTC', side: 'long', price: 100, margin: 500, leverage: 20, target: 101, stop: 99.5, time: T0, strategy: 'short' });
  const closed = w.markPrice('BTC', 101, T0 + 600);
  assert.equal(closed.length, 1);
  const t = closed[0];
  assert.equal(t.status, 'closed');
  assert.equal(t.cause, 'target');
  assert.ok(Math.abs(t.pnl - 100) < 1e-9);
  assert.ok(Math.abs(t.netPnl - (100 - 5 - 5)) < 1e-9);
  assert.ok(t.events.some((e) => e.type === 'close'));
  assert.ok(Math.abs(w.cash - (10000 - 5 + 100 - 5)) < 1e-9);
});

test('保证金与杠杆强制夹取到 [500,1000] 与 [10,30]', () => {
  const w = mkWallet();
  const pos = w.openPosition({ symbol: 'X', side: 'long', price: 100, margin: 100, leverage: 5, time: T0, strategy: 's' });
  assert.equal(pos.margin, 500);
  assert.equal(pos.leverage, 10);
  const pos2 = w.openPosition({ symbol: 'Y', side: 'long', price: 100, margin: 5000, leverage: 500, time: T0, strategy: 's' });
  assert.equal(pos2.margin, 1000);
  assert.equal(pos2.leverage, 30);
});

test('做空止损与强平（30x下反向约3.17%即强平）', () => {
  const w = mkWallet();
  w.openPosition({ symbol: 'ETH', side: 'short', price: 100, margin: 500, leverage: 30, stop: 110, time: T0, strategy: 'mid' });
  const closed = w.markPrice('ETH', 103.2, T0 + 60);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].cause, 'liquidated');
  assert.ok(Math.abs(closed[0].pnl - -500) < 1e-9);
});

test('资金费率：每8小时按名义价值0.01%计提', () => {
  const w = mkWallet();
  w.openPosition({ symbol: 'BTC', side: 'long', price: 100, margin: 500, leverage: 20, time: T0, strategy: 's' });
  const closed = w.markPrice('BTC', 100, T0 + 16 * 3600 + 60);
  assert.equal(closed.length, 0);
  const pos = w.positions[0];
  assert.ok(Math.abs(pos.fundingPaid - 10000 * FUNDING_RATE * 2) < 1e-9);
  const rec = w.closePosition(pos.id, 100, T0 + 16 * 3600 + 120, 'manual');
  assert.ok(Math.abs(rec.funding - 2) < 1e-9);
  assert.ok(Math.abs(rec.netPnl - (0 - 5 - 5 - 2)) < 1e-9);
});

test('手动平仓 cause=manual', () => {
  const w = mkWallet();
  const pos = w.openPosition({ symbol: 'BTC', side: 'long', price: 100, margin: 500, leverage: 20, time: T0, strategy: 's' });
  const rec = w.closePosition(pos.id, 102, T0 + 300, 'manual');
  assert.equal(rec.cause, 'manual');
  assert.ok(rec.netPnl > 0);
});

test('风控：最多3仓、同键去重、冷却', () => {
  const w = mkWallet();
  const base = { side: 'long', price: 100, margin: 500, leverage: 20, time: T0 };
  assert.ok(w.openPosition({ ...base, symbol: 'A', strategy: 's' }).id);
  assert.equal(w.openPosition({ ...base, symbol: 'A', strategy: 's' }).rejected, '同品种同策略已有持仓');
  assert.ok(w.openPosition({ ...base, symbol: 'B', strategy: 's' }).id);
  assert.ok(w.openPosition({ ...base, symbol: 'C', strategy: 's' }).id);
  assert.ok(w.openPosition({ ...base, symbol: 'D', strategy: 's' }).rejected.includes('最大并存'));
  w.closePosition(w.positions[0].id, 100, T0 + 100);
  assert.ok(w.openPosition({ ...base, symbol: 'A', strategy: 's', time: T0 + 200 }).rejected.includes('冷却'));
  assert.ok(w.openPosition({ ...base, symbol: 'A', strategy: 's', time: T0 + 7 * 3600 }).id);
});

test('注资/出金/设置初始资金', () => {
  const w = mkWallet();
  assert.equal(w.baseCapital, 10000);
  assert.ok(w.addFunds(5000));
  assert.equal(w.cash, 15000);
  assert.equal(w.baseCapital, 15000);
  assert.ok(w.withdrawFunds(3000));
  assert.equal(w.cash, 12000);
  assert.equal(w.baseCapital, 12000);
  assert.ok(!w.withdrawFunds(99999));
  assert.ok(w.setInitialCapital(20000));
  assert.equal(w.cash, 20000);
  assert.equal(w.baseCapital, 20000);
  assert.equal(w.closed.length, 0);
  assert.ok(!w.setInitialCapital(50));
});

test('每日收益复盘：只统计有真实平仓的日期', () => {
  const w = mkWallet();
  const day = 86400;
  w.openPosition({ symbol: 'BTC', side: 'long', price: 100, margin: 500, leverage: 20, target: 101, time: T0, strategy: 's' });
  w.markPrice('BTC', 101, T0 + 600);
  w.openPosition({ symbol: 'ETH', side: 'long', price: 100, margin: 500, leverage: 20, stop: 99, time: T0 + 2 * day, strategy: 's' });
  w.markPrice('ETH', 99, T0 + 2 * day + 600);
  const daily = w.dailyTradeReturns();
  assert.equal(daily.length, 2);
  assert.ok(daily[0].day > daily[1].day);
  const d1 = daily.find((d) => d.trades === 1 && d.pnl > 0);
  const d3 = daily.find((d) => d.trades === 1 && d.pnl < 0);
  assert.ok(d1 && d1.wins === 1);
  assert.ok(d3 && d3.wins === 0);
});

test('equitySpot 含浮盈与资金费', () => {
  const w = mkWallet();
  w.openPosition({ symbol: 'BTC', side: 'long', price: 100, margin: 500, leverage: 20, time: T0, strategy: 's' });
  const eq = w.equitySpot({ BTC: 100.4 });
  assert.ok(Math.abs(eq - (10000 - 500 - 5 + 500 + 40)) < 1e-9);
});

test('stats 汇总含费用', () => {
  const w = mkWallet();
  w.openPosition({ symbol: 'BTC', side: 'long', price: 100, margin: 500, leverage: 20, target: 101, time: T0, strategy: 's' });
  w.markPrice('BTC', 101, T0 + 600);
  const s = w.stats();
  assert.equal(s.spotTrades, 1);
  assert.equal(s.spotWins, 1);
  assert.ok(s.totalFees > 0);
  assert.ok(s.spotNetPnl > 0);
});

test('leverageFromScore 封顶30x', () => {
  assert.equal(leverageFromScore(3), 10);
  assert.ok(leverageFromScore(8) <= LEV_MAX);
  assert.equal(LEV_MAX, 30);
});
