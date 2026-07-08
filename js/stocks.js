/**
 * 股票行情模块（Yahoo Finance 公开接口）
 * 浏览器直连 Yahoo 会被 CORS 拦截，因此按顺序尝试多个公共CORS代理；
 * 全部失败时降级到仓库内置快照 data/stocks-snapshot.json（生成于构建时），
 * 保证纳指100与Serenity指数在任何网络环境下都能渲染。
 */

const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const PROXIES = [
  (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
];

/** Yahoo interval 映射与近似取数范围 */
const YAHOO_INTERVALS = {
  '1m': { iv: '1m', range: '1d' },
  '5m': { iv: '5m', range: '5d' },
  '15m': { iv: '15m', range: '5d' },
  '30m': { iv: '30m', range: '1mo' },
  '1h': { iv: '60m', range: '3mo' },
  '4h': { iv: '60m', range: '6mo', aggregate: 4 },
  '1d': { iv: '1d', range: '2y' },
};

let snapshotCache = null;

/** 加载内置快照（相对路径，随站点部署） */
export async function loadSnapshot() {
  if (snapshotCache) return snapshotCache;
  try {
    const res = await fetch('data/stocks-snapshot.json');
    if (res.ok) snapshotCache = await res.json();
  } catch (_) {
    snapshotCache = null;
  }
  return snapshotCache;
}

function parseYahooChart(data) {
  const r = data?.chart?.result?.[0];
  if (!r || !r.timestamp) return null;
  const q = r.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    if (q.close?.[i] == null || q.open?.[i] == null) continue;
    out.push({
      time: r.timestamp[i],
      open: q.open[i],
      high: q.high[i],
      low: q.low[i],
      close: q.close[i],
      volume: q.volume?.[i] || 0,
    });
  }
  return out.length ? out : null;
}

async function tryFetchJson(url, timeoutMs = 4000) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, ctrl ? { signal: ctrl.signal } : {});
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 把小时线聚合成4小时线 */
function aggregate(candles, n) {
  const out = [];
  for (let i = 0; i < candles.length; i += n) {
    const grp = candles.slice(i, i + n);
    out.push({
      time: grp[0].time,
      open: grp[0].open,
      high: Math.max(...grp.map((c) => c.high)),
      low: Math.min(...grp.map((c) => c.low)),
      close: grp[grp.length - 1].close,
      volume: grp.reduce((s, c) => s + c.volume, 0),
    });
  }
  return out;
}

/** 快照 -> candles */
function snapshotCandles(snapshot, ticker) {
  const rows = snapshot?.series?.[ticker];
  if (!rows || !rows.length) return null;
  return rows.map((r) => ({
    time: r[0],
    open: r[1],
    high: r[2],
    low: r[3],
    close: r[4],
    volume: r[5],
  }));
}

/** 通道健康缓存：失败的通道5分钟内跳过，成功的优先 */
const channelHealth = new Map(); // idx -> { ok, until }

function channelUsable(idx) {
  const h = channelHealth.get(idx);
  if (!h) return true;
  if (h.ok) return true;
  return Date.now() > h.until;
}

function markChannel(idx, ok) {
  channelHealth.set(idx, { ok, until: Date.now() + (ok ? 0 : 5 * 60 * 1000) });
}

/**
 * 拉取股票K线：直连 -> 代理链（带健康缓存）-> 内置快照（仅日线）
 * @returns {{candles, source: 'live'|'snapshot'}}
 */
export async function fetchStockHistory(ticker, interval = '1d', limit = 400) {
  const conf = YAHOO_INTERVALS[interval] || YAHOO_INTERVALS['1d'];
  const url = `${YAHOO}${encodeURIComponent(ticker)}?interval=${conf.iv}&range=${conf.range}`;

  const channels = [(u) => u, ...PROXIES];
  for (let i = 0; i < channels.length; i++) {
    if (!channelUsable(i)) continue;
    const data = await tryFetchJson(channels[i](url));
    let candles = data ? parseYahooChart(data) : null;
    markChannel(i, Boolean(candles));
    if (candles) {
      if (conf.aggregate) candles = aggregate(candles, conf.aggregate);
      return { candles: candles.slice(-limit), source: 'live' };
    }
  }

  // 快照降级（仅有日线；分钟级请求也回退到日线展示）
  const snapshot = await loadSnapshot();
  const candles = snapshotCandles(snapshot, ticker);
  if (candles) return { candles: candles.slice(-limit), source: 'snapshot' };
  throw new Error(`无法获取 ${ticker} 行情`);
}

/** 从内置快照批量取日线（同步快、离线可用） */
export async function snapshotBatch(tickers) {
  const snapshot = await loadSnapshot();
  const out = {};
  for (const t of tickers) {
    const candles = snapshotCandles(snapshot, t);
    out[t] = candles ? { candles, source: 'snapshot' } : null;
  }
  return out;
}

/**
 * 尝试实时批量取日线（带总预算），拿不到的返回null
 * @param {number} budgetMs 总时间预算，超时放弃剩余请求
 */
export async function fetchDailyBatch(tickers, budgetMs = 20000) {
  const out = {};
  const deadline = Date.now() + budgetMs;
  await Promise.all(
    tickers.map(async (t) => {
      if (Date.now() > deadline) {
        out[t] = null;
        return;
      }
      try {
        const { candles, source } = await fetchStockHistory(t, '1d', 90);
        out[t] = source === 'live' ? { candles, source } : null; // 只要live，快照由snapshotBatch负责
      } catch (_) {
        out[t] = null;
      }
    })
  );
  return out;
}

/**
 * 轮询订阅股票"实时"更新（Yahoo数据延迟约15分钟）
 * @returns 取消函数
 */
export function subscribeStockPolling(ticker, interval, onBar, periodMs = 60000) {
  let stopped = false;
  const timer = setInterval(async () => {
    if (stopped) return;
    try {
      const { candles } = await fetchStockHistory(ticker, interval, 2);
      if (candles.length && !stopped) onBar(candles[candles.length - 1], false);
    } catch (_) {
      /* 下次重试 */
    }
  }, periodMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
