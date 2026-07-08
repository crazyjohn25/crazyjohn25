import test from 'node:test';
import assert from 'node:assert/strict';
import { PaperWallet, FEE_RATE } from '../js/wallet.js';

const T0 = 1783500000;

function mkWallet() {
  return new PaperWallet({}); // 无localStorage时自动用内存存储
}

test('开仓收取手续费并冻结保证金', () => {
  const w = mkWallet();
  const pos = w.openPosition({ symbol: 'BTCUSDT', side: 'long', price: 100, margin: 150, leverage: 5, time: T0, strategy: 'short' });
  assert.ok(pos.id);
  const fee = 150 * 5 * FEE_RATE;
  assert.ok(Math.abs(w.cash - (1000 - 150 - fee)) < 1e-9);
  assert.equal(w.positions.length, 1);
});

test('止盈自动平仓：盈亏与ROI正确', () => {
  const w = mkWallet();
  w.openPosition({ symbol: 'BTC', side: 'long', price: 100, margin: 100, leverage: 5, target: 110, stop: 95, time: T0, strategy: 'short' });
  const closed = w.markPrice('BTC', 110, T0 + 600);
  assert.equal(closed.length, 1);
  const t = closed[0];
  assert.equal(t.cause, 'target');
  // pnl = 500 * 10% = 50；开平手续费各 500*0.0005=0.25
  assert.ok(Math.abs(t.pnl - 50) < 1e-9);
  assert.ok(Math.abs(t.netPnl - (50 - 0.25 - 0.25)) < 1e-9);
  assert.ok(Math.abs(t.roiPct - ((50 - 0.5) / 100) * 100) < 1e-6);
  assert.ok(Math.abs(w.cash - (1000 - 0.25 + 50 - 0.25)) < 1e-9);
});

test('做空止损与强平', () => {
  const w = mkWallet();
  w.openPosition({ symbol: 'ETH', side: 'short', price: 100, margin: 100, leverage: 10, stop: 103, time: T0, strategy: 'mid' });
  // 10x做空，价格+9.5% → 亏损95 → 达到95%强平线
  const closed = w.markPrice('ETH', 109.5, T0 + 60);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].cause, 'liquidated');
  assert.ok(Math.abs(closed[0].pnl - -100) < 1e-9, '强平损失全部保证金');
});

test('风控：最多3仓、同键去重、冷却、余额不足', () => {
  const w = mkWallet();
  const base = { side: 'long', price: 100, margin: 150, leverage: 2, time: T0 };
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
  w.openPosition({ symbol: 'BTC', side: 'long', price: 100, margin: 100, leverage: 5, time: T0, strategy: 's' });
  const eq = w.equitySpot({ BTC: 104 });
  // 现金=1000-100-0.25；持仓价值=100+500*4%=120
  assert.ok(Math.abs(eq - (1000 - 100 - 0.25 + 100 + 20)) < 1e-9);
});
