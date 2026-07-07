/**
 * 行情数据源模块
 * 默认使用币安公开REST + WebSocket接口获取真实K线（无需API Key）。
 * 网络不可用时自动降级为本地生成的模拟行情，便于离线演示。
 */

const BINANCE_REST = 'https://api.binance.com/api/v3/klines';
const BINANCE_WS = 'wss://stream.binance.com:9443/ws';

/** 币安K线数组 -> 标准candle */
function mapKline(k) {
  return {
    time: Math.floor(k[0] / 1000),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  };
}

/** 拉取历史K线 */
export async function fetchHistory(symbol, interval, limit = 500) {
  const url = `${BINANCE_REST}?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`行情接口错误: HTTP ${res.status}`);
  const data = await res.json();
  return data.map(mapKline);
}

/**
 * 订阅实时K线，返回取消订阅函数
 * @param {Function} onBar 回调 (candle, isClosed)
 */
export function subscribeKline(symbol, interval, onBar, onError) {
  const stream = `${symbol.toLowerCase()}@kline_${interval}`;
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
    ws.onerror = (e) => {
      if (onError) onError(e);
    };
    ws.onclose = () => {
      if (!closed) setTimeout(connect, 3000); // 断线自动重连
    };
  }
  connect();

  return () => {
    closed = true;
    if (ws) ws.close();
  };
}

// ---------------- 离线模拟行情（网络受限时的降级方案） ----------------

const INTERVAL_SECONDS = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
};

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
