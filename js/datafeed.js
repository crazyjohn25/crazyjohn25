/**
 * 行情数据源模块（多交易所适配）
 * - binance: 公开 REST + WebSocket（无需API Key）
 * - hyperliquid: 官方公开 info API + WebSocket（无需API Key）
 * 网络不可用时自动降级为本地生成的模拟行情，便于离线演示。
 */

import { fetchStockHistory, subscribeStockPolling } from './stocks.js';

const BINANCE_REST = 'https://api.binance.com/api/v3/klines';
const BINANCE_WS = 'wss://stream.binance.com:9443/ws';
const HL_REST = 'https://api.hyperliquid.xyz/info';
const HL_WS = 'wss://api.hyperliquid.xyz/ws';

/** 支持的品种注册表 */
export const SYMBOLS = [
  { id: 'BTCUSDT', label: 'BTC/USDT', source: 'binance', base: 'BTC', whaleUsd: 500000 },
  { id: 'ETHUSDT', label: 'ETH/USDT', source: 'binance', base: 'ETH', whaleUsd: 300000 },
  { id: 'SOLUSDT', label: 'SOL/USDT', source: 'binance', base: 'SOL', whaleUsd: 200000 },
  { id: 'BNBUSDT', label: 'BNB/USDT', source: 'binance', base: 'BNB', whaleUsd: 200000 },
  { id: 'HYPE', label: 'HYPE/USDC (Hyperliquid)', source: 'hyperliquid', base: 'HYPE', whaleUsd: 100000 },
  { id: 'NDX', label: '纳斯达克100 (NDX)', source: 'stock', base: 'NDX', whaleUsd: Infinity, yahoo: '^NDX' },
  { id: 'AAPL', label: '苹果 AAPL', source: 'stock', base: 'AAPL', whaleUsd: Infinity, yahoo: 'AAPL' },
  { id: 'NVDA', label: '英伟达 NVDA', source: 'stock', base: 'NVDA', whaleUsd: Infinity, yahoo: 'NVDA' },
  { id: 'TSLA', label: '特斯拉 TSLA', source: 'stock', base: 'TSLA', whaleUsd: Infinity, yahoo: 'TSLA' },
  { id: 'MSTR', label: 'MicroStrategy MSTR', source: 'stock', base: 'MSTR', whaleUsd: Infinity, yahoo: 'MSTR' },
];

/** 最近一次股票行情的来源：live=实时接口 / snapshot=内置快照 */
export let lastStockSource = null;

export function getSymbol(id) {
  return SYMBOLS.find((s) => s.id === id) || SYMBOLS[0];
}

export const INTERVAL_SECONDS = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
};

// ---------------- Binance ----------------

function mapBinanceKline(k) {
  return {
    time: Math.floor(k[0] / 1000),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  };
}

async function fetchBinanceHistory(symbolId, interval, limit) {
  const url = `${BINANCE_REST}?symbol=${encodeURIComponent(symbolId)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance接口错误: HTTP ${res.status}`);
  const data = await res.json();
  return data.map(mapBinanceKline);
}

function subscribeBinanceKline(symbolId, interval, onBar, onError) {
  const stream = `${symbolId.toLowerCase()}@kline_${interval}`;
  let ws;
  let closed = false;

  function connect() {
    ws = new WebSocket(`${BINANCE_WS}/${stream}`);
    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (!data.k) return;
        const k = data.k;
        onBar(
          {
            time: Math.floor(k.t / 1000),
            open: parseFloat(k.o),
            high: parseFloat(k.h),
            low: parseFloat(k.l),
            close: parseFloat(k.c),
            volume: parseFloat(k.v),
          },
          Boolean(k.x)
        );
      } catch (_) {
        /* 忽略解析失败的消息 */
      }
    };
    ws.onerror = (e) => onError && onError(e);
    ws.onclose = () => {
      if (!closed) setTimeout(connect, 3000);
    };
  }
  connect();
  return () => {
    closed = true;
    if (ws) ws.close();
  };
}

