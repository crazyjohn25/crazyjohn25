import assert from "node:assert/strict";
import test from "node:test";

import {
  accountSnapshot,
  buildBroadcast,
  classifyDir,
  shanghaiClock,
  takerAddress,
  tradeNotional,
} from "./hl-tape.mjs";

const closeTrade = {
  coin: "BTC",
  side: "A",
  px: "64540.0",
  sz: "0.03364",
  time: 1794987776229,
  hash: "0x94cdf236b089b122964704490ca4b3020161001c4b8ccff438969d896f8d8b0d",
  tid: 761350493534350,
  users: ["0x47472cd62c99b8b5ce7e84e733515133e9aec0bd", "0x7b7f72a28fe109fa703eeed7984f2a8a68fedee2"],
};

const closeFill = {
  coin: "BTC",
  dir: "Close Long",
  side: "A",
  px: "64540.0",
  sz: "0.03364",
  time: 1794987776229,
  startPosition: "12.73753",
  closedPnl: "-4.733148",
  fee: "0.395144",
  hash: closeTrade.hash,
  tid: closeTrade.tid,
  crossed: true,
};

test("taker is the buyer on B and the seller on A", () => {
  assert.equal(takerAddress(closeTrade), closeTrade.users[1]);
  assert.equal(takerAddress({ ...closeTrade, side: "B" }), closeTrade.users[0]);
  assert.equal(takerAddress({ side: "B", users: ["0xabc"] }), null);
});

test("only confirmed open and close directions become a broadcast", () => {
  assert.deepEqual(classifyDir("Open Long"), { kind: "open", side: "long", label: "开多" });
  assert.deepEqual(classifyDir("Open Short"), { kind: "open", side: "short", label: "开空" });
  assert.equal(classifyDir("Long > Short").label, "多转空");
  assert.equal(classifyDir("Short > Long").side, "long");
  assert.equal(classifyDir("Buy"), null);
  assert.equal(classifyDir(""), null);
});

test("a close fill keeps the address, Shanghai clock, and position after the trade", () => {
  const event = buildBroadcast(closeTrade, closeFill, accountSnapshot({
    marginSummary: { accountValue: "2882451.61", totalMarginUsed: "66847.63" },
    withdrawable: "1000",
    assetPositions: [{
      position: {
        coin: "BTC",
        szi: "12.70389",
        entryPx: "64680",
        liquidationPx: "50100",
        unrealizedPnl: "-120.5",
        leverage: { type: "cross", value: 20 },
      },
    }],
  }, "BTC"));
  assert.equal(event.action, "close");
  assert.equal(event.label, "平多");
  assert.equal(event.address, closeTrade.users[1]);
  assert.equal(event.addressShort, "0x7b7f…dee2");
  assert.equal(event.clock, shanghaiClock(1794987776229));
  assert.match(event.clock, /^\d{2}:\d{2}:\d{2}$/);
  assert.ok(Math.abs(event.notional - tradeNotional(closeTrade)) < 1e-6);
  assert.ok(Math.abs(event.endPosition - (12.73753 - 0.03364)) < 1e-8);
  assert.equal(event.account.leverage, 20);
  assert.equal(event.account.leverageType, "全仓");
  assert.equal(event.account.accountValue, 2882451.61);
});

test("an open long increases the position and a spot print is dropped", () => {
  const trade = {
    coin: "HYPE",
    side: "B",
    px: "68.5",
    sz: "500",
    time: 1794987776229,
    tid: 9,
    users: ["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222"],
  };
  const open = buildBroadcast(trade, {
    coin: "HYPE",
    dir: "Open Long",
    side: "B",
    px: "68.5",
    sz: "500",
    time: trade.time,
    startPosition: "0",
    fee: "1.2",
    hash: "0xabc",
  });
  assert.equal(open.label, "开多");
  assert.equal(open.notional, 34250);
  assert.equal(open.endPosition, 500);
  const spot = buildBroadcast(trade, {
    coin: "HYPE",
    dir: "Buy",
    side: "B",
    px: "68.5",
    sz: "500",
    time: trade.time,
    startPosition: "0",
  });
  assert.equal(spot, null);
});
