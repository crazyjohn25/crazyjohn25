/**
 * 异常交易监控模块
 * 1. detectCandleAnomalies：基于统计的量价异动检测（纯函数，可测）
 *    - 放量异动：成交量超过近N根均值 + volSigma 倍标准差
 *    - 价格异动：单根涨跌幅超过近N根收益率 priceSigma 倍标准差
 * 2. 大额成交（鲸鱼单）监听由 datafeed.subscribeWhaleTrades 提供实时流，
 *    本模块提供聚合缓存。
 *
 * 外部数据源说明：X（Twitter）与链上数据（如 sosovalue.com、Whale Alert、
 * Arkham 等）均需要 API Key / 登录态，纯前端无法直接抓取。
 * 预留 fetchExternalAnomalies 钩子：部署一个代理服务返回统一JSON即可接入。
 */

/**
 * 量价异动检测
 * @param {Array} candles K线（时间升序）
 * @param {Object} opts { lookback, volSigma, priceSigma, maxResults }
 * @returns {Array<{time, type, desc, zVol, zPrice, pricePct, volume}>} 新的在前
 */
export function detectCandleAnomalies(candles, opts = {}) {
  const cfg = { lookback: 96, volSigma: 3, priceSigma: 2.5, maxResults: 30, ...opts };
  const n = candles.length;
  const out = [];
  if (n < cfg.lookback + 2) return out;

  for (let i = cfg.lookback; i < n; i++) {
    // 用 i 之前 lookback 根做基准（不含当前，避免自我污染）
    let volSum = 0;
    let retSum = 0;
    const start = i - cfg.lookback;
    for (let j = start; j < i; j++) {
      volSum += candles[j].volume;
      retSum += pctChange(candles, j);
    }
    const volMean = volSum / cfg.lookback;
    const retMean = retSum / cfg.lookback;

    let volVar = 0;
    let retVar = 0;
    for (let j = start; j < i; j++) {
      volVar += (candles[j].volume - volMean) ** 2;
      retVar += (pctChange(candles, j) - retMean) ** 2;
    }
    const volStd = Math.sqrt(volVar / cfg.lookback);
    const retStd = Math.sqrt(retVar / cfg.lookback);

    const zVol = volStd > 0 ? (candles[i].volume - volMean) / volStd : 0;
    const ret = pctChange(candles, i);
    const zPrice = retStd > 0 ? (ret - retMean) / retStd : 0;

    const volHit = zVol > cfg.volSigma;
    const priceHit = Math.abs(zPrice) > cfg.priceSigma;
    if (!volHit && !priceHit) continue;

    let type;
    let desc;
    const dir = ret >= 0 ? '拉升' : '砸盘';
    if (volHit && priceHit) {
      type = 'both';
      desc = `放量${dir}：成交量${zVol.toFixed(1)}σ，价格波动${ret.toFixed(2)}%（${Math.abs(zPrice).toFixed(1)}σ）`;
    } else if (volHit) {
      type = 'volume';
      desc = `异常放量：成交量达均值${(candles[i].volume / volMean).toFixed(1)}倍（${zVol.toFixed(1)}σ）`;
    } else {
      type = 'price';
      desc = `价格异动：单根${dir}${ret.toFixed(2)}%（${Math.abs(zPrice).toFixed(1)}σ）`;
    }
    out.push({
      time: candles[i].time,
      type,
      desc,
      zVol,
      zPrice,
      pricePct: ret,
      volume: candles[i].volume,
    });
  }
  return out.reverse().slice(0, cfg.maxResults);
}

function pctChange(candles, i) {
  if (i === 0) return 0;
  const prev = candles[i - 1].close;
  return prev > 0 ? ((candles[i].close - prev) / prev) * 100 : 0;
}

/** 大额成交缓存：保留最近 maxSize 条 */
export class WhaleFeed {
  constructor(maxSize = 50) {
    this.trades = [];
    this.maxSize = maxSize;
  }
  push(trade) {
    this.trades.unshift(trade);
    if (this.trades.length > this.maxSize) this.trades.pop();
  }
  clear() {
    this.trades = [];
  }
}

/**
 * 外部异常数据接入钩子（X舆情、链上大额转账、sosovalue指标等）。
 * 这些源需要API Key或登录态，浏览器直接抓会被CORS/反爬拦截，
 * 需自建代理服务，返回 [{time, title, desc, url, severity}] 即可。
 */
export async function fetchExternalAnomalies(apiUrl) {
  if (!apiUrl) return [];
  try {
    const res = await fetch(apiUrl);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (_) {
    return [];
  }
}
