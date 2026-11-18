// Binance USDⓈ-M 永续，普通用户 VIP 0。
// 费率表：https://www.binance.com/en/fee/futureFee
// 吃单 0.0500%，挂单 0.0200%。模拟盘按市价开平，记吃单。
// 第一档维持保证金率 0.40%（小名义价值档，维持保证金速算额为 0）。
export const BINANCE_UM_VIP0 = {
  makerRate: 0.0002,
  takerRate: 0.0005,
  maintenanceMarginRate: 0.004,
  maxLeverage: 100,
  minNotional: 5,
  label: "Binance U 本位永续 VIP 0：吃单 0.0500%，挂单 0.0200%，维持保证金率 0.40%，最小名义价值 5 USDT",
};

export function roundMoney(value) {
  if (!Number.isFinite(Number(value))) return 0;
  return Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;
}

export function createWallet(cash = 10000, now = Date.now()) {
  return {
    cash: roundMoney(cash),
    realized: 0,
    fees: 0,
    positions: [],
    fills: [],
    createdAt: now,
  };
}

function withFill(wallet, fill) {
  return { ...wallet, fills: [fill, ...wallet.fills].slice(0, 80) };
}

export function deposit(wallet, amount, now = Date.now()) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return { ok: false, error: "增加资金必须大于 0" };
  const cash = roundMoney(wallet.cash + value);
  return {
    ok: true,
    wallet: withFill({ ...wallet, cash }, {
      id: `d-${now}`,
      t: now,
      type: "deposit",
      amount: roundMoney(value),
      cashAfter: cash,
      note: `增加资金 ${roundMoney(value)} USDT`,
    }),
  };
}

export function withdraw(wallet, amount, now = Date.now()) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return { ok: false, error: "减少资金必须大于 0" };
  if (value > wallet.cash + 1e-6) return { ok: false, error: "可用余额不足。保证金还锁在仓位里，不能转出" };
  const cash = roundMoney(wallet.cash - value);
  return {
    ok: true,
    wallet: withFill({ ...wallet, cash }, {
      id: `w-${now}`,
      t: now,
      type: "withdraw",
      amount: roundMoney(-value),
      cashAfter: cash,
      note: `减少资金 ${roundMoney(value)} USDT`,
    }),
  };
}

export function liquidationPrice(position) {
  const initial = 1 / position.leverage;
  const maintenance = position.mmr;
  if (position.side === "long") return position.entry * (1 - initial + maintenance);
  return position.entry * (1 + initial - maintenance);
}

export function unrealizedPnl(position, price) {
  const move = position.side === "long" ? price - position.entry : position.entry - price;
  return move * position.qty;
}

export function openingFee(margin, leverage) {
  return roundMoney(margin * leverage * BINANCE_UM_VIP0.takerRate);
}

export function openPosition(wallet, order, now = Date.now()) {
  const leverage = Math.floor(Number(order.leverage));
  const margin = Number(order.margin);
  const price = Number(order.price);
  const side = order.side === "short" ? "short" : order.side === "long" ? "long" : null;
  if (!side) return { ok: false, error: "方向只能是做多或做空" };
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > BINANCE_UM_VIP0.maxLeverage) {
    return { ok: false, error: "杠杆必须是 1 到 100 的整数" };
  }
  if (!Number.isFinite(margin) || margin <= 0) return { ok: false, error: "保证金必须大于 0" };
  if (!Number.isFinite(price) || price <= 0) return { ok: false, error: "没有可用的开仓价格" };
  const notional = margin * leverage;
  if (notional + 1e-8 < BINANCE_UM_VIP0.minNotional) {
    return { ok: false, error: `名义价值至少 ${BINANCE_UM_VIP0.minNotional} USDT，这是币安合约的最小开仓额` };
  }
  const fee = openingFee(margin, leverage);
  const need = roundMoney(margin + fee);
  if (need > wallet.cash + 1e-6) return { ok: false, error: "可用余额不够支付保证金和开仓手续费" };
  const position = {
    id: `p-${now}-${order.nonce ?? 0}`,
    assetId: order.assetId,
    symbol: order.symbol,
    name: order.name || order.symbol,
    side,
    leverage,
    qty: notional / price,
    entry: price,
    margin: roundMoney(margin),
    mmr: BINANCE_UM_VIP0.maintenanceMarginRate,
    openFee: fee,
    openedAt: now,
  };
  const cash = roundMoney(wallet.cash - need);
  const next = withFill({
    ...wallet,
    cash,
    fees: roundMoney(wallet.fees + fee),
    positions: [position, ...wallet.positions],
  }, {
    id: `o-${position.id}`,
    t: now,
    type: "open",
    assetId: position.assetId,
    symbol: position.symbol,
    side,
    leverage,
    price,
    fee,
    amount: -need,
    cashAfter: cash,
    note: `${position.symbol} ${side === "long" ? "开多" : "开空"} ${leverage}x，保证金 ${roundMoney(margin)}，吃单手续费 ${fee}`,
  });
  return { ok: true, wallet: next, position, fee };
}