/** Binance 大额成交监听（aggTrade流） */
function subscribeBinanceWhales(symbolId, minUsd, onTrade) {
  const stream = `${symbolId.toLowerCase()}@aggTrade`;
  let ws;
  let closed = false;

  function connect() {
    ws = new WebSocket(`${BINANCE_WS}/${stream}`);
    ws.onmessage = (msg) => {
      try {
        const d = JSON.parse(msg.data);
        const price = parseFloat(d.p);
        const qty = parseFloat(d.q);
        const usd = price * qty;
        if (usd >= minUsd) {
          onTrade({
            time: Math.floor(d.T / 1000),
            price,
            qty,
            usd,
            side: d.m ? 'sell' : 'buy', // m=true 表示买方是maker，即主动卖出
            source: 'binance',
          });
        }
      } catch (_) {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (!closed) setTimeout(connect, 3000);
    };
  }
  connect();
  return () => {
    closed = true;
    if (ws) ws.close();
  };
}

// ---------------- Hyperliquid ----------------

function mapHlCandle(c) {
  return {
    time: Math.floor(c.t / 1000),
    open: parseFloat(c.o),
    high: parseFloat(c.h),
    low: parseFloat(c.l),
    close: parseFloat(c.c),
    volume: parseFloat(c.v),
  };
}

async function fetchHlHistory(coin, interval, limit) {
  const step = (INTERVAL_SECONDS[interval] || 3600) * 1000;
  const endTime = Date.now();
  const startTime = endTime - step * limit;
  const res = await fetch(HL_REST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'candleSnapshot',
      req: { coin, interval, startTime, endTime },
    }),
  });
  if (!res.ok) throw new Error(`Hyperliquid接口错误: HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('Hyperliquid返回格式异常');
  return data.map(mapHlCandle);
}

function subscribeHlKline(coin, interval, onBar, onError) {
  let ws;
  let closed = false;

  function connect() {
    ws = new WebSocket(HL_WS);
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          method: 'subscribe',
          subscription: { type: 'candle', coin, interval },
        })
      );
    };
    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data.channel !== 'candle' || !data.data) return;
        const c = data.data;
        // T 为该K线的收盘时间；当前时间超过T即视为已收盘
        onBar(mapHlCandle(c), Date.now() > c.T);
      } catch (_) {
        /* ignore */
      }
    };
    ws.onerror = (e) => onError && onError(e);
    ws.onclose = () => {
      if (!closed) setTimeout(connect, 3000);
    };
  }
  connect();
  return () => {
    closed = true;
    if (ws) ws.close();
  };
}

/** Hyperliquid 大额成交监听（trades流） */
function subscribeHlWhales(coin, minUsd, onTrade) {
  let ws;
  let closed = false;

  function connect() {
    ws = new WebSocket(HL_WS);
    ws.onopen = () => {
      ws.send(
        JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin } })
      );
    };
    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data.channel !== 'trades' || !Array.isArray(data.data)) return;
        for (const t of data.data) {
          const price = parseFloat(t.px);
          const qty = parseFloat(t.sz);
          const usd = price * qty;
          if (usd >= minUsd) {
            onTrade({
              time: Math.floor(t.time / 1000),
              price,
              qty,
              usd,
              side: t.side === 'B' ? 'buy' : 'sell',
              source: 'hyperliquid',
            });
          }
        }
      } catch (_) {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (!closed) setTimeout(connect, 3000);
    };
  }
  connect();
  return () => {
    closed = true;
    if (ws) ws.close();
  };
}

// ---------------- 统一入口（按品种来源分发） ----------------

export async function fetchHistory(symbolId, interval, limit = 500) {
  const sym = getSymbol(symbolId);
  if (sym.source === 'hyperliquid') return fetchHlHistory(sym.id, interval, limit);
  if (sym.source === 'stock') {
    const { candles, source } = await fetchStockHistory(sym.yahoo, interval, limit);
    lastStockSource = source;
    return candles;
  }
  return fetchBinanceHistory(sym.id, interval, limit);
}

export function subscribeKline(symbolId, interval, onBar, onError) {
  const sym = getSymbol(symbolId);
  if (sym.source === 'hyperliquid')
    return subscribeHlKline(sym.id, interval, onBar, onError);
  if (sym.source === 'stock') return subscribeStockPolling(sym.yahoo, interval, onBar);
  return subscribeBinanceKline(sym.id, interval, onBar, onError);
}

export function subscribeWhaleTrades(symbolId, onTrade) {
  const sym = getSymbol(symbolId);
  if (sym.source === 'stock') return () => {}; // 股票无逐笔公开流
  if (sym.source === 'hyperliquid')
    return subscribeHlWhales(sym.id, sym.whaleUsd, onTrade);
  return subscribeBinanceWhales(sym.id, sym.whaleUsd, onTrade);
}

// ---------------- 离线模拟行情（网络受限时的降级方案） ----------------

/** 生成带趋势与波动的模拟K线 */
export function generateMockHistory(interval = '1h', limit = 500, seedPrice = 65000) {
  const step = INTERVAL_SECONDS[interval] || 3600;
  const now = Math.floor(Date.now() / 1000);
  const start = now - step * limit;
  const candles = [];
  let price = seedPrice;
  let trend = 0;
  for (let i = 0; i < limit; i++) {
    if (i % 40 === 0) trend = (Math.random() - 0.5) * 0.004;
    const drift = price * trend;
    const vol = price * 0.008;
    const open = price;
    const close = open + drift + (Math.random() - 0.5) * vol;
    const high = Math.max(open, close) + Math.random() * vol * 0.5;
    const low = Math.min(open, close) - Math.random() * vol * 0.5;
    candles.push({
      time: start + i * step,
      open,
      high,
      low,
      close,
      volume: 100 + Math.random() * 900,
    });
    price = close;
  }
  return candles;
}

/** 模拟实时推送：每2秒更新最后一根K线 */
export function subscribeMockKline(interval, lastCandle, onBar) {
  const step = INTERVAL_SECONDS[interval] || 3600;
  let cur = { ...lastCandle };
  const timer = setInterval(() => {
    const now = Math.floor(Date.now() / 1000);
    if (now >= cur.time + step) {
      onBar(cur, true);
      cur = {
        time: cur.time + step,
        open: cur.close,
        high: cur.close,
        low: cur.close,
        close: cur.close,
        volume: 0,
      };
    }
    const delta = cur.close * (Math.random() - 0.5) * 0.002;
    cur.close += delta;
    cur.high = Math.max(cur.high, cur.close);
    cur.low = Math.min(cur.low, cur.close);
    cur.volume += Math.random() * 5;
    onBar({ ...cur }, false);
  }, 2000);
  return () => clearInterval(timer);
}
