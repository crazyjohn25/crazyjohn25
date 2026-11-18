const SH_CLOCK = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export const WHALE_FLOOR_USD = 10_000;

const ACTIONS = {
  "Open Long": { kind: "open", side: "long", label: "开多" },
  "Open Short": { kind: "open", side: "short", label: "开空" },
  "Close Long": { kind: "close", side: "long", label: "平多" },
  "Close Short": { kind: "close", side: "short", label: "平空" },
  "Short > Long": { kind: "open", side: "long", label: "空转多" },
  "Long > Short": { kind: "open", side: "short", label: "多转空" },
};

export function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function tradeNotional(trade) {
  const px = num(trade?.px);
  const sz = num(trade?.sz);
  if (px == null || sz == null) return 0;
  return px * sz;
}

export function takerAddress(trade) {
  const users = trade?.users;
  if (!Array.isArray(users) || users.length < 2) return null;
  if (trade.side === "B") return users[0];
  if (trade.side === "A") return users[1];
  return null;
}

export function classifyDir(dir) {
  return ACTIONS[dir] || null;
}

export function shanghaiClock(ms) {
  const parts = SH_CLOCK.formatToParts(new Date(ms));
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("hour")}:${pick("minute")}:${pick("second")}`;
}

export function shortAddress(address) {
  const text = String(address || "");
  if (text.length < 12) return text;
  return `${text.slice(0, 6)}…${text.slice(-4)}`;
}

export function accountSnapshot(state, coin) {
  if (!state || typeof state !== "object") return null;
  const margin = state.marginSummary || {};
  const rows = Array.isArray(state.assetPositions) ? state.assetPositions : [];
  const position = rows.map((row) => row?.position).find((item) => item && item.coin === coin) || null;
  const leverage = position?.leverage || null;
  const leverageType = leverage?.type === "isolated" ? "逐仓" : leverage?.type === "cross" ? "全仓" : null;
  return {
    accountValue: num(margin.accountValue),
    marginUsed: num(margin.totalMarginUsed),
    withdrawable: num(state.withdrawable),
    leverage: num(leverage?.value),
    leverageType,
    entryPx: num(position?.entryPx),
    liquidationPx: num(position?.liquidationPx),
    unrealizedPnl: num(position?.unrealizedPnl),
    positionSize: num(position?.szi),
  };
}

export function buildBroadcast(trade, fill, account = null) {
  const action = classifyDir(fill?.dir);
  const address = takerAddress(trade);
  if (!action || !address) return null;
  const px = num(fill.px ?? trade.px);
  const sz = num(fill.sz ?? trade.sz);
  const start = num(fill.startPosition);
  if (px == null || sz == null || start == null) return null;
  const side = fill.side || trade.side;
  const signed = side === "B" ? sz : side === "A" ? -sz : null;
  if (signed == null) return null;
  const time = Number(fill.time ?? trade.time);
  const round = (value) => Math.round(value * 1e8) / 1e8;
  return {
    id: `${trade.coin}:${trade.tid}:${address}`,
    time,
    clock: shanghaiClock(time),
    coin: fill.coin || trade.coin,
    action: action.kind,
    side: action.side,
    label: action.label,
    address,
    addressShort: shortAddress(address),
    notional: round(px * sz),
    px,
    sz,
    startPosition: start,
    endPosition: round(start + signed),
    fee: num(fill.fee),
    closedPnl: num(fill.closedPnl),
    crossed: Boolean(fill.crossed),
    hash: fill.hash || trade.hash || "",
    account,
  };
}