export function closePosition(wallet, positionId, price, now = Date.now()) {
  const position = wallet.positions.find((item) => item.id === positionId);
  if (!position) return { ok: false, error: "仓位不存在" };
  if (!Number.isFinite(Number(price)) || Number(price) <= 0) return { ok: false, error: "没有可用的平仓价格" };
  const mark = Number(price);
  const pnl = unrealizedPnl(position, mark);
  const fee = roundMoney(position.qty * mark * BINANCE_UM_VIP0.takerRate);
  const released = roundMoney(position.margin + pnl - fee);
  const cash = roundMoney(wallet.cash + released);
  const next = withFill({
    ...wallet,
    cash,
    realized: roundMoney(wallet.realized + pnl - fee),
    fees: roundMoney(wallet.fees + fee),
    positions: wallet.positions.filter((item) => item.id !== positionId),
  }, {
    id: `c-${position.id}-${now}`,
    t: now,
    type: "close",
    assetId: position.assetId,
    symbol: position.symbol,
    side: position.side,
    leverage: position.leverage,
    price: mark,
    fee,
    pnl: roundMoney(pnl - fee),
    amount: released,
    cashAfter: cash,
    note: `${position.symbol} 平${position.side === "long" ? "多" : "空"} @ ${mark}，盈亏 ${roundMoney(pnl - fee)}，吃单手续费 ${fee}`,
  });
  return { ok: true, wallet: next, pnl: roundMoney(pnl - fee), fee };
}

export function liquidatePosition(wallet, positionId, now = Date.now()) {
  const position = wallet.positions.find((item) => item.id === positionId);
  if (!position) return { ok: false, error: "仓位不存在" };
  const liq = liquidationPrice(position);
  const next = withFill({
    ...wallet,
    realized: roundMoney(wallet.realized - position.margin),
    positions: wallet.positions.filter((item) => item.id !== positionId),
  }, {
    id: `l-${position.id}-${now}`,
    t: now,
    type: "liquidation",
    assetId: position.assetId,
    symbol: position.symbol,
    side: position.side,
    leverage: position.leverage,
    price: liq,
    pnl: roundMoney(-position.margin),
    amount: 0,
    cashAfter: wallet.cash,
    note: `${position.symbol} ${position.leverage}x ${position.side === "long" ? "多" : "空"}强平 @ ${roundMoney(liq)}，保证金 ${position.margin} 全部损失`,
  });
  return { ok: true, wallet: next };
}

export function settleLiquidations(wallet, quotes, now = Date.now()) {
  let next = wallet;
  const notes = [];
  for (const position of wallet.positions) {
    const quote = quotes.find((item) => item.id === position.assetId);
    if (!quote || !Number.isFinite(Number(quote.price))) continue;
    const mark = Number(quote.price);
    const liq = liquidationPrice(position);
    const hit = position.side === "long" ? mark <= liq : mark >= liq;
    if (!hit) continue;
    const closed = liquidatePosition(next, position.id, now);
    if (!closed.ok) continue;
    next = closed.wallet;
    notes.push(next.fills[0].note);
  }
  return { wallet: next, notes };
}

