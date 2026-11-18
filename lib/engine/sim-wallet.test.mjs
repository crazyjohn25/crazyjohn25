import assert from "node:assert/strict";
import test from "node:test";

import {
  BINANCE_UM_VIP0,
  closePosition,
  createWallet,
  deposit,
  inspectWallet,
  liquidatePosition,
  liquidationPrice,
  openPosition,
  openingFee,
  planAutoTrades,
  runAutoTrades,
  settleLiquidations,
  withdraw,
} from "./sim-wallet.mjs";

test("opening fee matches Binance USD-M VIP 0 taker on notional", () => {
  assert.equal(BINANCE_UM_VIP0.takerRate, 0.0005);
  assert.equal(BINANCE_UM_VIP0.makerRate, 0.0002);
  assert.equal(BINANCE_UM_VIP0.maxLeverage, 100);
  const wallet = createWallet(1000, 1);
  const opened = openPosition(wallet, {
    assetId: "btc",
    symbol: "BTCUSDT",
    side: "long",
    leverage: 100,
    margin: 20,
    price: 64000,
    nonce: "a",
  }, 2);
  assert.equal(opened.ok, true);
  assert.equal(opened.fee, openingFee(20, 100));
  assert.equal(opened.fee, 1);
  assert.equal(opened.wallet.cash, 979);
});

test("leverage above 100 and locked margin cannot leave the wallet", () => {
  const wallet = createWallet(100, 1);
  const denied = openPosition(wallet, {
    assetId: "btc",
    symbol: "BTCUSDT",
    side: "long",
    leverage: 101,
    margin: 10,
    price: 100,
    nonce: "b",
  }, 2);
  assert.equal(denied.ok, false);
  const opened = openPosition(wallet, {
    assetId: "btc",
    symbol: "BTCUSDT",
    side: "short",
    leverage: 10,
    margin: 40,
    price: 100,
    nonce: "c",
  }, 3);
  assert.equal(opened.ok, true);
  const pulled = withdraw(opened.wallet, 70, 4);
  assert.equal(pulled.ok, false);
  const added = deposit(opened.wallet, 15, 5);
  assert.equal(added.ok, true);
  assert.equal(added.wallet.cash, opened.wallet.cash + 15);
});

test("isolated liquidation wipes margin and a profitable close returns cash minus taker", () => {
  const wallet = createWallet(500, 1);
  const opened = openPosition(wallet, {
    assetId: "btc",
    symbol: "BTCUSDT",
    side: "long",
    leverage: 50,
    margin: 100,
    price: 100,
    nonce: "d",
  }, 2);
  const position = opened.position;
  const liq = liquidationPrice(position);
  assert.ok(liq < 100);
  assert.ok(liq > 97);
  const blown = settleLiquidations(opened.wallet, [{ id: "btc", price: liq - 0.01 }], 3);
  assert.equal(blown.notes.length, 1);
  assert.equal(blown.wallet.positions.length, 0);
  assert.equal(blown.wallet.cash, opened.wallet.cash);
  assert.equal(blown.wallet.realized, -100);

  const winner = closePosition(opened.wallet, position.id, 110, 4);
  assert.equal(winner.ok, true);
  const gross = (110 - 100) * position.qty;
  const fee = Math.round((position.qty * 110 * 0.0005 + Number.EPSILON) * 10000) / 10000;
  assert.equal(winner.pnl, Math.round((gross - fee + Number.EPSILON) * 10000) / 10000);
  assert.ok(winner.wallet.cash > opened.wallet.cash + 100);
});

test("auto trader can open with no score floor and follows a clear score", () => {
  const wallet = createWallet(1000, 1);
  const quotes = [
    { id: "nvda", symbol: "NVDA", name: "英伟达", price: 150, actionScore: -60 },
    { id: "btc", symbol: "BTCUSDT", name: "比特币", price: 64000, actionScore: 0 },
  ];
  let i = 0;
  const seq = [0.99, 0.01, 0.2, 0.1, 0.0, 0.0, 0.5, 0.2];
  const random = () => seq[i++] ?? 0.5;
  const plan = planAutoTrades(wallet, quotes, random, 9);
  const opens = plan.filter((step) => step.type === "open");
  assert.ok(opens.length >= 1);
  const nvda = opens.find((step) => step.assetId === "nvda");
  assert.ok(nvda);
  assert.equal(nvda.side, "short");
  assert.ok(nvda.leverage >= 1 && nvda.leverage <= 100);
  const ran = runAutoTrades(wallet, quotes, () => 0, 10);
  assert.ok(ran.wallet.positions.length >= 1);
  assert.ok(ran.wallet.fees > 0);
  const view = inspectWallet(ran.wallet, quotes);
  assert.ok(view.equity < 1000);
  assert.equal(liquidatePosition(createWallet(1), "missing").ok, false);
});
