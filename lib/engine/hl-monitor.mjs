import {
  WHALE_FLOOR_USD,
  accountSnapshot,
  buildBroadcast,
  takerAddress,
  tradeNotional,
} from "./hl-tape.mjs";

const INFO = "https://api.hyperliquid.xyz/info";
const WS_URL = "wss://api.hyperliquid.xyz/ws";
const UA = "MarketDesk/1.0 (research; +https://localhost)";
const KEY = "__hlWhaleMonitor";
const BACKFILL = ["BTC", "ETH", "SOL", "HYPE", "DOGE", "XRP", "BNB", "SUI", "WLD", "kPEPE", "AAVE", "ZEC", "LINK", "ARB", "AVAX", "LTC", "NEAR", "TIA", "WIF", "ENA", "TAO", "APT", "INJ", "PENDLE", "ONDO"];

async function postInfo(body) {
  const response = await fetch(INFO, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Hyperliquid ${response.status}`);
  return response.json();
}

function createMonitor() {
  const state = {
    events: [],
    seen: new Set(),
    pending: [],
    pumping: false,
    tokens: 8,
    socket: null,
    coins: [],
    reconnectMs: 1500,
    status: {
      connected: false,
      coins: 0,
      floorUsd: WHALE_FLOOR_USD,
      lookedUp: 0,
      queued: 0,
      largestUsd: 0,
      largestCoin: "",
      lastTradeAt: 0,
      error: null,
    },
  };

  function remember(id) {
    state.seen.add(id);
    if (state.seen.size > 6000) {
      const keep = [...state.seen].slice(-4000);
      state.seen = new Set(keep);
    }
  }

  function enqueue(trade) {
    const usd = tradeNotional(trade);
    if (!(usd >= WHALE_FLOOR_USD) || !takerAddress(trade)) return;
    const id = `${trade.coin}:${trade.tid}`;
    if (state.seen.has(id)) return;
    remember(id);
    if (usd > state.status.largestUsd) {
      state.status.largestUsd = usd;
      state.status.largestCoin = trade.coin;
    }
    state.pending.push(trade);
    state.pending.sort((a, b) => tradeNotional(b) - tradeNotional(a));
    if (state.pending.length > 40) state.pending.length = 40;
    state.status.queued = state.pending.length;
    pump();
  }

  async function lookup(trade) {
    const user = takerAddress(trade);
    let fill = null;
    for (let attempt = 0; attempt < 2 && !fill; attempt += 1) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 600));
      const fills = await postInfo({
        type: "userFillsByTime",
        user,
        startTime: Number(trade.time) - 4000,
        endTime: Number(trade.time) + 4000,
      });
      fill = Array.isArray(fills) ? fills.find((item) => item.tid === trade.tid) : null;
    }
    if (!fill) return;
    let account = null;
    try {
      account = accountSnapshot(await postInfo({ type: "clearinghouseState", user }), trade.coin);
    } catch {
      account = null;
    }
    const event = buildBroadcast(trade, fill, account);
    if (!event || event.notional < WHALE_FLOOR_USD) return;
    if (state.events.some((row) => row.id === event.id)) return;
    state.events.unshift(event);
    if (state.events.length > 80) state.events.length = 80;
    state.status.lookedUp += 1;
    state.status.error = null;
  }

  function pump() {
    if (state.pumping) return;
    state.pumping = true;
    (async () => {
      while (state.pending.length && state.tokens > 0) {
        state.tokens -= 1;
        const trade = state.pending.shift();
        state.status.queued = state.pending.length;
        try {
          await lookup(trade);
        } catch (error) {
          state.status.error = error instanceof Error ? error.message : "查询失败";
        }
      }
      state.pumping = false;
    })();
  }

  async function loadCoins() {
    try {
      const meta = await postInfo({ type: "meta" });
      const names = (meta?.universe || []).map((asset) => asset.name).filter(Boolean);
      if (names.length) return names;
    } catch (error) {
      state.status.error = error instanceof Error ? error.message : "合约列表失败";
    }
    return BACKFILL;
  }

  async function backfill(coins) {
    const names = BACKFILL.filter((coin) => coins.includes(coin));
    for (let i = 0; i < names.length; i += 6) {
      const slice = names.slice(i, i + 6);
      const batches = await Promise.all(slice.map(async (coin) => {
        try {
          const trades = await postInfo({ type: "recentTrades", coin });
          return Array.isArray(trades) ? trades : [];
        } catch {
          return [];
        }
      }));
      for (const trade of batches.flat()) {
        state.status.lastTradeAt = Math.max(state.status.lastTradeAt, Number(trade.time) || 0);
        const usd = tradeNotional(trade);
        if (usd > state.status.largestUsd) {
          state.status.largestUsd = usd;
          state.status.largestCoin = trade.coin;
        }
        enqueue(trade);
      }
    }
  }

  function connect() {
    const socket = new WebSocket(WS_URL);
    state.socket = socket;
    socket.addEventListener("open", () => {
      state.status.connected = true;
      state.reconnectMs = 1500;
      loadCoins().then((coins) => {
        if (state.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
        state.coins = coins;
        state.status.coins = coins.length;
        for (const coin of coins) {
          socket.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin } }));
        }
        backfill(coins);
      });
    });
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.channel !== "trades" || !Array.isArray(message.data)) return;
      for (const trade of message.data) {
        state.status.lastTradeAt = Number(trade.time) || state.status.lastTradeAt;
        const usd = tradeNotional(trade);
        if (usd > state.status.largestUsd) {
          state.status.largestUsd = usd;
          state.status.largestCoin = trade.coin;
        }
        enqueue(trade);
      }
    });
    socket.addEventListener("close", () => {
      if (state.socket !== socket) return;
      state.status.connected = false;
      const wait = state.reconnectMs;
      state.reconnectMs = Math.min(15000, state.reconnectMs * 2);
      setTimeout(connect, wait);
    });
    socket.addEventListener("error", () => {
      state.status.error = "行情连接中断";
    });
  }

  state.refill = setInterval(() => {
    state.tokens = Math.min(16, state.tokens + 1);
    pump();
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify({ method: "ping" }));
    }
  }, 3000);
  connect();
  return state;
}

export function getWhaleMonitor() {
  if (!globalThis[KEY]) globalThis[KEY] = createMonitor();
  return globalThis[KEY];
}