export function inspectWallet(wallet, quotes) {
  const positions = wallet.positions.map((position) => {
    const quote = quotes.find((item) => item.id === position.assetId);
    const mark = quote && Number.isFinite(Number(quote.price)) ? Number(quote.price) : null;
    const upnl = mark == null ? 0 : unrealizedPnl(position, mark);
    return {
      ...position,
      mark,
      upnl,
      liq: liquidationPrice(position),
      roi: position.margin ? upnl / position.margin : 0,
      notional: position.margin * position.leverage,
    };
  });
  const locked = positions.reduce((sum, position) => sum + position.margin, 0);
  const upnl = positions.reduce((sum, position) => sum + position.upnl, 0);
  return {
    cash: wallet.cash,
    locked: roundMoney(locked),
    upnl: roundMoney(upnl),
    equity: roundMoney(wallet.cash + locked + upnl),
    realized: wallet.realized,
    fees: wallet.fees,
    positions,
  };
}

function quotePrice(quotes, assetId) {
  const quote = quotes.find((item) => item.id === assetId);
  return quote && Number.isFinite(Number(quote.price)) ? Number(quote.price) : null;
}

export function planAutoTrades(wallet, quotes, random = Math.random, now = Date.now()) {
  const steps = [];
  const view = inspectWallet(wallet, quotes);
  for (const position of view.positions) {
    const quote = quotes.find((item) => item.id === position.assetId);
    const score = Number(quote?.actionScore) || 0;
    const against = (position.side === "long" && score < -8) || (position.side === "short" && score > 8);
    const takeProfit = position.roi > 0.18 && random() < 0.7;
    const cutLoss = position.roi < -0.3 && random() < 0.5;
    const flip = against && random() < 0.75;
    const age = now - position.openedAt;
    const wander = age > 180000 && random() < 0.04;
    if (!(takeProfit || cutLoss || flip || wander)) continue;
    if (position.mark == null) continue;
    const reason = takeProfit ? "浮盈落袋" : cutLoss ? "亏损收缩" : flip ? "分数反向" : "随机平仓";
    steps.push({ type: "close", id: position.id, price: position.mark, reason });
  }

  let free = wallet.cash;
  const pendingClose = new Set(steps.map((step) => step.id));
  for (const position of wallet.positions) {
    if (pendingClose.has(position.id)) free += position.margin;
  }
  const order = [...quotes].filter((item) => Number(item.price) > 0);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  let nonce = 1;
  for (const quote of order) {
    const score = Number(quote.actionScore) || 0;
    const conviction = Math.min(1, Math.abs(score) / 100);
    const chance = 0.22 + 0.7 * conviction;
    if (random() >= chance) continue;
    let side = "long";
    if (score <= -8) side = "short";
    else if (score < 8) side = random() < 0.5 ? "long" : "short";
    const leverage = 1 + Math.floor(random() * BINANCE_UM_VIP0.maxLeverage);
    const fraction = 0.04 + random() * 0.45;
    let margin = roundMoney(free * fraction);
    const minMargin = BINANCE_UM_VIP0.minNotional / leverage;
    if (margin < minMargin) margin = roundMoney(minMargin);
    const fee = openingFee(margin, leverage);
    if (margin + fee > free + 1e-6) continue;
    free = roundMoney(free - margin - fee);
    steps.push({
      type: "open",
      assetId: quote.id,
      symbol: quote.symbol,
      name: quote.name,
      side,
      leverage,
      margin,
      price: Number(quote.price),
      nonce: `${now}-${nonce}`,
      reason: Math.abs(score) >= 8 ? `顺着分数 ${score}` : "分数接近 0，随机方向",
    });
    nonce += 1;
    if (free < BINANCE_UM_VIP0.minNotional) break;
  }
  return steps;
}

export function runAutoTrades(wallet, quotes, random = Math.random, now = Date.now()) {
  const steps = planAutoTrades(wallet, quotes, random, now);
  let next = wallet;
  const notes = [];
  for (const step of steps) {
    const result = step.type === "close"
      ? closePosition(next, step.id, step.price, now)
      : openPosition(next, step, now);
    if (!result.ok) continue;
    next = result.wallet;
    notes.push(`${step.reason}：${result.wallet.fills[0].note}`);
  }
  return { wallet: next, notes, steps };
}
