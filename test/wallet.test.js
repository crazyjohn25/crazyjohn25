import test from 'node:test';
import assert from 'node:assert/strict';
import { PaperWallet, FEE_RATE } from '../js/wallet.js';

const T0 = 1783500000;

function mkWallet() {
  return new PaperWallet({}); // 无localStorage时自动用内存存储
}

test('开仓收取手续费并冻结保证金（初始$10000，杠杆下限20x）', () => {
  const w = mkWallet();
  const pos = w.openPosition({ symbol: 'BTCUSDT', side: 'long', price: 100, margin: 500, leverage: 20, time: T0, strategy: 'short' });
  assert.ok(pos.id);
  const fee = 500 * 20 * FEE_RATE;
  assert.ok(Math.abs(w.cash - (10000 - 500 - fee)) < 1e-9);
  assert.equal(w.positions.length, 1);
});

test('保证金与杠杆强制夹取到 [500,1000] 与 [20,100]', () => {
  const w = mkWallet();
  const pos = w.openPosition({ symbol: 'X', side: 'long', price: 100, margin: 100, leverage: 5, time: T0, strategy: 's' });
  assert.equal(pos.margin, 500);
  assert.equal(pos.leverage, 20);
  const pos2 = w.openPosition({ symbol: 'Y', side: 'long', price: 100, margin: 5000, leverage: 500, time: T0, strategy: 's' });
  assert.equal(pos2.margin, 1000);
  assert.equal(pos2.leverage, 100);
});

test('止盈自动平仓：盈亏与ROI正确', () => {
  const w = mkWallet();
  w.openPosition({ symbol: 'BTC', side: 'long', price: 100, margin: 500, leverage: 20, target: 101, stop: 99.5, time: T0, strategy: 'short' });
  const closed = w.markPrice('BTC', 101, T0 + 600);
  assert.equal(closed.length, 1);
  const t = closed[0];
  assert.equal(t.cause, 'target');
  // notional 10000, +1% → pnl 100；手续费 5/边
  assert.ok(Math.abs(t.pnl - 100) < 1e-9);
  assert.ok(Math.abs(t.netPnl - (100 - 5 - 5)) < 1e-9);
  assert.ok(Math.abs(t.roiPct - ((100 - 10) / 500) * 100) < 1e-6);
  assert.ok(Math.abs(w.cash - (10000 - 5 + 100 - 5)) < 1e-9);
});

test('做空止损与强平（100x下反向0.95%即强平）', () => {
  const w = mkWallet();
  w.openPosition({ symbol: 'ETH', side: 'short', price: 100, margin: 500, leverage: 100, stop: 103, time: T0, strategy: 'mid' });
  // 100x做空，价格+0.95% → 亏损475 = 95%保证金 → 强平
  const closed = w.markPrice('ETH', 100.95, T0 + 60);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].cause, 'liquidated');
  assert.ok(Math.abs(closed[0].pnl - -500) < 1e-9, '强平损失全部保证金');
});

test('addFunds 手动注资', () => {
  const w = mkWallet();
  assert.ok(w.addFunds(5000, 'spot'));
  assert.equal(w.cash, 15000);
  assert.ok(w.addFunds('2000', 'pm'));
  assert.equal(w.pmCash, 3000);
  assert.ok(!w.addFunds(-5, 'spot'));
  assert.ok(!w.addFunds('abc', 'spot'));
});

test('风控：最多3仓、同键去重、冷却、余额不足', () => {
  const w = mkWallet();
  const base = { side: 'long', price: 100, margin: 500, leverage: 20, time: T0 };
  assert.ok(w.openPosition({ ...base, symbol: 'A', strategy: 's' }).id);
  assert.equal(w.openPosition({ ...base, symbol: 'A', strategy: 's' }).rejected, '同品种同策略已有持仓');
  assert.ok(w.openPosition({ ...base, symbol: 'B', strategy: 's' }).id);
  assert.ok(w.openPosition({ ...base, symbol: 'C', strategy: 's' }).id);
  assert.ok(w.openPosition({ ...base, symbol: 'D', strategy: 's' }).rejected.includes('最大并存'));
  // 平掉A后冷却生效
  w.closePosition(w.positions[0].id, 100, T0 + 100);
  assert.ok(w.openPosition({ ...base, symbol: 'A', strategy: 's', time: T0 + 200 }).rejected.includes('冷却'));
  assert.ok(w.openPosition({ ...base, symbol: 'A', strategy: 's', time: T0 + 7 * 3600 }).id, '冷却期过后可再开');
});

test('PM下注与结算：命中按份额赔付，未中损失本金', () => {
  const w = mkWallet();
  const bet = w.placePmBet({ winStart: 1000, side: 'up', cost: 0.5, stake: 100, time: T0 });
  assert.ok(bet.shares === 200);
  assert.equal(w.pmCash, 900);
  assert.equal(w.placePmBet({ winStart: 1000, side: 'up', cost: 0.5, stake: 100, time: T0 }).rejected, '本窗口已下注');
  const win = w.settlePmBet(1000, 'up');
  assert.ok(win.won);
  assert.ok(Math.abs(win.pnl - 100) < 1e-9); // 200份×$1 - $100
  assert.ok(Math.abs(w.pmCash - 1100) < 1e-9);

  w.placePmBet({ winStart: 2000, side: 'down', cost: 0.4, stake: 50, time: T0 });
  const lose = w.settlePmBet(2000, 'up');
  assert.ok(!lose.won);
  assert.equal(lose.pnl, -50);
});

test('权益快照与每日/每小时收益', () => {
  const w = mkWallet();
  const day = 86400;
  w.snapshotEquity(T0, {});
  w.snapshotEquity(T0 + 3600, {});
  w.pmCash += 100; // 模拟盈利
  w.snapshotEquity(T0 + 2 * 3600, {});
  w.cash -= 50;
  w.snapshotEquity(T0 + day, {});
  w.snapshotEquity(T0 + day + 3600, {});

  const hourly = w.hourlyReturns(24);
  assert.ok(hourly.length >= 2);
  const gain = hourly.find((h) => h.pnl > 99);
  assert.ok(gain, '应捕捉到+100的小时');

  const daily = w.dailyReturns();
  assert.ok(daily.length >= 1);
  assert.ok(typeof daily[0].retPct === 'number');
});

test('equitySpot 含浮盈', () => {
  const w = mkWallet();
  w.openPosition({ symbol: 'BTC', side: 'long', price: 100, margin: 500, leverage: 20, time: T0, strategy: 's' });
  const eq = w.equitySpot({ BTC: 100.4 });
  // 现金=10000-500-5；持仓价值=500+10000*0.4%=540
  assert.ok(Math.abs(eq - (10000 - 500 - 5 + 500 + 40)) < 1e-9);
});
